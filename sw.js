// BHFIRMS Attendance kiosk — service worker (v0.3.4): cache-first app shell + models,
// Web Push + Home Screen Badging API (navigator.setAppBadge) + shared unread notification cache.
// Bump CACHE AND the ?v= strings in index.html on every deploy (they must match — see PWA.md).
const CACHE = "bhfatt-v0.3.4";
const NOTIF_CACHE = "bhfatt-notif-v1";
const UNREAD_NOTIFS_URL = "./__att_unread_notifs.json";
const SHELL = [
  "./",
  "./index.html",
  "./css/att.css?v=0.3.4",
  "./js/config.js?v=0.3.4",
  "./js/db.js?v=0.3.4",
  "./js/face.js?v=0.3.4",
  "./js/sync.js?v=0.3.4",
  "./js/app.js?v=0.3.4",
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

function applySwAppBadge(count) {
  const n = Math.max(0, Number(count) || 0);
  try {
    if (self.navigator && typeof self.navigator.setAppBadge === "function" && typeof self.navigator.clearAppBadge === "function") {
      return n > 0 ? self.navigator.setAppBadge(n).catch(() => {}) : self.navigator.clearAppBadge().catch(() => {});
    }
  } catch (e) {}
  return Promise.resolve();
}

async function readUnreadNotifsFromCache() {
  try {
    const c = await caches.open(NOTIF_CACHE);
    const res = await c.match(UNREAD_NOTIFS_URL);
    if (!res) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function writeUnreadNotifsToCache(items) {
  try {
    const clean = (Array.isArray(items) ? items : []).slice(0, 60);
    const c = await caches.open(NOTIF_CACHE);
    await c.put(UNREAD_NOTIFS_URL, new Response(JSON.stringify(clean), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    }));
    const unread = clean.filter(x => x && !x.checked).length;
    await applySwAppBadge(unread);
    return clean;
  } catch (e) {
    return [];
  }
}

async function upsertSwUnreadNotif(item) {
  const list = await readUnreadNotifsFromCache();
  const id = String((item && (item.id || item.tag)) || ("att-" + Date.now()));
  const idx = list.findIndex(x => x && (x.id === id || (item.tag && x.tag === item.tag)));
  const entry = Object.assign({ id, ts: Date.now(), checked: false }, item || {}, { id, checked: false });
  if (idx >= 0) list[idx] = entry;
  else list.unshift(entry);
  return writeUnreadNotifsToCache(list);
}

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== NOTIF_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;               // API POSTs go straight to the network
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;      // never cache the API host
  if (url.pathname.endsWith("__att_unread_notifs.json")) return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }))
  );
});

function buildNotifOptions(d) {
  const notifId = String(d.id || d.tag || ("att-notif-" + Date.now()));
  return {
    body: d.body || "Tap to open BHFIRMS Attendance.",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: d.tag || notifId,
    renotify: true,
    data: { url: d.url || "./", notifId }
  };
}

self.addEventListener("push", e => {
  let d = {};
  if (e.data) {
    try { d = e.data.json(); }
    catch (err) { try { d = { title: "BHFIRMS Attendance", body: e.data.text() }; } catch (x) {} }
  }
  const title = d.title || "BHFIRMS Attendance";
  const opts = buildNotifOptions(d);
  const entry = { id: opts.data.notifId, tag: opts.tag, title, body: opts.body, ts: Date.now(), checked: false };
  e.waitUntil(
    Promise.all([
      upsertSwUnreadNotif(entry),
      self.registration.showNotification(title, opts),
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
        list.forEach(c => { try { c.postMessage({ type: "att-push", payload: entry }); } catch (x) {} });
      }).catch(() => {})
    ])
  );
});

self.addEventListener("message", e => {
  const m = e.data;
  if (!m) return;
  if (m.type === "sync-unread-notifs") {
    e.waitUntil(writeUnreadNotifsToCache(m.items || []));
    return;
  }
  if (m.type === "set-app-badge") {
    e.waitUntil(applySwAppBadge(m.count || 0));
    return;
  }
  if (m.type === "show-notification") {
    const d = m.payload || {};
    const title = d.title || "BHFIRMS Attendance";
    const opts = buildNotifOptions(d);
    const entry = { id: opts.data.notifId, tag: opts.tag, title, body: opts.body, ts: Date.now(), checked: false };
    e.waitUntil(
      Promise.all([
        upsertSwUnreadNotif(entry),
        self.registration.showNotification(title, opts)
      ])
    );
  }
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const data = (e.notification && e.notification.data) || {};
  const notifId = data.notifId || (e.notification && e.notification.tag) || "";
  e.waitUntil(
    (async () => {
      if (notifId) {
        const list = await readUnreadNotifsFromCache();
        list.forEach(x => { if (x && (x.id === notifId || x.tag === notifId)) x.checked = true; });
        await writeUnreadNotifsToCache(list);
      }
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of list) {
        if ("focus" in c) {
          try { c.postMessage({ type: "att-notif-clicked", notifCheckedId: notifId }); } catch (x) {}
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(data.url || "./");
    })()
  );
});
