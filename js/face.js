// BHFIRMS Attendance kiosk — on-device face recognition (face-api.js)
// Models are served from ./vendor/models and cached by the service worker,
// so detection + matching work with no network at all.
//
// Pipeline per frame: detector (SSD MobileNet v1, or Tiny Face Detector as the
// fast / fallback path) -> 68-point landmarks (alignment) -> 128-d descriptor.
// Matching is nearest-sample euclidean distance with a runner-up margin, so a
// face is only accepted when it is close to ONE person and clearly further
// from everyone else (see ATT_CONFIG.match).

const Face = (() => {
  let ready = false;
  let loading = null;
  let backend = "?";
  let detector = "tiny";        // what actually loaded
  let landmarksTiny = true;     // true when only the tiny landmark net is available

  const M = () => ATT_CONFIG.match;
  let _workCanvas = null;
  let _enhanceCanvas = null;
  let _missStreak = 0;

  function opts(which) {
    const d = which || detector;
    if (d === "ssd") return new faceapi.SsdMobilenetv1Options({ minConfidence: M().detectorScore });
    return new faceapi.TinyFaceDetectorOptions({ inputSize: M().detectorInputSize, scoreThreshold: M().detectorScore });
  }

  async function load() {
    if (ready) return;
    if (loading) return loading;
    loading = (async () => {
      const base = "./vendor/models";
      try {
        await faceapi.tf.setBackend("webgl");
        await faceapi.tf.ready();
      } catch (e) {
        await faceapi.tf.setBackend("cpu");
        await faceapi.tf.ready();
      }
      backend = faceapi.tf.getBackend();
      // Load all neural nets in parallel instead of sequentially
      const tinyP = faceapi.nets.tinyFaceDetector.loadFromUri(base);
      const ssdP = (M().detector === "ssd")
        ? faceapi.nets.ssdMobilenetv1.loadFromUri(base).then(() => { detector = "ssd"; }).catch(e => {
            console.warn("SSD detector unavailable, using tiny", e);
            detector = "tiny";
          })
        : Promise.resolve();
      const lmP = faceapi.nets.faceLandmark68Net.loadFromUri(base).then(() => {
        landmarksTiny = false;
      }).catch(async e => {
        console.warn("full landmark net unavailable, using tiny", e);
        await faceapi.nets.faceLandmark68TinyNet.loadFromUri(base);
        landmarksTiny = true;
      });
      const recP = faceapi.nets.faceRecognitionNet.loadFromUri(base);
      await Promise.all([tinyP, ssdP, lmP, recP]);
      ready = true;
      // Warm up WebGL shaders in the background so the first live camera frame never freezes for 2-3s
      if (typeof document !== "undefined" && (!navigator || !navigator.webdriver)) {
        setTimeout(() => {
          try {
            const warmCv = document.createElement("canvas");
            warmCv.width = 64;
            warmCv.height = 64;
            faceapi.detectSingleFace(warmCv, new faceapi.TinyFaceDetectorOptions({ inputSize: 128, scoreThreshold: 0.99 }))
              .withFaceLandmarks(landmarksTiny)
              .withFaceDescriptor()
              .catch(() => {});
          } catch (_) {}
        }, 15);
      }
    })();
    return loading;
  }

  const frameWidth = src => src.videoWidth || src.naturalWidth || src.width || 0;

  function videoToWorkCanvas(src, maxDim = 320) {
    const sw = src.videoWidth || src.naturalWidth || src.width || 0;
    const sh = src.videoHeight || src.naturalHeight || src.height || 0;
    if (!sw || !sh) return null;
    const scale = (maxDim && sw > maxDim) ? (maxDim / sw) : 1;
    const tw = Math.max(64, Math.round(sw * scale));
    const th = Math.max(48, Math.round(sh * scale));
    const cv = _workCanvas || (_workCanvas = document.createElement("canvas"));
    if (cv.width !== tw || cv.height !== th) {
      cv.width = tw;
      cv.height = th;
    }
    cv._scaleX = sw / tw;
    cv._scaleY = sh / th;
    cv.getContext("2d").drawImage(src, 0, 0, tw, th);
    return cv;
  }

  function buildShadowLiftedCanvas(srcCanvas) {
    if (!srcCanvas || !srcCanvas.width || !srcCanvas.height) return null;
    const cv = _enhanceCanvas || (_enhanceCanvas = document.createElement("canvas"));
    if (cv.width !== srcCanvas.width || cv.height !== srcCanvas.height) {
      cv.width = srcCanvas.width;
      cv.height = srcCanvas.height;
    }
    cv._scaleX = srcCanvas._scaleX || 1;
    cv._scaleY = srcCanvas._scaleY || 1;
    const ctx = cv.getContext("2d");
    try { ctx.filter = "brightness(1.38) contrast(1.22)"; } catch (_) {}
    ctx.drawImage(srcCanvas, 0, 0, cv.width, cv.height);
    try { ctx.filter = "none"; } catch (_) {}
    return cv;
  }

  function pack(r, src, scaleX = 1, scaleY = 1) {
    const fw = frameWidth(src);
    const rawBox = r.detection.box;
    const box = (scaleX !== 1 || scaleY !== 1)
      ? { x: rawBox.x * scaleX, y: rawBox.y * scaleY, width: rawBox.width * scaleX, height: rawBox.height * scaleY }
      : rawBox;
    const rawLm = r.landmarks ? r.landmarks.positions : null;
    const lm = (rawLm && (scaleX !== 1 || scaleY !== 1))
      ? rawLm.map(pt => ({ x: pt.x * scaleX, y: pt.y * scaleY }))
      : rawLm;
    return {
      descriptor: r.descriptor, box, score: r.detection.score,
      frac: fw ? box.width / fw : 1,           // face width as a fraction of the frame
      landmarks: lm, ear: lm ? ear(lm) : null,
    };
  }

  // One face (the largest) -> {descriptor, box, score, frac, landmarks, ear} | null
  async function detectOne(src) {
    if (!ready || !src) return null;
    const isLiveVideo = src.tagName === "VIDEO" || Boolean(src._isLiveEnrolVideo);
    if (isLiveVideo) {
      const cv = src.tagName === "VIDEO" ? videoToWorkCanvas(src, 320) : src;
      if (!cv) return null;
      const sx = cv._scaleX || 1;
      const sy = cv._scaleY || 1;
      // Fast pass (~25-40ms on 320x240): TinyFaceDetector at inputSize 256
      let r = await faceapi
        .detectSingleFace(cv, new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.22 }))
        .withFaceLandmarks(landmarksTiny)
        .withFaceDescriptor();
      // Immediate SSD fallback on the 320x240 frame if Tiny missed
      if (!r && detector === "ssd") {
        r = await faceapi
          .detectSingleFace(cv, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.26 }))
          .withFaceLandmarks(landmarksTiny)
          .withFaceDescriptor();
      }
      if (r) {
        _missStreak = 0;
        return pack(r, src, sx, sy);
      }
      _missStreak++;
      if (_missStreak % 3 === 1 || src._isLiveEnrolVideo) {
        const enh = buildShadowLiftedCanvas(cv);
        if (enh) {
          r = await faceapi
            .detectSingleFace(enh, new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.20 }))
            .withFaceLandmarks(landmarksTiny)
            .withFaceDescriptor();
          if (r) {
            _missStreak = 0;
            return pack(r, src, sx, sy);
          }
        }
      }
      return null;
    }
    const r = await faceapi.detectSingleFace(src, opts()).withFaceLandmarks(landmarksTiny).withFaceDescriptor();
    return r ? pack(r, src) : null;
  }

  // All faces (enrolment preview / tests)
  async function detectAll(src) {
    if (!ready) return [];
    const rs = await faceapi.detectAllFaces(src, opts()).withFaceLandmarks(landmarksTiny).withFaceDescriptors();
    return rs.map(r => pack(r, src));
  }

  // Fast path for the liveness (blink) window: tiny detector + landmarks only, no descriptor.
  async function landmarksOnly(src) {
    if (!ready || !src) return null;
    const isVideo = src.tagName === "VIDEO";
    const cv = isVideo ? videoToWorkCanvas(src, 256) : src;
    if (!cv) return null;
    const sx = cv._scaleX || 1;
    const sy = cv._scaleY || 1;
    const r = await faceapi.detectSingleFace(cv, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.22 })).withFaceLandmarks(landmarksTiny);
    if (!r) return null;
    const rawBox = r.detection.box;
    const box = (sx !== 1 || sy !== 1)
      ? { x: rawBox.x * sx, y: rawBox.y * sy, width: rawBox.width * sx, height: rawBox.height * sy }
      : rawBox;
    const lm = r.landmarks.positions;
    return { box, landmarks: lm, ear: ear(lm) };
  }

  // Eye aspect ratio (Soukupová & Čech 2016) from the 68-point layout:
  // left eye = points 36..41, right eye = 42..47. Open eyes ~0.3, closed < 0.2.
  function ear(pts) {
    if (!pts || pts.length < 48) return null;
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const one = i => (d(pts[i + 1], pts[i + 5]) + d(pts[i + 2], pts[i + 4])) / (2 * d(pts[i], pts[i + 3]) || 1);
    return (one(36) + one(42)) / 2;
  }

  // faces = [{staffId, d: number[]}] -> {staffId, distance, runnerUp: {staffId, distance}|null, margin}
  // best = nearest sample overall; runnerUp = nearest sample of a DIFFERENT person.
  function match(descriptor, faces) {
    let best = null, second = null;
    for (const f of faces) {
      const dist = faceapi.euclideanDistance(descriptor, f.d);
      if (!best || dist < best.distance) {
        if (best && best.staffId !== f.staffId) second = best;
        best = { staffId: f.staffId, distance: dist };
      } else if (f.staffId !== best.staffId && (!second || dist < second.distance)) {
        second = { staffId: f.staffId, distance: dist };
      }
    }
    if (!best) return null;
    best.runnerUp = second;
    best.margin = second ? second.distance - best.distance : null;
    return best;
  }

  // Accept / reject a match result. threshold may be overridden per device.
  function decide(m, threshold) {
    const t = threshold == null ? M().threshold : threshold;
    if (!m) return { ok: false, reason: "no-enrolments" };
    if (m.distance > t) return { ok: false, reason: "far" };
    if (m.runnerUp && m.margin < M().margin) return { ok: false, reason: "ambiguous" };
    return { ok: true, weak: m.distance > M().weakAbove, reason: "" };
  }

  // Separation report over the stored samples: how close the closest two
  // DIFFERENT people are, how spread each person's own samples are, and a
  // recommended threshold. names = Map(staffId -> name).
  function calibration(faces, names, threshold) {
    const t = threshold == null ? M().threshold : threshold;
    const nm = id => (names && names.get(id)) || id;
    const byStaff = new Map();
    faces.forEach(f => { if (!byStaff.has(f.staffId)) byStaff.set(f.staffId, []); byStaff.get(f.staffId).push(f.d); });
    let closestOther = null;
    const perPerson = [];
    const ids = [...byStaff.keys()];
    for (let i = 0; i < ids.length; i++) {
      const A = byStaff.get(ids[i]);
      let spread = 0, nearest = null;
      for (let x = 0; x < A.length; x++) for (let y = x + 1; y < A.length; y++) spread = Math.max(spread, faceapi.euclideanDistance(A[x], A[y]));
      for (let j = 0; j < ids.length; j++) {
        if (i === j) continue;
        const B = byStaff.get(ids[j]);
        for (const a of A) for (const b of B) {
          const dd = faceapi.euclideanDistance(a, b);
          if (!nearest || dd < nearest.distance) nearest = { staffId: ids[j], distance: dd };
          if (i < j && (!closestOther || dd < closestOther.distance)) closestOther = { a: ids[i], b: ids[j], distance: dd };
        }
      }
      perPerson.push({ staffId: ids[i], name: nm(ids[i]), samples: A.length, spread, nearest: nearest ? { name: nm(nearest.staffId), distance: nearest.distance } : null });
    }
    perPerson.sort((a, b) => (a.nearest ? a.nearest.distance : 9) - (b.nearest ? b.nearest.distance : 9));
    const r3 = v => Math.round(v * 1000) / 1000;
    let recommend = t, warnings = [];
    if (closestOther) {
      const ceiling = closestOther.distance - M().margin - 0.02;
      recommend = Math.max(0.40, Math.min(0.55, Math.floor(ceiling * 100) / 100));
      if (closestOther.distance < t + M().margin) warnings.push(`${nm(closestOther.a)} and ${nm(closestOther.b)} are only ${r3(closestOther.distance)} apart — the kiosk will treat them as ambiguous and ask for a PIN; re-enrol both with ${M().maxSamples} clear samples.`);
    }
    perPerson.forEach(p => { if (p.spread > t) warnings.push(`${p.name}: own samples spread ${r3(p.spread)} — one sample is probably a bad capture; re-enrol.`); });
    return {
      persons: ids.length, samples: faces.length, threshold: t, margin: M().margin,
      closestOther: closestOther ? { a: nm(closestOther.a), b: nm(closestOther.b), distance: r3(closestOther.distance) } : null,
      perPerson: perPerson.map(p => ({ name: p.name, samples: p.samples, spread: r3(p.spread), nearest: p.nearest ? { name: p.nearest.name, distance: r3(p.nearest.distance) } : null })),
      recommend: r3(recommend), warnings,
    };
  }

  return {
    load, detectOne, detectAll, landmarksOnly, match, decide, calibration, ear,
    get ready() { return ready; },
    get backend() { return backend; },
    get detector() { return detector; },
    get landmarks() { return landmarksTiny ? "68-tiny" : "68"; },
  };
})();
