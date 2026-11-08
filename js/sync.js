// BHFIRMS Attendance kiosk — sync loop (v0.4.0)
// Pushes unsynced punches + enrolments to the API endpoint whenever the tablet
// is online; pulls the site roster on demand; supports Server-Redacted 1:N Mode
// (redact: true on roster, post-sync local vector/PIN scrubbing, and op: "verify").

const Sync = (() => {
  let timer = null;
  let running = false;
  let last = { at: null, ok: null, msg: "" };
  const listeners = [];

  function onChange(fn) { listeners.push(fn); }
  function emit() { listeners.forEach(fn => { try { fn(last); } catch (e) { /* ignore */ } }); }

  function dec(s) {
    if (!s) return "";
    try { return atob(s); } catch (e) { return ""; }
  }
  function endpointFor(site) {
    const E = (typeof ATT_ENDPOINTS === "object" && ATT_ENDPOINTS) || {};
    const e = ((E.sites || {})[site]) || E.default || {};
    return { url: e.url || dec(e.u) || "", key: e.key || dec(e.k) || "", perSite: !!((E.sites || {})[site]) };
  }
  async function settings() {
    const site = await DBX.getMeta("site", ATT_CONFIG.defaultSite);
    const ep = endpointFor(site);
    return {
      url: (await DBX.getMeta("apiUrl", "")) || ep.url,
      key: (await DBX.getMeta("apiKey", "")) || ep.key,
      site,
      device: await DBX.getMeta("device", ""),
    };
  }

  async function post(body, timeoutMs) {
    const s = await settings();
    if (!s.url) throw new Error(`no API endpoint for site ${s.site} — run scripts/att03_endpoints.py and redeploy`);
    const ctl = new AbortController();
    const tmr = setTimeout(() => ctl.abort(), timeoutMs || 15000);
    let res;
    try {
      res = await fetch(s.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({
          key: s.key,
          site: s.site,
          siteBu: (ATT_CONFIG.sites[s.site] || {}).bu || s.site,
          device: s.device,
          version: ATT_CONFIG.version,
        }, body)),
        signal: ctl.signal,
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("request timed out");
      throw e;
    } finally {
      clearTimeout(tmr);
    }
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
    const redactedBefore = !!(await DBX.getMeta("redactedMode", false));
    const res = await post({
      op: "sync",
      punches: punches.map(p => ({
        id: p.id, staffId: p.staffId, staffName: p.staffName, ts: p.ts, tzOffsetMin: p.tzOffsetMin,
        day: p.day, direction: p.direction, method: p.method, confidence: p.confidence,
        snapshot: p.snapshot || "", note: p.note || "",
      })),
      faces: faces.map(f => ({
        id: f.id, staffId: f.staffId, staffName: (f.staffName || ""), sample: f.sample,
        descriptor: f.d || [], consentAt: f.consentAt || "",
        pinhash: f.pinhash || "", ts: f.ts,
      })),
    });
    const redactedNow = redactedBefore || !!(await DBX.getMeta("redactedMode", false));
    const okP = (res.punches || []).filter(id => punches.some(p => p.id === id));
    const okF = (res.faces || []).filter(id => faces.some(f => f.id === id));
    const revs = {}; punches.forEach(p => { revs[p.id] = p.rev || 0; });
    if (okP.length) await DBX.markPunchesSynced(okP, revs);
    if (okF.length) {
      await DBX.markFacesSynced(okF, { scrubLocal: redactedNow });
      if (redactedNow) await DBX.scrubLocalBiometrics();
    }
    if (okP.length < punches.length || okF.length < faces.length) {
      throw new Error(`server accepted ${okP.length}/${punches.length} punches, ${okF.length}/${faces.length} faces`);
    }
    return { punches: okP.length, faces: okF.length };
  }

  let queued = false;
  let activeRunPromise = null;
  async function run(reason) {
    if (running) {
      queued = true;
      return activeRunPromise || last;
    }
    if (!navigator.onLine) { last = { at: new Date(), ok: null, msg: "offline" }; emit(); return last; }
    running = true; queued = false;
    activeRunPromise = (async () => {
      let curReason = reason;
      try {
        do {
          queued = false;
          const total = { punches: 0, faces: 0 };
          try {
            for (let i = 0; i < 50; i++) {
              const r = await pushOnce();
              if (!r) break;
              total.punches += r.punches; total.faces += r.faces;
            }
            if (await DBX.getMeta("redactedMode", false)) {
              await DBX.scrubLocalBiometrics();
            }
            last = { at: new Date(), ok: true, msg: `synced ${total.punches} punches, ${total.faces} enrolments (${curReason || "auto"})` };
          } catch (e) {
            last = { at: new Date(), ok: false, msg: String(e.message || e) };
          }
          emit();
          curReason = curReason ? curReason + "+queued" : "queued";
        } while (queued && navigator.onLine);
      } finally {
        running = false;
        activeRunPromise = null;
      }
      return last;
    })();
    return activeRunPromise;
  }

  // Pull the site's roster (+ server-held enrolments when restore=true).
  // In redactedMode, requests redact=true and stores zero raw 128-d vectors or pinhashes on the tablet.
  async function roster(restore) {
    const redacted = !!(await DBX.getMeta("redactedMode", false));
    const res = await post({ op: "roster", restore: !!restore, redact: redacted });
    const useRedacted = !!(redacted || res.redacted);

    const staff = (res.staff || []).filter(s => s && s.id).map(s => {
      const base = { id: s.id, name: s.name || "?", officialName: s.officialName || "" };
      if (useRedacted) {
        if (s.hasPin || s.pinhash) { base.hasPin = true; base.pinRedacted = true; }
        if (typeof s.faceSamples === "number") base.serverSamples = s.faceSamples;
      } else if (s.pinhash) {
        base.pinhash = s.pinhash;
      }
      return base;
    });
    await DBX.replaceStaff(staff);

    let restored = 0;
    if ((restore || useRedacted) && Array.isArray(res.faces)) {
      const existingFaces = await DBX.allFaces();
      if (useRedacted) {
        const have = new Set(existingFaces.map(f => f.id));
        for (const f of res.faces) {
          if (!f || !f.id || have.has(f.id)) continue;
          const isFaceSample = Boolean(
            f.faceRedacted === true ||
            (Array.isArray(f.descriptor) && f.descriptor.length === 128) ||
            (f.faceRedacted !== false && Number(f.sample) > 0)
          );
          const hasPin = !!(f.hasPin || f.pinhash);
          await DBX.saveFace({
            id: f.id,
            staffId: f.staffId,
            sample: f.sample || 0,
            faceRedacted: isFaceSample,
            pinRedacted: hasPin,
            consentAt: f.consentAt || "",
            ts: f.ts || "",
            synced: 1,
            device: "server",
          });
          if (isFaceSample) restored++;
          if (hasPin && f.staffId) {
            const st = await DBX.getStaff(f.staffId);
            if (st) { st.hasPin = true; st.pinRedacted = true; delete st.pinhash; await DBX.saveStaff(st); }
          }
        }
      } else if (restore) {
        // Only treat faces that ALREADY hold usable 128-d vectors as present; overwrite scrubbed stubs cleanly
        const haveFullVector = new Set(
          existingFaces.filter(f => Array.isArray(f.d) && f.d.length === 128).map(f => f.id)
        );
        const serverIds = new Set();
        for (const f of res.faces) {
          if (!f || !f.id) continue;
          serverIds.add(f.id);
          if (haveFullVector.has(f.id) || !Array.isArray(f.descriptor) || f.descriptor.length !== 128) continue;
          await DBX.saveFace({
            id: f.id,
            staffId: f.staffId,
            d: f.descriptor,
            sample: f.sample || 0,
            consentAt: f.consentAt || "",
            pinhash: f.pinhash || "",
            ts: f.ts || "",
            synced: 1,
            device: "server",
          });
          restored++;
        }
        // Clean up any leftover redacted stubs that had no real 128-d vector
        for (const old of existingFaces) {
          if ((old.faceRedacted || old.pinRedacted) && (!Array.isArray(old.d) || old.d.length !== 128)) {
            const updated = await DBX.allFaces();
            const cur = updated.find(x => x.id === old.id);
            if (cur && (!Array.isArray(cur.d) || cur.d.length !== 128) && (!serverIds.has(old.id) || !cur.pinhash)) {
              await DBX.deleteFace(old.id);
            }
          }
        }
        const newestPinByStaff = new Map();
        for (const f of res.faces) {
          if (!f || !f.staffId || !f.pinhash) continue;
          const tMs = Date.parse(f.ts || "") || 0;
          const prev = newestPinByStaff.get(f.staffId);
          if (!prev || tMs >= prev.tMs) {
            newestPinByStaff.set(f.staffId, { pinhash: f.pinhash, tMs });
          }
        }
        for (const [sid, entry] of newestPinByStaff.entries()) {
          const st = await DBX.getStaff(sid);
          if (st) {
            st.pinhash = entry.pinhash;
            st.hasPin = true;
            delete st.pinRedacted;
            delete st.serverSamples;
            await DBX.saveStaff(st);
          }
        }
      }
    }
    if (useRedacted) await DBX.scrubLocalBiometrics();
    await DBX.setMeta("rosterAt", new Date().toISOString());
    return { staff: staff.length, restored, redacted: useRedacted };
  }

  // Server-side 1:N verification for redacted tablets (op = "verify").
  // Payload: { method: "face", descriptor: number[128], threshold } | { method: "pin", pinhash }
  async function verify(payload) {
    return post(Object.assign({ op: "verify" }, payload || {}), 8000);
  }

  function start() {
    stop();
    timer = setInterval(() => run("timer"), ATT_CONFIG.sync.intervalSec * 1000);
    window.addEventListener("online", () => run("online"));
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { run, roster, verify, start, stop, onChange, endpointFor, get last() { return last; }, get running() { return running; } };
})();
