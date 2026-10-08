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
    threshold: C.match.threshold,   // per-device override lives in meta "threshold"
    liveness: C.liveness.enabled,   // per-device override lives in meta "liveness"
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
    testing: false,       // "Test recognition" loop in the Enrol tab
    manualStaff: null,
    wake: null,
    defaultPin: true,     // manager PIN still the factory default
  };

  // ---------- helpers ----------
  const pad = n => String(n).padStart(2, "0");
  function nowLocal() {
    const d = new Date();
    return {
      ts: d.toISOString(),
      day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
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
  let toastT = null;
  function toast(msg, bad, ms) {
    const t = $("toast"); t.textContent = msg; t.className = "toast on" + (bad ? " bad" : "");
    clearTimeout(toastT); toastT = setTimeout(() => t.className = "toast", ms || 2600);
  }
  function hint(msg, warn) { const h = $("hint"); h.textContent = msg; h.className = "hint" + (warn ? " warn" : ""); }

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

  // ---------- face frame overlay ----------
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
    const col = { ok: "#22c55e", live: "#38bdf8", warn: "#f59e0b", unknown: "#f59e0b", far: "#94a3b8", scan: "#c9a227" }[status] || "#c9a227";
    const L = Math.min(w, h) * 0.22;
    g.lineWidth = 4; g.strokeStyle = col; g.lineCap = "round";
    const corner = (cx, cy, dx, dy) => { g.beginPath(); g.moveTo(cx + dx * L, cy); g.lineTo(cx, cy); g.lineTo(cx, cy + dy * L); g.stroke(); };
    corner(x, y, 1, 1); corner(x + w, y, -1, 1); corner(x, y + h, 1, -1); corner(x + w, y + h, -1, -1);
  }

  // ---------- keypad (with lockout) ----------
  const Keypad = (() => {
    let buf = "", cb = null, len = C.pinLength, fails = 0, lockedUntil = 0, title = "";
    const locked = () => Date.now() < lockedUntil;
    const remaining = () => Math.ceil((lockedUntil - Date.now()) / 1000);
    function render() {
      $("kpDots").innerHTML = Array.from({ length: len }, (_, i) => `<i class="${i < buf.length ? "on" : ""}"></i>`).join("");
      $("kpTitle").textContent = locked() ? `Too many attempts — wait ${remaining()} s` : title;
    }
    function open(t, onDone, length) {
      buf = ""; cb = onDone; len = length || C.pinLength; title = t;
      render();
      $("keypad").classList.add("open");
      state.busy = true;
    }
    function close() { $("keypad").classList.remove("open"); buf = ""; cb = null; state.busy = false; }
    function shake() {
      const d = $("kpDots"); d.classList.add("shake");
      setTimeout(() => { d.classList.remove("shake"); buf = ""; render(); }, 450);
    }
    $("keypad").querySelectorAll("button").forEach(b => b.addEventListener("click", async () => {
      const k = b.dataset.k;
      if (k === "x") { const c = cb; close(); if (c) c(null); return; }
      if (locked()) { render(); return; }
      if (k === "b") { buf = buf.slice(0, -1); render(); return; }
      if (buf.length >= len) return;
      buf += k; render();
      if (buf.length === len) {
        const pin = buf; const c = cb;
        const ok = await c(pin);
        if (ok === false) {
          fails++;
          if (fails >= C.pinLockAfter) { lockedUntil = Date.now() + C.pinLockSec * 1000; fails = 0; }
          shake();
        } else { fails = 0; close(); }
      }
    }));
    return {
      open, close, shake,
      get isOpen() { return $("keypad").classList.contains("open"); },
      get locked() { return locked(); },
      unlock() { lockedUntil = 0; fails = 0; render(); },
    };
  })();

  // ---------- data ----------
  async function loadData() {
    state.site = await DBX.getMeta("site", C.defaultSite);
    const t = parseFloat(await DBX.getMeta("threshold", ""));
    state.threshold = (t > 0 && t < 1) ? t : C.match.threshold;
    const lv = await DBX.getMeta("liveness", null);
    state.liveness = lv == null ? C.liveness.enabled : !!lv;
    state.defaultPin = !(await DBX.getMeta("mgrPinHash", ""));
    const staff = await DBX.allStaff();
    state.staff = new Map(staff.map(s => [s.id, s]));
    state.faces = (await DBX.allFaces()).filter(f => Array.isArray(f.d) && f.d.length === 128);
    $("siteName").textContent = (C.sites[state.site] || {}).name || state.site;
  }
  function usableFaces() {
    // only staff with >= minSamples samples and an active roster entry
    const count = new Map();
    state.faces.forEach(f => count.set(f.staffId, (count.get(f.staffId) || 0) + 1));
    return state.faces.filter(f => count.get(f.staffId) >= C.match.minSamples && (state.staff.get(f.staffId) || {}).active !== false);
  }
  const staffNames = () => new Map([...state.staff.values()].map(s => [s.id, s.name]));

  // ---------- punching ----------
  async function lastPunchToday(staffId) {
    const rows = (await DBX.punchesForDay(nowLocal().day)).filter(p => p.staffId === staffId && !p.void);
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return rows[rows.length - 1] || null;
  }

  async function punch(staffId, method, confidence, src, forcedDirection, note) {
    const st = state.staff.get(staffId);
    if (!st) { toast("Unknown staff id", true); return null; }
    const n = nowLocal();
    const last = await lastPunchToday(staffId);
    if (!forcedDirection && last && (Date.now() - new Date(last.ts).getTime()) < C.punch.debounceMinutes * 60000) {
      showCard(st, last, true);
      return null;
    }
    const direction = forcedDirection || (last && last.direction === "in" ? "out" : "in");
    const p = {
      id: uuid(), staffId, staffName: st.name, ts: n.ts, day: n.day, tzOffsetMin: n.tzOffsetMin,
      direction, method, confidence: confidence == null ? null : r3(confidence),
      snapshot: src ? snapshot(src) : "", site: state.site, synced: 0, note: note || "",
    };
    await DBX.savePunch(p);
    state.lastPunchAt.set(staffId, Date.now());
    showCard(st, p, false);
    updateSyncDot();
    Sync.run("punch").catch(() => {});
    return p;
  }

  function showCard(st, p, already) {
    const card = $("card");
    state.cardPunch = already ? null : p;
    $("cardImg").src = p.snapshot || "icon.svg";
    $("cardName").textContent = st.name;
    const dir = p.direction.toUpperCase();
    $("cardLine").innerHTML = already
      ? `Already clocked <b>${dir}</b> at ${fmtTime(p.ts)}`
      : `Clocked <b>${dir}</b> at ${fmtTime(p.ts)}`;
    card.className = "card " + (already ? "warn" : p.direction);
    $("cardFlip").style.display = already ? "none" : "";
    $("cardFlip").textContent = `Wrong? Switch to ${p.direction === "in" ? "OUT" : "IN"}`;
    state.busy = true;
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
  $("cardFlip").addEventListener("click", async () => {
    const p = state.cardPunch; if (!p) return;
    p.direction = p.direction === "in" ? "out" : "in";
    p.synced = 0;                       // re-push: the server upserts on id
    await DBX.savePunch(p);
    showCard(state.staff.get(p.staffId), p, false);
    Sync.run("flip").catch(() => {});
  });

  // ---------- kiosk loop ----------
  async function startCamera() {
    if (state.stream) return;
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      $("video").srcObject = state.stream;
      $("enVideo").srcObject = state.stream;
      await new Promise(r => { $("video").onloadedmetadata = r; setTimeout(r, 1500); });
    } catch (e) {
      hint("Camera unavailable: " + (e.message || e), true);
    }
  }
  async function keepAwake() {
    try { if ("wakeLock" in navigator && !state.wake) { state.wake = await navigator.wakeLock.request("screen"); state.wake.addEventListener("release", () => { state.wake = null; }); } } catch (e) { /* not granted */ }
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") keepAwake(); });

  function resetStreak() { state.streak = { staffId: null, n: 0, dist: [] }; }

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
      hint(`Hello ${st ? st.name : ""}…`);
      if (state.streak.n >= C.match.confirmFrames) {
        const mean = state.streak.dist.reduce((a, b) => a + b, 0) / state.streak.dist.length;
        const weak = mean > C.match.weakAbove;
        resetStreak();
        if (state.liveness) {
          state.live = { staffId: m.staffId, distance: mean, weak, until: Date.now() + C.liveness.windowSec * 1000, closed: false };
          hint("Please blink to confirm");
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
  function openManager() {
    state.mgrOpen = true; state.busy = true; state.live = null;
    drawOverlay(null);
    $("kiosk").classList.remove("open"); $("mgr").classList.add("open");
    { const v = $("enVideo"); if (v.srcObject && v.paused) v.play().catch(() => {}); }
    showTab("enrol"); renderEnrolList(""); renderStaff(); renderSettings();
    $("logDay").value = nowLocal().day; renderLog();
    if (state.defaultPin) toast("Manager PIN is still the factory default — change it in Settings", true, 5000);
  }
  function closeManager() {
    stopTest();
    state.mgrOpen = false; state.busy = false;
    $("mgr").classList.remove("open"); $("kiosk").classList.add("open");
    hideCard();
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
  // A head outline with the features shifted the way the face turns, plus a pulsing
  // arrow on the side to turn to. Plain shapes, no text: usable without reading.
  function poseSvg(kind) {
    const head = (dx, dy, mouth) => `<circle cx="50" cy="52" r="26" fill="none" stroke="#f8fafc" stroke-width="4"/>` +
      `<circle cx="${41 + dx}" cy="${46 + dy}" r="3.2" fill="#f8fafc"/><circle cx="${59 + dx}" cy="${46 + dy}" r="3.2" fill="#f8fafc"/>` +
      `<path d="M${50 + dx * 1.5} ${47 + dy} v9 h${dx >= 0 ? 5 : -5}" fill="none" stroke="#f8fafc" stroke-width="3" stroke-linecap="round"/>` +
      (mouth || `<path d="M${42 + dx} ${64 + dy} h16" fill="none" stroke="#f8fafc" stroke-width="3.5" stroke-linecap="round"/>`);
    const arrow = (d, dx, dy) => `<g class="arrow" style="--dx:${dx}px;--dy:${dy}px"><path d="${d}" fill="none" stroke="#c9a227" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></g>`;
    const cam = `<rect x="39" y="4" width="22" height="14" rx="3" fill="#c9a227"/><circle cx="50" cy="11" r="4" fill="#0f172a"/>`;
    let body;
    switch (kind) {
      case "left":  body = head(-8, 0) + arrow("M38 88 H10 M22 76 L10 88 L22 100", -7, 0); break;
      case "right": body = head(8, 0) + arrow("M62 88 H90 M78 76 L90 88 L78 100", 7, 0); break;
      case "up":    body = head(0, -7) + arrow("M50 24 V4 M38 16 L50 4 L62 16", 0, -6); break;
      case "smile": body = head(0, 0, `<path d="M38 60 Q50 74 62 60" fill="none" stroke="#f8fafc" stroke-width="3.5" stroke-linecap="round"/>`) +
                           `<path d="M14 36 l4 -4 M10 48 l5 0 M86 36 l-4 -4 M90 48 l-5 0" stroke="#c9a227" stroke-width="3" stroke-linecap="round"/>`; break;
      case "done":  body = `<circle cx="50" cy="52" r="34" fill="none" stroke="#22c55e" stroke-width="5"/><path d="M32 54 l12 12 l26 -28" fill="none" stroke="#22c55e" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`; break;
      default:      body = cam + head(0, 0) + `<circle cx="50" cy="52" r="34" fill="none" stroke="#c9a227" stroke-width="2.5" stroke-dasharray="6 6"/>`;
    }
    return `<svg viewBox="0 0 100 104" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
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
  function renderEnrolList(q) {
    const el = $("enList");
    el.innerHTML = staffMatches(q).map(s => `<div data-id="${s.id}" class="${s.id === state.enrol.staffId ? "sel" : ""}">${esc(s.name)}<small>${sampleCount(s.id)} samples${s.pinhash ? " · PIN" : ""}</small></div>`).join("") || `<div class="muted">No staff in the roster. Settings → Refresh roster.</div>`;
    el.querySelectorAll("div[data-id]").forEach(d => d.addEventListener("click", () => selectEnrol(d.dataset.id)));
  }
  $("enSearch").addEventListener("input", e => renderEnrolList(e.target.value));
  function selectEnrol(id) {
    const st = state.staff.get(id); if (!st) return;
    state.enrol = { staffId: id, samples: [], pin: null };
    $("enWho").textContent = `${st.name}${st.officialName ? " (" + st.officialName + ")" : ""} — ${sampleCount(id)} sample(s) stored`;
    ["enCapture", "enClear", "enPin", "enConsent"].forEach(x => $(x).disabled = false);
    $("enConsent").checked = false;
    $("enPinState").textContent = st.pinhash ? "PIN already set (Set PIN replaces it)" : "no PIN";
    renderEnrolList($("enSearch").value);
    renderSamples();
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
    if (!det) { toast("No face found — look straight at the camera", true); return false; }
    if (det.frac < C.match.minFaceFrac) { toast("Too far — come closer to the camera", true); return false; }
    if (det.score < C.match.enrolScore) { toast("Face not clear enough — more light, look straight", true); return false; }
    // reject a sample that already matches someone ELSE's enrolment
    const other = usableFaces().filter(f => f.staffId !== state.enrol.staffId);
    const m = other.length ? Face.match(det.descriptor, other) : null;
    if (m && m.distance <= state.threshold * 0.8) {
      const who = state.staff.get(m.staffId);
      toast(`This face already matches ${who ? who.name : "another person"}`, true);
      return false;
    }
    state.enrol.samples.push({ d: Array.from(det.descriptor), thumb: snapshot(src) });
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
    renderEnrolList($("enSearch").value); renderSamples();
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
    const tb = $("stTable").querySelector("tbody");
    const rows = [...state.staff.values()].sort((a, b) => a.name.localeCompare(b.name));
    tb.innerHTML = rows.map(s => `<tr><td>${esc(s.name)}<br><small class="muted">${esc(s.officialName || "")}</small></td><td>${sampleCount(s.id)}${sampleCount(s.id) && sampleCount(s.id) < C.match.minSamples ? ` <span class="tag warn">below ${C.match.minSamples}</span>` : ""}</td><td>${s.pinhash ? "yes" : "—"}</td><td>${s.active === false ? "no" : "yes"}</td><td><button class="btn small" data-en="${s.id}">Enrol</button></td></tr>`).join("") || `<tr><td colspan="5" class="muted">Roster empty — refresh from the server.</td></tr>`;
    tb.querySelectorAll("button[data-en]").forEach(b => b.addEventListener("click", () => { showTab("enrol"); selectEnrol(b.dataset.en); }));
    DBX.getMeta("rosterAt", "").then(at => $("stInfo").textContent = at ? `roster refreshed ${new Date(at).toLocaleString()}` : "roster never refreshed");
  }
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

  // ----- log -----
  async function renderLog() {
    const day = $("logDay").value || nowLocal().day;
    const rows = (await DBX.punchesForDay(day)).sort((a, b) => b.ts.localeCompare(a.ts));
    const tb = $("logTable").querySelector("tbody");
    tb.innerHTML = rows.map(p => `<tr data-id="${p.id}"><td>${p.snapshot ? `<img src="${p.snapshot}" alt="">` : ""}</td><td>${esc(p.staffName)}</td><td>${fmtTime(p.ts)}</td><td><span class="tag ${p.direction}">${p.direction.toUpperCase()}</span></td><td>${p.method}${p.confidence != null ? ` <small class="muted">${p.confidence}</small>` : ""}${p.note ? ` <span class="tag ${/weak/.test(p.note) ? "warn" : ""}">${esc(p.note)}</span>` : ""}</td><td><span class="tag ${p.synced ? "ok" : "pending"}">${p.synced ? "synced" : "pending"}</span></td><td><button class="btn small" data-flip="${p.id}">Flip</button> ${p.synced ? "" : `<button class="btn small danger" data-del="${p.id}">Delete</button>`}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">No punches on ${day}.</td></tr>`;
    tb.querySelectorAll("button[data-flip]").forEach(b => b.addEventListener("click", async () => {
      const p = await DBX.getPunch(b.dataset.flip); p.direction = p.direction === "in" ? "out" : "in"; p.synced = 0; await DBX.savePunch(p); renderLog(); updateSyncDot();
    }));
    tb.querySelectorAll("button[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this punch?")) return;
      await DBX.deletePunch(b.dataset.del); renderLog(); updateSyncDot();
    }));
    const n = await DBX.unsyncedCount();
    const l = Sync.last;
    $("logInfo").textContent = `${n} pending · ${l.at ? `last sync ${l.at.toLocaleTimeString()}: ${l.msg}` : "never synced"}`;
  }
  $("logDay").addEventListener("change", renderLog);
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
    d.className = "syncDot " + (n ? (l.ok === false ? "bad" : "pending") : (l.ok === false ? "bad" : "ok"));
    d.title = `${n} pending · ${l.msg || ""}`;
  }
  Sync.onChange(() => { updateSyncDot(); if (state.mgrOpen) renderSettings(); });

  // ---------- boot ----------
  function tickClock() { $("clock").textContent = nowLocal().hhmm; }
  async function migrate() {
    // v0.1 stored the manager PIN in clear; hash it once.
    const plain = await DBX.getMeta("mgrPin", "");
    if (plain && !(await DBX.getMeta("mgrPinHash", ""))) await setManagerPin(plain);
    else if (plain) await DBX.delMeta("mgrPin");
  }
  async function boot() {
    tickClock(); setInterval(tickClock, 15000);
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
    punch, hideCard, loadData, openManager, closeManager,
    db: DBX, sync: Sync, face: Face,
  };

  boot();
})();
