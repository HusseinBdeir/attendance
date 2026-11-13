// BHFIRMS Attendance kiosk — app logic
// Kiosk loop: camera frame -> face descriptor -> match against local
// enrolments (nearest sample + runner-up margin) -> optional blink check ->
// punch (IN/OUT auto-toggled) -> confirmation card.
// Everything is local-first; sync.js pushes when the tablet is online.

(() => {
  const $ = id => document.getElementById(id);
  const C = ATT_CONFIG;

  const state = {
    site: C.defaultSite,
    device: "",
    threshold: C.match.threshold,   // per-device override lives in meta "threshold"
    liveness: C.liveness.enabled,   // per-device override lives in meta "liveness"
    redactedMode: false,            // per-device override lives in meta "redactedMode"
    sound: true,                    // per-device override lives in meta "sound"
    faces: [],            // [{id, staffId, d}] in memory for matching
    redactedFaceCounts: new Map(), // staffId -> sample count when vectors are scrubbed
    redactedStreak: [],   // consecutive descriptors stabilized before server 1:N verify
    verifyingRedacted: false,
    staff: new Map(),     // id -> {id, name, officialName, pinhash, active}
    stream: null,
    running: false,
    busy: false,          // card up / keypad open / manager open -> detection paused
    streak: { staffId: null, n: 0, dist: [], vecs: [] },
    unknown: 0,
    live: null,           // reserved test/legacy state (passive liveness uses livenessHist)
    livenessHist: [],     // passive biometric liveness & PAD sliding window
    livenessWaitStart: 0, // timestamp when stabilized match began waiting on passive liveness
    lastDescVec: null,    // previous descriptor for cross-frame identity continuity
    liveMock: null,       // tests can override ear/pose in recordLivenessFrame
    frameSource: null,    // tests inject an <img>/<canvas> instead of the camera
    lastPunchAt: new Map(),
    cardTimer: null,
    cardPunch: null,
    mgrOpen: false,
    enrol: { staffId: null, samples: [], pin: null },
    enFilter: "all",
    stFilter: "all",
    logFilter: "all",
    testing: false,       // "Test recognition" loop in the Enrol tab
    manualStaff: null,
    wake: null,
    defaultPin: true,     // manager PIN still the factory default
    notifs: [],           // custom/push notifications
    checkedNotifs: {},    // checked notification IDs
    lastBadgeCount: 0,
  };

  // ---------- helpers ----------
  const pad = n => String(n).padStart(2, "0");
  function nowLocal() {
    const d = new Date();
    return {
      ts: d.toISOString(),
      day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      sec: `:${pad(d.getSeconds())}`,
      dateStr: d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
      tzOffsetMin: -d.getTimezoneOffset(),
    };
  }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
  async function sha256(s) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  const fmtTime = iso => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const r3 = v => Math.round(v * 1000) / 1000;
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const initials = name => String(name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "?";

  let toastT = null;
  function toast(msg, bad, ms) {
    const t = $("toast"); t.textContent = msg; t.className = "toast on" + (bad ? " bad" : "");
    clearTimeout(toastT); toastT = setTimeout(() => t.className = "toast", ms || 2600);
  }
  function hint(msg, warn, mode) {
    const h = $("hint");
    h.textContent = msg;
    h.className = "hint" + (warn ? " warn" : "") + (mode ? " " + mode : "");
  }
  function setStreakProgress(frac) {
    const bar = $("streakBar"), fill = $("streakFill");
    if (!bar || !fill) return;
    if (!frac || frac <= 0) { bar.classList.remove("on"); fill.style.width = "0%"; }
    else { bar.classList.add("on"); fill.style.width = `${Math.min(100, Math.round(frac * 100))}%`; }
  }

  // ---------- synthesized Web Audio feedback (zero external files, 100% offline) ----------
  const Sound = (() => {
    let ctx = null;
    function getCtx() {
      if (navigator.webdriver || !state.sound) return null;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!ctx) ctx = new AC();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return ctx;
    }
    function tone(freq, dur, delay, type, gainVal) {
      try {
        const c = getCtx(); if (!c) return;
        const t0 = c.currentTime + (delay || 0);
        const osc = c.createOscillator(), g = c.createGain();
        osc.type = type || "sine";
        osc.frequency.setValueAtTime(freq, t0);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(gainVal || 0.12, t0 + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g); g.connect(c.destination);
        osc.start(t0); osc.stop(t0 + dur + 0.02);
      } catch (e) { /* audio blocked or unsupported */ }
    }
    return {
      play(kind) {
        if (!state.sound || navigator.webdriver) return;
        if (kind === "in") { tone(587.33, 0.14, 0, "sine", 0.14); tone(880, 0.24, 0.11, "triangle", 0.16); }
        else if (kind === "out") { tone(783.99, 0.14, 0, "sine", 0.13); tone(523.25, 0.24, 0.11, "triangle", 0.14); }
        else if (kind === "warn") { tone(349.23, 0.12, 0, "triangle", 0.12); tone(311.13, 0.18, 0.13, "triangle", 0.12); }
        else if (kind === "capture") { tone(1046.5, 0.09, 0, "sine", 0.1); }
        else if (kind === "tap") { tone(660, 0.035, 0, "sine", 0.05); }
      }
    };
  })();

  function updateSoundUi() {
    if ($("icoSoundOn")) $("icoSoundOn").hidden = !state.sound;
    if ($("icoSoundOff")) $("icoSoundOff").hidden = !!state.sound;
    if ($("setSound")) $("setSound").checked = !!state.sound;
  }
  if ($("btnSound")) {
    $("btnSound").addEventListener("click", async () => {
      state.sound = !state.sound;
      await DBX.setMeta("sound", state.sound);
      updateSoundUi();
      if (state.sound) Sound.play("tap");
      toast(state.sound ? "Sound effects enabled" : "Sound effects muted");
    });
  }

  function snapshot(src) {
    const cv = $("snap");
    const w = C.punch.snapshotWidth;
    const sw = src.videoWidth || src.naturalWidth || src.width || 320;
    const sh = src.videoHeight || src.naturalHeight || src.height || 240;
    if (!sw || !sh) return "";
    cv.width = w; cv.height = Math.round(w * sh / sw);
    try {
      cv.getContext("2d").drawImage(src, 0, 0, cv.width, cv.height);
      return cv.toDataURL("image/jpeg", C.punch.snapshotQuality);
    } catch (e) { return ""; }
  }

  // ---------- face frame overlay (biometric HUD reticle) ----------
  // The video is object-fit: cover and mirrored by CSS; the canvas gets the same
  // mirror, so boxes are drawn in video coordinates mapped through the cover scale.
  function drawOverlay(det, status) {
    const cv = $("overlay"), video = $("video"), wrap = cv.parentElement;
    const cw = wrap.clientWidth, ch = wrap.clientHeight;
    if (!cw || !ch) return;
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    const g = cv.getContext("2d");
    g.clearRect(0, 0, cw, ch);
    if (!det || !det.box || state.frameSource) return;
    const vw = video.videoWidth || cw, vh = video.videoHeight || ch;
    const s = Math.max(cw / vw, ch / vh);
    const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
    const b = det.box;
    const x = b.x * s + ox, y = b.y * s + oy, w = b.width * s, h = b.height * s;
    const col = { ok: "#22c55e", live: "#38bdf8", warn: "#f59e0b", unknown: "#f59e0b", far: "#94a3b8", scan: "#d4af37" }[status] || "#d4af37";
    const L = Math.min(w, h) * 0.22;

    g.save();
    // Subtle frame outline
    g.strokeStyle = col + "33";
    g.lineWidth = 1.5;
    g.strokeRect(x, y, w, h);

    // Glowing corner brackets
    g.shadowColor = col;
    g.shadowBlur = 12;
    g.lineWidth = 4;
    g.strokeStyle = col;
    g.lineCap = "round";
    const corner = (cx, cy, dx, dy) => {
      g.beginPath();
      g.moveTo(cx + dx * L, cy);
      g.lineTo(cx, cy);
      g.lineTo(cx, cy + dy * L);
      g.stroke();
    };
    corner(x, y, 1, 1);
    corner(x + w, y, -1, 1);
    corner(x, y + h, 1, -1);
    corner(x + w, y + h, -1, -1);

    // Midpoint reticle ticks
    g.shadowBlur = 0;
    g.lineWidth = 2;
    const tick = 6;
    g.beginPath();
    g.moveTo(x + w / 2, y - tick / 2); g.lineTo(x + w / 2, y + tick / 2);
    g.moveTo(x + w / 2, y + h - tick / 2); g.lineTo(x + w / 2, y + h + tick / 2);
    g.moveTo(x - tick / 2, y + h / 2); g.lineTo(x + tick / 2, y + h / 2);
    g.moveTo(x + w - tick / 2, y + h / 2); g.lineTo(x + w + tick / 2, y + h / 2);
    g.stroke();
    g.restore();
  }

  // ---------- keypad (with live lockout countdown & keyboard support) ----------
  const Keypad = (() => {
    let buf = "", cb = null, len = C.pinLength, fails = 0, lockedUntil = 0, title = "", lockTimer = null, verifying = false, shakeTimer = null;
    const locked = () => Date.now() < lockedUntil;
    const remaining = () => Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
    function render(forceFilledCount) {
      const filled = typeof forceFilledCount === "number" ? forceFilledCount : buf.length;
      $("kpDots").innerHTML = Array.from({ length: len }, (_, i) => `<i class="${i < filled ? "on" : ""}"></i>`).join("");
      $("kpTitle").textContent = locked() ? `Too many attempts — wait ${remaining()} s` : title;
      if ($("kpSub")) {
        $("kpSub").textContent = locked()
          ? "Keypad temporarily locked for security"
          : (title.toLowerCase().includes("manager") ? "Enter 4-digit administrator PIN" : "Enter 4-digit security PIN");
      }
    }
    function startLockTicker() {
      clearInterval(lockTimer);
      lockTimer = setInterval(() => {
        if (!locked()) { clearInterval(lockTimer); lockTimer = null; }
        if ($("keypad").classList.contains("open")) render();
      }, 500);
    }
    function open(t, onDone, length) {
      clearTimeout(shakeTimer); shakeTimer = null;
      verifying = false;
      buf = ""; cb = onDone; len = length || C.pinLength; title = t;
      $("kpDots").classList.remove("shake");
      render();
      $("keypad").classList.add("open");
      state.busy = true;
    }
    function close() {
      clearTimeout(shakeTimer); shakeTimer = null;
      verifying = false;
      $("kpDots").classList.remove("shake");
      $("keypad").classList.remove("open");
      buf = ""; cb = null;
      // The kiosk loop stays paused while the manager is open (a PIN typed there must not free it).
      if (!state.mgrOpen) state.busy = false;
    }
    function shake() {
      Sound.play("warn");
      buf = "";
      render(len);
      const d = $("kpDots"); d.classList.add("shake");
      clearTimeout(shakeTimer);
      shakeTimer = setTimeout(() => { shakeTimer = null; d.classList.remove("shake"); render(); }, 450);
    }
    async function pressKey(k) {
      if (k === "x") { const c = cb; close(); if (c) c(null); return; }
      if (verifying) return;
      if (shakeTimer) { clearTimeout(shakeTimer); shakeTimer = null; $("kpDots").classList.remove("shake"); }
      if (locked()) { buf = ""; render(); return; }
      if (k === "b") { buf = buf.slice(0, -1); Sound.play("tap"); render(); return; }
      if (buf.length >= len) return;
      Sound.play("tap");
      buf += k; render();
      if (buf.length === len) {
        const pin = buf;
        buf = "";
        const c = cb;
        verifying = true;
        try {
          const ok = c ? await c(pin) : false;
          if (ok === false) {
            fails++;
            if (fails >= C.pinLockAfter) {
              lockedUntil = Date.now() + C.pinLockSec * 1000;
              fails = 0;
              startLockTicker();
            }
            shake();
          } else { fails = 0; close(); }
        } finally {
          verifying = false;
        }
      }
    }
    $("keypad").querySelectorAll("button").forEach(b => b.addEventListener("click", () => pressKey(b.dataset.k)));
    document.addEventListener("keydown", e => {
      if (!$("keypad").classList.contains("open")) return;
      if (e.key >= "0" && e.key <= "9") { e.preventDefault(); pressKey(e.key); }
      else if (e.key === "Backspace") { e.preventDefault(); pressKey("b"); }
      else if (e.key === "Escape") { e.preventDefault(); pressKey("x"); }
    });
    return {
      open, close, shake,
      get isOpen() { return $("keypad").classList.contains("open"); },
      get locked() { return locked(); },
      unlock() { lockedUntil = 0; fails = 0; clearInterval(lockTimer); render(); },
    };
  })();

  // ---------- data ----------
  async function loadData() {
    state.site = await DBX.getMeta("site", C.defaultSite);
    state.device = await DBX.getMeta("device", "");
    const t = parseFloat(await DBX.getMeta("threshold", ""));
    state.threshold = (t > 0 && t < 1) ? t : C.match.threshold;
    const lv = await DBX.getMeta("liveness", null);
    state.liveness = lv == null ? C.liveness.enabled : !!lv;
    state.redactedMode = !!(await DBX.getMeta("redactedMode", false));
    const snd = await DBX.getMeta("sound", null);
    state.sound = snd == null ? true : !!snd;
    state.defaultPin = !(await DBX.getMeta("mgrPinHash", ""));
    const staff = await DBX.allStaff();
    state.staff = new Map(staff.map(s => [s.id, s]));
    const allFaceRows = await DBX.allFaces();
    state.faces = allFaceRows.filter(f => Array.isArray(f.d) && f.d.length === 128);
    const redCounts = new Map();
    allFaceRows.forEach(f => {
      if (f && f.staffId && (f.faceRedacted || (Array.isArray(f.d) && f.d.length === 128))) {
        redCounts.set(f.staffId, (redCounts.get(f.staffId) || 0) + 1);
      }
    });
    staff.forEach(s => {
      if (s && typeof s.serverSamples === "number" && s.serverSamples > (redCounts.get(s.id) || 0)) {
        redCounts.set(s.id, s.serverSamples);
      }
    });
    state.redactedFaceCounts = redCounts;
    const siteLabel = (C.sites[state.site] || {}).name || state.site;
    $("siteName").textContent = siteLabel;
    if ($("mgrSiteBadge")) $("mgrSiteBadge").textContent = siteLabel;
    if ($("kioskDevice")) $("kioskDevice").textContent = state.device || "";
    if ($("mgrPinBanner")) $("mgrPinBanner").hidden = !state.defaultPin;
    updateSoundUi();
    await updateKioskHud();
  }
  function hasStaffPin(s) {
    return !!(s && (s.pinhash || (state.redactedMode && (s.hasPin || s.pinRedacted))));
  }
  function usableFaces() {
    // only staff with >= minSamples samples and an active roster entry
    const count = new Map();
    state.faces.forEach(f => count.set(f.staffId, (count.get(f.staffId) || 0) + 1));
    return state.faces.filter(f => count.get(f.staffId) >= C.match.minSamples && (state.staff.get(f.staffId) || {}).active !== false);
  }
  function enrolledStaffCount() {
    const active = [...state.staff.values()].filter(s => s.active !== false);
    return active.filter(s => sampleCount(s.id) >= C.match.minSamples).length;
  }
  const staffNames = () => new Map([...state.staff.values()].map(s => [s.id, s.name]));


  // ---------- Home Screen & Top-Right Notification Count Badge (v0.3.4) ----------
  function loadCheckedNotifs() {
    try {
      const raw = localStorage.getItem("bhfatt_checked_notifs");
      if (raw) state.checkedNotifs = JSON.parse(raw) || {};
      const rawN = localStorage.getItem("bhfatt_custom_notifs");
      if (rawN) state.notifs = JSON.parse(rawN) || [];
    } catch (e) {}
  }
  function saveCheckedNotifs() {
    try {
      localStorage.setItem("bhfatt_checked_notifs", JSON.stringify(state.checkedNotifs || {}));
      localStorage.setItem("bhfatt_custom_notifs", JSON.stringify((state.notifs || []).slice(0, 40)));
    } catch (e) {}
  }
  loadCheckedNotifs();

  async function computeAttendanceNotifs() {
    const items = [];
    const chk = state.checkedNotifs || {};
    try {
      const pending = await DBX.unsyncedCount();
      const l = Sync.last || {};
      if (pending > 0) {
        const id = "att-sync-" + pending + (l.ok === false ? "-err" : "");
        items.push({
          id,
          tag: "att-sync",
          title: `${pending} Punch${pending === 1 ? "" : "es"} Pending Cloud Sync`,
          body: l.ok === false ? `Last sync error: ${l.msg || "offline"}` : "Queued locally on tablet — syncs automatically when online.",
          action: "sync",
          ts: Date.now(),
          checked: !!chk[id],
        });
      }
      const activeStaff = [...state.staff.values()].filter(s => s.active !== false);
      const missing = activeStaff.filter(s => sampleCount(s.id) < C.match.minSamples && !hasStaffPin(s)).length;
      if (missing > 0) {
        const id = "att-missing-" + missing;
        items.push({
          id,
          tag: "att-missing",
          title: `${missing} Active Staff Need Face ID or PIN`,
          body: "Open Manager → Enrol to capture 3 Face ID poses or set a 4-digit PIN.",
          action: "mgr",
          ts: Date.now(),
          checked: !!chk[id],
        });
      }
      if (state.defaultPin) {
        const id = "att-default-pin";
        items.push({
          id,
          tag: "att-pin",
          title: "Security Notice: Default Manager PIN (9999)",
          body: "Change the factory manager PIN in Manager → Settings.",
          action: "mgr",
          ts: Date.now(),
          checked: !!chk[id],
        });
      }
    } catch (e) {}
    (state.notifs || []).forEach(n => {
      if (n && n.id) {
        items.push(Object.assign({}, n, { checked: !!(n.checked || chk[n.id]) }));
      }
    });
    return items;
  }

  async function updateAttendanceAppBadge() {
    const items = await computeAttendanceNotifs();
    const unread = items.filter(x => !x.checked).length;
    state.lastBadgeCount = unread;
    const text = unread > 99 ? "99+" : String(unread);
    ["notifCountBadge", "mgrCountBadge"].forEach(id => {
      const el = $(id);
      if (el) {
        el.hidden = unread <= 0;
        el.textContent = text;
      }
    });
    if ($("btnNotif")) {
      $("btnNotif").title = unread > 0 ? `${unread} unread alert${unread === 1 ? "" : "s"}` : "Notifications & Kiosk Alerts";
    }
    try {
      if (typeof navigator !== "undefined") {
        if (unread > 0 && typeof navigator.setAppBadge === "function") await navigator.setAppBadge(unread).catch(() => {});
        else if (unread <= 0 && typeof navigator.clearAppBadge === "function") await navigator.clearAppBadge().catch(() => {});
      }
    } catch (e) {}
    try {
      if (typeof navigator !== "undefined" && navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: "sync-unread-notifs", items });
      }
    } catch (e) {}
    return unread;
  }

  async function renderNotifSheet() {
    const sheet = $("notifSheet"), listEl = $("notifList");
    if (!sheet || !listEl) return;
    const items = await computeAttendanceNotifs();
    const unread = items.filter(x => !x.checked).length;
    if ($("notifSheetSub")) {
      $("notifSheetSub").textContent = unread > 0
        ? `${unread} unchecked item${unread === 1 ? "" : "s"} shown on the Home Screen badge`
        : "All caught up — Home Screen badge is clear";
    }
    listEl.innerHTML = items.length ? items.map(it => `
      <div class="notifItem${it.checked ? " checked" : ""}" data-nid="${esc(it.id)}">
        <div style="flex:1;min-width:0">
          <div class="notifItemTitle">${esc(it.title)}</div>
          <div class="notifItemBody">${esc(it.body || "")}</div>
        </div>
        ${it.checked
          ? `<span class="tag ok">&#10003; Checked</span>`
          : `<button class="btn small" type="button" data-ncheck="${esc(it.id)}">&#10003; Check</button>`}
      </div>
    `).join("") : `<div class="muted" style="padding:12px 4px">No active alerts or notifications.</div>`;
    listEl.querySelectorAll("button[data-ncheck]").forEach(btn => {
      btn.addEventListener("click", async () => {
        await markAttNotifChecked(btn.dataset.ncheck);
      });
    });
  }

  async function markAttNotifChecked(id) {
    if (!id) return 0;
    state.checkedNotifs = state.checkedNotifs || {};
    state.checkedNotifs[id] = Date.now();
    (state.notifs || []).forEach(n => { if (n && (n.id === id || n.tag === id)) n.checked = true; });
    saveCheckedNotifs();
    const cnt = await updateAttendanceAppBadge();
    if ($("notifSheet") && $("notifSheet").classList.contains("open")) await renderNotifSheet();
    return cnt;
  }

  async function markAllAttNotifsChecked() {
    const items = await computeAttendanceNotifs();
    state.checkedNotifs = state.checkedNotifs || {};
    items.forEach(it => { if (it && it.id) state.checkedNotifs[it.id] = Date.now(); });
    (state.notifs || []).forEach(n => { if (n) n.checked = true; });
    saveCheckedNotifs();
    const cnt = await updateAttendanceAppBadge();
    if ($("notifSheet") && $("notifSheet").classList.contains("open")) await renderNotifSheet();
    return cnt;
  }

  async function pushAttNotif(item) {
    if (!item || !item.title) return 0;
    const id = String(item.id || item.tag || ("att-" + Date.now()));
    if (state.checkedNotifs) delete state.checkedNotifs[id];
    const entry = { id, tag: item.tag || id, title: String(item.title), body: String(item.body || ""), ts: Date.now(), checked: false };
    state.notifs = (state.notifs || []).filter(x => x && x.id !== id);
    state.notifs.unshift(entry);
    saveCheckedNotifs();
    const cnt = await updateAttendanceAppBadge();
    if ($("notifSheet") && $("notifSheet").classList.contains("open")) await renderNotifSheet();
    return cnt;
  }

  if ($("btnNotif")) {
    $("btnNotif").addEventListener("click", async () => {
      await renderNotifSheet();
      $("notifSheet").classList.add("open");
    });
  }
  if ($("notifCloseBtn")) $("notifCloseBtn").addEventListener("click", () => $("notifSheet").classList.remove("open"));
  if ($("notifSheet")) $("notifSheet").addEventListener("click", e => { if (e.target === $("notifSheet")) $("notifSheet").classList.remove("open"); });
  if ($("notifCheckAllBtn")) $("notifCheckAllBtn").addEventListener("click", () => markAllAttNotifsChecked());
  if ($("notifSyncBtn")) $("notifSyncBtn").addEventListener("click", async () => {
    toast("Syncing with server…");
    const r = await Sync.run("manual");
    toast(r.msg, r.ok === false);
    await updateAttendanceAppBadge();
    await renderNotifSheet();
  });

  // Live HUD counters on kiosk & manager tabs
  async function updateKioskHud() {
    try {
      const todayRows = (await DBX.punchesForDay(nowLocal().day)).filter(p => !p.void);
      const latestByStaff = new Map();
      (await recentPunches()).forEach(p => latestByStaff.set(p.staffId, p));
      let onSite = 0;
      const win = C.punch.shiftMaxHours * 3600000;
      latestByStaff.forEach(p => { if (p.direction === "in" && Date.now() - new Date(p.ts).getTime() <= win) onSite++; });
      if ($("onSiteCount")) $("onSiteCount").textContent = `${onSite} on-site`;

      const enrolledPersons = enrolledStaffCount();
      const activeTotal = [...state.staff.values()].filter(s => s.active !== false).length;
      if ($("kioskStats")) {
        const redTag = state.redactedMode ? " · Redacted 1:N" : "";
        $("kioskStats").textContent = activeTotal
          ? `${enrolledPersons} / ${activeTotal} Face IDs Ready${redTag} · ${todayRows.length} events today`
          : `Face ID & PIN Ready${redTag}`;
      }
      if ($("tabStaffBadge")) {
        const missing = [...state.staff.values()].filter(s => s.active !== false && sampleCount(s.id) < C.match.minSamples && !hasStaffPin(s)).length;
        $("tabStaffBadge").textContent = String(missing);
        $("tabStaffBadge").hidden = missing === 0;
      }
      await updateAttendanceAppBadge();
    } catch (e) { /* ignore during early boot */ }
  }

  // ---------- punching ----------
  // Yesterday + today, oldest first: a night shift clocks IN before midnight and OUT after it.
  async function recentPunches() {
    const n = nowLocal();
    const y = new Date(); y.setDate(y.getDate() - 1);
    const yday = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;
    const rows = (await DBX.punchesForDays([yday, n.day])).filter(p => !p.void);
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return rows;
  }
  // The person's last punch if it is recent enough to still belong to the same shift
  // (C.punch.shiftMaxHours); older punches do not flip the direction — a new day starts with IN.
  async function lastPunchRecent(staffId) {
    const rows = (await recentPunches()).filter(p => p.staffId === staffId);
    const last = rows[rows.length - 1] || null;
    if (!last) return null;
    return (Date.now() - new Date(last.ts).getTime()) <= C.punch.shiftMaxHours * 3600000 ? last : null;
  }

  async function punch(staffId, method, confidence, src, forcedDirection, note) {
    const st = state.staff.get(staffId);
    if (!st) { toast("Unknown staff id", true); return null; }
    if (!forcedDirection && st.active === false) { toast("Staff account is inactive", true); return null; }
    const n = nowLocal();
    const last = await lastPunchRecent(staffId);
    if (!forcedDirection && last && (Date.now() - new Date(last.ts).getTime()) < C.punch.debounceMinutes * 60000) {
      showCard(st, last, true);
      return null;
    }
    const direction = forcedDirection || (last && last.direction === "in" ? "out" : "in");
    const p = {
      id: uuid(), staffId, staffName: st.name, ts: n.ts, day: n.day, tzOffsetMin: n.tzOffsetMin,
      direction, method, confidence: confidence == null ? null : r3(confidence),
      snapshot: src ? snapshot(src) : "", site: state.site, synced: 0, rev: 0, note: note || "",
    };
    await DBX.savePunch(p);
    state.lastPunchAt.set(staffId, Date.now());
    showCard(st, p, false);
    updateSyncDot();
    updateKioskHud();
    Sync.run("punch").catch(() => {});
    return p;
  }

  function showCard(st, p, already) {
    const card = $("card");
    state.cardPunch = already ? null : p;
    $("cardImg").src = p.snapshot || "icon.svg";
    $("cardName").textContent = st.name;
    if ($("cardSub")) $("cardSub").textContent = (st.officialName && st.officialName !== st.name) ? st.officialName : "";
    const dir = p.direction.toUpperCase();
    if ($("cardBadge")) $("cardBadge").textContent = already ? "ALREADY CLOCKED" : `CLOCKED ${dir}`;
    if ($("cardAvatarBadge")) $("cardAvatarBadge").innerHTML = already ? "&#8987;" : "&#10003;";
    if ($("cardMeta")) {
      const via = p.method === "face"
        ? `Face ID${p.confidence != null ? ` · ${Math.max(50, Math.min(99, Math.round((1 - p.confidence * 0.65) * 100)))}% match` : ""}`
        : (p.method === "pin" ? "PIN Verified" : "Manager Entry");
      $("cardMeta").textContent = via;
    }
    $("cardLine").innerHTML = already
      ? `Already clocked <b>${dir}</b> at ${fmtTime(p.ts)}`
      : `Clocked <b>${dir}</b> at ${fmtTime(p.ts)}`;
    card.className = "card " + (already ? "warn" : p.direction);
    $("cardFlip").style.display = already ? "none" : "";
    $("cardFlip").textContent = `Wrong? Switch to ${p.direction === "in" ? "OUT" : "IN"}`;
    if ($("cardBar")) {
      const b = $("cardBar");
      b.classList.remove("run");
      b.style.setProperty("--card-ms", `${C.punch.cardSeconds * 1000}ms`);
      void b.offsetWidth;
      b.classList.add("run");
    }
    Sound.play(already ? "warn" : p.direction);
    state.busy = true;
    setStreakProgress(0);
    drawOverlay(null);
    clearTimeout(state.cardTimer);
    state.cardTimer = setTimeout(hideCard, C.punch.cardSeconds * 1000);
  }
  function hideCard() {
    $("card").className = "card hidden";
    state.cardPunch = null;
    resetStreak();
    resetLiveness();
    if (!Keypad.isOpen && !state.mgrOpen) state.busy = false;
    hint("Look at the camera");
  }
  if ($("cardDismiss")) $("cardDismiss").addEventListener("click", hideCard);
  $("cardFlip").addEventListener("click", async () => {
    const p = state.cardPunch; if (!p) return;
    p.direction = p.direction === "in" ? "out" : "in";
    p.synced = 0; p.rev = (p.rev || 0) + 1;   // re-push: the server upserts on id; rev guards an in-flight push
    await DBX.savePunch(p);
    showCard(state.staff.get(p.staffId), p, false);
    updateSyncDot();
    updateKioskHud();
    Sync.run("flip").catch(() => {});
  });

  // ---------- kiosk loop ----------
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // Station key QR scanner state (the scanner itself lives with the settings code below).
  const keyScan = { open: false, stream: null, timer: null, det: null, busy: false, gumPending: 0, session: 0 };
  const streamAlive = () => !!(state.stream && state.stream.getVideoTracks().some(t => t.readyState === "live"));
  let camStarting = false;
  let lastVideoTime = -1;
  let lastTimeMoveAt = 0;
  let lastCamRestartAt = 0;
  async function startCamera(force = false) {
    if (camStarting) return;
    // The station key scanner owns the camera while it is open (Android gives the camera to one
    // user at a time); it hands the camera back through restoreKioskCamera() when it closes.
    if (keyScan.open) return;
    if (!force && streamAlive()) return;
    camStarting = true;
    if (state.stream) { try { state.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ } state.stream = null; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camStarting = false; hint("Camera needs HTTPS (or localhost) — open the https:// address", true); return; }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640, max: 960 }, height: { ideal: 480, max: 720 }, frameRate: { ideal: 15, max: 24 } },
        audio: false
      }).catch(() => navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
      }));
      // the key scanner opened while this request was waiting: it owns the camera now
      if (keyScan.open) { stopKioskCamera(); return; }
      // phones/tablets end the track when backgrounded or if Camera HAL disconnects: restart automatically
      state.stream.getVideoTracks().forEach(t => t.addEventListener("ended", () => {
        if (document.visibilityState === "visible") setTimeout(() => startCamera(true).catch(() => {}), 800);
      }));
      lastVideoTime = -1;
      lastTimeMoveAt = Date.now();
      $("video").srcObject = state.stream;
      $("enVideo").srcObject = state.stream;
      await new Promise(r => { $("video").onloadedmetadata = r; setTimeout(r, 1500); });
      $("video").play().catch(() => {});
    } catch (e) {
      hint("Camera unavailable: " + (e.message || e), true);
    } finally {
      camStarting = false;
    }
  }
  function resumeCamera(force = false) {
    if (force || !streamAlive()) { startCamera(true).catch(() => {}); return; }
    const v = $("video"); if (v.paused) v.play().catch(() => {});
  }
  // Release the kiosk / enrol camera completely (tracks stopped, previews detached).
  function stopKioskCamera() {
    if (state.stream) { try { state.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ } state.stream = null; }
    try { $("video").srcObject = null; $("enVideo").srcObject = null; } catch (e) { /* ignore */ }
  }
  async function keepAwake() {
    try { if ("wakeLock" in navigator && !state.wake) { state.wake = await navigator.wakeLock.request("screen"); state.wake.addEventListener("release", () => { state.wake = null; }); } } catch (e) { /* not granted */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { keepAwake(); if (state.running) resumeCamera(); }
    else if (keyScan.open) closeKeyScanner();   // the tablet was locked or the app left: give the camera up
  });

  function isFiniteDesc128(v) {
    if (!v || v.length !== 128) return false;
    for (let i = 0; i < 128; i++) {
      const n = Number(v[i]);
      if (v[i] === null || v[i] === "" || typeof v[i] === "boolean" || !Number.isFinite(n)) return false;
    }
    return true;
  }
  function dist128(a, b) {
    if (!isFiniteDesc128(a) || !isFiniteDesc128(b)) return 99;
    let s = 0;
    for (let i = 0; i < 128; i++) { const d = Number(a[i]) - Number(b[i]); s += d * d; }
    const out = Math.sqrt(s);
    return Number.isFinite(out) ? out : 99;
  }
  function avgDescriptors(list) {
    const valid = (list || []).filter(isFiniteDesc128);
    if (!valid.length) return null;
    const out = new Array(128).fill(0);
    for (const d of valid) for (let i = 0; i < 128; i++) out[i] += Number(d[i]);
    for (let i = 0; i < 128; i++) out[i] = Math.round((out[i] / valid.length) * 1e6) / 1e6;
    return out;
  }

  function resetStreak() {
    state.streak = { staffId: null, n: 0, dist: [], vecs: [] };
    state.redactedStreak = [];
    setStreakProgress(0);
  }
  function resetLiveness() {
    state.livenessHist = [];
    state.livenessWaitStart = 0;
    state.lastDescVec = null;
    state.live = null;
  }
  const passiveLiveCfg = () => ({
    mode: (C.liveness && C.liveness.mode) || "blink_or_turn",
    requireRealtimeCadence: true,
    minFrames: Math.max(3, Number((C.liveness && C.liveness.minFrames) || 4)),
    minSpanMs: Math.max(250, Number((C.liveness && C.liveness.minSpanMs) || 550)),
  });
  function recordLivenessFrame(det, src) {
    const pad = Face.analyzePad(src, det);
    const mock = (IS_TEST_ENV && typeof state.liveMock === "function") ? (state.liveMock(det) || {}) : null;
    const effPad = (mock && mock.pad) ? mock.pad : pad;
    const winMs = Math.max(2000, Number((C.liveness && C.liveness.windowSec) || 4.5) * 1000);
    const now = (mock && typeof mock.t === "number") ? mock.t : Date.now();
    const mPose = (mock && mock.pose) ? mock.pose : (det && det.pose);
    const mBox = (mock && mock.box) ? mock.box : (det && det.box);
    const entry = {
      t: now,
      ear: (mock && typeof mock.ear === "number") ? mock.ear : (det && typeof det.ear === "number" ? det.ear : null),
      yaw: mPose && typeof mPose.yaw === "number" ? mPose.yaw : null,
      parallax3d: mPose && typeof (mPose.parallax3d ?? mPose.parallax) === "number" ? (mPose.parallax3d ?? mPose.parallax) : null,
      pitch: mPose && typeof mPose.pitch === "number" ? mPose.pitch : null,
      parallaxPitch3d: mPose && typeof mPose.parallaxPitch3d === "number" ? mPose.parallaxPitch3d : null,
      landmarkModel: (mock && mock.landmarkModel) || (det && det.landmarkModel) || Face.landmarks || "",
      boxCx: mBox ? (mBox.x + mBox.width * 0.5) : null,
      boxCy: mBox ? (mBox.y + mBox.height * 0.5) : null,
      boxW: mBox ? mBox.width : 0,
      padEvaluated: !!effPad.evaluated,
      frameSpoof: !!effPad.frameSpoof,
      padScore: Number(effPad.score || 0),
      padReasons: Array.isArray(effPad.reasons) ? effPad.reasons.slice() : [],
    };
    state.livenessHist.push(entry);
    const cutoff = now - winMs;
    while (state.livenessHist.length > 36 || (state.livenessHist.length && state.livenessHist[0].t < cutoff)) {
      state.livenessHist.shift();
    }
    const lv = Face.evaluatePassiveLiveness(state.livenessHist, passiveLiveCfg());
    return { pad: effPad, lv };
  }

  // Frame-level gate (multi-person, face size, PAD & passive liveness) then descriptor matching.
  async function handleDetection(det, src) {
    if (det.multiple) {
      resetStreak();
      resetLiveness();
      drawOverlay(det, "warn");
      if (!state.busy) hint("One person in frame at a time", true);
      return { matched: false, reason: "multiple" };
    }
    if (det.frac < C.match.minFaceFrac) {
      if (state.frameSource || (state.missedFrames = (state.missedFrames || 0) + 1) >= 3) {
        resetStreak();
        resetLiveness();
      }
      drawOverlay(det, "far");
      if (!state.busy) hint("Come closer to the camera");
      return { matched: false, reason: "small", frac: det.frac };
    }
    state.missedFrames = 0;
    return handleDescriptor(det.descriptor, src, det);
  }

  async function handleDescriptor(desc, src, det) {
    if (!isFiniteDesc128(desc)) {
      resetStreak();
      resetLiveness();
      return { matched: false, reason: "bad-descriptor" };
    }
    const arr = Array.from(desc);
    const maxStep = (C.liveness && C.liveness.maxStepDist) || 0.26;
    let { pad, lv } = det
      ? recordLivenessFrame(det, src)
      : { pad: { evaluated: false, frameSpoof: false, reasons: [] }, lv: Face.evaluatePassiveLiveness(state.livenessHist, passiveLiveCfg()) };
    if (state.lastDescVec && !Face.checkDescriptorStability([state.lastDescVec, arr], maxStep)) {
      state.livenessHist = det ? state.livenessHist.slice(-1) : [];
      state.livenessWaitStart = 0;
      lv = Face.evaluatePassiveLiveness(state.livenessHist, passiveLiveCfg());
    }
    state.lastDescVec = arr;
    if (pad.frameSpoof || lv.spoofSuspected) {
      resetStreak();
      state.livenessWaitStart = 0;
      drawOverlay(det, "warn");
      if (!state.busy) hint("Live face required - remove screen or photo", true);
      return { matched: false, reason: "pad-spoof", padReasons: (pad.reasons && pad.reasons.length) ? pad.reasons : (lv.padReasons || []) };
    }

    const faces = usableFaces();
    const m = faces.length ? Face.match(desc, faces) : null;
    // Allow a small +0.05 tolerance on live camera frames 2..N for the same person so a slight head turn never resets the streak
    const isBuildingLiveStreak = Boolean(!state.frameSource && m && state.streak.staffId === m.staffId && state.streak.n >= 1);
    const effThreshold = isBuildingLiveStreak ? Math.min(0.62, state.threshold + 0.05) : state.threshold;
    const v = Face.decide(m, effThreshold);

    if (v.ok) {
      const priorUnknown = state.unknown > 0;
      state.unknown = 0;
      state.missedFrames = 0;
      state.redactedStreak = [];
      if (state.streak.staffId === m.staffId) {
        const lastVec = state.streak.vecs[state.streak.vecs.length - 1];
        if (lastVec && !Face.checkDescriptorStability([lastVec, arr], maxStep)) {
          state.streak = { staffId: m.staffId, n: 1, dist: [m.distance], vecs: [arr] };
          state.livenessHist = det ? state.livenessHist.slice(-1) : [];
          state.livenessWaitStart = 0;
          lv = Face.evaluatePassiveLiveness(state.livenessHist, passiveLiveCfg());
        } else {
          state.streak.n++;
          state.streak.dist.push(m.distance);
          state.streak.vecs.push(arr);
          if (state.streak.dist.length > 8) state.streak.dist.shift();
          if (state.streak.vecs.length > 8) state.streak.vecs.shift();
        }
      } else {
        if (state.streak.staffId || priorUnknown) {
          state.livenessHist = det ? state.livenessHist.slice(-1) : [];
          lv = Face.evaluatePassiveLiveness(state.livenessHist, passiveLiveCfg());
        }
        state.streak = { staffId: m.staffId, n: 1, dist: [m.distance], vecs: [arr] };
        state.livenessWaitStart = 0;
      }
      drawOverlay(det, "ok");
      setStreakProgress(Math.min(1, state.streak.n / C.match.confirmFrames));
      if (state.streak.n < C.match.confirmFrames) {
        if (!state.busy) hint("Hold steady…", false, "ok");
        return { matched: true, staffId: m.staffId, distance: m.distance, margin: m.margin, punched: false };
      }

      const avg = Face.averageDescriptors(state.streak.vecs.slice(-C.match.confirmFrames));
      const mAvg = avg ? Face.match(avg, faces) : null;
      const vAvg = Face.decide(mAvg, state.threshold);
      if (!vAvg.ok) {
        resetStreak();
        resetLiveness();
        drawOverlay(det, vAvg.reason === "ambiguous" ? "warn" : "unknown");
        return { matched: false, distance: mAvg ? mAvg.distance : null, reason: vAvg.reason };
      }

      if (state.liveness && !lv.ok) {
        state.livenessWaitStart = state.livenessWaitStart || Date.now();
        if (Date.now() - state.livenessWaitStart > (C.liveness.windowSec || 4.5) * 1000) {
          resetStreak();
          resetLiveness();
          drawOverlay(null);
          if (!state.busy) hint("Live face not confirmed - look naturally at camera or tap Use PIN", true);
          return { matched: false, reason: "liveness-timeout" };
        }
        drawOverlay(det, "live");
        if (!state.busy) hint("Verifying live face…", false, "live");
        return { matched: false, staffId: mAvg.staffId, reason: "awaiting-liveness", livenessReason: lv.reason };
      }

      const mean = mAvg.distance;
      const weak = mean > C.match.weakAbove;
      const liveNote = state.liveness ? (lv.blinkPassed ? "blink ok" : "3d liveness ok") : "";
      const note = [weak ? `weak match ${r3(mean)}` : "", liveNote].filter(Boolean).join("; ");
      resetStreak();
      resetLiveness();
      await punch(mAvg.staffId, "face", mean, (src && src._rawSource) || src, null, note);
      return { matched: true, staffId: mAvg.staffId, distance: mean, margin: mAvg.margin, punched: true, liveness: lv.method || "off" };
    }

    // In Server-Redacted 1:N Mode, fall through to server verify whenever no local vector matched
    // (including when 1 new unsynced local enrolment coexists with server-redacted staff).
    if (state.redactedMode && v.reason !== "ambiguous") {
      const activeCount = [...state.staff.values()].filter(s => s.active !== false).length;
      if (!activeCount) {
        resetStreak();
        resetLiveness();
        state.unknown++;
        drawOverlay(det, "unknown");
        if (state.unknown >= C.match.unknownFrames && !state.busy) hint("No enrolments yet - tap Use PIN", true);
        return { matched: false, reason: "no-enrolments", redacted: true };
      }
      if (state.redactedStreak.length) {
        const prev = state.redactedStreak[state.redactedStreak.length - 1];
        if (!Face.checkDescriptorStability([prev, arr], maxStep)) {
          state.redactedStreak = [];
          state.livenessHist = det ? state.livenessHist.slice(-1) : [];
          state.livenessWaitStart = 0;
          lv = Face.evaluatePassiveLiveness(state.livenessHist, passiveLiveCfg());
        }
      }
      state.redactedStreak.push(arr);
      if (state.redactedStreak.length > 8) state.redactedStreak.shift();
      setStreakProgress(Math.min(1, state.redactedStreak.length / C.match.confirmFrames));
      drawOverlay(det, "scan");
      if (state.redactedStreak.length < C.match.confirmFrames) {
        if (!state.busy) hint("Hold steady…", false, "ok");
        return { matched: false, reason: "stabilizing", streak: state.redactedStreak.length, redacted: true };
      }
      if (state.liveness && !lv.ok) {
        state.livenessWaitStart = state.livenessWaitStart || Date.now();
        if (Date.now() - state.livenessWaitStart > (C.liveness.windowSec || 4.5) * 1000) {
          resetStreak();
          resetLiveness();
          drawOverlay(null);
          if (!state.busy) hint("Live face not confirmed - look naturally at camera or tap Use PIN", true);
          return { matched: false, reason: "liveness-timeout", redacted: true };
        }
        drawOverlay(det, "live");
        if (!state.busy) hint("Verifying live face…", false, "live");
        return { matched: false, reason: "awaiting-liveness", livenessReason: lv.reason, redacted: true };
      }
      if (state.verifyingRedacted) return { matched: false, reason: "verifying", redacted: true };
      const probe = Face.averageDescriptors(state.redactedStreak.slice(-C.match.confirmFrames));
      state.redactedStreak = [];
      if (!probe) return { matched: false, reason: "bad-descriptor", redacted: true };
      state.verifyingRedacted = true;
      try {
        const vr = await Sync.verify({ method: "face", descriptor: probe, threshold: state.threshold });
        if (state.mgrOpen || Keypad.isOpen || state.cardPunch || !state.running) {
          return { matched: false, reason: "cancelled", redacted: true };
        }
        const matchedSt = (vr && vr.matched && vr.staffId) ? state.staff.get(vr.staffId) : null;
        if (matchedSt && matchedSt.active !== false) {
          state.unknown = 0;
          state.missedFrames = 0;
          drawOverlay(det, "ok");
          const liveNote = state.liveness ? (lv.blinkPassed ? "blink ok" : "3d liveness ok") : "";
          const note = [vr.weak ? "weak match (server)" : "", liveNote].filter(Boolean).join("; ");
          resetLiveness();
          await punch(vr.staffId, "face", null, (src && src._rawSource) || src, null, note);
          return { matched: true, staffId: vr.staffId, weak: !!vr.weak, redacted: true, liveness: lv.method || "off" };
        }
        setStreakProgress(0);
        resetLiveness();
        const rsn = (vr && vr.matched && (!matchedSt || matchedSt.active === false)) ? "inactive" : ((vr && vr.reason) || "far");
        state.unknown = Math.max(state.unknown + 1, C.match.unknownFrames);
        drawOverlay(det, rsn === "ambiguous" ? "warn" : "unknown");
        if (!state.busy) {
          if (rsn === "no-enrolments") hint("No enrolments yet - tap Use PIN", true);
          else if (rsn === "ambiguous") hint("Close match with a colleague - use your PIN", true);
          else hint("Not recognised - tap Use PIN", true);
        }
        return { matched: false, reason: rsn, redacted: true };
      } catch (err) {
        setStreakProgress(0);
        if (!state.busy) hint("Server offline - try again or tap Use PIN", true);
        return { matched: false, reason: "offline", redacted: true };
      } finally {
        state.verifyingRedacted = false;
      }
    }

    if (!state.frameSource && state.streak.n > 0 && (state.missedFrames = (state.missedFrames || 0) + 1) < 3) {
      drawOverlay(det, "scan");
      return { matched: false, distance: m ? m.distance : null, reason: v.reason, margin: m ? m.margin : null };
    }
    resetStreak();
    state.unknown++;
    if (state.unknown >= C.match.unknownFrames || v.reason === "ambiguous") resetLiveness();
    drawOverlay(det, v.reason === "ambiguous" ? "warn" : "unknown");
    if (state.unknown >= C.match.unknownFrames && !state.busy) {
      if (v.reason === "no-enrolments") hint("No enrolments yet — tap Use PIN", true);
      else if (v.reason === "ambiguous") hint("Can't tell you apart from a colleague — use your PIN", true);
      else hint("Not recognised — tap Use PIN", true);
    }
    return { matched: false, distance: m ? m.distance : null, reason: v.reason, margin: m ? m.margin : null };
  }

  async function loop() {
    if (!state.running) return;
    let delay = state.frameSource ? 120 : 85;
    try {
      if (!state.busy && Face.ready) {
        const src = state.frameSource || $("video");
        if (!state.frameSource && !navigator.webdriver) {
          if (!streamAlive() || src.ended) {
            if (Date.now() - lastCamRestartAt > 2500) {
              lastCamRestartAt = Date.now();
              resumeCamera(true);
            }
          } else {
            if (src.paused) src.play().catch(() => {});
            const ct = typeof src.currentTime === "number" ? src.currentTime : -1;
            if (ct >= 0 && ct !== lastVideoTime) {
              lastVideoTime = ct;
              lastTimeMoveAt = Date.now();
            } else if (lastTimeMoveAt > 0 && document.visibilityState === "visible") {
              const stuckMs = Date.now() - lastTimeMoveAt;
              if (stuckMs > 1800 && stuckMs <= 3600) src.play().catch(() => {});
              else if (stuckMs > 3600 && Date.now() - lastCamRestartAt > 3000) {
                lastCamRestartAt = Date.now();
                resumeCamera(true);
              }
            }
          }
        }
        const ok = state.frameSource || (src.readyState >= 2 && src.videoWidth > 0);
        if (ok) {
          const det = await Face.detectOne(src);
          if (det) {
            state.missedFrames = 0;
            await handleDetection(det, src);
            delay = state.frameSource ? 120 : 85;
          } else {
            state.missedFrames = (state.missedFrames || 0) + 1;
            if (state.frameSource || state.missedFrames >= 3) {
              resetStreak();
              resetLiveness();
              drawOverlay(null);
              if (state.unknown) state.unknown = 0;
              if (!state.busy) hint("Look at the camera");
            }
          }
        }
      }
    } catch (e) { console.error(e); }
    setTimeout(loop, delay);
  }

  // ---------- staff PIN ----------
  $("btnPin").addEventListener("click", () => {
    resetLiveness();
    Keypad.open("Enter your PIN", async pin => {
      if (pin === null) return;
      const h = await sha256(pin);
      let st = [...state.staff.values()].find(s => s.pinhash === h && s.active !== false);
      if (!st && state.redactedMode) {
        try {
          const vr = await Sync.verify({ method: "pin", pinhash: h });
          if (vr && vr.matched && vr.staffId) {
            st = state.staff.get(vr.staffId);
            if (st && st.active === false) st = null;
          }
        } catch (err) {
          toast("Offline - server PIN check unavailable", true);
          return null;
        }
      }
      if (!st) return false;
      await punch(st.id, "pin", null, state.frameSource || $("video"));
      return true;
    });
  });

  // ---------- manager ----------
  async function managerPinOk(pin) {
    const h = await DBX.getMeta("mgrPinHash", "");
    if (h) return (await sha256(pin)) === h;
    return pin === C.firstRunManagerPin;
  }
  async function setManagerPin(pin) {
    await DBX.setMeta("mgrPinHash", await sha256(pin));
    await DBX.delMeta("mgrPin");
    state.defaultPin = false;
    if ($("mgrPinBanner")) $("mgrPinBanner").hidden = true;
    await updateAttendanceAppBadge();
  }
  $("btnMgr").addEventListener("click", () => {
    resetLiveness();
    Keypad.open("Manager PIN", async pin => {
      if (pin === null) return;
      if (!(await managerPinOk(pin))) return false;
      openManager();
      return true;
    });
  });
  if ($("btnBannerPin")) {
    $("btnBannerPin").addEventListener("click", () => {
      Keypad.open("New manager PIN", async pin => {
        if (pin === null) return;
        await setManagerPin(pin);
        toast("Manager PIN changed");
        renderSettings();
        return true;
      });
    });
  }
  function openManager() {
    state.mgrOpen = true; state.busy = true; resetStreak(); resetLiveness();
    state.enFilter = "all"; state.stFilter = "all"; state.logFilter = "all";
    if ($("enSearch")) $("enSearch").value = "";
    if ($("stSearch")) $("stSearch").value = "";
    if ($("logSearch")) $("logSearch").value = "";
    document.querySelectorAll("#enFilter .chip").forEach(c => c.classList.toggle("on", c.dataset.ef === "all"));
    document.querySelectorAll("#stFilter .chip").forEach(c => c.classList.toggle("on", c.dataset.sf === "all"));
    document.querySelectorAll("#logFilter .chip").forEach(c => c.classList.toggle("on", c.dataset.lf === "all"));
    drawOverlay(null);
    $("kiosk").classList.remove("open"); $("mgr").classList.add("open");
    { const v = $("enVideo"); if (v.srcObject && v.paused) v.play().catch(() => {}); }
    if ($("mgrPinBanner")) $("mgrPinBanner").hidden = !state.defaultPin;
    showTab("enrol"); renderEnrolList(""); renderStaff(); renderSettings();
    $("logDay").value = nowLocal().day; renderLog();
  }
  function closeManager() {
    stopTest();
    if (keyScan.open) closeKeyScanner();
    state.mgrOpen = false; state.busy = false;
    $("mgr").classList.remove("open"); $("kiosk").classList.add("open");
    hideCard();
    updateKioskHud();
  }
  $("btnBack").addEventListener("click", closeManager);
  function showTab(name) {
    if (name !== "enrol") stopTest();
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === name));
    document.querySelectorAll(".panel").forEach(p => p.classList.toggle("on", p.id === "tab-" + name));
  }
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
    showTab(t.dataset.tab);
    if (t.dataset.tab === "log") renderLog();
    if (t.dataset.tab === "staff") renderStaff();
    if (t.dataset.tab === "settings") renderSettings();
  }));


  // ---------- pose pictograms (enrolment guide; mirrored-preview sense) ----------
  // Every pictogram shows the camera at the top and a head beneath it, so the turn is
  // read RELATIVE TO THE CAMERA. Straight: both ears, a dashed sight line from the lens
  // to the nose. Slightly left / right: the features slide a little off centre, the
  // far ear disappears, the near ear shows, and a SHORT curved arrow over the crown
  // pulses the way the head turns (as seen in the mirrored preview). v0.2.4: the old
  // big side arrow + wide feature shift read as "turn all the way" — a full profile
  // hides one eye and the detector finds no face, so the turn must stay small enough
  // to keep both eyes in view. Plain shapes, no text: usable without reading.
  function poseSvg(kind) {
    const W = "#f8fafc", B = "#c9a227";
    const cam = `<rect x="40" y="2" width="20" height="12" rx="3" fill="${B}"/><circle cx="50" cy="8" r="3.4" fill="#0f172a"/>`;
    const sight = `<path d="M50 16 V40" fill="none" stroke="${B}" stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round"/>`;
    const earL = `<path d="M24.5 57 q-8 7 0 14" fill="none" stroke="${W}" stroke-width="3.5" stroke-linecap="round"/>`;
    const earR = `<path d="M75.5 57 q8 7 0 14" fill="none" stroke="${W}" stroke-width="3.5" stroke-linecap="round"/>`;
    // dx = how far the features slide (a small number = a small turn); the eye on the
    // far side is drawn a touch smaller, as it is when a face turns a little
    const head = (dx) => `<circle cx="50" cy="64" r="26" fill="none" stroke="${W}" stroke-width="4"/>` +
      `<circle cx="${41 + dx}" cy="58" r="${dx < 0 ? 2.7 : 3.3}" fill="${W}"/><circle cx="${59 + dx}" cy="58" r="${dx > 0 ? 2.7 : 3.3}" fill="${W}"/>` +
      `<path d="M${50 + dx * 1.5} 59 v9 h${dx >= 0 ? 5 : -5}" fill="none" stroke="${W}" stroke-width="3" stroke-linecap="round"/>` +
      `<path d="M${42 + dx} 76 h16" fill="none" stroke="${W}" stroke-width="3.5" stroke-linecap="round"/>`;
    // a short arc over the crown with a chevron at the end = "turn a little this way"
    const arrow = (d, dx) => `<g class="arrow" style="--dx:${dx}px;--dy:0px"><path d="${d}" fill="none" stroke="${B}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></g>`;
    let body;
    switch (kind) {
      case "left":  body = cam + head(-6) + earR + arrow("M60 32 Q50 20 38 29 M46 28 L38 29 L41 22", -4); break;
      case "right": body = cam + head(6) + earL + arrow("M40 32 Q50 20 62 29 M54 28 L62 29 L59 22", 4); break;
      case "done":  body = `<circle cx="50" cy="56" r="34" fill="none" stroke="#22c55e" stroke-width="5"/><path d="M32 58 l12 12 l26 -28" fill="none" stroke="#22c55e" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`; break;
      default:      body = cam + sight + head(0) + earL + earR;
    }
    return `<svg viewBox="0 0 100 92" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
  }
  function poseIcon(i) { return (C.match.poseIcons || [])[i] || "straight"; }

  // Enrol-side frame: a canvas copy of the hidden enrol <video>. face-api waits for a
  // "load" event on a video whose readyState < 3 — an event a MediaStream video never
  // fires — so detecting straight from a paused/hidden video can hang forever (the
  // "Test recognition shows nothing" bug). A canvas is never waited on.
  function enrolFrame() {
    if (state.frameSource) return state.frameSource;
    const v = $("enVideo");
    if (v.paused && v.srcObject) v.play().catch(() => {});
    if (v.readyState < 2 || !v.videoWidth) return null;
    const cv = state.enFrame || (state.enFrame = document.createElement("canvas"));
    const scale = v.videoWidth > 320 ? (320 / v.videoWidth) : 1;
    const tw = Math.max(64, Math.round(v.videoWidth * scale));
    const th = Math.max(48, Math.round(v.videoHeight * scale));
    if (cv.width !== tw || cv.height !== th) { cv.width = tw; cv.height = th; }
    cv._scaleX = v.videoWidth / tw;
    cv._scaleY = v.videoHeight / th;
    cv._rawSource = v;
    cv._isLiveEnrolVideo = true;
    (cv.getContext("2d", { willReadFrequently: true }) || cv.getContext("2d")).drawImage(v, 0, 0, tw, th);
    return cv;
  }

  // ----- enrol -----
  function staffMatches(q) {
    q = (q || "").trim().toLowerCase();
    return [...state.staff.values()].filter(s => s.active !== false && (!q || s.name.toLowerCase().includes(q) || (s.officialName || "").toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  function sampleCount(staffId) {
    const local = state.faces.filter(f => f.staffId === staffId).length;
    if (local > 0) return local;
    return state.redactedMode ? (state.redactedFaceCounts.get(staffId) || 0) : 0;
  }

  function updateEnrolCoverage() {
    const active = [...state.staff.values()].filter(s => s.active !== false);
    const ready = active.filter(s => sampleCount(s.id) >= C.match.minSamples).length;
    const pct = active.length ? Math.round((ready / active.length) * 100) : 0;
    if ($("enCoverageTxt")) $("enCoverageTxt").textContent = active.length ? `${ready} of ${active.length} active staff enrolled with Face ID` : "Roster empty — refresh from server";
    if ($("enCoveragePct")) $("enCoveragePct").textContent = `${pct}%`;
    if ($("enCoverageFill")) $("enCoverageFill").style.width = `${pct}%`;
  }

  function renderEnrolList(q) {
    updateEnrolCoverage();
    const el = $("enList");
    let list = staffMatches(q);
    if (state.enFilter === "missing") list = list.filter(s => sampleCount(s.id) < C.match.minSamples);
    else if (state.enFilter === "ready") list = list.filter(s => sampleCount(s.id) >= C.match.minSamples);
    else if (state.enFilter === "pin") list = list.filter(s => hasStaffPin(s));

    el.innerHTML = list.map(s => `<div data-id="${esc(s.id)}" class="${s.id === state.enrol.staffId ? "sel" : ""}">${esc(s.name)}<small>${sampleCount(s.id)} samples${hasStaffPin(s) ? " · PIN" : ""}</small></div>`).join("") || `<div class="muted">No staff in the roster. Settings → Refresh roster.</div>`;
    el.querySelectorAll("div[data-id]").forEach(d => d.addEventListener("click", () => selectEnrol(d.dataset.id)));
  }
  $("enSearch").addEventListener("input", e => renderEnrolList(e.target.value));
  document.querySelectorAll("#enFilter .chip").forEach(btn => btn.addEventListener("click", () => {
    state.enFilter = btn.dataset.ef;
    document.querySelectorAll("#enFilter .chip").forEach(c => c.classList.toggle("on", c === btn));
    renderEnrolList($("enSearch").value);
  }));

  function selectEnrol(id) {
    const st = state.staff.get(id); if (!st) return;
    state.enrol = { staffId: id, samples: [], pin: null };
    state.lastEnrolDet = null;
    state.lastEnrolDetAt = 0;
    state.enrolSteady = 0;
    $("enWho").textContent = `${st.name}${st.officialName ? " (" + st.officialName + ")" : ""} — ${sampleCount(id)} sample(s) stored`;
    ["enCapture", "enClear", "enPin", "enConsent"].forEach(x => $(x).disabled = false);
    $("enConsent").checked = false;
    $("enPinState").textContent = hasStaffPin(st) ? "PIN already set (Set PIN replaces it)" : "no PIN";
    renderEnrolList($("enSearch").value);
    renderSamples();
    if (!navigator.webdriver && !state.frameSource) startEnrolPrewarmLoop();
    if (window.innerWidth <= 860 && !navigator.webdriver) { const stu = document.querySelector(".enrolStudio"); if (stu && stu.scrollIntoView) stu.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }

  let enrolLoopTimer = null;
  let enrolLoopBusy = false;
  function startEnrolPrewarmLoop() {
    clearTimeout(enrolLoopTimer);
    enrolLoopTimer = setTimeout(enrolPrewarmTick, 45);
  }
  async function enrolPrewarmTick() {
    if (!state.mgrOpen || !state.enrol.staffId || state.enrol.samples.length >= C.match.maxSamples || state.frameSource || navigator.webdriver) return;
    if (!enrolLoopBusy && Face.ready && streamAlive()) {
      enrolLoopBusy = true;
      try {
        const src = enrolFrame();
        if (src) {
          const det = await Face.detectOne(src);
          const padOk = !det || (!det.multiple && !Face.analyzePad(src, det).frameSpoof);
          if (det && padOk && det.descriptor && det.frac >= C.match.minFaceFrac && det.score >= C.match.enrolScore) {
            state.lastEnrolDet = det;
            state.lastEnrolDetAt = Date.now();
            state.enrolSteady = (state.enrolSteady || 0) + 1;
            const nowMs = Date.now();
            if (state.enrolSteady >= 2 && nowMs - (state.lastEnrolAutoAt || 0) > 850) {
              state.enrolSteady = 0;
              state.lastEnrolAutoAt = nowMs;
              await captureSample();
            }
          } else {
            state.enrolSteady = 0;
          }
        }
      } catch (_) {}
      enrolLoopBusy = false;
    }
    if (state.mgrOpen && state.enrol.staffId && state.enrol.samples.length < C.match.maxSamples && !state.frameSource && !navigator.webdriver) {
      enrolLoopTimer = setTimeout(enrolPrewarmTick, 55);
    }
  }
  function renderSamples() {
    const s = state.enrol.samples;
    const target = Math.min(C.match.maxSamples, C.match.poses.length);
    $("enSamples").innerHTML = s.map(x => `<img src="${x.thumb}" alt="">`).join("") +
      Array.from({ length: Math.max(0, target - s.length) }, () => `<span class="empty"></span>`).join("");
    const ready = state.enrol.staffId && (s.length >= C.match.minSamples || (state.enrol.pin && s.length === 0));
    $("enSave").disabled = !ready;
    $("enSave").classList.toggle("ready", !!ready && s.length > 0);
    $("enCapture").disabled = !state.enrol.staffId || s.length >= C.match.maxSamples;

    // Update 3-step visual stepper
    if ($("enStepper")) {
      $("enStepper").querySelectorAll(".stepItem").forEach(item => {
        const idx = parseInt(item.dataset.step, 10);
        item.classList.toggle("done", !!state.enrol.staffId && idx < s.length);
        item.classList.toggle("active", !!state.enrol.staffId && idx === s.length && s.length < target);
      });
    }

    const pose = $("enPose"), guide = $("enGuide");
    if (!state.enrol.staffId) { pose.textContent = ""; guide.hidden = true; guide.className = "guide"; }
    else if (s.length >= C.match.maxSamples) {
      pose.innerHTML = `<span class="ico">${poseSvg("done")}</span><span>All ${s.length} samples taken — tick the consent box, then press <b>Save enrolment</b>.</span>`;
      guide.innerHTML = poseSvg("done"); guide.className = "guide done"; guide.hidden = false;
    } else {
      const i = Math.min(s.length, C.match.poses.length - 1);
      pose.innerHTML = `<span class="ico">${poseSvg(poseIcon(i))}</span><span><span class="n">${s.length + 1} / ${target}</span>${esc(C.match.poses[i])}</span>`;
      guide.innerHTML = poseSvg(poseIcon(i)); guide.className = "guide"; guide.hidden = false;
    }
    guide.dataset.pose = s.length >= C.match.maxSamples ? "done" : poseIcon(Math.min(s.length, C.match.poses.length - 1));
  }
  async function captureSample(src) {
    if (state.enrol.samples.length >= C.match.maxSamples) { toast(`${C.match.maxSamples} samples already taken — save the enrolment`, true); return false; }
    const isCustomSrc = Boolean(src);
    src = src || enrolFrame();
    if (!src) { toast("Camera not ready — wait a second and try again", true); return false; }
    let det = null;
    if (!isCustomSrc && !state.frameSource && state.lastEnrolDet && (Date.now() - (state.lastEnrolDetAt || 0)) < 1400) {
      det = state.lastEnrolDet;
      state.lastEnrolDet = null;
    } else {
      det = await Face.detectOne(src);
    }
    // a turned pose that finds no face is almost always a FULL turn (profile hides an eye)
    const turning = ["left", "right"].includes(poseIcon(Math.min(state.enrol.samples.length, C.match.poses.length - 1)));
    if (!det) { toast(turning ? "No face found — turn only a little, both eyes must stay in view" : "No face found — look straight at the camera", true); return false; }
    if (det.multiple) { toast("Multiple faces in view — enrol one person at a time", true); return false; }
    if (det.frac < C.match.minFaceFrac) { toast("Too far — come closer to the camera", true); return false; }
    if (det.score < C.match.enrolScore) { toast(turning ? "Face not clear enough — turn less, more light" : "Face not clear enough — more light, look straight", true); return false; }
    const pad = Face.analyzePad(src, det);
    if (pad.frameSpoof) { toast("Live face required — do not enrol from a screen or photo", true); return false; }
    // reject a sample that already matches someone ELSE's enrolment (local or server-redacted)
    const other = usableFaces().filter(f => f.staffId !== state.enrol.staffId);
    const m = other.length ? Face.match(det.descriptor, other) : null;
    if (m && m.distance <= state.threshold * 0.8) {
      const who = state.staff.get(m.staffId);
      toast(`This face already matches ${who ? who.name : "another person"}`, true);
      return false;
    }
    if (state.redactedMode && navigator.onLine) {
      const vr = await Sync.verify({
        method: "face",
        descriptor: Array.from(det.descriptor),
        threshold: Math.min(0.58, state.threshold + C.match.margin),
      }).catch(() => null);
      if (vr && vr.matched && vr.staffId && vr.staffId !== state.enrol.staffId) {
        const who = state.staff.get(vr.staffId);
        toast(`This face already matches ${who ? who.name : "another person"}`, true);
        return false;
      }
    }
    state.enrol.samples.push({ d: Array.from(det.descriptor), thumb: snapshot((src && src._rawSource) || src) });
    Sound.play("capture");
    renderSamples();
    return true;
  }
  $("enCapture").addEventListener("click", () => captureSample());
  $("enClear").addEventListener("click", async () => {
    state.enrol.samples = [];
    const targetId = state.enrol.staffId;
    if (targetId && sampleCount(targetId)) {
      if (!confirm("Also delete the stored samples on this tablet? (server copies stay)")) { renderSamples(); return; }
      for (const f of await DBX.facesForStaff(targetId)) await DBX.deleteFace(f.id);
      state.faces = state.faces.filter(f => f.staffId !== targetId);
      state.redactedFaceCounts.delete(targetId);
      const st = state.staff.get(targetId);
      if (st && st.serverSamples) { st.serverSamples = 0; await DBX.saveStaff(st); }
      selectEnrol(targetId);
    }
    renderSamples();
  });
  $("enPin").addEventListener("click", () => {
    Keypad.open("New staff PIN", async pin => {
      if (pin === null) return;
      const h = await sha256(pin);
      const clash = [...state.staff.values()].find(s => s.pinhash === h && s.id !== state.enrol.staffId);
      if (clash) { toast("That PIN is already used by " + clash.name, true); return false; }
      if (state.redactedMode && navigator.onLine) {
        const vr = await Sync.verify({ method: "pin", pinhash: h }).catch(() => null);
        if (vr && vr.matched && vr.staffId && vr.staffId !== state.enrol.staffId) {
          const who = state.staff.get(vr.staffId);
          toast("That PIN is already used by " + (who ? who.name : "another staff member"), true);
          return false;
        }
      }
      state.enrol.pin = { pin, hash: h };
      $("enPinState").textContent = "PIN set (saved with the enrolment)";
      renderSamples();
      return true;
    });
  });
  $("enConsent").addEventListener("change", renderSamples);
  // How well the new samples separate from everyone else already enrolled.
  function separation(staffId, rows) {
    const other = state.faces.filter(f => f.staffId !== staffId);
    if (!other.length || !rows.length) return null;
    let best = null;
    for (const r of rows) { const m = Face.match(r.d, other); if (m && (!best || m.distance < best.distance)) best = m; }
    return best;
  }
  async function saveEnrolment() {
    const e = state.enrol; if (!e.staffId) return false;
    if (e.samples.length && !$("enConsent").checked) { toast("Tick the consent box first", true); return false; }
    const st = state.staff.get(e.staffId);
    const nowIso = new Date().toISOString();
    const consentAt = e.samples.length ? nowIso : "";
    const device = await DBX.getMeta("device", "");
    const pinhash = e.pin ? e.pin.hash : (st.pinhash || "");
    const priorFaces = await DBX.facesForStaff(e.staffId);
    let rows = [];

    if (e.samples.length > 0) {
      // Replace previous samples (including redacted stubs) for this person using deterministic pose IDs
      for (const f of priorFaces) await DBX.deleteFace(f.id);
      state.faces = state.faces.filter(f => f.staffId !== e.staffId);
      state.redactedFaceCounts.delete(e.staffId);
      rows = e.samples.map((s, i) => ({
        id: `${e.staffId}:${i + 1}`,
        staffId: e.staffId,
        staffName: st.name,
        d: s.d,
        sample: i + 1,
        consentAt,
        pinhash,
        ts: nowIso,
        device,
        synced: 0,
      }));
      for (const r of rows) await DBX.saveFace(r);
      state.faces.push(...rows.filter(r => r.d.length === 128));
    } else if (e.pin) {
      // PIN-only save/rotation: preserve existing face vectors & redacted face stubs; overwrite sample=0 / pinhash deterministically
      for (const f of priorFaces.filter(f => !f.sample || Number(f.sample) === 0)) {
        await DBX.deleteFace(f.id);
      }
      const localVecRows = priorFaces.filter(f => Number(f.sample) > 0 && Array.isArray(f.d) && f.d.length === 128);
      if (localVecRows.length > 0) {
        for (const f of localVecRows) {
          f.pinhash = e.pin.hash;
          f.ts = nowIso;
          f.synced = 0;
          await DBX.saveFace(f);
        }
        rows = localVecRows;
      } else {
        const pinRow = {
          id: `${e.staffId}:0`,
          staffId: e.staffId,
          staffName: st.name,
          d: [],
          sample: 0,
          consentAt: "",
          pinhash: e.pin.hash,
          ts: nowIso,
          device,
          synced: 0,
        };
        await DBX.saveFace(pinRow);
        rows = [pinRow];
      }
    }

    const sep = separation(e.staffId, rows.filter(r => Array.isArray(r.d) && r.d.length === 128));
    if (e.pin) {
      st.pinhash = e.pin.hash;
      st.hasPin = true;
      delete st.pinRedacted;
      await DBX.saveStaff(st);
    } else if (st.pinRedacted || st.hasPin) {
      st.hasPin = true;
      await DBX.saveStaff(st);
    }
    if (sep) {
      const who = state.staff.get(sep.staffId);
      const close = sep.distance < state.threshold + C.match.margin;
      toast(`Saved ${e.samples.length} sample(s) for ${st.name} · closest other person: ${who ? who.name : "?"} at ${r3(sep.distance)}${close ? ` — TOO CLOSE, re-enrol both with all ${C.match.maxSamples} samples in good light` : " (good)"}`, close, close ? 7000 : 4000);
    } else toast(`Saved ${e.samples.length} sample(s) for ${st.name}`);
    state.enrol = { staffId: null, samples: [], pin: null };
    $("enWho").textContent = "Pick a staff member on the left.";
    ["enCapture", "enClear", "enPin", "enConsent", "enSave"].forEach(x => $(x).disabled = true);
    $("enPinState").textContent = "";
    renderEnrolList($("enSearch").value); renderSamples(); renderStaff(); updateKioskHud();
    Sync.run("enrol").catch(() => {});
    return true;
  }
  $("enSave").addEventListener("click", saveEnrolment);

  // ----- test recognition (manager stands the person in front of the camera) -----
  async function testLoop() {
    if (!state.testing) return;
    const out = $("enTestOut");
    const big = (cls, t, detail) => { out.innerHTML = `<div class="testBig ${cls}">${t}</div>` + (detail ? `<div class="testDetail">${detail}</div>` : ""); };
    try {
      if (!state.stream) await startCamera();
      const src = enrolFrame();
      if (!src) big("wait", "Camera starting…", state.stream ? "" : "no camera stream — check the camera permission");
      else {
        const det = await Face.detectOne(src);
        const pad = det ? Face.analyzePad(src, det) : null;
        if (!det) big("wait", "No face in view");
        else if (det.multiple) big("bad", "✗ Multiple faces in view", "stand one person in front of the camera");
        else if (pad && pad.frameSpoof) big("bad", "✗ Screen or photo blocked", "PAD flagged: " + esc((pad.reasons || []).join(", ")));
        else if (det.frac < C.match.minFaceFrac) big("wait", "Come closer", `face is ${Math.round(det.frac * 100)}% of the frame, minimum ${Math.round(C.match.minFaceFrac * 100)}%`);
        else {
          // Unsaved captures of the person being enrolled count too (they replace that
          // person's stored samples on Save), so the manager can test before saving.
          const pend = state.enrol.staffId ? state.enrol.samples : [];
          const pendOk = pend.length >= C.match.minSamples;
          let faces = usableFaces();
          if (pendOk) faces = faces.filter(f => f.staffId !== state.enrol.staffId).concat(pend.map(s => ({ staffId: state.enrol.staffId, d: s.d, pending: true })));
          const nm = id => esc((state.staff.get(id) || {}).name || "?");
          const m = faces.length ? Face.match(det.descriptor, faces) : null;
          const v = Face.decide(m, state.threshold);
          if (state.redactedMode && !pendOk && (!m || !v.ok)) {
            const vr = await Sync.verify({ method: "face", descriptor: Array.from(det.descriptor), threshold: state.threshold });
            const vrSt = (vr && vr.matched && vr.staffId) ? state.staff.get(vr.staffId) : null;
            if (vrSt && vrSt.active !== false) {
              big("ok", `✓ ${nm(vr.staffId)}${vr.weak ? " (weak)" : ""}`, "verified via Server-Redacted 1:N (0 local vectors)");
            } else {
              const rsn = (vr && vr.matched && (!vrSt || vrSt.active === false)) ? "inactive" : ((vr && vr.reason) || "far");
              big("bad", "✗ Not recognised", `server 1:N status: ${esc(rsn)} · threshold ${state.threshold} · margin ${C.match.margin}`);
            }
          } else {
            const reasons = { far: "no enrolled face is close enough", ambiguous: "two people are too close to tell apart", "no-enrolments": "no usable enrolments on this device" };
            const unsaved = m && pendOk && m.staffId === state.enrol.staffId ? `<span class="pend">not saved yet — press Save enrolment</span> · ` : "";
            const short = pend.length && !pendOk ? `<span class="pend">only ${pend.length} of ${C.match.minSamples} samples taken for ${nm(state.enrol.staffId)} — capture the rest, then press Save enrolment</span>` : "";
            if (!m && short) big("bad", `✗ Only ${pend.length} of ${C.match.minSamples} samples taken`, short);
            else if (!m) big("bad", "✗ No usable enrolments on this device", "save at least " + C.match.minSamples + " samples for someone first");
            else big(v.ok ? "ok" : "bad", v.ok ? `✓ ${nm(m.staffId)}${v.weak ? " (weak)" : ""}` : `✗ Not recognised`,
              unsaved + (short ? short + " · " : "") + `${v.ok ? "" : (reasons[v.reason] || v.reason) + " · "}closest: ${nm(m.staffId)} at ${r3(m.distance)}` +
              (m.runnerUp ? ` · next: ${nm(m.runnerUp.staffId)} at ${r3(m.runnerUp.distance)} (gap ${r3(m.margin)})` : " · no other enrolled person") +
              ` · threshold ${state.threshold} · margin ${C.match.margin}`);
          }
        }
      }
    } catch (e) { big("bad", "Test error", esc(String(e.message || e))); }
    setTimeout(testLoop, 300);
  }
  function stopTest() { state.testing = false; $("enTest").textContent = "Test recognition"; $("enTestOut").innerHTML = ""; }
  $("enTest").addEventListener("click", () => {
    if (state.testing) { stopTest(); return; }
    state.testing = true; $("enTest").textContent = "Stop test"; testLoop();
  });

  // ----- staff -----
  function renderStaff() {
    // people switched off go last; within each group by name
    const allRows = [...state.staff.values()].sort((a, b) => ((a.active === false) - (b.active === false)) || a.name.localeCompare(b.name));
    const active = allRows.filter(s => s.active !== false);
    const faceReady = active.filter(s => sampleCount(s.id) >= C.match.minSamples).length;
    const pinReady = active.filter(s => hasStaffPin(s)).length;
    const missing = active.filter(s => sampleCount(s.id) < C.match.minSamples && !hasStaffPin(s)).length;
    if ($("kpiStTotal")) $("kpiStTotal").textContent = String(active.length);
    if ($("kpiStFace")) $("kpiStFace").textContent = String(faceReady);
    if ($("kpiStFaceSub")) $("kpiStFaceSub").textContent = active.length ? `${Math.round((faceReady / active.length) * 100)}% of active roster` : "3 / 3 samples stored";
    if ($("kpiStPin")) $("kpiStPin").textContent = String(pinReady);
    if ($("kpiStMissing")) $("kpiStMissing").textContent = String(missing);

    const q = ($("stSearch") ? $("stSearch").value : "").trim().toLowerCase();
    let rows = allRows.filter(s => !q || s.name.toLowerCase().includes(q) || (s.officialName || "").toLowerCase().includes(q));
    // The enrolment filters follow the KPI cards above: active people only.
    if (state.stFilter === "face") rows = rows.filter(s => s.active !== false && sampleCount(s.id) >= C.match.minSamples);
    else if (state.stFilter === "pin") rows = rows.filter(s => s.active !== false && hasStaffPin(s) && sampleCount(s.id) < C.match.minSamples);
    else if (state.stFilter === "none") rows = rows.filter(s => s.active !== false && sampleCount(s.id) < C.match.minSamples && !hasStaffPin(s));
    else if (state.stFilter === "off") rows = rows.filter(s => s.active === false);

    const tb = $("stTable").querySelector("tbody");
    tb.innerHTML = rows.map(s => {
      const off = s.active === false;
      const sc = sampleCount(s.id);
      const isCloudOnly = state.redactedMode && state.faces.filter(f => f.staffId === s.id).length === 0 && sc >= C.match.minSamples;
      const sampleBadge = sc >= C.match.minSamples
        ? `<span class="tag ok">${sc} / ${C.match.maxSamples} ${isCloudOnly ? "cloud" : "ready"}</span>`
        : (sc > 0 ? `${sc} <span class="tag warn">below ${C.match.minSamples}</span>` : `<span class="muted">0</span>`);
      const activeCell = off
        ? `<span class="tag off">off</span> <button class="btn small" type="button" data-on="${esc(s.id)}">Switch on</button>`
        : `<button class="btn small" type="button" data-off="${esc(s.id)}">Switch off</button>`;
      // a switched-off person cannot be enrolled until they are switched back on
      const enrolCell = off ? "" : `<button class="btn small" type="button" data-en="${esc(s.id)}">Enrol</button>`;
      return `<tr${off ? ` class="isOff"` : ""}><td class="dimOff"><div class="staffCell"><span class="avatarCircle">${esc(initials(s.name))}</span><div><b>${esc(s.name)}</b>${s.officialName ? `<br><small class="muted">${esc(s.officialName)}</small>` : ""}</div></div></td><td class="dimOff">${sampleBadge}</td><td class="dimOff">${hasStaffPin(s) ? `<span class="tag ok">yes</span>` : "—"}</td><td class="activeCell">${activeCell}</td><td>${enrolCell}</td></tr>`;
    }).join("") || `<tr><td colspan="5" class="muted">${state.stFilter === "off" ? "Nobody is switched off." : (state.staff.size ? "No staff match this filter." : "Roster empty. Add staff with the box above, or refresh from the server.")}</td></tr>`;
    tb.querySelectorAll("button[data-en]").forEach(b => b.addEventListener("click", () => { showTab("enrol"); selectEnrol(b.dataset.en); }));
    tb.querySelectorAll("button[data-off]").forEach(b => b.addEventListener("click", () => {
      const st = state.staff.get(b.dataset.off);
      if (!st) return;
      if (!confirm(`Switch off ${st.name}? They will not be able to clock in until switched back on.`)) return;
      setStaffActive(st.id, false);
    }));
    tb.querySelectorAll("button[data-on]").forEach(b => b.addEventListener("click", () => setStaffActive(b.dataset.on, true)));
    DBX.getMeta("rosterAt", "").then(at => $("stInfo").textContent = at ? `roster refreshed ${new Date(at).toLocaleString()}` : "roster never refreshed");
  }
  if ($("stSearch")) $("stSearch").addEventListener("input", renderStaff);
  document.querySelectorAll("#stFilter .chip").forEach(btn => btn.addEventListener("click", () => {
    state.stFilter = btn.dataset.sf;
    document.querySelectorAll("#stFilter .chip").forEach(c => c.classList.toggle("on", c === btn));
    renderStaff();
  }));

  async function refreshRoster(restore) {
    try {
      toast("Contacting server…");
      const r = await Sync.roster(restore);
      await loadData();
      renderStaff(); renderEnrolList($("enSearch").value); renderSettings();
      toast(`Roster: ${r.staff} staff${r.off ? `, ${r.off} switched off` : ""}${restore ? `, ${r.restored} enrolment samples restored` : ""}`);
    } catch (e) { toast("Roster failed: " + e.message, true); }
  }
  $("stRefresh").addEventListener("click", () => refreshRoster(false));

  // Switch a person off or back on at the door. A switched-off person is not matched by face or
  // PIN and is not offered for enrolment; their enrolment rows stay on the tablet. The switch is
  // queued (pending + activeSet, srev bumped) and the next sync carries it to the server.
  async function setStaffActive(id, on) {
    const st = await DBX.setStaffActive(id, !!on);
    if (!st) { toast("Unknown staff id", true); return null; }
    if (!on) {
      if (state.enrol.staffId === id) {
        state.enrol = { staffId: null, samples: [], pin: null };
        $("enWho").textContent = "Pick a staff member on the left.";
        ["enCapture", "enClear", "enPin", "enConsent", "enSave"].forEach(x => $(x).disabled = true);
        $("enPinState").textContent = "";
        renderSamples();
      }
      if (state.manualStaff === id) state.manualStaff = null;
      if (state.streak.staffId === id) resetStreak();
      if (state.live && state.live.staffId === id) state.live = null;
    }
    await loadData();   // reloads the roster and refreshes the kiosk HUD counters
    renderStaff(); renderEnrolList($("enSearch").value);
    toast(on ? `${st.name} switched on` : `${st.name} switched off`);
    Sync.run("staff").catch(() => {});
    return st;
  }

  // Add a person on this tablet. They can be enrolled and can punch straight away; the next
  // sync sends them to the server, which then includes them in every roster for this site.
  async function addLocalStaff(rawName) {
    const name = String(rawName || "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (name.length < 2) { toast("Type the staff member's name first", true); return null; }
    const dup = [...state.staff.values()].some(s => s.active !== false && String(s.name || "").toLowerCase() === name.toLowerCase());
    if (dup) { toast(`${name} is already on the roster`, true); return null; }
    const st = { id: "loc-" + uuid(), name, officialName: "", active: true, pending: 1 };
    await DBX.saveStaff(st);
    await loadData();
    renderStaff(); renderEnrolList($("enSearch").value);
    toast(`${name} added. Enrol a face or a PIN next.`);
    Sync.run("staff").catch(() => {});
    return st;
  }
  if ($("stAdd")) {
    const submitNewStaff = async () => { const st = await addLocalStaff($("stNewName").value); if (st) $("stNewName").value = ""; };
    $("stAdd").addEventListener("click", submitNewStaff);
    $("stNewName").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submitNewStaff(); } });
  }

  // ----- log & shift pairing -----
  function fmtDur(ms) {
    const mins = Math.max(0, Math.round(ms / 60000));
    const h = Math.floor(mins / 60), m = mins % 60;
    return h > 0 ? `${h}h ${pad(m)}m` : `${m}m`;
  }

  function computeShifts(dayRows) {
    const asc = [...dayRows].filter(p => !p.void).sort((a, b) => a.ts.localeCompare(b.ts));
    const byStaff = new Map();
    asc.forEach(p => {
      if (!byStaff.has(p.staffId)) byStaff.set(p.staffId, { staffId: p.staffId, name: p.staffName, events: [] });
      byStaff.get(p.staffId).events.push(p);
    });
    const out = [];
    byStaff.forEach(g => {
      let totalMs = 0, openIn = null, firstIn = null, lastOut = null;
      g.events.forEach(ev => {
        if (ev.direction === "in") {
          if (!firstIn) firstIn = ev.ts;
          if (!openIn) openIn = ev.ts;
        } else if (ev.direction === "out") {
          lastOut = ev.ts;
          if (openIn) { totalMs += Math.max(0, new Date(ev.ts) - new Date(openIn)); openIn = null; }
        }
      });
      const lastEv = g.events[g.events.length - 1];
      const onSite = lastEv && lastEv.direction === "in";
      out.push({
        staffId: g.staffId,
        name: g.name,
        onSite,
        firstIn,
        lastOut,
        totalMs,
        eventsCount: g.events.length,
      });
    });
    return out.sort((a, b) => (b.onSite - a.onSite) || a.name.localeCompare(b.name));
  }

  async function renderLog() {
    const day = $("logDay").value || nowLocal().day;
    const allDayRows = (await DBX.punchesForDay(day)).sort((a, b) => b.ts.localeCompare(a.ts));
    const shifts = computeShifts(allDayRows);
    const onSiteList = shifts.filter(s => s.onSite);
    const inCount = allDayRows.filter(p => p.direction === "in").length;
    const outCount = allDayRows.filter(p => p.direction === "out").length;

    if ($("kpiLogOnSite")) $("kpiLogOnSite").textContent = String(onSiteList.length);
    if ($("kpiLogOnSiteSub")) $("kpiLogOnSiteSub").textContent = onSiteList.length ? onSiteList.map(s => s.name).join(", ") : "No staff currently clocked in";
    if ($("kpiLogStaff")) $("kpiLogStaff").textContent = String(shifts.length);
    if ($("kpiLogStaffSub")) $("kpiLogStaffSub").textContent = `Active on ${day}`;
    if ($("kpiLogEvents")) $("kpiLogEvents").textContent = String(allDayRows.length);
    if ($("kpiLogEventsSub")) $("kpiLogEventsSub").textContent = `${inCount} IN · ${outCount} OUT`;

    // Render shift summary cards
    if ($("logShiftsBody")) {
      if ($("logShiftsSummary")) $("logShiftsSummary").textContent = `${shifts.length} staff active · ${onSiteList.length} currently on-site`;
      $("logShiftsBody").innerHTML = shifts.map(s => `
        <div class="shiftCard">
          <div class="shiftCardTop">
            <span>${esc(s.name)}</span>
            <span class="tag ${s.onSite ? "in" : "out"}">${s.onSite ? "ON-SITE" : "OUT"}</span>
          </div>
          <div class="shiftTimes">First IN: ${s.firstIn ? fmtTime(s.firstIn) : "—"} · Last OUT: ${s.lastOut ? fmtTime(s.lastOut) : (s.onSite ? "Active" : "—")}</div>
          <div class="shiftDur">${s.totalMs > 0 ? `Completed shift: ${fmtDur(s.totalMs)}` : (s.onSite && s.firstIn ? `Clocked in at ${fmtTime(s.firstIn)}` : `${s.eventsCount} event(s)`)}</div>
        </div>
      `).join("") || `<div class="muted">No shift activity recorded on ${day}.</div>`;
    }

    // Filter rows for table if user searched/filtered
    const q = ($("logSearch") ? $("logSearch").value : "").trim().toLowerCase();
    let rows = allDayRows.filter(p => !q || (p.staffName || "").toLowerCase().includes(q));
    if (state.logFilter === "in") rows = rows.filter(p => p.direction === "in");
    else if (state.logFilter === "out") rows = rows.filter(p => p.direction === "out");
    else if (state.logFilter === "unsynced") rows = rows.filter(p => !p.synced);

    const tb = $("logTable").querySelector("tbody");
    tb.innerHTML = rows.map(p => `<tr data-id="${p.id}"><td>${p.snapshot ? `<img src="${p.snapshot}" alt="" data-snap="${p.id}">` : ""}</td><td><b>${esc(p.staffName)}</b></td><td>${fmtTime(p.ts)}</td><td><span class="tag ${p.direction}">${p.direction.toUpperCase()}</span></td><td>${p.method}${p.confidence != null ? ` <small class="muted">${p.confidence}</small>` : ""}${p.note ? ` <span class="tag ${/weak/.test(p.note) ? "warn" : ""}">${esc(p.note)}</span>` : ""}</td><td><span class="tag ${p.synced ? "ok" : "pending"}">${p.synced ? "synced" : "pending"}</span></td><td><button class="btn small" data-flip="${p.id}">Flip</button> ${p.synced ? "" : `<button class="btn small danger" data-del="${p.id}">Delete</button>`}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">No punches on ${day}.</td></tr>`;

    tb.querySelectorAll("img[data-snap]").forEach(img => img.addEventListener("click", () => {
      const p = allDayRows.find(x => x.id === img.dataset.snap);
      if (!p || !$("photoModal")) return;
      $("photoModalImg").src = p.snapshot;
      $("photoModalMeta").textContent = `${p.staffName} · Clocked ${p.direction.toUpperCase()} at ${fmtTime(p.ts)} (${p.day}) · via ${p.method}${p.confidence != null ? ` (dist ${p.confidence})` : ""}`;
      $("photoModal").classList.add("open");
    }));
    tb.querySelectorAll("button[data-flip]").forEach(b => b.addEventListener("click", async () => {
      const p = await DBX.getPunch(b.dataset.flip); if (!p) return; p.direction = p.direction === "in" ? "out" : "in"; p.synced = 0; p.rev = (p.rev || 0) + 1; await DBX.savePunch(p); renderLog(); updateSyncDot(); updateKioskHud(); Sync.run("flip").catch(() => {});
    }));
    tb.querySelectorAll("button[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this punch?")) return;
      await DBX.deletePunch(b.dataset.del); renderLog(); updateSyncDot(); updateKioskHud();
    }));
    const n = await DBX.unsyncedCount();
    const l = Sync.last;
    if ($("kpiLogSync")) $("kpiLogSync").textContent = n ? `${n} Pending` : "Synced";
    $("logInfo").textContent = `${n} pending · ${l.at ? `last sync ${l.at.toLocaleTimeString()}: ${l.msg}` : "never synced"}`;
  }

  $("logDay").addEventListener("change", renderLog);
  function shiftLogDay(deltaDays) {
    const cur = $("logDay").value || nowLocal().day;
    const d = new Date(cur + "T12:00:00");
    d.setDate(d.getDate() + deltaDays);
    $("logDay").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    renderLog();
  }
  if ($("logPrev")) $("logPrev").addEventListener("click", () => shiftLogDay(-1));
  if ($("logNext")) $("logNext").addEventListener("click", () => shiftLogDay(1));
  if ($("logToday")) $("logToday").addEventListener("click", () => { $("logDay").value = nowLocal().day; renderLog(); });
  if ($("logSearch")) $("logSearch").addEventListener("input", renderLog);
  document.querySelectorAll("#logFilter .chip").forEach(btn => btn.addEventListener("click", () => {
    state.logFilter = btn.dataset.lf;
    document.querySelectorAll("#logFilter .chip").forEach(c => c.classList.toggle("on", c === btn));
    renderLog();
  }));
  if ($("logShiftsToggle")) {
    $("logShiftsToggle").addEventListener("click", () => {
      const p = $("logShiftsPanel");
      if (!p) return;
      p.hidden = !p.hidden;
      $("logShiftsToggle").classList.toggle("primary", !p.hidden);
    });
  }
  if ($("logExport")) {
    $("logExport").addEventListener("click", async () => {
      const day = $("logDay").value || nowLocal().day;
      const rows = (await DBX.punchesForDay(day)).sort((a, b) => a.ts.localeCompare(b.ts));
      if (!rows.length) { toast("No punches on " + day + " to export", true); return; }
      const qCsv = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
      const csv = [
        ["Date", "Time", "Staff Name", "Direction", "Method", "Match Distance", "Synced", "Notes"].join(","),
        ...rows.map(p => [p.day, fmtTime(p.ts), qCsv(p.staffName), p.direction.toUpperCase(), p.method, p.confidence ?? "", p.synced ? "Yes" : "No", qCsv(p.note)].join(",")),
      ].join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `attendance-${state.site.toLowerCase()}-${day}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported ${rows.length} events for ${day}`);
    });
  }
  if ($("photoModalClose")) $("photoModalClose").addEventListener("click", () => $("photoModal").classList.remove("open"));
  if ($("photoModal")) $("photoModal").addEventListener("click", e => { if (e.target === $("photoModal")) $("photoModal").classList.remove("open"); });

  $("logSync").addEventListener("click", async () => { await Sync.run("manual"); renderLog(); });
  $("logManual").addEventListener("click", () => { state.manualStaff = null; $("mnIn").disabled = $("mnOut").disabled = true; renderManualList(""); $("manual").classList.add("open"); });
  function renderManualList(q) {
    const el = $("mnList");
    el.innerHTML = staffMatches(q).map(s => `<div data-id="${esc(s.id)}" class="${s.id === state.manualStaff ? "sel" : ""}">${esc(s.name)}</div>`).join("");
    el.querySelectorAll("div[data-id]").forEach(d => d.addEventListener("click", () => { state.manualStaff = d.dataset.id; $("mnIn").disabled = $("mnOut").disabled = false; renderManualList($("mnSearch").value); }));
  }
  $("mnSearch").addEventListener("input", e => renderManualList(e.target.value));
  $("mnCancel").addEventListener("click", () => $("manual").classList.remove("open"));
  async function manualPunch(direction) {
    if (!state.manualStaff) return;
    // the list only offers active people; a person switched off after being picked is refused too
    const who = state.staff.get(state.manualStaff);
    if (!who || who.active === false) { toast("This person is switched off. Switch them on in the Staff tab first.", true, 4500); return; }
    const p = await punch(state.manualStaff, "manual", null, null, direction, "manager entry");
    clearTimeout(state.cardTimer); $("card").className = "card hidden"; state.busy = true;   // stay in manager
    $("manual").classList.remove("open");
    if (p) toast(`Manual ${direction.toUpperCase()} saved for ${p.staffName}`);
    renderLog();
  }
  $("mnIn").addEventListener("click", () => manualPunch("in"));
  $("mnOut").addEventListener("click", () => manualPunch("out"));

  // ----- settings -----
  async function renderSettings() {
    const sel = $("setSite");
    sel.innerHTML = Object.entries(C.sites).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join("");
    sel.value = state.site;
    $("setDevice").value = await DBX.getMeta("device", "");
    $("setThreshold").value = state.threshold;
    $("setLive").checked = state.liveness;
    if ($("setRedacted")) $("setRedacted").checked = state.redactedMode;
    if ($("setSound")) $("setSound").checked = state.sound;
    const pending = await DBX.unsyncedCount();
    const l = Sync.last;
    const hasKey = !!(await DBX.getMeta("apiKey", ""));
    if ($("setKey")) $("setKey").placeholder = hasKey ? "Saved. Type a new key to replace it" : "Station key for this tablet";
    if ($("setKeyScan")) $("setKeyScan").hidden = !window.BarcodeDetector;   // scanning needs the browser's QR reader
    $("setInfo").textContent = [
      `version ${C.version} · face backend ${Face.backend} · detector ${Face.detector} · landmarks ${Face.landmarks} · models ${Face.ready ? "ready" : "loading"}`,
      `roster ${state.staff.size} staff · ${state.faces.length} raw vectors on device · redacted 1:N ${state.redactedMode ? "ON" : "off"} · ${pending} punches pending`,
      `match threshold ${state.threshold} (default ${C.match.threshold}) · runner-up margin ${C.match.margin} · min face ${Math.round(C.match.minFaceFrac * 100)}% of frame · confirm ${C.match.confirmFrames} frames · liveness ${state.liveness ? "ON (passive blink/3D + PAD)" : "off (PAD active)"}`,
      `online ${navigator.onLine} · last sync ${l.at ? l.at.toLocaleString() + " " + (l.ok === false ? "FAILED " : "") + l.msg : "never"}`,
      (ep => {
        let host = "";
        try { host = new URL(ep.url).host; } catch (e) { /* no endpoint */ }
        return host
          ? `sync endpoint for ${(C.sites[state.site] || {}).name || state.site}: ${host}${ep.perSite ? " (site-specific)" : ""} · station key ${hasKey ? "saved" : "NOT SET: type it in the Cloud Sync card"}`
          : `⚠ no sync endpoint for site ${state.site}`;
      })(Sync.endpointFor(state.site)),
      `service worker ${navigator.serviceWorker && navigator.serviceWorker.controller ? "active" : "none"} · screen wake lock ${state.wake ? "held" : "not held"}`,
      state.defaultPin ? "⚠ manager PIN is the factory default — change it now" : "manager PIN set",
    ].join("\n");
  }
  async function applyRedactedModeTransition(nextRedacted) {
    const wasRedacted = state.redactedMode || !!(await DBX.getMeta("redactedMode", false));
    if (nextRedacted) {
      if (!navigator.onLine) {
        await DBX.setMeta("redactedMode", false);
        state.redactedMode = false;
        if ($("setRedacted")) $("setRedacted").checked = false;
        toast("Connect online first to sync and verify server 1:N support", true);
        return { ok: false, error: "offline" };
      }
      const sr = await Sync.run("redact-enable");
      if (sr && sr.ok === false) {
        await DBX.setMeta("redactedMode", false);
        state.redactedMode = false;
        if ($("setRedacted")) $("setRedacted").checked = false;
        toast("Sync failed; kept local biometrics (" + sr.msg + ")", true);
        return { ok: false, error: "sync-failed" };
      }
      try {
        const probeRes = await Sync.verify({ method: "face", descriptor: new Array(128).fill(0), threshold: state.threshold });
        if (!probeRes || probeRes.ok !== true) throw new Error("verify-unsupported");
      } catch (err) {
        await DBX.setMeta("redactedMode", false);
        state.redactedMode = false;
        if ($("setRedacted")) $("setRedacted").checked = false;
        toast("Server does not support 1:N redacted verify; local templates kept", true);
        return { ok: false, error: "verify-unsupported" };
      }
      await DBX.setMeta("redactedMode", true);
      await DBX.scrubLocalBiometrics();
      state.redactedMode = true;
      return { ok: true, redacted: true };
    }
    await DBX.setMeta("redactedMode", false);
    state.redactedMode = false;
    if (wasRedacted && navigator.onLine) {
      await Sync.roster(true).catch(() => {});
    }
    return { ok: true, redacted: false };
  }

  $("setSave").addEventListener("click", async () => {
    const siteChanged = $("setSite").value !== state.site;
    const nextRedacted = $("setRedacted") ? $("setRedacted").checked : state.redactedMode;
    await DBX.setMeta("site", $("setSite").value);
    await DBX.setMeta("device", $("setDevice").value.trim());
    const t = parseFloat($("setThreshold").value);
    await DBX.setMeta("threshold", (t > 0.2 && t < 0.8) ? String(t) : "");
    await DBX.setMeta("liveness", $("setLive").checked);
    if ($("setSound")) await DBX.setMeta("sound", $("setSound").checked);
    const redRes = await applyRedactedModeTransition(nextRedacted);
    await loadData();
    renderSettings();
    if (redRes.ok) toast("Settings saved");
    if (siteChanged) autoRoster(true);   // a new site = a new roster
  });
  // Pull the roster without anyone pressing a button: on boot when it is empty
  // or stale, and whenever the site changes. Skipped under automation
  // (navigator.webdriver) so the headless smoke never touches the real API.
  async function autoRoster(force) {
    if (navigator.webdriver || !navigator.onLine || !(await Sync.ready())) return;
    const at = Date.parse(await DBX.getMeta("rosterAt", "")) || 0;
    const stale = Date.now() - at > C.sync.rosterMaxAgeHours * 3600 * 1000;
    if (force || !state.staff.size || stale) await refreshRoster(false);
  }
  $("setSync").addEventListener("click", async () => { const r = await Sync.run("manual"); toast(r.msg, r.ok === false); renderSettings(); });
  // The station key is typed once per tablet by the manager and is never shown again.
  // One function applies a key, whether it was typed, pasted or scanned. The Command Center shows a
  // new key as text and as a QR code whose text is ISABIKEY1|<SITE>|<scope>|<key>; a plain key
  // (no prefix) is taken as typed. The key itself is never logged or shown in a message.
  const KEY_QR_PREFIX = "ISABIKEY1|";
  const siteLabel = code => {
    const c = String(code || "");
    if (C.sites[c]) return C.sites[c].name;
    return /^[A-Za-z0-9_-]{2,16}$/.test(c) ? c : "another site";   // never echo arbitrary payload text
  };
  async function applyKeyPayload(raw) {
    const text = String(raw == null ? "" : raw).trim();
    let key = text;
    let newSite = "";
    if (text.slice(0, KEY_QR_PREFIX.length).toUpperCase() === KEY_QR_PREFIX) {
      const parts = text.split("|");
      const site = String(parts[1] || "").trim().toUpperCase();
      const scope = String(parts[2] || "").trim().toLowerCase();
      key = parts.slice(3).join("|").trim();
      if (parts.length < 4 || !site || !scope || !key) {
        toast("This QR code is not a complete station key", true);
        return { ok: false, reason: "format" };
      }
      if (scope !== "attendance") {
        toast("This key is for a till, not for the attendance tablet", true, 5000);
        return { ok: false, reason: "scope" };
      }
      const cur = String(await DBX.getMeta("site", C.defaultSite) || "");
      if (site !== cur.toUpperCase()) {
        const known = Object.keys(C.sites).find(k => k.toUpperCase() === site) || "";
        const empty = known && (await DBX.punchCount()) === 0 && (await DBX.allStaff()).length === 0;
        if (!empty) {
          toast(`This key is for ${siteLabel(known || site)}, but this tablet is set to ${siteLabel(cur)}. Key not saved.`, true, 7000);
          return { ok: false, reason: "site" };
        }
        newSite = known;   // a fresh tablet takes the site the key was made for
      }
    }
    if (key.length < 12) { toast("The station key is at least 12 characters", true); return { ok: false, reason: "short" }; }
    if (newSite) await DBX.setMeta("site", newSite);
    await DBX.setMeta("apiKey", key);
    if ($("setKey")) $("setKey").value = "";
    if (newSite) await loadData();
    await renderSettings();
    toast(newSite ? `Station key saved. This tablet is now set to ${siteLabel(newSite)}.` : "Station key saved", false, newSite ? 5000 : 0);
    const r = await Sync.run("key");
    if (r && r.ok === false) toast("Key saved, but the server answered: " + r.msg, true);
    else autoRoster(true);
    return { ok: true, site: state.site, siteChanged: !!newSite };
  }
  if ($("setKeySave")) $("setKeySave").addEventListener("click", () => applyKeyPayload($("setKey").value));

  // ----- station key QR scanner (only where the browser has BarcodeDetector) -----
  // The scanner takes the camera for itself: the kiosk / enrol stream is stopped first and started
  // again when the scanner closes, whichever way it closes.
  function restoreKioskCamera() {
    (async () => {
      for (let i = 0; keyScan.gumPending > 0 && i < 80; i++) await wait(100);   // let a late camera grant be released first
      await wait(350);                                                      // camera teardown on the tablet
      if (keyScan.open) return;                                             // reopened meanwhile: that session restores on its own close
      // hidden (tablet locked, app left): do not take the camera in the background; the
      // visibilitychange handler starts it again when the app is back in view
      if (document.visibilityState !== "visible") return;
      await startCamera(true);
      if (state.mgrOpen) { const v = $("enVideo"); if (v.srcObject && v.paused) v.play().catch(() => {}); }
    })().catch(() => {});
  }
  function closeKeyScanner(msg, bad) {
    if (!keyScan.open) return;
    keyScan.open = false;
    keyScan.session++;
    clearInterval(keyScan.timer); keyScan.timer = null;
    const s = keyScan.stream; keyScan.stream = null;
    if (s) { try { s.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ } }
    try { const v = $("keyScanVideo"); v.pause(); v.srcObject = null; } catch (e) { /* ignore */ }
    keyScan.det = null;
    $("keyScan").classList.remove("open");
    if (msg) toast(msg, !!bad, 4500);
    restoreKioskCamera();
  }
  async function keyScanTick() {
    if (!keyScan.open || keyScan.busy || !keyScan.det) return;
    const v = $("keyScanVideo");
    if (v.readyState < 2 || !v.videoWidth) return;
    keyScan.busy = true;
    let hit = "";
    try {
      const codes = await keyScan.det.detect(v);
      if (!keyScan.open) return;
      const texts = (codes || []).map(c => String((c && c.rawValue) || "").trim());
      hit = texts.find(t => t.startsWith(KEY_QR_PREFIX)) || "";
      if (!hit && texts.length) $("keyScanMsg").textContent = "That QR code is not a station key";
    } catch (e) {
      closeKeyScanner("Scanner stopped: " + ((e && e.name) || "error") + ". Type the key instead.", true);
      return;
    } finally {
      keyScan.busy = false;
    }
    if (!hit) return;
    // the first station key code ends the scan: close (camera released) and apply it
    closeKeyScanner();
    try { await applyKeyPayload(hit); }
    catch (e) { toast("The key could not be saved. Try again or type it.", true, 4500); }
  }
  async function openKeyScanner() {
    if (keyScan.open) return;
    if (!("BarcodeDetector" in window)) { toast("This tablet cannot scan QR codes. Type the key instead.", true); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("Camera needs HTTPS (or localhost)", true); return; }
    const session = ++keyScan.session;
    const mine = () => keyScan.open && keyScan.session === session;
    keyScan.open = true;
    stopTest();
    $("keyScanMsg").textContent = "Starting camera...";
    $("keyScan").classList.add("open");
    try {
      for (let i = 0; camStarting && i < 50; i++) await wait(100);   // a kiosk camera start in progress finishes first
      if (!mine()) return;                                           // cancelled while waiting: leave the kiosk camera alone
      stopKioskCamera();
      await wait(350);
      if (!mine()) return;
      const det = new BarcodeDetector({ formats: ["qr_code"] });
      let stream = null;
      keyScan.gumPending++;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } finally {
        keyScan.gumPending--;
      }
      if (!mine()) { try { stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ } return; }
      keyScan.stream = stream;
      keyScan.det = det;
      stream.getVideoTracks().forEach(t => t.addEventListener("ended", () => {
        if (keyScan.open && keyScan.stream === stream) closeKeyScanner("Camera stopped. Try again or type the key.", true);
      }));
      const v = $("keyScanVideo");
      v.srcObject = stream;
      await v.play().catch(() => {});
      if (!mine()) return;
      $("keyScanMsg").textContent = "Hold the QR code in front of the camera";
      keyScan.timer = setInterval(keyScanTick, 250);
    } catch (e) {
      if (keyScan.session === session) closeKeyScanner("Scanner could not start: " + ((e && (e.message || e.name)) || "camera error"), true);
    }
  }
  if ($("setKeyScan")) $("setKeyScan").addEventListener("click", () => openKeyScanner());
  if ($("keyScanCancel")) $("keyScanCancel").addEventListener("click", () => closeKeyScanner());
  $("setRoster").addEventListener("click", () => refreshRoster(false));
  $("setRestore").addEventListener("click", () => refreshRoster(true));
  $("setMgrPin").addEventListener("click", () => {
    Keypad.open("New manager PIN", async pin => { if (pin === null) return; await setManagerPin(pin); toast("Manager PIN changed"); renderSettings(); return true; });
  });
  $("setFull").addEventListener("click", () => { const el = document.documentElement; (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el); });
  function calibrationReport() { return Face.calibration(usableFaces(), staffNames(), state.threshold); }
  $("setCalib").addEventListener("click", () => {
    if (state.redactedMode && usableFaces().length === 0) {
      $("calibOut").textContent = "Server-Redacted 1:N Mode is active (0 raw vectors stored on this tablet). Run calibration prior to scrubbing or on the server.";
      return;
    }
    const r = calibrationReport();
    const lines = [
      `${r.persons} people with usable enrolments · ${r.samples} samples · threshold ${r.threshold} · margin ${r.margin}`,
      r.closestOther ? `closest two DIFFERENT people: ${r.closestOther.a} ↔ ${r.closestOther.b} at ${r.closestOther.distance}` : "fewer than two people enrolled — nothing to compare yet",
      `recommended threshold: ${r.recommend}${r.recommend !== r.threshold ? " (type it above and Save)" : " (current value is fine)"}`,
      ...r.warnings.map(w => "⚠ " + w),
      "",
      "per person (nearest other person first):",
      ...r.perPerson.map(p => `  ${p.name}: ${p.samples} samples, own spread ${p.spread}${p.nearest ? `, nearest other ${p.nearest.name} at ${p.nearest.distance}` : ""}`),
    ];
    $("calibOut").textContent = lines.join("\n");
  });
  $("setReset").addEventListener("click", async () => {
    const n = await DBX.unsyncedCount();
    if (!confirm(`Erase ALL data on this tablet (${n} unsynced punches will be lost)?`)) return;
    await DBX.wipe(); location.reload();
  });

  // ---------- sync indicator ----------
  async function updateSyncDot() {
    const n = await DBX.unsyncedCount();
    const l = Sync.last;
    const d = $("syncDot");
    const status = n ? (l.ok === false ? "bad" : "pending") : (l.ok === false ? "bad" : "ok");
    d.className = "syncDot " + status;
    d.title = `${n} pending · ${l.msg || ""}`;
    if ($("syncLabel")) {
      $("syncLabel").textContent = !navigator.onLine ? (n ? `Offline (${n})` : "Offline") : (n ? `${n} Pending` : (l.ok === false ? "Sync Err" : (/station key not set/.test(l.msg || "") ? "No Key" : "Synced")));
    }
    if ($("tabLogBadge")) {
      $("tabLogBadge").textContent = String(n);
      $("tabLogBadge").hidden = n === 0;
    }
    await updateAttendanceAppBadge();
  }
  if ($("syncPill")) $("syncPill").addEventListener("click", async () => { toast("Syncing with server…"); const r = await Sync.run("manual"); toast(r.msg, r.ok === false); });
  Sync.onChange(async () => {
    if (state.redactedMode) await loadData();
    else {
      // a sync clears the queued flags (pending, activeSet) on staff rows: clear them on the in-memory
      // copies too, so a later save of one of them does not queue a stale switch again
      try {
        (await DBX.allStaff()).forEach(r => {
          const m = state.staff.get(r.id);
          if (!m) return;
          if (r.pending !== 1) delete m.pending;
          if (r.activeSet !== true) delete m.activeSet;
        });
      } catch (e) { /* keep what we have */ }
    }
    updateSyncDot();
    if (state.mgrOpen) renderSettings();
  });

  // ---------- boot ----------
  function tickClock() {
    const n = nowLocal();
    $("clock").textContent = n.hhmm;
    if ($("clockSec")) $("clockSec").textContent = n.sec;
    if ($("clockDate")) $("clockDate").textContent = n.dateStr;
  }
  async function migrate() {
    // v0.1 stored the manager PIN in clear; hash it once.
    const plain = await DBX.getMeta("mgrPin", "");
    if (plain && !(await DBX.getMeta("mgrPinHash", ""))) await setManagerPin(plain);
    else if (plain) await DBX.delMeta("mgrPin");
    // v0.5.0: the server moved from the Power Automate flow to the ISABI cloud, which starts with no
    // knowledge of this tablet's staff or enrolments. Queue them once, before the first roster
    // refresh, so the first sync carries them over and nobody enrolled here is switched off.
    if (!(await DBX.getMeta("cloudMove050", false))) {
      await DBX.requeueForCloudMove();
      await DBX.setMeta("cloudMove050", true);
    }
    // v0.7.0: enable passive blink/3D liveness by default once on tablets that previously saved the old off default.
    if (!(await DBX.getMeta("livenessPassive070", false))) {
      await DBX.setMeta("liveness", true);
      await DBX.setMeta("livenessPassive070", true);
    }
  }
  async function boot() {
    tickClock(); setInterval(tickClock, 1000);
    await migrate();
    await loadData();
    updateSyncDot();
    autoRoster(false).catch(() => {});
    hint("Loading face models…");
    const camP = startCamera();
    let modelErr = null;
    try { await Face.load(); } catch (e) { modelErr = e; console.error("model load", e); }
    await camP;
    keepAwake();
    document.body.classList.remove("loading");
    if (modelErr) hint("Face models failed to load: " + (modelErr.message || modelErr), true);
    else hint((usableFaces().length || (state.redactedMode && enrolledStaffCount() > 0)) ? "Look at the camera" : "No enrolments yet — manager: ⚙");
    state.running = true;
    loop();
    Sync.start();
    Sync.run("boot").catch(() => {});
    // A wall tablet can stay up for weeks: check hourly whether the roster has gone stale (rosterMaxAgeHours)
    // so someone switched off in the staff register drops off this tablet without a reboot.
    setInterval(() => { autoRoster(false).catch(() => {}); }, 60 * 60 * 1000);
    if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
      const hadController = Boolean(navigator.serviceWorker.controller);
      navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded && navigator.serviceWorker.controller) { reloaded = true; location.reload(); } });
      navigator.serviceWorker.addEventListener("message", e => {
        const m = e && e.data;
        if (!m) return;
        if (m.notifCheckedId) markAttNotifChecked(m.notifCheckedId);
        if (m.type === "att-push" && m.payload) pushAttNotif(m.payload);
      });
    }
  }

  // ---------- test hooks (strictly quarantined to automated WebDriver sessions) ----------
  const IS_TEST_ENV = Boolean(navigator.webdriver);
  if (IS_TEST_ENV) {
    window.ATT_TEST = {
      state,
      ready: () => Face.ready,
      setFrameSource: el => { state.frameSource = el; },
      seedStaff: async list => { await DBX.replaceStaff(list); await loadData(); },
      addLocalStaff,
      setStaffActive,
      applyKeyPayload, openKeyScanner, closeKeyScanner, keyScan,
      migrate,
      renderLists: () => { renderStaff(); renderEnrolList(""); renderManualList(""); },
      descriptorsFromImage: async el => (await Face.detectAll(el)).map(r => ({ d: Array.from(r.descriptor), box: r.box, score: r.score, frac: r.frac })),
      injectDescriptor: (d, src, det) => handleDescriptor(Array.isArray(d) ? d : new Float32Array(d), src || null, det || null),
      detectFrame: async src => { const det = await Face.detectOne(src); return det ? handleDetection(det, src) : { matched: false, reason: "no-face" }; },
      selectEnrol, captureSample, saveEnrolment, renderLog, poseSvg, enrolFrame,
      setEnrolConsent: v => { $("enConsent").checked = v; renderSamples(); },
      setEnrolPin: async pin => { state.enrol.pin = { pin, hash: await sha256(pin) }; renderSamples(); },
      setManagerPin, managerPinOk,
      setLiveness: async v => { await DBX.setMeta("liveness", v); state.liveness = v; resetStreak(); resetLiveness(); },
      recordLivenessSample: entry => { state.livenessHist.push(entry); },
      resetLiveness,
      setRedactedMode: async v => {
        const res = await applyRedactedModeTransition(!!v);
        await loadData();
        return res;
      },
      setLiveMock: fn => { state.liveMock = fn; },
      calibration: calibrationReport,
      keypad: Keypad,
      punch, hideCard, loadData, openManager, closeManager, lastPunchRecent, recentPunches, startCamera, streamAlive,
      computeAttendanceNotifs, updateAttendanceAppBadge, markAttNotifChecked, markAllAttNotifsChecked, pushAttNotif,
      db: DBX, sync: Sync, face: Face,
    };
  }

  boot();
})();
