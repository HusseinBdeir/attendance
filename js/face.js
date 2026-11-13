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
  let _boostLut = null;
  let _padCanvas = null;
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
        if (faceapi.tf && typeof faceapi.tf.env === "function") {
          faceapi.tf.env().set("WEBGL_PACK", false);
        }
      } catch (_) {}
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
    const ctx = cv.getContext("2d", { willReadFrequently: true }) || cv.getContext("2d");
    ctx.drawImage(src, 0, 0, tw, th);
    return cv;
  }

  function buildShadowLiftedCanvas(srcCanvas) {
    if (!srcCanvas || !srcCanvas.width || !srcCanvas.height) return null;
    const bw = srcCanvas.width, bh = srcCanvas.height;
    const cv = _enhanceCanvas || (_enhanceCanvas = document.createElement("canvas"));
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw;
      cv.height = bh;
    }
    cv._scaleX = srcCanvas._scaleX || 1;
    cv._scaleY = srcCanvas._scaleY || 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true }) || cv.getContext("2d");
    ctx.drawImage(srcCanvas, 0, 0, bw, bh);
    // Pure CPU LUT shadow-lift (avoids ctx.filter GPU Skia pipeline which wedges Android SurfaceTexture)
    try {
      if (!_boostLut) {
        _boostLut = new Uint8ClampedArray(256);
        for (let i = 0; i < 256; i++) {
          const b = i * 1.38;
          _boostLut[i] = Math.max(0, Math.min(255, Math.round((b - 128) * 1.18 + 128)));
        }
      }
      const img = ctx.getImageData(0, 0, bw, bh);
      const d = img.data;
      const lut = _boostLut;
      for (let i = 0, len = d.length; i < len; i += 4) {
        d[i] = lut[d[i]];
        d[i + 1] = lut[d[i + 1]];
        d[i + 2] = lut[d[i + 2]];
      }
      ctx.putImageData(img, 0, 0);
    } catch (_) {}
    return cv;
  }

  function pack(r, src, scaleX = 1, scaleY = 1, multiple = false) {
    const rawSrc = (src && src._rawSource) ? src._rawSource : src;
    const fw = frameWidth(rawSrc);
    const rawBox = r.detection.box;
    const box = (scaleX !== 1 || scaleY !== 1)
      ? { x: rawBox.x * scaleX, y: rawBox.y * scaleY, width: rawBox.width * scaleX, height: rawBox.height * scaleY }
      : rawBox;
    const rawLm = r.landmarks ? r.landmarks.positions : null;
    const lm = (rawLm && (scaleX !== 1 || scaleY !== 1))
      ? rawLm.map(pt => ({ x: pt.x * scaleX, y: pt.y * scaleY }))
      : rawLm;
    let padEyeBox = null;
    if (rawLm && rawLm.length >= 48 && rawBox && rawBox.width > 0 && rawBox.height > 0) {
      let minEx = 1, minEy = 1, maxEx = 0, maxEy = 0;
      for (let i = 36; i <= 47; i++) {
        const nx = (rawLm[i].x - rawBox.x) / rawBox.width;
        const ny = (rawLm[i].y - rawBox.y) / rawBox.height;
        if (nx < minEx) minEx = nx;
        if (ny < minEy) minEy = ny;
        if (nx > maxEx) maxEx = nx;
        if (ny > maxEy) maxEy = ny;
      }
      padEyeBox = {
        x0: Math.max(0.05, minEx - 0.08),
        y0: Math.max(0.08, minEy - 0.08),
        x1: Math.min(0.95, maxEx + 0.08),
        y1: Math.min(0.75, maxEy + 0.09)
      };
    }
    return {
      descriptor: r.descriptor,
      box,
      score: r.detection.score,
      frac: fw ? box.width / fw : 1,           // face width as a fraction of the frame
      multiple: !!multiple,
      landmarks: lm,
      landmarkModel: landmarksTiny ? "68-tiny" : "68",
      ear: lm ? ear(lm) : null,
      pose: lm ? pose(lm) : null,
      padEyeBox,
    };
  }

  // One primary face (largest) + multiple-person flag -> {descriptor, box, score, frac, multiple, landmarks, landmarkModel, ear, pose, padEyeBox} | null
  async function detectOne(src) {
    if (!ready || !src) return null;
    const isLiveVideo = src.tagName === "VIDEO" || Boolean(src._isLiveEnrolVideo);
    if (isLiveVideo) {
      const cv = src.tagName === "VIDEO" ? videoToWorkCanvas(src, 320) : src;
      if (!cv) return null;
      const sx = cv._scaleX || 1;
      const sy = cv._scaleY || 1;
      // Fast pass (~25-40ms on 320x240): TinyFaceDetector at inputSize 256, detectAllFaces to catch multi-person frames
      const all = await faceapi
        .detectAllFaces(cv, new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.24 }))
        .withFaceLandmarks(landmarksTiny)
        .withFaceDescriptors();
      if (all && all.length) {
        _missStreak = 0;
        const significant = all.filter(x => (cv.width ? x.detection.box.width / cv.width : 1) >= M().minFaceFrac);
        const pick = (significant.length ? significant : all)
          .slice()
          .sort((a, b) => (b.detection.box.width * b.detection.box.height) - (a.detection.box.width * a.detection.box.height))[0];
        return pack(pick, src, sx, sy, significant.length > 1);
      }
      _missStreak++;
      let r = null;
      // Throttle heavier SSD / shadow-lift fallback on empty live frames so tablet GPUs never overheat or stall ISP buffers
      if (detector === "ssd" && (_missStreak % 5 === 0 || src._isLiveEnrolVideo)) {
        r = await faceapi
          .detectSingleFace(cv, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.26 }))
          .withFaceLandmarks(landmarksTiny)
          .withFaceDescriptor();
        if (r) {
          _missStreak = 0;
          return pack(r, src, sx, sy, false);
        }
      }
      if (_missStreak % 6 === 0 || src._isLiveEnrolVideo) {
        const enh = buildShadowLiftedCanvas(cv);
        if (enh) {
          r = await faceapi
            .detectSingleFace(enh, new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.22 }))
            .withFaceLandmarks(landmarksTiny)
            .withFaceDescriptor();
          if (r) {
            _missStreak = 0;
            return pack(r, src, sx, sy, false);
          }
        }
      }
      return null;
    }
    const fw = frameWidth((src && src._rawSource) ? src._rawSource : src);
    const all = await faceapi.detectAllFaces(src, opts()).withFaceLandmarks(landmarksTiny).withFaceDescriptors();
    if (!all || !all.length) return null;
    const sig = all.filter(x => (fw ? x.detection.box.width / fw : 1) >= M().minFaceFrac);
    const pick = (sig.length ? sig : all)
      .slice()
      .sort((a, b) => (b.detection.box.width * b.detection.box.height) - (a.detection.box.width * a.detection.box.height))[0];
    return pack(pick, src, 1, 1, sig.length > 1);
  }

  // All faces (enrolment preview / tests)
  async function detectAll(src) {
    if (!ready) return [];
    const rs = await faceapi.detectAllFaces(src, opts()).withFaceLandmarks(landmarksTiny).withFaceDescriptors();
    return rs.map(r => pack(r, src, 1, 1, rs.length > 1));
  }

  // Fast path: tiny detector + landmarks only, no descriptor.
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
    const rawLm = r.landmarks.positions;
    const lm = (sx !== 1 || sy !== 1) ? rawLm.map(pt => ({ x: pt.x * sx, y: pt.y * sy })) : rawLm;
    return { box, landmarks: lm, landmarkModel: landmarksTiny ? "68-tiny" : "68", ear: ear(lm), pose: pose(lm) };
  }

  // Eye aspect ratio (Soukupová & Čech 2016) from the 68-point layout:
  // left eye = points 36..41, right eye = 42..47. Open eyes ~0.3, closed < 0.215.
  function ear(pts) {
    if (!pts || pts.length < 48) return null;
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const one = i => (d(pts[i + 1], pts[i + 5]) + d(pts[i + 2], pts[i + 4])) / (2 * d(pts[i], pts[i + 3]) || 1);
    return (one(36) + one(42)) / 2;
  }

  // 3D Head-Turn & Nod Parallax: compares protruding 3D nose-tip (30) projection across jaw contour (2, 14)
  // and chin (8) against flat inter-ocular nose-bridge (27) / canthi-mouth plane (36, 45, 48, 54).
  function pose(pts) {
    if (!pts || pts.length < 68) return null;
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const dLeftJaw = d(pts[30], pts[2]);
    const dRightJaw = d(pts[30], pts[14]);
    const yaw = (dLeftJaw - dRightJaw) / ((dLeftJaw + dRightJaw) || 1);
    const dLeftEye = d(pts[27], pts[36]);
    const dRightEye = d(pts[27], pts[45]);
    const yawEye = (dLeftEye - dRightEye) / ((dLeftEye + dRightEye) || 1);
    const parallax3d = yaw - 1.35 * yawEye;
    const dBridgeNose = d(pts[27], pts[30]);
    const dNoseChin = d(pts[30], pts[8]);
    const pitch = (dBridgeNose - dNoseChin) / ((dBridgeNose + dNoseChin) || 1);
    const midCanthi = { x: (pts[36].x + pts[45].x) * 0.5, y: (pts[36].y + pts[45].y) * 0.5 };
    const midMouth = { x: (pts[48].x + pts[54].x) * 0.5, y: (pts[48].y + pts[54].y) * 0.5 };
    const dCanthiNose = d(midCanthi, pts[30]);
    const pitchNose = (dCanthiNose - dNoseChin) / ((dCanthiNose + dNoseChin) || 1);
    const dCanthiMouth = d(midCanthi, midMouth);
    const dMouthChin = d(midMouth, pts[8]);
    const pitchPlane = (dCanthiMouth - dMouthChin) / ((dCanthiMouth + dMouthChin) || 1);
    const parallaxPitch3d = pitchNose - pitchPlane;
    return {
      yaw: Number(yaw.toFixed(4)),
      yawEye: Number(yawEye.toFixed(4)),
      bridgeYaw: Number(yawEye.toFixed(4)),
      parallax: Number(parallax3d.toFixed(4)),
      parallax3d: Number(parallax3d.toFixed(4)),
      pitch: Number(pitch.toFixed(4)),
      parallaxPitch3d: Number(parallaxPitch3d.toFixed(4)),
    };
  }

  // Deterministic On-Device Presentation Attack Detection (PAD):
  // Inspects native-scale pixels around det.box BEFORE neural downscale (< 2 ms, zero ctx.filter).
  // Detects (1) 2D Nyquist subpixel/Moire grid on inner cheek/forehead skin (excluding padEyeBox),
  // (2) localized horizontally correlated PWM/refresh row-banding, (3) non-eye planar glare + flat jaw shading,
  // and (4) paired straight dark device bezels flanking a bright interior.
  function analyzePad(src, det) {
    const empty = { evaluated: false, frameSpoof: false, score: 0, reasons: [], metrics: null };
    const rawSrc = (src && src._rawSource) ? src._rawSource : src;
    if (!rawSrc || !det || !det.box) return empty;
    const rawBox = det.box;
    const bx = Number(rawBox.x || 0), by = Number(rawBox.y || 0);
    const bw = Number(rawBox.width || 0), bh = Number(rawBox.height || 0);
    if (!(bw >= 18 && bh >= 18)) return empty;

    let rgba = null;
    let cw = 0, ch = 0;
    let faceX0 = 0, faceY0 = 0, faceW = 0, faceH = 0;

    if (rawSrc.data && rawSrc.width > 0 && rawSrc.height > 0) {
      cw = rawSrc.width | 0;
      ch = rawSrc.height | 0;
      rgba = rawSrc.data;
      faceX0 = Math.max(0, Math.round(bx));
      faceY0 = Math.max(0, Math.round(by));
      faceW = Math.min(cw - faceX0, Math.max(12, Math.round(bw)));
      faceH = Math.min(ch - faceY0, Math.max(12, Math.round(bh)));
    } else {
      if (rawSrc.tagName === "VIDEO" && (rawSrc.readyState < 2 || !rawSrc.videoWidth || !rawSrc.videoHeight)) return empty;
      const srcW = frameWidth(rawSrc);
      const srcH = rawSrc.videoHeight || rawSrc.naturalHeight || rawSrc.height || 0;
      if (!(srcW >= 32 && srcH >= 32)) return empty;

      const padMarginX = Math.round(bw * 0.32);
      const padMarginY = Math.round(bh * 0.24);
      const roiX = Math.max(0, Math.floor(bx - padMarginX));
      const roiY = Math.max(0, Math.floor(by - padMarginY));
      const roiRight = Math.min(srcW, Math.ceil(bx + bw + padMarginX));
      const roiBottom = Math.min(srcH, Math.ceil(by + bh + padMarginY));
      const roiW = Math.max(24, roiRight - roiX);
      const roiH = Math.max(24, roiBottom - roiY);
      const maxDim = 320;
      const scale = Math.max(roiW, roiH) > maxDim ? (maxDim / Math.max(roiW, roiH)) : 1;
      cw = Math.max(24, Math.round(roiW * scale));
      ch = Math.max(24, Math.round(roiH * scale));

      const cv = _padCanvas || (_padCanvas = document.createElement("canvas"));
      if (cv.width !== cw) cv.width = cw;
      if (cv.height !== ch) cv.height = ch;
      try {
        const ctx = cv.getContext("2d", { willReadFrequently: true }) || cv.getContext("2d");
        ctx.drawImage(rawSrc, roiX, roiY, roiW, roiH, 0, 0, cw, ch);
        rgba = ctx.getImageData(0, 0, cw, ch).data;
      } catch (_) {
        return empty;
      }
      faceX0 = Math.max(0, Math.round((bx - roiX) * (cw / roiW)));
      faceY0 = Math.max(0, Math.round((by - roiY) * (ch / roiH)));
      faceW = Math.min(cw - faceX0, Math.max(12, Math.round(bw * (cw / roiW))));
      faceH = Math.min(ch - faceY0, Math.max(12, Math.round(bh * (ch / roiH))));
    }

    if (!rgba || rgba.length < cw * ch * 4 || faceW < 18 || faceH < 18) return empty;

    const Y = new Float32Array(cw * ch);
    for (let i = 0, p = 0; p < cw * ch; i += 4, p++) {
      Y[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }

    const eyeBand = det.padEyeBox || { x0: 0.14, y0: 0.22, x1: 0.86, y1: 0.44 };
    const cheekY0 = Math.max(faceY0 + Math.round(faceH * Math.max(0.45, eyeBand.y1 + 0.02)), faceY0 + 2);
    const cheekY1 = Math.min(faceY0 + Math.round(faceH * 0.72), ch - 4);
    const leftCheek = {
      x0: Math.max(faceX0 + Math.round(faceW * 0.14), 3),
      x1: Math.min(faceX0 + Math.round(faceW * 0.37), cw - 4),
      y0: cheekY0,
      y1: cheekY1,
    };
    const rightCheek = {
      x0: Math.max(faceX0 + Math.round(faceW * 0.63), 3),
      x1: Math.min(faceX0 + Math.round(faceW * 0.86), cw - 4),
      y0: cheekY0,
      y1: cheekY1,
    };
    const forehead = {
      x0: Math.max(faceX0 + Math.round(faceW * 0.28), 3),
      x1: Math.min(faceX0 + Math.round(faceW * 0.72), cw - 4),
      y0: Math.max(faceY0 + Math.round(faceH * 0.08), 3),
      y1: Math.min(faceY0 + Math.round(faceH * Math.max(0.10, eyeBand.y0 - 0.02)), ch - 4),
    };
    const jawPatch = {
      x0: Math.max(faceX0 + Math.round(faceW * 0.28), 3),
      x1: Math.min(faceX0 + Math.round(faceW * 0.72), cw - 4),
      y0: Math.max(faceY0 + Math.round(faceH * 0.76), 3),
      y1: Math.min(faceY0 + Math.round(faceH * 0.90), ch - 4),
    };

    const patches = [leftCheek, rightCheek, forehead];
    let skinCount = 0;
    let sumSkinY = 0;
    let sumHf = 0;
    let sumLf = 0;
    let sumChromaHf = 0;
    let altCount = 0;
    let clippedCount = 0;
    const hist = new Uint32Array(256);

    for (const pt of patches) {
      if (pt.x1 <= pt.x0 + 2 || pt.y1 <= pt.y0 + 2) continue;
      for (let y = pt.y0; y < pt.y1; y++) {
        const rowOff = y * cw;
        for (let x = pt.x0; x < pt.x1; x++) {
          const p = rowOff + x;
          const lum = Y[p];
          sumSkinY += lum;
          skinCount += 1;
          hist[Math.max(0, Math.min(255, lum | 0))] += 1;

          const lapX = Math.abs(Y[p - 1] - 2 * lum + Y[p + 1]);
          const lapY = Math.abs(Y[p - cw] - 2 * lum + Y[p + cw]);
          const hf = 0.5 * (lapX + lapY);
          const lf = 0.5 * (Math.abs(Y[p + 3] - lum) + Math.abs(Y[p + 3 * cw] - lum)) + 2.5;
          sumHf += hf;
          sumLf += lf;

          const d1 = lum - Y[p - 1];
          const d2 = Y[p + 1] - lum;
          if (d1 * d2 < -9) altCount += 1;

          const pi = p * 4;
          const r = rgba[pi], g = rgba[pi + 1], b = rgba[pi + 2];
          const sat = Math.max(r, g, b) - Math.min(r, g, b);
          if (lum >= 244 && sat <= 18) clippedCount += 1;

          const piL = (p - 1) * 4;
          const piR = (p + 1) * 4;
          const rgL = rgba[piL] - rgba[piL + 1], rgM = r - g, rgR = rgba[piR] - rgba[piR + 1];
          const bgL = rgba[piL + 2] - rgba[piL + 1], bgM = b - g, bgR = rgba[piR + 2] - rgba[piR + 1];
          sumChromaHf += 0.5 * (Math.abs(rgL - 2 * rgM + rgR) + Math.abs(bgL - 2 * bgM + bgR));
        }
      }
    }

    const meanSkinY = skinCount ? (sumSkinY / skinCount) : 0;
    const moireRatio = sumLf > 0 ? (sumHf / sumLf) : 0;
    const hfMean = skinCount ? (sumHf / skinCount) : 0;
    const chromaHfMean = skinCount ? (sumChromaHf / skinCount) : 0;
    const altFrac = skinCount ? (altCount / skinCount) : 0;
    const glareFrac = skinCount ? (clippedCount / skinCount) : 0;

    let p50 = meanSkinY, p98 = meanSkinY;
    if (skinCount > 0) {
      let acc = 0, got50 = false;
      const t50 = skinCount * 0.50, t98 = skinCount * 0.98;
      for (let bIdx = 0; bIdx < 256; bIdx++) {
        acc += hist[bIdx];
        if (!got50 && acc >= t50) { p50 = bIdx; got50 = true; }
        if (acc >= t98) { p98 = bIdx; break; }
      }
    }

    let jawY = 0, jawCnt = 0;
    if (jawPatch.x1 > jawPatch.x0 && jawPatch.y1 > jawPatch.y0) {
      for (let y = jawPatch.y0; y < jawPatch.y1; y++) {
        const ro = y * cw;
        for (let x = jawPatch.x0; x < jawPatch.x1; x++) {
          jawY += Y[ro + x];
          jawCnt += 1;
        }
      }
    }
    const meanJawY = jawCnt ? (jawY / jawCnt) : meanSkinY;
    const flatShading = Math.abs(meanSkinY - meanJawY) <= 5.5;

    const moireHit = Boolean(
      skinCount >= 180 &&
      meanSkinY >= 45 &&
      (
        (moireRatio >= 0.92 && hfMean >= 6.8) ||
        (altFrac >= 0.30 && hfMean >= 6.2) ||
        (chromaHfMean >= 6.0 && moireRatio >= 0.78)
      )
    );

    const glareHit = Boolean(
      skinCount >= 180 &&
      meanSkinY >= 120 &&
      glareFrac >= 0.055 &&
      (p98 - p50) >= 65 &&
      (flatShading || glareFrac >= 0.11)
    );

    const rowY0 = Math.max(faceY0 + Math.round(faceH * 0.08), 2);
    const rowY1 = Math.min(faceY0 + Math.round(faceH * 0.92), ch - 3);
    const rLen = Math.max(0, rowY1 - rowY0);
    const midX = faceX0 + (faceW >> 1);
    let innerBandRms = 0;
    let outerBandRms = 0;
    let rowCorr = 0;
    let outerCols = 0;

    if (rLen >= 20 && faceW >= 24) {
      const leftMean = new Float32Array(rLen);
      const rightMean = new Float32Array(rLen);
      const innerMean = new Float32Array(rLen);
      const outerMean = new Float32Array(rLen);
      const xStart = Math.max(0, faceX0 + 2);
      const xEnd = Math.min(cw, faceX0 + faceW - 2);
      const leftOuterEnd = Math.max(0, faceX0 - 4);
      const rightOuterStart = Math.min(cw, faceX0 + faceW + 4);
      const hasOuterL = leftOuterEnd >= 8;
      const hasOuterR = (cw - rightOuterStart) >= 8;
      outerCols = (hasOuterL ? leftOuterEnd : 0) + (hasOuterR ? (cw - rightOuterStart) : 0);

      for (let ri = 0; ri < rLen; ri++) {
        const ro = (rowY0 + ri) * cw;
        let sl = 0, cl = 0, sr = 0, cr = 0;
        for (let x = xStart; x < xEnd; x++) {
          const valY = Y[ro + x];
          if (x < midX) { sl += valY; cl += 1; } else { sr += valY; cr += 1; }
        }
        leftMean[ri] = cl ? sl / cl : 0;
        rightMean[ri] = cr ? sr / cr : 0;
        innerMean[ri] = (cl + cr) ? (sl + sr) / (cl + cr) : 0;

        if (outerCols > 0) {
          let so = 0, co = 0;
          if (hasOuterL) {
            for (let x = 0; x < leftOuterEnd; x++) { so += Y[ro + x]; co += 1; }
          }
          if (hasOuterR) {
            for (let x = rightOuterStart; x < cw; x++) { so += Y[ro + x]; co += 1; }
          }
          outerMean[ri] = co ? so / co : 0;
        }
      }

      const hp = (arr, out) => {
        for (let i = 2; i < rLen - 2; i++) {
          const avg5 = 0.2 * (arr[i - 2] + arr[i - 1] + arr[i] + arr[i + 1] + arr[i + 2]);
          out[i] = arr[i] - avg5;
        }
      };
      const bL = new Float32Array(rLen);
      const bR = new Float32Array(rLen);
      const bI = new Float32Array(rLen);
      const bO = new Float32Array(rLen);
      hp(leftMean, bL); hp(rightMean, bR); hp(innerMean, bI);
      if (outerCols >= 10) hp(outerMean, bO);

      const eyeRowStart = faceY0 + Math.round(faceH * eyeBand.y0) - 3;
      const eyeRowEnd = faceY0 + Math.round(faceH * eyeBand.y1) + 3;
      let sumI2 = 0, sumO2 = 0, dotLR = 0, normL = 0, normR = 0;
      let validRows = 0;
      for (let i = 2; i < rLen - 2; i++) {
        const ry = rowY0 + i;
        if (ry >= eyeRowStart && ry <= eyeRowEnd) continue;
        validRows += 1;
        sumI2 += bI[i] * bI[i];
        dotLR += bL[i] * bR[i];
        normL += bL[i] * bL[i];
        normR += bR[i] * bR[i];
        if (outerCols >= 10) sumO2 += bO[i] * bO[i];
      }
      validRows = Math.max(1, validRows);
      innerBandRms = Math.sqrt(sumI2 / validRows);
      outerBandRms = outerCols >= 10 ? Math.sqrt(sumO2 / validRows) : 0;
      rowCorr = (normL > 1e-6 && normR > 1e-6) ? (dotLR / Math.sqrt(normL * normR)) : 0;
    }

    const pwmHit = Boolean(
      innerBandRms >= 3.0 &&
      rowCorr >= 0.45 &&
      (outerCols < 10 || innerBandRms >= 1.95 * (outerBandRms + 0.55))
    );

    const checkVerticalEdge = isLeft => {
      const stripLen = isLeft ? faceX0 : Math.max(0, cw - (faceX0 + faceW));
      if (stripLen < 6) return false;
      const posList = [];
      let edgeHits = 0;
      const totalScanRows = Math.max(1, rowY1 - rowY0);
      for (let y = rowY0; y < rowY1; y += 2) {
        const ro = y * cw;
        let bezelPos = -1;
        let minDark = 255;
        let innerBright = 0;
        if (isLeft) {
          for (let x = faceX0 + 4; x >= 2; x--) {
            const v = Y[ro + x];
            if (v > innerBright) innerBright = v;
            if (v < minDark) minDark = v;
            if (v <= 46 && (innerBright - v) >= 52 && Y[ro + x + 2] >= 105) {
              bezelPos = x;
              break;
            }
          }
        } else {
          for (let x = Math.max(0, faceX0 + faceW - 4); x < cw - 2; x++) {
            const v = Y[ro + x];
            if (v > innerBright) innerBright = v;
            if (v < minDark) minDark = v;
            if (v <= 46 && (innerBright - v) >= 52 && Y[ro + x - 2] >= 105) {
              bezelPos = x;
              break;
            }
          }
        }
        if (bezelPos >= 0) {
          edgeHits += 1;
          posList.push(bezelPos);
        }
      }
      if (posList.length < 8 || (edgeHits / Math.ceil(totalScanRows / 2)) < 0.62) return false;
      const meanPos = posList.reduce((a, b) => a + b, 0) / posList.length;
      const varPos = posList.reduce((a, b) => a + (b - meanPos) * (b - meanPos), 0) / posList.length;
      return Math.sqrt(varPos) <= 2.8;
    };

    const bezelHit = Boolean(checkVerticalEdge(true) && checkVerticalEdge(false));

    const reasons = [];
    let padScore = 0;
    if (moireHit) { reasons.push("moire_grid"); padScore += 0.75; }
    if (pwmHit) { reasons.push("pwm_banding"); padScore += 0.75; }
    if (bezelHit) { reasons.push("screen_bezel"); padScore += 0.70; }
    if (glareHit) { reasons.push("planar_glare"); padScore += 0.65; }
    const clampedScore = Math.min(1, padScore);

    return {
      evaluated: true,
      frameSpoof: clampedScore >= 0.65,
      score: Number(clampedScore.toFixed(3)),
      reasons,
      metrics: {
        meanSkinY: Number(meanSkinY.toFixed(1)),
        moireRatio: Number(moireRatio.toFixed(3)),
        hfMean: Number(hfMean.toFixed(2)),
        chromaHfMean: Number(chromaHfMean.toFixed(2)),
        altFrac: Number(altFrac.toFixed(3)),
        innerBandRms: Number(innerBandRms.toFixed(2)),
        outerBandRms: Number(outerBandRms.toFixed(2)),
        rowCorr: Number(rowCorr.toFixed(2)),
        glareFrac: Number(glareFrac.toFixed(3)),
        bezelHit,
      },
    };
  }

  function evaluatePassiveLiveness(hist, evalOpts = {}) {
    const mode = String((evalOpts && evalOpts.mode) || "blink_or_turn");
    const entries = Array.isArray(hist) ? hist.filter(Boolean) : [];
    if (!entries.length) {
      return { ok: false, method: "", blinkPassed: false, turnPassed: false, spoofSuspected: false, reason: "empty", spanMs: 0, frames: 0 };
    }

    const padEntries = entries.filter(e => e.padEvaluated).slice(-4);
    if (padEntries.length >= 2) {
      const spoofFrames = padEntries.filter(e => e.frameSpoof).length;
      const meanPadScore = padEntries.reduce((a, e) => a + Number(e.padScore || 0), 0) / padEntries.length;
      if (spoofFrames >= 2 || (padEntries.length >= 3 && meanPadScore >= 0.60)) {
        const padReasons = Array.from(new Set(padEntries.flatMap(e => e.padReasons || [])));
        return {
          ok: false,
          method: "",
          blinkPassed: false,
          turnPassed: false,
          spoofSuspected: true,
          reason: "pad_spoof",
          padReasons,
          spanMs: 0,
          frames: entries.length,
        };
      }
    }

    const activeModel = entries[entries.length - 1].landmarkModel || "";
    let modelStart = 0;
    if (activeModel) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].landmarkModel && entries[i].landmarkModel !== activeModel) {
          modelStart = i + 1;
          break;
        }
      }
    }
    let cleanHist = entries.slice(modelStart);

    for (let i = cleanHist.length - 1; i >= 0; i--) {
      if (cleanHist[i] && cleanHist[i].frameSpoof) {
        cleanHist = cleanHist.slice(i + 1);
        break;
      }
    }

    for (let i = 1; i < cleanHist.length; i++) {
      const prev = cleanHist[i - 1], cur = cleanHist[i];
      if (prev.boxW > 0 && cur.boxCx != null && prev.boxCx != null && cur.boxCy != null && prev.boxCy != null) {
        const jumpFrac = Math.hypot(cur.boxCx - prev.boxCx, cur.boxCy - prev.boxCy) / Math.max(24, prev.boxW);
        if (jumpFrac > 0.24) {
          cleanHist = cleanHist.slice(i);
          i = 0;
        }
      }
    }

    const spanMs = cleanHist.length >= 2
      ? Math.max(0, Number(cleanHist[cleanHist.length - 1].t || 0) - Number(cleanHist[0].t || 0))
      : 0;

    if (evalOpts && evalOpts.requireRealtimeCadence) {
      const minFrames = Math.max(3, Number(evalOpts.minFrames || 4));
      const minSpanMs = Math.max(250, Number(evalOpts.minSpanMs || 550));
      if (cleanHist.length < minFrames || spanMs < minSpanMs) {
        return {
          ok: false,
          method: "",
          blinkPassed: false,
          turnPassed: false,
          spoofSuspected: false,
          reason: "cadence_pending",
          spanMs,
          frames: cleanHist.length,
        };
      }
    }

    // Signal 1: Biomechanical Blink (strict interior Open -> Closed -> Open valley)
    const ears = cleanHist.map(h => h.ear).filter(v => typeof v === "number" && v > 0);
    let blinkPassed = false;
    if (ears.length >= 3) {
      let minIdx = 0;
      for (let i = 1; i < ears.length; i++) {
        if (ears[i] < ears[minIdx]) minIdx = i;
      }
      if (minIdx > 0 && minIdx < ears.length - 1) {
        const minEar = ears[minIdx];
        const maxBefore = Math.max(...ears.slice(0, minIdx));
        const maxAfter = Math.max(...ears.slice(minIdx + 1));
        const stdBlink = (maxBefore >= 0.238 && minEar <= 0.214 && maxAfter >= 0.236 && (maxBefore - minEar) >= 0.032 && (maxAfter - minEar) >= 0.024);
        const narrowEyeBlink = (maxBefore >= 0.195 && maxAfter >= 0.195 && (maxBefore - minEar) >= 0.030 && (maxAfter - minEar) >= 0.022 && (minEar / maxBefore) <= 0.86);
        blinkPassed = Boolean(stdBlink || narrowEyeBlink);
      }
    }

    // Signal 2: Positively-Coupled 3D Head-Turn / Nod Parallax + Non-Rigid Eyelid Variation
    const pairedPose = cleanHist.filter(h =>
      typeof h.yaw === "number" &&
      typeof h.parallax3d === "number" &&
      typeof h.ear === "number" && h.ear > 0
    );
    let turnPassed = false;
    let yawSpan = 0, parallaxSpan = 0, pitchSpan = 0, earSpan = 0, corrYawPar = 0;

    if (pairedPose.length >= 2) {
      const yaws = pairedPose.map(h => h.yaw);
      const pars = pairedPose.map(h => h.parallax3d);
      const earVals = pairedPose.map(h => h.ear);
      const pitches = pairedPose.map(h => h.pitch).filter(v => typeof v === "number");

      let minYIdx = 0, maxYIdx = 0;
      for (let i = 1; i < yaws.length; i++) {
        if (yaws[i] < yaws[minYIdx]) minYIdx = i;
        if (yaws[i] > yaws[maxYIdx]) maxYIdx = i;
      }
      yawSpan = yaws[maxYIdx] - yaws[minYIdx];
      parallaxSpan = Math.max(...pars) - Math.min(...pars);
      earSpan = Math.max(...earVals) - Math.min(...earVals);
      pitchSpan = pitches.length >= 2 ? (Math.max(...pitches) - Math.min(...pitches)) : 0;

      const meanY = yaws.reduce((a, b) => a + b, 0) / yaws.length;
      const meanP = pars.reduce((a, b) => a + b, 0) / pars.length;
      let cov = 0, varY = 0, varP = 0;
      for (let i = 0; i < yaws.length; i++) {
        const dy = yaws[i] - meanY;
        const dp = pars[i] - meanP;
        cov += dy * dp;
        varY += dy * dy;
        varP += dp * dp;
      }
      corrYawPar = (varY > 1e-8 && varP > 1e-8) ? (cov / Math.sqrt(varY * varP)) : 0;
      const dirDeltaPar = pars[maxYIdx] - pars[minYIdx];

      const horizontalTurnOk = (
        yawSpan >= 0.055 &&
        parallaxSpan >= 0.022 &&
        dirDeltaPar >= 0.018 &&
        corrYawPar >= 0.60 &&
        earSpan >= 0.012
      );

      const pairedPitch = pairedPose.filter(h => typeof h.pitch === "number" && typeof h.parallaxPitch3d === "number");
      let verticalNodOk = false;
      if (pairedPitch.length >= 2) {
        const vp = pairedPitch.map(h => h.pitch);
        const vpar = pairedPitch.map(h => h.parallaxPitch3d);
        let minPIdx = 0, maxPIdx = 0;
        for (let i = 1; i < vp.length; i++) {
          if (vp[i] < vp[minPIdx]) minPIdx = i;
          if (vp[i] > vp[maxPIdx]) maxPIdx = i;
        }
        pitchSpan = vp[maxPIdx] - vp[minPIdx];
        const parallaxPitchSpan = Math.max(...vpar) - Math.min(...vpar);
        const dirDeltaPitchPar = vpar[maxPIdx] - vpar[minPIdx];
        const meanVp = vp.reduce((a, b) => a + b, 0) / vp.length;
        const meanVpar = vpar.reduce((a, b) => a + b, 0) / vpar.length;
        let covV = 0, varVp = 0, varVpar = 0;
        for (let i = 0; i < vp.length; i++) {
          const dvp = vp[i] - meanVp;
          const dvpar = vpar[i] - meanVpar;
          covV += dvp * dvpar;
          varVp += dvp * dvp;
          varVpar += dvpar * dvpar;
        }
        const corrPitchPar = (varVp > 1e-8 && varVpar > 1e-8) ? (covV / Math.sqrt(varVp * varVpar)) : 0;
        verticalNodOk = (
          pitchSpan >= 0.030 &&
          parallaxPitchSpan >= 0.010 &&
          dirDeltaPitchPar >= 0.008 &&
          corrPitchPar >= 0.45 &&
          earSpan >= 0.025
        );
      }
      turnPassed = Boolean(horizontalTurnOk || verticalNodOk);
    }

    const ok = mode === "blink"
      ? blinkPassed
      : (mode === "turn3d" ? turnPassed : (blinkPassed || turnPassed));

    return {
      ok,
      method: blinkPassed ? (turnPassed ? "blink+turn3d" : "blink") : (turnPassed ? "turn3d" : ""),
      blinkPassed,
      turnPassed,
      spoofSuspected: false,
      yawSpan,
      parallaxSpan,
      earSpan,
      corrYawPar: Number(corrYawPar.toFixed(3)),
      spanMs,
      frames: cleanHist.length,
    };
  }

  function checkDescriptorStability(vecs, maxStepDist = 0.26) {
    if (!Array.isArray(vecs) || vecs.length < 2) return true;
    for (let i = 1; i < vecs.length; i++) {
      if (!isFiniteVec128(vecs[i - 1]) || !isFiniteVec128(vecs[i])) return false;
      if (safeEuclidean128(vecs[i - 1], vecs[i]) > maxStepDist) return false;
    }
    return true;
  }

  function averageDescriptors(vecs) {
    const valid = Array.isArray(vecs) ? vecs.filter(isFiniteVec128) : [];
    if (!valid.length) return null;
    if (valid.length === 1) return Array.from(valid[0], n => Number(Number(n).toFixed(5)));
    const out = new Array(128).fill(0);
    for (const v of valid) {
      for (let i = 0; i < 128; i++) out[i] += Number(v[i]) || 0;
    }
    for (let i = 0; i < 128; i++) out[i] = Number((out[i] / valid.length).toFixed(5));
    return out;
  }

  function isFiniteVec128(v) {
    if (!v || v.length !== 128) return false;
    for (let i = 0; i < 128; i++) {
      const n = Number(v[i]);
      if (v[i] === null || v[i] === "" || typeof v[i] === "boolean" || !Number.isFinite(n)) return false;
    }
    return true;
  }

  function safeEuclidean128(a, b) {
    if (!isFiniteVec128(a) || !isFiniteVec128(b)) return 99;
    let s = 0;
    for (let i = 0; i < 128; i++) {
      const d = Number(a[i]) - Number(b[i]);
      s += d * d;
    }
    const out = Math.sqrt(s);
    return Number.isFinite(out) ? out : 99;
  }

  // faces = [{staffId, d: number[]}] -> {staffId, distance, runnerUp: {staffId, distance}|null, margin}
  // best = nearest sample overall; runnerUp = nearest sample of a DIFFERENT person.
  function match(descriptor, faces) {
    if (!isFiniteVec128(descriptor) || !Array.isArray(faces)) return null;
    let best = null, second = null;
    for (const f of faces) {
      if (!f || !isFiniteVec128(f.d)) continue;
      const dist = safeEuclidean128(descriptor, f.d);
      if (!Number.isFinite(dist) || dist >= 99) continue;
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
    if (!m || !Number.isFinite(m.distance)) return { ok: false, reason: "no-enrolments" };
    if (!Number.isFinite(t) || m.distance > t) return { ok: false, reason: "far" };
    if (m.runnerUp && (!Number.isFinite(m.margin) || m.margin < M().margin)) return { ok: false, reason: "ambiguous" };
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
    load, detectOne, detectAll, landmarksOnly, match, decide, calibration,
    ear, pose, analyzePad, evaluatePassiveLiveness, checkDescriptorStability, averageDescriptors,
    get ready() { return ready; },
    get backend() { return backend; },
    get detector() { return detector; },
    get landmarks() { return landmarksTiny ? "68-tiny" : "68"; },
  };
})();
