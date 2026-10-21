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
    sound: true,                    // per-device override lives in meta "sound"
    faces: [],            // [{id, staffId, d}] in memory for matching
    staff: new Map(),     // id -> {id, name, officialName, pinhash, active}
    stream: null,
    running: false,
    busy: false,          // card up / keypad open / manager open -> detection paused
    streak: { staffId: null, n: 0, dist: [] },
    unknown: 0,
    live: null,           // blink challenge in progress {staffId, distance, weak, until, closed}
    liveMock: null,       // tests replace the landmark reader
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
    let buf = "", cb = null, len = C.pinLength, fails = 0, lockedUntil = 0, title = "", lockTimer = null;
    const locked = () => Date.now() < lockedUntil;
    const remaining = () => Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
    function render() {
      $("kpDots").innerHTML = Array.from({ length: len }, (_, i) => `<i class="${i < buf.length ? "on" : ""}"></i>`).join("");
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
      buf = ""; cb = onDone; len = length || C.pinLength; title = t;
      render();
      $("keypad").classList.add("open");
      state.busy = true;
    }
    function close() { $("keypad").classList.remove("open"); buf = ""; cb = null; state.busy = false; }
    function shake() {
      Sound.play("warn");
      const d = $("kpDots"); d.classList.add("shake");
      setTimeout(() => { d.classList.remove("shake"); buf = ""; render(); }, 450);
    }
    async function pressKey(k) {
      if (k === "x") { const c = cb; close(); if (c) c(null); return; }
      if (locked()) { render(); return; }
      if (k === "b") { buf = buf.slice(0, -1); Sound.play("tap"); render(); return; }
      if (buf.length >= len) return;
      Sound.play("tap");
      buf += k; render();
      if (buf.length === len) {
        const pin = buf; const c = cb;
        const ok = await c(pin);
        if (ok === false) {
          fails++;
          if (fails >= C.pinLockAfter) {
            lockedUntil = Date.now() + C.pinLockSec * 1000;
            fails = 0;
            startLockTicker();
          }
          shake();
        } else { fails = 0; close(); }
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
    const snd = await DBX.getMeta("sound", null);
    state.sound = snd == null ? true : !!snd;
    state.defaultPin = !(await DBX.getMeta("mgrPinHash", ""));
    const staff = await DBX.allStaff();
    state.staff = new Map(staff.map(s => [s.id, s]));
    state.faces = (await DBX.allFaces()).filter(f => Array.isArray(f.d) && f.d.length === 128);
    const siteLabel = (C.sites[state.site] || {}).name || state.site;
    $("siteName").textContent = siteLabel;
    if ($("mgrSiteBadge")) $("mgrSiteBadge").textContent = siteLabel;
    if ($("kioskDevice")) $("kioskDevice").textContent = state.device || "";
    if ($("mgrPinBanner")) $("mgrPinBanner").hidden = !state.defaultPin;
    updateSoundUi();
    await updateKioskHud();
  }
  function usableFaces() {
    // only staff with >= minSamples samples and an active roster entry
    const count = new Map();
    state.faces.forEach(f => count.set(f.staffId, (count.get(f.staffId) || 0) + 1));
    return state.faces.filter(f => count.get(f.staffId) >= C.match.minSamples && (state.staff.get(f.staffId) || {}).active !== false);
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
      const missing = activeStaff.filter(s => sampleCount(s.id) < C.match.minSamples && !s.pinhash).length;
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

      const enrolledPersons = new Set(usableFaces().map(f => f.staffId)).size;
      const activeTotal = [...state.staff.values()].filter(s => s.active !== false).length;
      if ($("kioskStats")) {
        $("kioskStats").textContent = activeTotal
          ? `${enrolledPersons} / ${activeTotal} Face IDs Ready · ${todayRows.length} events today`
          : "Face ID & PIN Ready";
      }
      if ($("tabStaffBadge")) {
        const missing = [...state.staff.values()].filter(s => s.active !== false && sampleCount(s.id) < C.match.minSamples && !s.pinhash).length;
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
  const streamAlive = () => !!(state.stream && state.stream.getVideoTracks().some(t => t.readyState === "live"));
  async function startCamera() {
    if (streamAlive()) return;
    if (state.stream) { try { state.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ } state.stream = null; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { hint("Camera needs HTTPS (or localhost) — open the https:// address", true); return; }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      // phones end the track when the app is backgrounded or the screen locks: restart when it comes back
      state.stream.getVideoTracks().forEach(t => t.addEventListener("ended", () => { if (document.visibilityState === "visible") setTimeout(() => startCamera().catch(() => {}), 800); }));
      $("video").srcObject = state.stream;
      $("enVideo").srcObject = state.stream;
      await new Promise(r => { $("video").onloadedmetadata = r; setTimeout(r, 1500); });
      $("video").play().catch(() => {});
    } catch (e) {
      hint("Camera unavailable: " + (e.message || e), true);
    }
  }
  function resumeCamera() {
    if (!streamAlive()) { startCamera().catch(() => {}); return; }
    const v = $("video"); if (v.paused) v.play().catch(() => {});
  }
  async function keepAwake() {
    try { if ("wakeLock" in navigator && !state.wake) { state.wake = await navigator.wakeLock.request("screen"); state.wake.addEventListener("release", () => { state.wake = null; }); } } catch (e) { /* not granted */ }
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { keepAwake(); if (state.running) resumeCamera(); } });

  function resetStreak() { state.streak = { staffId: null, n: 0, dist: [] }; setStreakProgress(0); }

  // Frame-level gate (face size) then descriptor matching.
  async function handleDetection(det, src) {
    if (det.frac < C.match.minFaceFrac) {
      resetStreak(); drawOverlay(det, "far");
      if (!state.busy) hint("Come closer to the camera");
      return { matched: false, reason: "small", frac: det.frac };
    }
    return handleDescriptor(det.descriptor, src, det);
  }

  async function handleDescriptor(desc, src, det) {
    const faces = usableFaces();
    const m = faces.length ? Face.match(desc, faces) : null;
    const v = Face.decide(m, state.threshold);
    if (v.ok) {
      state.unknown = 0;
      if (state.streak.staffId === m.staffId) { state.streak.n++; state.streak.dist.push(m.distance); }
      else state.streak = { staffId: m.staffId, n: 1, dist: [m.distance] };
      const st = state.staff.get(m.staffId);
      drawOverlay(det, "ok");
      setStreakProgress(state.streak.n / C.match.confirmFrames);
      hint(`Hello ${st ? st.name : ""}…`, false, "ok");
      if (state.streak.n >= C.match.confirmFrames) {
        const mean = state.streak.dist.reduce((a, b) => a + b, 0) / state.streak.dist.length;
        const weak = mean > C.match.weakAbove;
        resetStreak();
        if (state.liveness) {
          state.live = { staffId: m.staffId, distance: mean, weak, until: Date.now() + C.liveness.windowSec * 1000, closed: false };
          hint("Please blink to confirm", false, "live");
          return { matched: true, staffId: m.staffId, distance: m.distance, liveness: "pending" };
        }
        await punch(m.staffId, "face", mean, src, null, weak ? `weak match ${r3(mean)}` : "");
      }
      return { matched: true, staffId: m.staffId, distance: m.distance, margin: m.margin };
    }
    resetStreak();
    state.unknown++;
    drawOverlay(det, v.reason === "ambiguous" ? "warn" : "unknown");
    if (state.unknown >= C.match.unknownFrames && !state.busy) {
      if (v.reason === "no-enrolments") hint("No enrolments yet — tap Use PIN", true);
      else if (v.reason === "ambiguous") hint("Can't tell you apart from a colleague — use your PIN", true);
      else hint("Not recognised — tap Use PIN", true);
    }
    return { matched: false, distance: m ? m.distance : null, reason: v.reason, margin: m ? m.margin : null };
  }

  // Blink challenge: fast landmark loop until the eyes close and reopen.
  async function livenessStep(src) {
    const L = state.live;
    if (Date.now() > L.until) {
      state.live = null; drawOverlay(null);
      hint("Blink not seen — try again or use PIN", true);
      return 400;
    }
    const r = state.liveMock ? state.liveMock() : await Face.landmarksOnly(src);
    if (r && r.ear != null) {
      drawOverlay(r, "live");
      if (r.ear < C.liveness.earClosed) L.closed = true;
      else if (L.closed && r.ear > C.liveness.earOpen) {
        state.live = null;
        await punch(L.staffId, "face", L.distance, src, null, (L.weak ? `weak match ${r3(L.distance)}; ` : "") + "blink ok");
        return 400;
      }
    }
    return 60;
  }

  async function loop() {
    if (!state.running) return;
    let delay = 400;
    try {
      if (!state.busy && Face.ready) {
        const src = state.frameSource || $("video");
        const ok = state.frameSource || (src.readyState >= 2 && src.videoWidth > 0);
        if (ok) {
          if (state.live) delay = await livenessStep(src);
          else {
            const det = await Face.detectOne(src);
            if (det) { await handleDetection(det, src); delay = 250; }
            else { resetStreak(); drawOverlay(null); if (state.unknown) state.unknown = 0; if (!state.busy) hint("Look at the camera"); }
          }
        }
      }
    } catch (e) { console.error(e); }
    setTimeout(loop, delay);
  }

  // ---------- staff PIN ----------
  $("btnPin").addEventListener("click", () => {
    state.live = null;
    Keypad.open("Enter your PIN", async pin => {
      if (pin === null) return;
      const h = await sha256(pin);
      const st = [...state.staff.values()].find(s => s.pinhash === h && s.active !== false);
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
    state.live = null;
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
    state.mgrOpen = true; state.busy = true; state.live = null;
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
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    cv.getContext("2d").drawImage(v, 0, 0);
    return cv;
  }

  // ----- enrol -----
  function staffMatches(q) {
    q = (q || "").trim().toLowerCase();
    return [...state.staff.values()].filter(s => s.active !== false && (!q || s.name.toLowerCase().includes(q) || (s.officialName || "").toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  function sampleCount(staffId) { return state.faces.filter(f => f.staffId === staffId).length; }

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
    else if (state.enFilter === "pin") list = list.filter(s => !!s.pinhash);

    el.innerHTML = list.map(s => `<div data-id="${s.id}" class="${s.id === state.enrol.staffId ? "sel" : ""}">${esc(s.name)}<small>${sampleCount(s.id)} samples${s.pinhash ? " · PIN" : ""}</small></div>`).join("") || `<div class="muted">No staff in the roster. Settings → Refresh roster.</div>`;
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
    $("enWho").textContent = `${st.name}${st.officialName ? " (" + st.officialName + ")" : ""} — ${sampleCount(id)} sample(s) stored`;
    ["enCapture", "enClear", "enPin", "enConsent"].forEach(x => $(x).disabled = false);
    $("enConsent").checked = false;
    $("enPinState").textContent = st.pinhash ? "PIN already set (Set PIN replaces it)" : "no PIN";
    renderEnrolList($("enSearch").value);
    renderSamples();
    if (window.innerWidth <= 860 && !navigator.webdriver) { const stu = document.querySelector(".enrolStudio"); if (stu && stu.scrollIntoView) stu.scrollIntoView({ behavior: "smooth", block: "start" }); }
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
    src = src || enrolFrame();
    if (!src) { toast("Camera not ready — wait a second and try again", true); return false; }
    const det = await Face.detectOne(src);
    // a turned pose that finds no face is almost always a FULL turn (profile hides an eye)
    const turning = ["left", "right"].includes(poseIcon(Math.min(state.enrol.samples.length, C.match.poses.length - 1)));
    if (!det) { toast(turning ? "No face found — turn only a little, both eyes must stay in view" : "No face found — look straight at the camera", true); return false; }
    if (det.frac < C.match.minFaceFrac) { toast("Too far — come closer to the camera", true); return false; }
    if (det.score < C.match.enrolScore) { toast(turning ? "Face not clear enough — turn less, more light" : "Face not clear enough — more light, look straight", true); return false; }
    // reject a sample that already matches someone ELSE's enrolment
    const other = usableFaces().filter(f => f.staffId !== state.enrol.staffId);
    const m = other.length ? Face.match(det.descriptor, other) : null;
    if (m && m.distance <= state.threshold * 0.8) {
      const who = state.staff.get(m.staffId);
      toast(`This face already matches ${who ? who.name : "another person"}`, true);
      return false;
    }
    state.enrol.samples.push({ d: Array.from(det.descriptor), thumb: snapshot(src) });
    Sound.play("capture");
    renderSamples();
    return true;
  }
  $("enCapture").addEventListener("click", () => captureSample());
  $("enClear").addEventListener("click", async () => {
    state.enrol.samples = [];
    if (state.enrol.staffId && sampleCount(state.enrol.staffId)) {
      if (!confirm("Also delete the stored samples on this tablet? (server copies stay)")) { renderSamples(); return; }
      for (const f of state.faces.filter(f => f.staffId === state.enrol.staffId)) await DBX.deleteFace(f.id);
      state.faces = state.faces.filter(f => f.staffId !== state.enrol.staffId);
      selectEnrol(state.enrol.staffId);
    }
    renderSamples();
  });
  $("enPin").addEventListener("click", () => {
    Keypad.open("New staff PIN", async pin => {
      if (pin === null) return;
      const h = await sha256(pin);
      const clash = [...state.staff.values()].find(s => s.pinhash === h && s.id !== state.enrol.staffId);
      if (clash) { toast("That PIN is already used by " + clash.name, true); return false; }
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
    const consentAt = e.samples.length ? new Date().toISOString() : "";
    const device = await DBX.getMeta("device", "");
    const pinhash = e.pin ? e.pin.hash : (st.pinhash || "");
    // replace previous samples for this person
    for (const f of state.faces.filter(f => f.staffId === e.staffId)) await DBX.deleteFace(f.id);
    state.faces = state.faces.filter(f => f.staffId !== e.staffId);
    const rows = e.samples.map((s, i) => ({ id: uuid(), staffId: e.staffId, staffName: st.name, d: s.d, sample: i + 1, consentAt, pinhash, ts: new Date().toISOString(), device, synced: 0 }));
    if (!rows.length && e.pin) rows.push({ id: uuid(), staffId: e.staffId, staffName: st.name, d: [], sample: 0, consentAt: "", pinhash, ts: new Date().toISOString(), device, synced: 0 });
    for (const r of rows) await DBX.saveFace(r);
    const sep = separation(e.staffId, rows.filter(r => r.d.length === 128));
    state.faces.push(...rows.filter(r => r.d.length === 128));
    if (e.pin) { st.pinhash = e.pin.hash; await DBX.saveStaff(st); }
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
        if (!det) big("wait", "No face in view");
        else if (det.frac < C.match.minFaceFrac) big("wait", "Come closer", `face is ${Math.round(det.frac * 100)}% of the frame, minimum ${Math.round(C.match.minFaceFrac * 100)}%`);
        else {
          // Unsaved captures of the person being enrolled count too (they replace that
          // person's stored samples on Save), so the manager can test before saving.
          const pend = state.enrol.staffId ? state.enrol.samples : [];
          const pendOk = pend.length >= C.match.minSamples;
          let faces = usableFaces();
          if (pendOk) faces = faces.filter(f => f.staffId !== state.enrol.staffId).concat(pend.map(s => ({ staffId: state.enrol.staffId, d: s.d, pending: true })));
          const m = faces.length ? Face.match(det.descriptor, faces) : null;
          const v = Face.decide(m, state.threshold);
          const nm = id => esc((state.staff.get(id) || {}).name || "?");
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
    const allRows = [...state.staff.values()].sort((a, b) => a.name.localeCompare(b.name));
    const active = allRows.filter(s => s.active !== false);
    const faceReady = active.filter(s => sampleCount(s.id) >= C.match.minSamples).length;
    const pinReady = active.filter(s => !!s.pinhash).length;
    const missing = active.filter(s => sampleCount(s.id) < C.match.minSamples && !s.pinhash).length;
    if ($("kpiStTotal")) $("kpiStTotal").textContent = String(active.length);
    if ($("kpiStFace")) $("kpiStFace").textContent = String(faceReady);
    if ($("kpiStFaceSub")) $("kpiStFaceSub").textContent = active.length ? `${Math.round((faceReady / active.length) * 100)}% of active roster` : "3 / 3 samples stored";
    if ($("kpiStPin")) $("kpiStPin").textContent = String(pinReady);
    if ($("kpiStMissing")) $("kpiStMissing").textContent = String(missing);

    const q = ($("stSearch") ? $("stSearch").value : "").trim().toLowerCase();
    let rows = allRows.filter(s => !q || s.name.toLowerCase().includes(q) || (s.officialName || "").toLowerCase().includes(q));
    if (state.stFilter === "face") rows = rows.filter(s => sampleCount(s.id) >= C.match.minSamples);
    else if (state.stFilter === "pin") rows = rows.filter(s => !!s.pinhash && sampleCount(s.id) < C.match.minSamples);
    else if (state.stFilter === "none") rows = rows.filter(s => sampleCount(s.id) < C.match.minSamples && !s.pinhash);

    const tb = $("stTable").querySelector("tbody");
    tb.innerHTML = rows.map(s => {
      const sc = sampleCount(s.id);
      const sampleBadge = sc >= C.match.minSamples
        ? `<span class="tag ok">${sc} / ${C.match.maxSamples} ready</span>`
        : (sc > 0 ? `${sc} <span class="tag warn">below ${C.match.minSamples}</span>` : `<span class="muted">0</span>`);
      return `<tr><td><div class="staffCell"><span class="avatarCircle">${esc(initials(s.name))}</span><div><b>${esc(s.name)}</b>${s.officialName ? `<br><small class="muted">${esc(s.officialName)}</small>` : ""}</div></div></td><td>${sampleBadge}</td><td>${s.pinhash ? `<span class="tag ok">yes</span>` : "—"}</td><td>${s.active === false ? `<span class="tag warn">no</span>` : "yes"}</td><td><button class="btn small" data-en="${s.id}">Enrol</button></td></tr>`;
    }).join("") || `<tr><td colspan="5" class="muted">Roster empty — refresh from the server.</td></tr>`;
    tb.querySelectorAll("button[data-en]").forEach(b => b.addEventListener("click", () => { showTab("enrol"); selectEnrol(b.dataset.en); }));
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
      toast(`Roster: ${r.staff} staff${restore ? `, ${r.restored} enrolment samples restored` : ""}`);
    } catch (e) { toast("Roster failed: " + e.message, true); }
  }
  $("stRefresh").addEventListener("click", () => refreshRoster(false));

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
    el.innerHTML = staffMatches(q).map(s => `<div data-id="${s.id}" class="${s.id === state.manualStaff ? "sel" : ""}">${esc(s.name)}</div>`).join("");
    el.querySelectorAll("div[data-id]").forEach(d => d.addEventListener("click", () => { state.manualStaff = d.dataset.id; $("mnIn").disabled = $("mnOut").disabled = false; renderManualList($("mnSearch").value); }));
  }
  $("mnSearch").addEventListener("input", e => renderManualList(e.target.value));
  $("mnCancel").addEventListener("click", () => $("manual").classList.remove("open"));
  async function manualPunch(direction) {
    if (!state.manualStaff) return;
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
    if ($("setSound")) $("setSound").checked = state.sound;
    const pending = await DBX.unsyncedCount();
    const l = Sync.last;
    $("setInfo").textContent = [
      `version ${C.version} · face backend ${Face.backend} · detector ${Face.detector} · landmarks ${Face.landmarks} · models ${Face.ready ? "ready" : "loading"}`,
      `roster ${state.staff.size} staff · ${state.faces.length} face samples on device · ${pending} punches pending`,
      `match threshold ${state.threshold} (default ${C.match.threshold}) · runner-up margin ${C.match.margin} · min face ${Math.round(C.match.minFaceFrac * 100)}% of frame · confirm ${C.match.confirmFrames} frames · liveness ${state.liveness ? "ON (blink)" : "off"}`,
      `online ${navigator.onLine} · last sync ${l.at ? l.at.toLocaleString() + " " + (l.ok === false ? "FAILED " : "") + l.msg : "never"}`,
      (ep => ep.url ? `API endpoint for ${(C.sites[state.site] || {}).name || state.site}: built in${ep.perSite ? " (site-specific key)" : ""}` : `⚠ no API endpoint for site ${state.site} — run scripts/att03_endpoints.py and redeploy`)(Sync.endpointFor(state.site)),
      `service worker ${navigator.serviceWorker && navigator.serviceWorker.controller ? "active" : "none"} · screen wake lock ${state.wake ? "held" : "not held"}`,
      state.defaultPin ? "⚠ manager PIN is the factory default — change it now" : "manager PIN set",
    ].join("\n");
  }
  $("setSave").addEventListener("click", async () => {
    const siteChanged = $("setSite").value !== state.site;
    await DBX.setMeta("site", $("setSite").value);
    await DBX.setMeta("device", $("setDevice").value.trim());
    const t = parseFloat($("setThreshold").value);
    await DBX.setMeta("threshold", (t > 0.2 && t < 0.8) ? String(t) : "");
    await DBX.setMeta("liveness", $("setLive").checked);
    if ($("setSound")) await DBX.setMeta("sound", $("setSound").checked);
    await loadData(); renderSettings(); toast("Settings saved");
    if (siteChanged) autoRoster(true);   // a new site = a new roster
  });
  // Pull the roster without anyone pressing a button: on boot when it is empty
  // or stale, and whenever the site changes. Skipped under automation
  // (navigator.webdriver) so the headless smoke never touches the real API.
  async function autoRoster(force) {
    if (navigator.webdriver || !navigator.onLine || !Sync.endpointFor(state.site).url) return;
    const at = Date.parse(await DBX.getMeta("rosterAt", "")) || 0;
    const stale = Date.now() - at > C.sync.rosterMaxAgeHours * 3600 * 1000;
    if (force || !state.staff.size || stale) await refreshRoster(false);
  }
  $("setSync").addEventListener("click", async () => { const r = await Sync.run("manual"); toast(r.msg, r.ok === false); renderSettings(); });
  $("setRoster").addEventListener("click", () => refreshRoster(false));
  $("setRestore").addEventListener("click", () => refreshRoster(true));
  $("setMgrPin").addEventListener("click", () => {
    Keypad.open("New manager PIN", async pin => { if (pin === null) return; await setManagerPin(pin); toast("Manager PIN changed"); renderSettings(); return true; });
  });
  $("setFull").addEventListener("click", () => { const el = document.documentElement; (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el); });
  function calibrationReport() { return Face.calibration(usableFaces(), staffNames(), state.threshold); }
  $("setCalib").addEventListener("click", () => {
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
      $("syncLabel").textContent = !navigator.onLine ? (n ? `Offline (${n})` : "Offline") : (n ? `${n} Pending` : (l.ok === false ? "Sync Err" : "Synced"));
    }
    if ($("tabLogBadge")) {
      $("tabLogBadge").textContent = String(n);
      $("tabLogBadge").hidden = n === 0;
    }
    await updateAttendanceAppBadge();
  }
  if ($("syncPill")) $("syncPill").addEventListener("click", async () => { toast("Syncing with server…"); const r = await Sync.run("manual"); toast(r.msg, r.ok === false); });
  Sync.onChange(() => { updateSyncDot(); if (state.mgrOpen) renderSettings(); });

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
    else hint(usableFaces().length ? "Look at the camera" : "No enrolments yet — manager: ⚙");
    state.running = true;
    loop();
    Sync.start();
    Sync.run("boot").catch(() => {});
    if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded && navigator.serviceWorker.controller) { reloaded = true; location.reload(); } });
      navigator.serviceWorker.addEventListener("message", e => {
        const m = e && e.data;
        if (!m) return;
        if (m.notifCheckedId) markAttNotifChecked(m.notifCheckedId);
        if (m.type === "att-push" && m.payload) pushAttNotif(m.payload);
      });
    }
  }

  // ---------- test hooks (headless smoke only) ----------
  window.ATT_TEST = {
    state,
    ready: () => Face.ready,
    setFrameSource: el => { state.frameSource = el; },
    seedStaff: async list => { await DBX.replaceStaff(list); await loadData(); },
    descriptorsFromImage: async el => (await Face.detectAll(el)).map(r => ({ d: Array.from(r.descriptor), box: r.box, score: r.score, frac: r.frac })),
    injectDescriptor: (d, src) => handleDescriptor(new Float32Array(d), src || null),
    detectFrame: async src => { const det = await Face.detectOne(src); return det ? handleDetection(det, src) : { matched: false, reason: "no-face" }; },
    selectEnrol, captureSample, saveEnrolment, renderLog, poseSvg, enrolFrame,
    setEnrolConsent: v => { $("enConsent").checked = v; renderSamples(); },
    setEnrolPin: async pin => { state.enrol.pin = { pin, hash: await sha256(pin) }; renderSamples(); },
    setManagerPin, managerPinOk,
    setLiveness: async v => { await DBX.setMeta("liveness", v); state.liveness = v; },
    setLiveMock: fn => { state.liveMock = fn; },
    calibration: calibrationReport,
    keypad: Keypad,
    punch, hideCard, loadData, openManager, closeManager, lastPunchRecent, recentPunches, startCamera, streamAlive,
    computeAttendanceNotifs, updateAttendanceAppBadge, markAttNotifChecked, markAllAttNotifsChecked, pushAttNotif,
    db: DBX, sync: Sync, face: Face,
  };

  boot();
})();
