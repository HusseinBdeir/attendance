// BHFIRMS Attendance kiosk — sync loop
// Pushes unsynced punches + enrolments to the Dataverse API flow whenever the
// tablet is online; pulls the site roster on demand. Idempotent: every row
// carries a uuid the server upserts on (bhf_sourceref), so retries never
// duplicate. A response is only trusted if it echoes the ids it accepted.

const Sync = (() => {
  let timer = null;
  let running = false;
  let last = { at: null, ok: null, msg: "" };
  const listeners = [];

  function onChange(fn) { listeners.push(fn); }
  function emit() { listeners.forEach(fn => { try { fn(last); } catch (e) { /* ignore */ } }); }

  async function settings() {
    return {
      url: await DBX.getMeta("apiUrl", ""),
      key: await DBX.getMeta("apiKey", ""),
      site: await DBX.getMeta("site", ATT_CONFIG.defaultSite),
      device: await DBX.getMeta("device", ""),
    };
  }

  async function post(body) {
    const s = await settings();
    if (!s.url) throw new Error("API URL not set");
    const res = await fetch(s.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ key: s.key, site: s.site, siteBu: (ATT_CONFIG.sites[s.site] || {}).bu || s.site, device: s.device, version: ATT_CONFIG.version }, body)),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (!json || json.ok !== true) throw new Error(`bad response: ${text.slice(0, 200)}`);
    return json;
  }

  // Push one batch. Returns {punches, faces} counts pushed, or null if nothing to do.
  async function pushOnce() {
    const punches = await DBX.unsyncedPunches(ATT_CONFIG.sync.batchPunches);
    const faces = await DBX.unsyncedFaces(ATT_CONFIG.sync.batchFaces);
    if (!punches.length && !faces.length) return null;
    const res = await post({
      op: "sync",
      punches: punches.map(p => ({
        id: p.id, staffId: p.staffId, staffName: p.staffName, ts: p.ts, tzOffsetMin: p.tzOffsetMin,
        day: p.day, direction: p.direction, method: p.method, confidence: p.confidence,
        snapshot: p.snapshot || "", note: p.note || "",
      })),
      faces: faces.map(f => ({
        id: f.id, staffId: f.staffId, sample: f.sample, descriptor: f.d || [], consentAt: f.consentAt || "",
        pinhash: f.pinhash || "", ts: f.ts,
      })),
    });
    const okP = (res.punches || []).filter(id => punches.some(p => p.id === id));
    const okF = (res.faces || []).filter(id => faces.some(f => f.id === id));
    if (okP.length) await DBX.markPunchesSynced(okP);
    if (okF.length) await DBX.markFacesSynced(okF);
    if (okP.length < punches.length || okF.length < faces.length) {
      throw new Error(`server accepted ${okP.length}/${punches.length} punches, ${okF.length}/${faces.length} faces`);
    }
    return { punches: okP.length, faces: okF.length };
  }

  async function run(reason) {
    if (running) return last;
    if (!navigator.onLine) { last = { at: new Date(), ok: null, msg: "offline" }; emit(); return last; }
    running = true;
    let total = { punches: 0, faces: 0 };
    try {
      for (let i = 0; i < 50; i++) {            // drain in batches
        const r = await pushOnce();
        if (!r) break;
        total.punches += r.punches; total.faces += r.faces;
      }
      last = { at: new Date(), ok: true, msg: `synced ${total.punches} punches, ${total.faces} enrolments (${reason || "auto"})` };
    } catch (e) {
      last = { at: new Date(), ok: false, msg: String(e.message || e) };
    } finally {
      running = false;
      emit();
    }
    return last;
  }

  // Pull the site's roster (+ server-held enrolments when restore=true).
  async function roster(restore) {
    const res = await post({ op: "roster", restore: !!restore });
    const staff = (res.staff || []).map(s => ({ id: s.id, name: s.name, officialName: s.officialName || "", pinhash: s.pinhash || undefined }));
    await DBX.replaceStaff(staff);
    let restored = 0;
    if (restore && Array.isArray(res.faces)) {
      const have = new Set((await DBX.allFaces()).map(f => f.id));
      for (const f of res.faces) {
        if (have.has(f.id) || !Array.isArray(f.descriptor) || f.descriptor.length !== 128) continue;
        await DBX.saveFace({ id: f.id, staffId: f.staffId, d: f.descriptor, sample: f.sample || 0, consentAt: f.consentAt || "", pinhash: f.pinhash || "", ts: f.ts || "", synced: 1, device: "server" });
        restored++;
      }
      // pin hashes ride on enrolment rows: copy them onto the roster
      for (const f of res.faces) {
        if (f.pinhash) { const st = await DBX.getStaff(f.staffId); if (st && !st.pinhash) { st.pinhash = f.pinhash; await DBX.saveStaff(st); } }
      }
    }
    await DBX.setMeta("rosterAt", new Date().toISOString());
    return { staff: staff.length, restored };
  }

  function start() {
    stop();
    timer = setInterval(() => run("timer"), ATT_CONFIG.sync.intervalSec * 1000);
    window.addEventListener("online", () => run("online"));
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { run, roster, start, stop, onChange, get last() { return last; }, get running() { return running; } };
})();
