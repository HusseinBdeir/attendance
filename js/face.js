// BHFIRMS Attendance kiosk — on-device face recognition (face-api.js)
// Models are served from ./vendor/models and cached by the service worker,
// so detection + matching work with no network at all.

const Face = (() => {
  let ready = false;
  let loading = null;
  let backend = "?";

  function opts() {
    return new faceapi.TinyFaceDetectorOptions({
      inputSize: ATT_CONFIG.match.detectorInputSize,
      scoreThreshold: ATT_CONFIG.match.detectorScore,
    });
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
      await faceapi.nets.tinyFaceDetector.loadFromUri(base);
      await faceapi.nets.faceLandmark68TinyNet.loadFromUri(base);
      await faceapi.nets.faceRecognitionNet.loadFromUri(base);
      ready = true;
    })();
    return loading;
  }

  // One face (the largest) -> {descriptor: Float32Array(128), box, score} | null
  async function detectOne(src) {
    if (!ready) return null;
    const r = await faceapi.detectSingleFace(src, opts()).withFaceLandmarks(true).withFaceDescriptor();
    if (!r) return null;
    return { descriptor: r.descriptor, box: r.detection.box, score: r.detection.score };
  }

  // All faces (enrolment preview / tests)
  async function detectAll(src) {
    if (!ready) return [];
    const rs = await faceapi.detectAllFaces(src, opts()).withFaceLandmarks(true).withFaceDescriptors();
    return rs.map(r => ({ descriptor: r.descriptor, box: r.detection.box, score: r.detection.score }));
  }

  // faces = [{staffId, d: number[]}] -> {staffId, distance} (best) | null
  function match(descriptor, faces) {
    let best = null;
    for (const f of faces) {
      const dist = faceapi.euclideanDistance(descriptor, f.d);
      if (!best || dist < best.distance) best = { staffId: f.staffId, distance: dist };
    }
    return best;
  }

  return {
    load, detectOne, detectAll, match,
    get ready() { return ready; },
    get backend() { return backend; },
  };
})();
