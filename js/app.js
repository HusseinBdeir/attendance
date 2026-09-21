// BHFIRMS Attendance kiosk — app logic
// Kiosk loop: camera frame -> face descriptor -> match against local
// enrolments -> punch (IN/OUT auto-toggled) -> confirmation card.
// Everything is local-first; sync.js pushes when the tablet is online.

(() => {
  const $ = id => document.getElementById(id);
  const C = ATT_CONFIG;

  const state = {
    site: C.defaultSite,
    faces: [],            // [{id, staffId, d}] in memory for matching
    staff: new Map(),     // id -> {id, name, officialName, pinhash, active}
    stream: null,
    running: false,
    busy: false,          // card up / keypad open -> detection paused
    streak: { staffId: null, n: 0 },
    unknown: 0,
    frameSource: null,    // tests inject an <img>/<canvas> instead of the camera
    lastPunchAt: new Map(),
    cardTimer: null,
    cardPunch: null,
    mgrOpen: false,
    enrol: { staffId: null, samples: [], pin: null },
    manualStaff: null,
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
  let toastT = null;
  function toast(msg, bad) {
    const t = $("toast"); t.textContent = msg; t.className = "toast on" + (bad ? " bad" : "");
    clearTimeout(toastT); toastT = setTimeout(() => t.className = "toast", 2600);
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

  // ---------- keypad ----------
  const Keypad = (() => {
    let buf = "", cb = null, len = C.pinLength;
    function render() {
      $("kpDots").innerHTML = Array.from({ length: len }, (_, i) => `<i class="${i < buf.length ? "on" : ""}"></i>`).join("");
    }
    function open(title, onDone, length) {
      buf = ""; cb = onDone; len = length || C.pinLength;
      $("kpTitle").textContent = title; render();
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
      if (k === "b") { buf = buf.slice(0, -1); render(); return; }
      if (buf.length >= len) return;
      buf += k; render();
      if (buf.length === len) {
        const pin = buf; const c = cb;
        const ok = await c(pin);
        if (ok === false) { shake(); } else close();
      }
    }));
    return { open, close, shake, get isOpen() { return $("keypad").classList.contains("open"); } };
  })();

  // ---------- data ----------
  async function loadData() {
    state.site = await DBX.getMeta("site", C.defaultSite);
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

  // ---------- punching ----------
  async function lastPunchToday(staffId) {
    const rows = (await DBX.punchesForDay(nowLocal().day)).filter(p => p.staffId === staffId && !p.void);
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return rows[rows.length - 1] || null;
  }

  async function punch(staffId, method, confidence, src, forcedDirection) {
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
      direction, method, confidence: confidence == null ? null : Math.round(confidence * 1000) / 1000,
      snapshot: src ? snapshot(src) : "", site: state.site, synced: 0,
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
    clearTimeout(state.cardTimer);
    state.cardTimer = setTimeout(hideCard, C.punch.cardSeconds * 1000);
  }
  function hideCard() {
    $("card").className = "card hidden";
    state.cardPunch = null;
    state.streak = { staffId: null, n: 0 };
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

  async function handleDescriptor(desc, src) {
    const faces = usableFaces();
    const m = faces.length ? Face.match(desc, faces) : null;
    if (m && m.distance <= C.match.threshold) {
      state.unknown = 0;
      if (state.streak.staffId === m.staffId) state.streak.n++; else state.streak = { staffId: m.staffId, n: 1 };
      const st = state.staff.get(m.staffId);
      hint(`Hello ${st ? st.name : ""}…`);
      if (state.streak.n >= C.match.confirmFrames) {
        state.streak = { staffId: null, n: 0 };
        await punch(m.staffId, "face", m.distance, src);
      }
      return { matched: true, staffId: m.staffId, distance: m.distance };
    }
    state.streak = { staffId: null, n: 0 };
    state.unknown++;
    if (state.unknown >= C.match.unknownFrames) hint(faces.length ? "Not recognised — tap Use PIN" : "No enrolments yet — tap Use PIN", true);
    return { matched: false, distance: m ? m.distance : null };
  }

  async function loop() {
    if (!state.running) return;
    let delay = 400;
    try {
      if (!state.busy && Face.ready) {
        const src = state.frameSource || $("video");
        const ok = state.frameSource || (src.readyState >= 2 && src.videoWidth > 0);
        if (ok) {
          const det = await Face.detectOne(src);
          if (det) { await handleDescriptor(det.descriptor, src); delay = 250; }
          else { state.streak = { staffId: null, n: 0 }; if (state.unknown) state.unknown = 0; if (!state.busy) hint("Look at the camera"); }
        }
      }
    } catch (e) { console.error(e); }
    setTimeout(loop, delay);
  }

  // ---------- staff PIN ----------
  $("btnPin").addEventListener("click", () => {
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
  async function managerPin() { return DBX.getMeta("mgrPin", C.firstRunManagerPin); }
  $("btnMgr").addEventListener("click", () => {
    Keypad.open("Manager PIN", async pin => {
      if (pin === null) return;
      if (pin !== await managerPin()) return false;
      openManager();
      return true;
    });
  });
  function openManager() {
    state.mgrOpen = true; state.busy = true;
    $("kiosk").classList.remove("open"); $("mgr").classList.add("open");
    showTab("enrol"); renderEnrolList(""); renderStaff(); renderSettings();
    $("logDay").value = nowLocal().day; renderLog();
  }
  function closeManager() {
    state.mgrOpen = false; state.busy = false;
    $("mgr").classList.remove("open"); $("kiosk").classList.add("open");
    hideCard();
  }
  $("btnBack").addEventListener("click", closeManager);
  function showTab(name) {
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === name));
    document.querySelectorAll(".panel").forEach(p => p.classList.toggle("on", p.id === "tab-" + name));
  }
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
    showTab(t.dataset.tab);
    if (t.dataset.tab === "log") renderLog();
    if (t.dataset.tab === "staff") renderStaff();
    if (t.dataset.tab === "settings") renderSettings();
  }));

  // ----- enrol -----
  function staffMatches(q) {
    q = (q || "").trim().toLowerCase();
    return [...state.staff.values()].filter(s => s.active !== false && (!q || s.name.toLowerCase().includes(q) || (s.officialName || "").toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  function sampleCount(staffId) { return state.faces.filter(f => f.staffId === staffId).length; }
  function renderEnrolList(q) {
    const el = $("enList");
    el.innerHTML = staffMatches(q).map(s => `<div data-id="${s.id}" class="${s.id === state.enrol.staffId ? "sel" : ""}">${s.name}<small>${sampleCount(s.id)} samples${s.pinhash ? " · PIN" : ""}</small></div>`).join("") || `<div class="muted">No staff in the roster. Settings → Refresh roster.</div>`;
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
    $("enSamples").innerHTML = s.map(x => `<img src="${x.thumb}" alt="">`).join("") +
      Array.from({ length: Math.max(0, C.match.minSamples - s.length) }, () => `<span class="empty"></span>`).join("");
    const ready = state.enrol.staffId && (s.length >= C.match.minSamples || (state.enrol.pin && s.length === 0));
    $("enSave").disabled = !ready;
    $("enCapture").disabled = !state.enrol.staffId || s.length >= C.match.maxSamples;
  }
  async function captureSample(src) {
    src = src || state.frameSource || $("enVideo");
    const det = await Face.detectOne(src);
    if (!det) { toast("No face found — look straight at the camera", true); return false; }
    // reject a sample that already matches someone ELSE's enrolment
    const other = usableFaces().filter(f => f.staffId !== state.enrol.staffId);
    const m = other.length ? Face.match(det.descriptor, other) : null;
    if (m && m.distance <= C.match.threshold * 0.8) {
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
    const rows = e.samples.map((s, i) => ({ id: uuid(), staffId: e.staffId, d: s.d, sample: i + 1, consentAt, pinhash, ts: new Date().toISOString(), device, synced: 0 }));
    if (!rows.length && e.pin) rows.push({ id: uuid(), staffId: e.staffId, d: [], sample: 0, consentAt: "", pinhash, ts: new Date().toISOString(), device, synced: 0 });
    for (const r of rows) await DBX.saveFace(r);
    state.faces.push(...rows.filter(r => r.d.length === 128));
    if (e.pin) { st.pinhash = e.pin.hash; await DBX.saveStaff(st); }
    toast(`Saved ${e.samples.length} sample(s) for ${st.name}`);
    state.enrol = { staffId: null, samples: [], pin: null };
    $("enWho").textContent = "Pick a staff member on the left.";
    ["enCapture", "enClear", "enPin", "enConsent", "enSave"].forEach(x => $(x).disabled = true);
    $("enPinState").textContent = "";
    renderEnrolList($("enSearch").value); renderSamples();
    Sync.run("enrol").catch(() => {});
    return true;
  }
  $("enSave").addEventListener("click", saveEnrolment);

  // ----- staff -----
  function renderStaff() {
    const tb = $("stTable").querySelector("tbody");
    const rows = [...state.staff.values()].sort((a, b) => a.name.localeCompare(b.name));
    tb.innerHTML = rows.map(s => `<tr><td>${s.name}<br><small class="muted">${s.officialName || ""}</small></td><td>${sampleCount(s.id)}</td><td>${s.pinhash ? "yes" : "—"}</td><td>${s.active === false ? "no" : "yes"}</td><td><button class="btn small" data-en="${s.id}">Enrol</button></td></tr>`).join("") || `<tr><td colspan="5" class="muted">Roster empty — refresh from the server.</td></tr>`;
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
    tb.innerHTML = rows.map(p => `<tr data-id="${p.id}"><td>${p.snapshot ? `<img src="${p.snapshot}" alt="">` : ""}</td><td>${p.staffName}</td><td>${fmtTime(p.ts)}</td><td><span class="tag ${p.direction}">${p.direction.toUpperCase()}</span></td><td>${p.method}${p.confidence != null ? ` <small class="muted">${p.confidence}</small>` : ""}</td><td><span class="tag ${p.synced ? "ok" : "pending"}">${p.synced ? "synced" : "pending"}</span></td><td><button class="btn small" data-flip="${p.id}">Flip</button> ${p.synced ? "" : `<button class="btn small danger" data-del="${p.id}">Delete</button>`}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">No punches on ${day}.</td></tr>`;
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
    el.innerHTML = staffMatches(q).map(s => `<div data-id="${s.id}" class="${s.id === state.manualStaff ? "sel" : ""}">${s.name}</div>`).join("");
    el.querySelectorAll("div[data-id]").forEach(d => d.addEventListener("click", () => { state.manualStaff = d.dataset.id; $("mnIn").disabled = $("mnOut").disabled = false; renderManualList($("mnSearch").value); }));
  }
  $("mnSearch").addEventListener("input", e => renderManualList(e.target.value));
  $("mnCancel").addEventListener("click", () => $("manual").classList.remove("open"));
  async function manualPunch(direction) {
    if (!state.manualStaff) return;
    const p = await punch(state.manualStaff, "manual", null, null, direction);
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
    sel.innerHTML = Object.entries(C.sites).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("");
    sel.value = state.site;
    $("setDevice").value = await DBX.getMeta("device", "");
    $("setUrl").value = await DBX.getMeta("apiUrl", "");
    $("setKey").value = await DBX.getMeta("apiKey", "");
    const pending = await DBX.unsyncedCount();
    const l = Sync.last;
    $("setInfo").textContent = [
      `version ${C.version} · face backend ${Face.backend} · models ${Face.ready ? "ready" : "loading"}`,
      `roster ${state.staff.size} staff · ${state.faces.length} face samples on device · ${pending} punches pending`,
      `online ${navigator.onLine} · last sync ${l.at ? l.at.toLocaleString() + " " + (l.ok === false ? "FAILED " : "") + l.msg : "never"}`,
      `service worker ${navigator.serviceWorker && navigator.serviceWorker.controller ? "active" : "none"}`,
    ].join("\n");
  }
  $("setSave").addEventListener("click", async () => {
    await DBX.setMeta("site", $("setSite").value);
    await DBX.setMeta("device", $("setDevice").value.trim());
    await DBX.setMeta("apiUrl", $("setUrl").value.trim());
    await DBX.setMeta("apiKey", $("setKey").value.trim());
    await loadData(); renderSettings(); toast("Settings saved");
  });
  $("setSync").addEventListener("click", async () => { const r = await Sync.run("manual"); toast(r.msg, r.ok === false); renderSettings(); });
  $("setRoster").addEventListener("click", () => refreshRoster(false));
  $("setRestore").addEventListener("click", () => refreshRoster(true));
  $("setMgrPin").addEventListener("click", () => {
    Keypad.open("New manager PIN", async pin => { if (pin === null) return; await DBX.setMeta("mgrPin", pin); toast("Manager PIN changed"); return true; });
  });
  $("setFull").addEventListener("click", () => { const el = document.documentElement; (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el); });
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
  async function boot() {
    tickClock(); setInterval(tickClock, 15000);
    await loadData();
    updateSyncDot();
    hint("Loading face models…");
    const camP = startCamera();
    let modelErr = null;
    try { await Face.load(); } catch (e) { modelErr = e; console.error("model load", e); }
    await camP;
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
    descriptorsFromImage: async el => (await Face.detectAll(el)).map(r => ({ d: Array.from(r.descriptor), box: r.box })),
    injectDescriptor: (d, src) => handleDescriptor(new Float32Array(d), src || null),
    selectEnrol, captureSample, saveEnrolment, renderLog,
    setEnrolConsent: v => { $("enConsent").checked = v; renderSamples(); },
    setEnrolPin: async pin => { state.enrol.pin = { pin, hash: await sha256(pin) }; renderSamples(); },
    punch, hideCard, loadData, openManager, closeManager,
    db: DBX, sync: Sync, face: Face,
  };

  boot();
})();
