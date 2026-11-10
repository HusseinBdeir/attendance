// BHFIRMS Attendance kiosk — sync loop (v0.6.0)
// v0.5.0: the endpoint is the ISABI cloud (Cloudflare); the station key is typed once in Settings
// and never ships in the code; staff added on the tablet are pushed with the same sync.
// v0.6.0: a person switched off or on at the door is pushed as active: true|false (only for a
// switch, never for a person who was merely added); the roster also lists switched-off people.
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

  const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/;
  // Only a plain URL is read from the shipped file. Anything else in it is ignored, so a stale
  // v0.4.0 copy (which carried an encoded flow address and key) yields no endpoint at all.
  function endpointFor(site) {
    const E = (typeof ATT_ENDPOINTS === "object" && ATT_ENDPOINTS) || {};
    const e = ((E.sites || {})[site]) || E.default || {};
    const raw = String(e.url || "");
    const url = (/^https:\/\//.test(raw) || LOCAL_URL.test(raw)) ? raw : "";
    return { url, perSite: !!((E.sites || {})[site]) };
  }
  async function settings() {
    const site = await DBX.getMeta("site", ATT_CONFIG.defaultSite);
    const ep = endpointFor(site);
    return {
      url: (await DBX.getMeta("apiUrl", "")) || ep.url,
      key: (await DBX.getMeta("apiKey", "")) || "",
      site,
      device: await DBX.getMeta("device", ""),
    };
  }

  // True once this tablet can talk to the server: an endpoint for its site and a station key.
  async function ready() {
    const s = await settings();
    return !!(s.url && s.key);
  }

  async function post(body, timeoutMs) {
    const s = await settings();
    if (!s.url) throw new Error(`no sync endpoint for site ${s.site}`);
    if (!s.key) throw new Error("station key not set (Settings, Cloud Sync card)");
    // Automated test runs never call a live endpoint, whatever is configured.
    if (navigator.webdriver && !LOCAL_URL.test(s.url)) throw new Error("automated run: live endpoint not called");
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
    const staffNew = await DBX.unsyncedStaff(50);
    if (!punches.length && !faces.length && !staffNew.length) return null;
    const redactedBefore = !!(await DBX.getMeta("redactedMode", false));
    const res = await post({
      op: "sync",
      // staff added on this tablet go first so their enrolments and punches have a name on the server
      // `active` goes out only for a switch made at the door (activeSet), never for a person merely added
      staff: staffNew.map(s => Object.assign(
        { id: s.id, name: s.name, officialName: s.officialName || "" },
        s.pinhash ? { pinhash: s.pinhash } : {},
        s.activeSet === true ? { active: s.active !== false } : {}
      )),
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
    const badP = (res.rejectedPunches || []).filter(id => punches.some(p => p.id === id));
    if (badP.length) await DBX.parkPunches(badP, "it belongs to another site");
    const okF = (res.faces || []).filter(id => faces.some(f => f.id === id));
    const okS = (res.staff || []).filter(id => staffNew.some(s => s.id === id));
    // srev as sent: a person switched again while this request was in flight stays pending
    const srevs = {}; staffNew.forEach(s => { srevs[s.id] = s.srev || 0; });
    if (okS.length) await DBX.markStaffSynced(okS, srevs);
    const revs = {}; punches.forEach(p => { revs[p.id] = p.rev || 0; });
    if (okP.length) await DBX.markPunchesSynced(okP, revs);
    if (okF.length) {
      await DBX.markFacesSynced(okF, { scrubLocal: redactedNow });
      if (redactedNow) await DBX.scrubLocalBiometrics();
    }
    if (okP.length + badP.length < punches.length || okF.length < faces.length || okS.length < staffNew.length) {
      throw new Error(`server accepted ${okP.length}/${punches.length} punches, ${okF.length}/${faces.length} faces, ${okS.length}/${staffNew.length} new staff`);
    }
    return { punches: okP.length + badP.length, faces: okF.length, staff: okS.length };
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
        if (!(await ready())) {
          // Not an error: punches and enrolments keep queuing on the tablet until the key is typed.
          last = { at: new Date(), ok: null, msg: "station key not set" };
          emit();
          return last;
        }
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
    // includeInactive: people switched off at the door come back as active: false, so this tablet
    // can show them as switched off and offer to switch them back on.
    // srev of every person before the request: a switch made while the list is on its way is newer than the list
    const srevBefore = {};
    (await DBX.allStaff()).forEach(s => { srevBefore[s.id] = s.srev || 0; });
    const res = await post({ op: "roster", restore: !!restore, redact: redacted, includeInactive: true });
    const useRedacted = !!(redacted || res.redacted);

    const staff = (res.staff || []).filter(s => s && s.id).map(s => {
      const base = { id: s.id, name: s.name || "?", officialName: s.officialName || "", active: s.active !== false };
      if (useRedacted) {
        if (s.hasPin || s.pinhash) { base.hasPin = true; base.pinRedacted = true; }
        if (typeof s.faceSamples === "number") base.serverSamples = s.faceSamples;
      } else if (s.pinhash) {
        base.pinhash = s.pinhash;
      }
      return base;
    });
    await DBX.replaceStaff(staff, srevBefore);

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
            await DBX.patchStaff(f.staffId, st => { st.hasPin = true; st.pinRedacted = true; delete st.pinhash; });
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
          await DBX.patchStaff(sid, st => {
            st.pinhash = entry.pinhash;
            st.hasPin = true;
            delete st.pinRedacted;
            delete st.serverSamples;
          });
        }
      }
    }
    if (useRedacted) await DBX.scrubLocalBiometrics();
    await DBX.setMeta("rosterAt", new Date().toISOString());
    const off = staff.filter(s => s.active === false).length;
    return { staff: staff.length - off, off, restored, redacted: useRedacted };
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

  return { run, roster, verify, start, stop, onChange, endpointFor, ready, get last() { return last; }, get running() { return running; } };
})();
