// BHFIRMS Attendance kiosk — service worker: cache-first app shell + models,
// so the tablet works fully offline. Bump CACHE AND the ?v= strings in
// index.html on every deploy (they must match — see POS.md, same lesson).
const CACHE = "bhfatt-v0.3.3";
const SHELL = [
  "./",
  "./index.html",
  "./css/att.css?v=0.3.3",
  "./js/config.js?v=0.3.3",
  "./js/db.js?v=0.3.3",
  "./js/face.js?v=0.3.3",
  "./js/sync.js?v=0.3.3",
  "./js/app.js?v=0.3.3",
  "./vendor/face-api.js",
  "./vendor/models/tiny_face_detector_model-weights_manifest.json",
  "./vendor/models/tiny_face_detector_model.bin",
  "./vendor/models/ssd_mobilenetv1_model-weights_manifest.json",
  "./vendor/models/ssd_mobilenetv1_model.bin",
  "./vendor/models/face_landmark_68_model-weights_manifest.json",
  "./vendor/models/face_landmark_68_model.bin",
  "./vendor/models/face_landmark_68_tiny_model-weights_manifest.json",
  "./vendor/models/face_landmark_68_tiny_model.bin",
  "./vendor/models/face_recognition_model-weights_manifest.json",
  "./vendor/models/face_recognition_model.bin",
  "./brand/isabi-header.svg",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;               // API POSTs go straight to the network
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;      // never cache the API host
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }))
  );
});
