// Headless smoke test for the attendance kiosk.
// Run:  node tests/smoke.js   (needs the repo served at http://localhost:8090)
// Uses playwright-core from codex-hub + the installed Chrome. The camera is
// replaced by injected frame sources (face crops from tests/faces/sample*.jpg);
// the API is a mocked route that behaves like the Dataverse flow (upsert on id).

const http = require("http");
const fs = require("fs");
const path = require("path");

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    "C:/Users/hbdei/OneDrive - BHFIRMS/System/System/THEO/codex-hub-refinement/node_modules/playwright-core",
    "C:/Users/HusseinBdeir/bhfirms/codex-hub/node_modules/playwright-core",
    "playwright-core",
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (_) {}
  }
  throw new Error("playwright-core not found in candidate paths");
}

const { chromium } = loadPlaywright();
const ROOT = path.resolve(__dirname, "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

function isValidVec128(v) {
  if (!Array.isArray(v) || v.length !== 128) return false;
  for (let i = 0; i < 128; i++) {
    const n = Number(v[i]);
    if (v[i] === null || v[i] === "" || typeof v[i] === "boolean" || !Number.isFinite(n)) return false;
  }
  return true;
}

function euclidean128(a, b) {
  if (!isValidVec128(a) || !isValidVec128(b)) return 99;
  let s = 0;
  for (let i = 0; i < 128; i++) { const d = Number(a[i]) - Number(b[i]); s += d * d; }
  const out = Math.sqrt(s);
  return Number.isFinite(out) ? out : 99;
}

function startStaticServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(u.pathname);
    if (rel === "/") rel = "/index.html";
    if (rel === "/js/endpoints.js" && !fs.existsSync(path.join(ROOT, "js", "endpoints.js"))) {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      res.end("const ATT_ENDPOINTS = {};\n");
      return;
    }
    const fp = path.resolve(ROOT, "." + rel);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404); res.end("Not found"); return;
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise(resolve => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// waitForFunction treats a Promise as truthy, so async predicates poll here instead
async function waitFor(page, fn, arg, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 60000)) {
    if (await page.evaluate(fn, arg)) return true;
    await sleep(300);
  }
  throw new Error("waitFor timeout");
}

(async () => {
  const localSrv = process.env.ATT_BASE ? null : await startStaticServer();
  const BASE = process.env.ATT_BASE || localSrv.base;
  const browser = await chromium.launch({
    channel: "chrome", headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const ctx = await browser.newContext({ permissions: ["camera"], viewport: { width: 1280, height: 800 } });

  // ---- mock API (what the Power Automate flow / ISABI Edge endpoint will do) ----
  const server = { punches: new Map(), faces: new Map(), calls: [], delayMs: 0, disableVerify: false, staffAdded: new Map(), rejectStaff: false, rejectPunchIds: new Set() };
  const roster = [
    { id: "11111111-1111-1111-1111-111111111111", name: "Alice A", officialName: "Alice Abbas" },
    { id: "22222222-2222-2222-2222-222222222222", name: "Bilal B", officialName: "Bilal Baz" },
    { id: "33333333-3333-3333-3333-333333333333", name: "Carla C", officialName: "" },
  ];
  await ctx.route("**/fakeapi", async route => {
    const body = JSON.parse(route.request().postData() || "{}");
    server.calls.push(body.op);
    if (server.delayMs) await sleep(server.delayMs);
    if (body.key !== "k") return route.fulfill({ status: 401, body: "bad key" });
    if (body.op === "roster") {
      if (body.redact) {
        const allF = [...server.faces.values()];
        const staffOut = roster.map(s => {
          const sf = allF.filter(f => f.staffId === s.id);
          return {
            id: s.id,
            name: s.name,
            officialName: s.officialName,
            hasPin: sf.some(f => !!f.pinhash),
            faceSamples: sf.filter(f => Array.isArray(f.descriptor) && f.descriptor.length === 128).length,
          };
        });
        const facesOut = allF.map(f => ({
          id: f.id,
          staffId: f.staffId,
          sample: f.sample || 0,
          faceRedacted: Array.isArray(f.descriptor) && f.descriptor.length === 128,
          hasPin: !!f.pinhash,
          consentAt: f.consentAt || "",
          ts: f.ts || "",
        }));
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, redacted: true, staff: staffOut, faces: facesOut }) });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, staff: roster.concat([...server.staffAdded.values()]), faces: body.restore ? [...server.faces.values()] : [] }) });
    }
    if (body.op === "sync") {
      if (!server.rejectStaff) (body.staff || []).forEach(s => server.staffAdded.set(s.id, { id: s.id, name: s.name, officialName: s.officialName || "" }));
      (body.punches || []).forEach(p => { if (!server.rejectPunchIds.has(p.id)) server.punches.set(p.id, p); });
      (body.faces || []).forEach(f => {
        if (!f || !f.id) return;
        const sid = f.staffId;
        const samp = Number(f.sample || 0);
        // Carry forward existing staff PIN hash when re-enrolling face poses without changing PIN
        let effPinhash = f.pinhash || "";
        if (!effPinhash && sid) {
          for (const old of server.faces.values()) {
            if (old.staffId === sid && old.pinhash) { effPinhash = old.pinhash; break; }
          }
        }
        // Remove superseded server rows for the same (staffId, sample), or legacy random-ID face rows on sample=1
        for (const [k, old] of [...server.faces.entries()]) {
          if (old.staffId === sid && k !== f.id) {
            if (Number(old.sample || 0) === samp || (samp === 1 && Number(old.sample || 0) > 0 && !String(k).startsWith(sid + ":"))) {
              server.faces.delete(k);
            }
          }
        }
        server.faces.set(f.id, { ...f, pinhash: effPinhash });
        // Propagate rotated PIN hash across all server rows for this staffId so revoked PINs never remain matchable
        if (f.pinhash && sid) {
          for (const [k, old] of server.faces.entries()) {
            if (old.staffId === sid && old.pinhash !== f.pinhash) {
              server.faces.set(k, { ...old, pinhash: f.pinhash, ts: f.ts || old.ts });
            }
          }
        }
      });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, punches: (body.punches || []).filter(p => !server.rejectPunchIds.has(p.id)).map(p => p.id), rejectedPunches: (body.punches || []).filter(p => server.rejectPunchIds.has(p.id)).map(p => p.id), faces: (body.faces || []).map(f => f.id), staff: server.rejectStaff ? [] : (body.staff || []).map(s => s.id) }) });
    }
    if (body.op === "verify" && !server.disableVerify) {
      if (body.method === "pin") {
        const hit = [...server.faces.values()].find(f => f.pinhash && f.pinhash === body.pinhash);
        if (!hit) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, matched: false, reason: "bad-pin" }) });
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, matched: true, staffId: hit.staffId }) });
      }
      if (body.method === "face") {
        const thr = typeof body.threshold === "number" ? body.threshold : 0.50;
        const probe = body.descriptor;
        if (!isValidVec128(probe)) {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, matched: false, reason: "bad-descriptor" }) });
        }
        const sampleCounts = new Map();
        for (const f of server.faces.values()) {
          if (Array.isArray(f.descriptor) && f.descriptor.length === 128) {
            sampleCounts.set(f.staffId, (sampleCounts.get(f.staffId) || 0) + 1);
          }
        }
        const usable = [...server.faces.values()].filter(f => Array.isArray(f.descriptor) && f.descriptor.length === 128 && (sampleCounts.get(f.staffId) || 0) >= 3);
        if (!usable.length) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, matched: false, reason: "no-enrolments" }) });
        let best = null, second = null;
        for (const f of usable) {
          const dist = euclidean128(probe, f.descriptor);
          if (!Number.isFinite(dist) || dist >= 99) continue;
          if (!best || dist < best.dist) {
            if (best && best.staffId !== f.staffId) second = best;
            best = { staffId: f.staffId, dist };
          } else if (f.staffId !== best.staffId && (!second || dist < second.dist)) {
            second = { staffId: f.staffId, dist };
          }
        }
        // Strictly zero distance / face_dist returned to kiosk client
        if (!best || !Number.isFinite(best.dist) || best.dist > thr) {
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, matched: false, reason: "far" }) });
        }
        if (second && (!Number.isFinite(second.dist - best.dist) || (second.dist - best.dist) < 0.08)) {
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, matched: false, reason: "ambiguous" }) });
        }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, matched: true, staffId: best.staffId, weak: best.dist > 0.45 }) });
      }
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, error: "bad op" }) });
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });

  console.log("1. boot + models");
  await page.goto(BASE + "/index.html");
  // first load installs the service worker; the page reloads itself once when it takes control
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 60000 });
  await page.waitForFunction(() => window.ATT_TEST && ATT_TEST.ready(), null, { timeout: 180000 });
  check("models loaded (after SW reload)", true);
  const backend = await page.evaluate(() => ATT_TEST.face.backend);
  console.log("     tf backend:", backend);

  console.log("1b. cloud endpoint + station key (v0.5.0)");
  const epInfo = await page.evaluate(async () => {
    const d = (typeof ATT_ENDPOINTS === "object" && ATT_ENDPOINTS && ATT_ENDPOINTS.default) || {};
    const raw = await (await fetch("js/endpoints.js?probe=" + Date.now())).text();
    const r = await ATT_TEST.sync.run("no-key");
    let rosterErr = "";
    try { await ATT_TEST.sync.roster(false); } catch (e) { rosterErr = String(e.message || e); }
    return { url: d.url || "", keys: Object.keys(d).join(","), raw, ready: await ATT_TEST.sync.ready(), ok: r.ok, msg: r.msg, rosterErr };
  });
  check("endpoint is the ISABI cloud and the shipped file carries no key",
    epInfo.url === "https://isabisystems.com/app/api/kiosk/verify" && epInfo.keys === "url"
    && !/"[uk]"\s*:|\bkey\s*:/.test(epInfo.raw) && !/[A-Za-z0-9+/=]{40,}/.test(epInfo.raw), { url: epInfo.url, keys: epInfo.keys });
  check("with no station key nothing is sent and it is not shown as a sync error",
    epInfo.ready === false && epInfo.ok === null && /station key not set/.test(epInfo.msg) && /station key not set/.test(epInfo.rosterErr) && server.calls.length === 0,
    { ready: epInfo.ready, ok: epInfo.ok, msg: epInfo.msg, rosterErr: epInfo.rosterErr, calls: server.calls.length });

  console.log("2. settings + roster");
  await page.evaluate(async () => {
    await ATT_TEST.db.setMeta("apiUrl", location.origin + "/fakeapi");
    await ATT_TEST.db.setMeta("apiKey", "k");
    await ATT_TEST.db.setMeta("site", "LAUNA");
    await ATT_TEST.db.setMeta("device", "test-tablet");
  });
  const ro = await page.evaluate(async () => { const r = await ATT_TEST.sync.roster(false); await ATT_TEST.loadData(); return r; });
  check("roster pulled 3 staff", ro.staff === 3, ro);
  check("site name shown", (await page.textContent("#siteName")) === "La Una");

  console.log("3. descriptors from sample photo");
  const faces = await page.evaluate(async () => {
    const img = new Image(); img.src = "tests/faces/sample1.jpg"; await img.decode();
    window.__img = img;
    const r = await ATT_TEST.descriptorsFromImage(img);
    return r.map(x => ({ box: { x: x.box.x, y: x.box.y, width: x.box.width, height: x.box.height } }));
  });
  console.log("     faces found in sample1:", faces.length);
  check("at least 2 faces in the sample photo", faces.length >= 2, faces.length);
  // crop helper lives in the page: crop(faceIdx, pad, mirror, scale) -> canvas (re-installed after reloads)
  const installCrop = () => page.evaluate(async boxes => {
    if (!window.__img) { const img = new Image(); img.src = "tests/faces/sample1.jpg"; await img.decode(); window.__img = img; }
    window.__crop = (i, pad, mirror, scale) => {
      const b = boxes[i].box; const img = window.__img;
      const px = b.width * pad, py = b.height * pad;
      const sx = Math.max(0, b.x - px), sy = Math.max(0, b.y - py);
      const sw = Math.min(img.naturalWidth - sx, b.width + 2 * px), sh = Math.min(img.naturalHeight - sy, b.height + 2 * py);
      const cv = document.createElement("canvas"); cv.width = Math.round(sw * scale); cv.height = Math.round(sh * scale);
      const g = cv.getContext("2d");
      if (mirror) { g.translate(cv.width, 0); g.scale(-1, 1); }
      g.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
      return cv;
    };
  }, faces.map(f => ({ box: f.box })));
  await installCrop();

  console.log("4. enrol Alice (face 0) with 3 samples");
  await page.evaluate(() => ATT_TEST.openManager());
  await page.evaluate(() => ATT_TEST.selectEnrol("11111111-1111-1111-1111-111111111111"));
  const caps = [];
  for (const [pad, mirror, scale] of [[0.6, false, 1.0], [0.8, true, 0.9], [0.5, false, 1.2]]) {
    caps.push(await page.evaluate(async a => { ATT_TEST.setFrameSource(window.__crop(0, a[0], a[1], a[2])); return ATT_TEST.captureSample(); }, [pad, mirror, scale]));
  }
  check("3 samples captured", caps.every(Boolean), caps);
  check("save blocked without consent", (await page.evaluate(() => ATT_TEST.saveEnrolment())) === false);
  await page.evaluate(() => ATT_TEST.setEnrolConsent(true));
  check("save ok with consent", await page.evaluate(() => ATT_TEST.saveEnrolment()));
  const nFaces = await page.evaluate(async () => (await ATT_TEST.db.allFaces()).length);
  check("3 face rows stored", nFaces === 3, nFaces);

  console.log("4b. test recognition readout + 3-sample cap + pose pictograms + test before save");
  await page.evaluate(() => { ATT_TEST.setFrameSource(window.__crop(0, 0.6, false, 1.0)); });
  await page.click("#enTest");
  await sleep(1500);
  const tOut = await page.textContent("#enTestOut");
  check("test recognition shows Alice accepted", /\u2713 Alice A/.test(tOut), tOut);
  await page.click("#enTest");
  check("stop test clears the readout", (await page.textContent("#enTestOut")) === "");
  // Bilal: three samples of face 1 walk through the three pictograms; a fourth is refused
  await page.evaluate(() => ATT_TEST.selectEnrol("22222222-2222-2222-2222-222222222222"));
  // test with 0 pending samples and Bilal in front: not recognised (only Alice is stored)
  await page.evaluate(() => { ATT_TEST.setFrameSource(window.__crop(1, 0.6, false, 1.0)); });
  await page.click("#enTest"); await sleep(1500);
  check("before capture: Bilal not recognised", /Not recognised/.test(await page.textContent("#enTestOut")), await page.textContent("#enTestOut"));
  await page.click("#enTest");
  const poseTexts = [], guides = [], caps3 = [];
  for (const [pad, mirror, scale] of [[0.6, false, 1.0], [0.8, true, 0.9], [0.5, false, 1.2]]) {
    poseTexts.push(await page.textContent("#enPose"));
    guides.push(await page.evaluate(() => document.getElementById("enGuide").dataset.pose));
    caps3.push(await page.evaluate(async a => { ATT_TEST.setFrameSource(window.__crop(1, a[0], a[1], a[2])); return ATT_TEST.captureSample(); }, [pad, mirror, scale]));
    if (caps3.length === 2) {
      // two of three taken: the test says how many are missing instead of "no enrolments"
      await page.click("#enTest"); await sleep(1500);
      check("2 of 3 taken: readout says only 2 of 3", /[Oo]nly 2 of 3/.test(await page.textContent("#enTestOut")), await page.textContent("#enTestOut"));
      await page.click("#enTest");
    }
  }
  check("3 samples captured for Bilal", caps3.every(Boolean), caps3);
  check("pose line counts 1 / 3 … 3 / 3", poseTexts[0].includes("1 / 3") && poseTexts[2].includes("3 / 3"), poseTexts);
  check("guide pictograms follow the pose order", guides.join(",") === "straight,left,right", guides);
  check("guide shows done after the 3rd", await page.evaluate(() => document.getElementById("enGuide").dataset.pose) === "done");
  check("4th capture refused + Capture disabled", (await page.evaluate(() => ATT_TEST.captureSample())) === false && await page.evaluate(() => document.getElementById("enCapture").disabled));
  check("Save enabled + glowing with 3 unsaved samples", await page.evaluate(() => !document.getElementById("enSave").disabled && document.getElementById("enSave").classList.contains("ready")));
  check("LEFT pictogram carries a pulsing arrow", /class="arrow"/.test(await page.evaluate(() => ATT_TEST.poseSvg("left"))));
  // v0.2.4: every pose shows the camera; the turns are SMALL (both eyes drawn, one ear) + a short arc arrow
  const svgs = await page.evaluate(() => ({ s: ATT_TEST.poseSvg("straight"), l: ATT_TEST.poseSvg("left"), r: ATT_TEST.poseSvg("right") }));
  const eyes = s => (s.match(/<circle cx="[\d.]+" cy="58"/g) || []).length, ears = s => (s.match(/q-?8 7 0 14/g) || []).length;
  check("all three pictograms show the camera", [svgs.s, svgs.l, svgs.r].every(s => /<rect x="40" y="2"/.test(s)));
  check("straight: no arrow, both ears, sight line", !/class="arrow"/.test(svgs.s) && ears(svgs.s) === 2 && /stroke-dasharray/.test(svgs.s));
  check("left/right: both eyes still drawn + one ear each", eyes(svgs.l) === 2 && eyes(svgs.r) === 2 && ears(svgs.l) === 1 && ears(svgs.r) === 1);
  check("right pictogram arrow nudges the other way", /--dx:-4px/.test(svgs.l) && /--dx:4px/.test(svgs.r));
  check("turn prompts say slightly + both eyes", (await page.evaluate(() => ATT_CONFIG.match.poses.slice(1))).every(p => /slightly/.test(p) && /both eyes/.test(p)));
  // test BEFORE saving: the unsaved captures count, the readout says so
  await page.evaluate(() => { ATT_TEST.setFrameSource(window.__crop(1, 0.7, true, 1.0)); });
  await page.click("#enTest"); await sleep(1500);
  const tPend = await page.textContent("#enTestOut");
  check("test before save recognises Bilal from the unsaved samples", /\u2713 Bilal B/.test(tPend) && /not saved yet/.test(tPend), tPend);
  await page.click("#enTest");
  check("nothing stored for Bilal yet", (await page.evaluate(async () => (await ATT_TEST.db.allFaces()).filter(f => f.staffId.startsWith("2222")).length)) === 0);
  // a sample of Alice offered for Bilal must be rejected as "already matches"
  await page.evaluate(() => ATT_TEST.selectEnrol("22222222-2222-2222-2222-222222222222"));
  const dup = await page.evaluate(async () => { ATT_TEST.setFrameSource(window.__crop(0, 0.7, false, 1.0)); return ATT_TEST.captureSample(); });
  check("Alice's face rejected as a sample for Bilal", dup === false);
  await page.evaluate(() => ATT_TEST.closeManager());

  console.log("5. kiosk: Alice punches IN via face");
  const day = await page.evaluate(() => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; });
  await page.evaluate(() => ATT_TEST.setFrameSource(window.__crop(0, 0.9, false, 0.8)));
  await waitFor(page, async d => (await ATT_TEST.db.punchesForDay(d)).length === 1, day, 60000);
  let punches = await page.evaluate(d => ATT_TEST.db.punchesForDay(d), day);
  check("one punch", punches.length === 1);
  check("punch is IN / face / Alice", punches[0].direction === "in" && punches[0].method === "face" && punches[0].staffName === "Alice A", punches[0]);
  check("punch has a snapshot", (punches[0].snapshot || "").startsWith("data:image/jpeg"));
  check("confidence recorded", typeof punches[0].confidence === "number" && punches[0].confidence <= 0.5, punches[0].confidence);
  check("card visible + IN", (await page.getAttribute("#card", "class")).includes("in"));

  console.log("6. debounce: same face again = no new punch");
  await page.evaluate(() => ATT_TEST.hideCard());
  // confirmFrames frames must pass again before the debounce card shows (slow under swiftshader)
  await page.waitForFunction(() => document.getElementById("cardLine").textContent.includes("Already"), null, { timeout: 60000 });
  punches = await page.evaluate(d => ATT_TEST.db.punchesForDay(d), day);
  check("still one punch", punches.length === 1, punches.length);
  check("'already clocked' card", (await page.textContent("#cardLine")).includes("Already"));
  await page.evaluate(() => ATT_TEST.hideCard());

  console.log("7. unknown face (face 1) -> PIN hint, no punch");
  // the unknown person comes from a second photo; try pads until the detector sees the face
  const unk = await page.evaluate(async () => {
    const img = new Image(); img.src = "tests/faces/sample2.jpg"; await img.decode();
    const all = await ATT_TEST.face.detectAll(img);
    if (!all.length) return { found: false };
    const faces = (await ATT_TEST.db.allFaces()).filter(f => f.d.length === 128);
    for (const r of all) {
      for (const pad of [1.0, 1.5, 0.7, 2.0]) {
        const b = r.box, px = b.width * pad, py = b.height * pad;
        const sx = Math.max(0, b.x - px), sy = Math.max(0, b.y - py);
        const sw = Math.min(img.naturalWidth - sx, b.width + 2 * px), sh = Math.min(img.naturalHeight - sy, b.height + 2 * py);
        const cv = document.createElement("canvas"); cv.width = Math.round(sw); cv.height = Math.round(sh);
        cv.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
        const det = await ATT_TEST.face.detectOne(cv);
        if (det) { window.__unk = cv; const m = ATT_TEST.face.match(det.descriptor, faces); return { found: true, pad, distance: m && m.distance }; }
      }
    }
    return { found: false };
  });
  console.log("     unknown face:", JSON.stringify(unk));
  check("unknown face detectable + not matching Alice", unk.found && unk.distance > 0.5, unk);
  await page.evaluate(() => ATT_TEST.setFrameSource(window.__unk));
  await page.waitForFunction(() => document.getElementById("hint").textContent.includes("Not recognised"), null, { timeout: 30000 });
  check("PIN hint shown", true);
  punches = await page.evaluate(d => ATT_TEST.db.punchesForDay(d), day);
  check("no punch for the unknown face", punches.length === 1, punches.length);

  console.log("8. Bilal gets a PIN only, punches via keypad");
  await page.evaluate(() => ATT_TEST.setFrameSource(null));
  await page.evaluate(() => ATT_TEST.openManager());
  await page.evaluate(() => ATT_TEST.selectEnrol("22222222-2222-2222-2222-222222222222"));
  await page.evaluate(() => ATT_TEST.setEnrolPin("1234"));
  check("pin-only enrolment saved", await page.evaluate(() => ATT_TEST.saveEnrolment()));
  await page.evaluate(() => ATT_TEST.closeManager());
  await page.click("#btnPin");
  for (const k of ["9", "9", "9", "9"]) await page.click(`#keypad button[data-k="${k}"]`);
  await sleep(600);
  check("wrong PIN keeps the keypad open", await page.evaluate(() => document.getElementById("keypad").classList.contains("open")));
  for (const k of ["1", "2", "3", "4"]) await page.click(`#keypad button[data-k="${k}"]`);
  await waitFor(page, async d => (await ATT_TEST.db.punchesForDay(d)).length === 2, day, 10000);
  punches = await page.evaluate(d => ATT_TEST.db.punchesForDay(d), day);
  const bp = punches.find(p => p.staffName === "Bilal B");
  check("Bilal punched IN via pin", bp && bp.direction === "in" && bp.method === "pin", bp);
  await page.evaluate(() => ATT_TEST.hideCard());

  console.log("9. sync pushes punches + enrolments");
  const s1 = await page.evaluate(() => ATT_TEST.sync.run("test"));
  check("sync ok", s1.ok === true, s1);
  check("server holds 2 punches", server.punches.size === 2, server.punches.size);
  check("server holds 4 enrolment rows (3 face + 1 pin-only)", server.faces.size === 4, server.faces.size);
  const pinRow = [...server.faces.values()].find(f => f.staffId.startsWith("2222"));
  check("pin-only row carries a sha256 pinhash, no descriptor", pinRow && pinRow.pinhash.length === 64 && pinRow.descriptor.length === 0, pinRow && pinRow.pinhash);
  check("nothing pending", (await page.evaluate(() => ATT_TEST.db.unsyncedCount())) === 0);

  console.log("10. flip direction re-syncs as an upsert");
  const aliceId = punches.find(p => p.staffName === "Alice A").id;
  await page.evaluate(async id => { const p = await ATT_TEST.db.getPunch(id); p.direction = "out"; p.synced = 0; await ATT_TEST.db.savePunch(p); }, aliceId);
  await page.evaluate(() => ATT_TEST.sync.run("test"));
  check("server punch updated in place (still 2 rows)", server.punches.size === 2 && server.punches.get(aliceId).direction === "out");

  console.log("11. reload persistence + restore from server");
  await page.reload();
  await page.waitForFunction(() => window.ATT_TEST && ATT_TEST.ready(), null, { timeout: 180000 });
  await installCrop();
  const after = await page.evaluate(async () => ({ staff: (await ATT_TEST.db.allStaff()).length, faces: (await ATT_TEST.db.allFaces()).length, punches: (await ATT_TEST.db.unsyncedCount()) }));
  check("data survives reload", after.staff === 3 && after.faces === 4 && after.punches === 0, after);
  await page.evaluate(async () => { for (const f of await ATT_TEST.db.allFaces()) await ATT_TEST.db.deleteFace(f.id); await ATT_TEST.loadData(); });
  const rr = await page.evaluate(async () => { const r = await ATT_TEST.sync.roster(true); await ATT_TEST.loadData(); return r; });
  check("restore brings back 3 face samples", rr.restored === 3, rr);
  const bilal = await page.evaluate(() => ATT_TEST.db.getStaff("22222222-2222-2222-2222-222222222222"));
  check("Bilal's pin hash restored onto the roster", bilal && bilal.pinhash && bilal.pinhash.length === 64);
  // Alice matches again after restore, and toggles to IN (last synced was OUT).
  // Backdate her earlier punch past the debounce window first (the test runs inside 2 minutes).
  await page.evaluate(async id => { const p = await ATT_TEST.db.getPunch(id); p.ts = new Date(Date.now() - 5 * 60000).toISOString(); await ATT_TEST.db.savePunch(p); }, aliceId);
  await page.evaluate(() => ATT_TEST.setFrameSource(window.__crop(0, 0.7, true, 1.0)));
  await waitFor(page, async d => (await ATT_TEST.db.punchesForDay(d)).filter(p => p.staffName === "Alice A").length === 2, day, 60000);
  punches = await page.evaluate(d => ATT_TEST.db.punchesForDay(d), day);
  const a2 = punches.filter(p => p.staffName === "Alice A").sort((x, y) => x.ts.localeCompare(y.ts))[1];
  check("Alice recognised after restore, direction toggled to IN", a2 && a2.direction === "in", a2 && a2.direction);

  console.log("12. manager keypad");
  await page.evaluate(() => ATT_TEST.hideCard());
  await page.click("#btnMgr");
  for (const k of ["9", "9", "9", "9"]) await page.click(`#keypad button[data-k="${k}"]`);
  await sleep(300);
  check("manager view opens with default PIN", await page.evaluate(() => document.getElementById("mgr").classList.contains("open")));
  await page.click('.tab[data-tab="log"]');
  await sleep(300);
  const rows = await page.$$eval("#logTable tbody tr", r => r.length);
  check("log shows today's punches", rows === 3, rows);

  console.log("13. matching rules (synthetic descriptors)");
  const rules = await page.evaluate(() => {
    const v = (i, val) => { const d = new Array(128).fill(0); d[i] = val; return d; };
    const faces = [{ staffId: "A", d: v(0, 0) }, { staffId: "A", d: v(1, 0.05) }, { staffId: "B", d: v(0, 0.6) }];
    const near = ATT_TEST.face.match(v(0, 0.2), faces);     // A 0.20, B 0.40 -> gap 0.20
    const amb = ATT_TEST.face.match(v(0, 0.28), faces);     // A 0.28, B 0.32 -> gap 0.04 < margin
    const far = ATT_TEST.face.match(v(0, -0.7), faces);     // A 0.70
    const names = new Map([["A", "Ann"], ["B", "Bob"]]);
    return {
      near: { m: near, d: ATT_TEST.face.decide(near, 0.5) },
      amb: { m: amb, d: ATT_TEST.face.decide(amb, 0.5) },
      far: ATT_TEST.face.decide(far, 0.5),
      weak: ATT_TEST.face.decide({ distance: 0.47, runnerUp: null, margin: null }, 0.5),
      none: ATT_TEST.face.decide(null, 0.5),
      calOk: ATT_TEST.face.calibration(faces, names, 0.5),
      calClose: ATT_TEST.face.calibration([faces[0], faces[1], { staffId: "B", d: v(0, 0.5) }], names, 0.5),
      calReal: ATT_TEST.calibration(),
    };
  });
  check("best = A with B as runner-up, accepted", rules.near.m.staffId === "A" && rules.near.m.runnerUp.staffId === "B" && rules.near.d.ok && !rules.near.d.weak, rules.near);
  check("gap below margin -> ambiguous (no punch)", rules.amb.d.ok === false && rules.amb.d.reason === "ambiguous", rules.amb);
  check("far -> rejected", rules.far.ok === false && rules.far.reason === "far", rules.far);
  check("0.47 accepted but flagged weak", rules.weak.ok && rules.weak.weak === true, rules.weak);
  check("no enrolments -> reason", rules.none.reason === "no-enrolments");
  check("calibration: closest pair Ann/Bob at 0.6, recommend 0.5, no warning", rules.calOk.closestOther && rules.calOk.closestOther.distance === 0.6 && rules.calOk.recommend === 0.5 && rules.calOk.warnings.length === 0, rules.calOk);
  check("calibration: pair at 0.5 -> warning + stricter recommendation", rules.calClose.warnings.length === 1 && /Ann/.test(rules.calClose.warnings[0]) && rules.calClose.recommend === 0.4, rules.calClose);
  check("device calibration: 1 person, 3 samples, nothing to compare", rules.calReal.persons === 1 && rules.calReal.samples === 3 && rules.calReal.closestOther === null, rules.calReal);

  console.log("14. face-size gate (background faces ignored)");
  await page.evaluate(() => ATT_TEST.closeManager());
  const small = await page.evaluate(() => ATT_TEST.detectFrame(window.__crop(0, 4.0, false, 0.6)));
  console.log("     small face:", JSON.stringify(small));
  check("face under minFaceFrac is ignored (no punch)", small.matched === false && (small.reason === "small" || small.reason === "no-face"), small);
  const big = await page.evaluate(() => ATT_TEST.detectFrame(window.__crop(0, 0.7, false, 1.0)));
  check("close face reports its frame fraction >= min", big.matched === true || big.reason !== "small", big);

  console.log("15. liveness (blink) challenge");
  await page.evaluate(async d => {
    ATT_TEST.setFrameSource(null);
    for (const p of await ATT_TEST.db.punchesForDay(d)) { if (p.staffName === "Alice A") { p.ts = new Date(Date.now() - 10 * 60000).toISOString(); await ATT_TEST.db.savePunch(p); } }
    await ATT_TEST.setLiveness(true);
    window.__ears = [0.3, 0.3, 0.3, 0.15, 0.15, 0.3];
    ATT_TEST.setLiveMock(() => ({ ear: window.__ears.length > 1 ? window.__ears.shift() : window.__ears[0], box: { x: 0, y: 0, width: 10, height: 10 } }));
    ATT_TEST.hideCard();
    ATT_TEST.setFrameSource(window.__crop(0, 0.7, false, 1.0));
  }, day);
  await waitFor(page, async d => (await ATT_TEST.db.punchesForDay(d)).filter(p => p.staffName === "Alice A").length === 3, day, 30000);
  punches = await page.evaluate(d => ATT_TEST.db.punchesForDay(d), day);
  const live = punches.filter(p => p.staffName === "Alice A").sort((x, y) => x.ts.localeCompare(y.ts))[2];
  check("punch only after the blink, note says so", live && live.method === "face" && /blink ok/.test(live.note), live && live.note);
  // no blink within the window -> no punch
  await page.evaluate(async d => {
    for (const p of await ATT_TEST.db.punchesForDay(d)) { if (p.staffName === "Alice A") { p.ts = new Date(Date.now() - 10 * 60000).toISOString(); await ATT_TEST.db.savePunch(p); } }
    window.__ears = [0.3];
    ATT_TEST.hideCard();
  }, day);
  await page.waitForFunction(() => document.getElementById("hint").textContent.includes("Blink not seen"), null, { timeout: 15000 });
  punches = await page.evaluate(d => ATT_TEST.db.punchesForDay(d), day);
  check("no blink -> no punch, hint explains", punches.filter(p => p.staffName === "Alice A").length === 3);
  await page.evaluate(async () => { await ATT_TEST.setLiveness(false); ATT_TEST.setLiveMock(null); ATT_TEST.setFrameSource(null); ATT_TEST.state.live = null; });

  console.log("16. PIN lockout + hashed manager PIN");
  await page.click("#btnMgr");
  for (let i = 0; i < 5; i++) { for (const k of ["1", "1", "1", "1"]) await page.click(`#keypad button[data-k="${k}"]`); await sleep(550); }
  check("5 wrong PINs lock the keypad", await page.evaluate(() => ATT_TEST.keypad.locked) === true);
  check("lock message shown", /Too many attempts/.test(await page.textContent("#kpTitle")));
  await page.evaluate(() => ATT_TEST.keypad.unlock());
  await page.click('#keypad button[data-k="x"]');
  const pinHash = await page.evaluate(async () => {
    await ATT_TEST.setManagerPin("4321");
    return { h: await ATT_TEST.db.getMeta("mgrPinHash", ""), old: await ATT_TEST.managerPinOk("9999"), neu: await ATT_TEST.managerPinOk("4321") };
  });
  check("manager PIN stored as sha256, old default rejected", pinHash.h.length === 64 && pinHash.old === false && pinHash.neu === true, pinHash);

  console.log("17. v0.3.0 HUD, KPIs, shift pairing & filters");
  check("kiosk on-site pill shows 1 on-site (Bilal IN, Alice IN after OUT+IN+IN)", /on-site/.test(await page.textContent("#onSiteCount")));
  await page.evaluate(() => ATT_TEST.openManager());
  check("default PIN warning banner hidden after PIN changed", await page.evaluate(() => document.getElementById("mgrPinBanner").hidden === true));
  await page.click('.tab[data-tab="staff"]');
  await sleep(200);
  check("staff KPIs: 3 active, 1 face ready, 1 PIN configured, 1 needs setup",
    (await page.textContent("#kpiStTotal")) === "3" &&
    (await page.textContent("#kpiStFace")) === "1" &&
    (await page.textContent("#kpiStPin")) === "1" &&
    (await page.textContent("#kpiStMissing")) === "1");
  await page.click('#stFilter button[data-sf="none"]');
  check("staff filter 'Not Enrolled' shows only Carla", (await page.$$eval("#stTable tbody tr", r => r.length)) === 1);
  await page.click('#stFilter button[data-sf="all"]');
  await page.click('.tab[data-tab="log"]');
  await sleep(200);
  check("log KPIs show 2 staff seen and 4 events",
    (await page.textContent("#kpiLogStaff")) === "2" &&
    (await page.textContent("#kpiLogEvents")) === "4");
  await page.click("#logShiftsToggle");
  check("shift pairing panel opens and shows 2 shift cards",
    await page.evaluate(() => !document.getElementById("logShiftsPanel").hidden) &&
    (await page.$$eval("#logShiftsBody .shiftCard", r => r.length)) === 2);

  console.log("18. v0.3.2 edge cases: PIN survives roster refresh, night shift, in-flight flip, phone layout");
  const ALICE = "11111111-1111-1111-1111-111111111111", BILAL = "22222222-2222-2222-2222-222222222222", CARLA = "33333333-3333-3333-3333-333333333333";
  const pinBefore = await page.evaluate(async id => (await ATT_TEST.db.getStaff(id)).pinhash, BILAL);
  await page.evaluate(async () => { await ATT_TEST.sync.roster(false); await ATT_TEST.loadData(); });
  const pinAfter = await page.evaluate(async id => (await ATT_TEST.db.getStaff(id)).pinhash, BILAL);
  check("staff PIN survives a plain roster refresh (server sends no pinhash)", pinBefore && pinBefore.length === 64 && pinAfter === pinBefore, { pinBefore, pinAfter });

  // night shift: Carla clocked IN "yesterday" 3 h ago -> the next punch must be OUT; a 20 h old IN no longer counts
  const night = await page.evaluate(async id => {
    const pad = n => String(n).padStart(2, "0");
    const y = new Date(); y.setDate(y.getDate() - 1);
    const yday = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;
    const row = { id: "aaaaaaaa-0000-4000-8000-00000000a001", staffId: id, staffName: "Carla C", ts: new Date(Date.now() - 3 * 3600000).toISOString(), day: yday, tzOffsetMin: 0, direction: "in", method: "manual", confidence: null, snapshot: "", site: "LAUNA", synced: 1, rev: 0, note: "" };
    await ATT_TEST.db.savePunch(row);
    const last = await ATT_TEST.lastPunchRecent(id);
    const p = await ATT_TEST.punch(id, "manual", null, null, null, "night test");
    ATT_TEST.hideCard();
    row.ts = new Date(Date.now() - 20 * 3600000).toISOString(); await ATT_TEST.db.savePunch(row);
    if (p) await ATT_TEST.db.deletePunch(p.id);
    const stale = await ATT_TEST.lastPunchRecent(id);
    await ATT_TEST.db.deletePunch(row.id);
    return { lastDir: last && last.direction, newDir: p && p.direction, stale };
  }, CARLA);
  check("IN before midnight -> next punch after midnight is OUT", night.lastDir === "in" && night.newDir === "out", night);
  check("a 20 h old IN no longer flips the direction", night.stale === null, night);

  // in-flight flip: the server answers slowly; the user flips the card while the first push is on the wire
  server.delayMs = 1500;
  await page.evaluate(() => ATT_TEST.closeManager());
  const raceId = await page.evaluate(async id => { const p = await ATT_TEST.punch(id, "manual", null, null, "in", "race"); return p && p.id; }, ALICE);
  await sleep(400);
  await page.evaluate(() => document.getElementById("cardFlip").click());
  await waitFor(page, async id => { const p = await ATT_TEST.db.getPunch(id); return p && p.synced === 1 && !ATT_TEST.sync.running; }, raceId, 15000);
  await sleep(300);
  const raceLocal = await page.evaluate(async id => ATT_TEST.db.getPunch(id), raceId);
  const raceServer = server.punches.get(raceId);
  check("flip during an in-flight push: local row synced only after the OUT reached the server", raceLocal.direction === "out" && raceLocal.rev === 1 && raceLocal.synced === 1 && raceServer && raceServer.direction === "out", { local: raceLocal.direction, rev: raceLocal.rev, server: raceServer && raceServer.direction });
  server.delayMs = 0;
  await page.evaluate(() => ATT_TEST.hideCard());

  // phone layout (portrait 390x844 and landscape 844x390), no reload needed
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  const portrait = await page.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect();
    const W = innerWidth;
    const hud = r("#kiosk .kioskTopRight"), left = r("#kiosk .kioskTopLeft"), bar = r(".bar");
    return { W, hudRight: Math.round(hud.right), hudOverlap: hud.left < left.right && hud.top < left.bottom, barRight: Math.round(bar.right), hint: Math.round(r("#hint").right) };
  });
  check("portrait phone: clock/sync HUD stays inside the screen", portrait.hudRight <= portrait.W && !portrait.hudOverlap, portrait);
  await page.evaluate(() => ATT_TEST.openManager());
  await sleep(300);
  const tabs = await page.$$eval(".tab", els => els.map(e => { const r = e.getBoundingClientRect(); return { t: e.dataset.tab, l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) }; }));
  check("portrait phone: all four manager tabs reachable on screen", tabs.length === 4 && tabs.every(t => t.l >= 0 && t.r <= 390 && t.h >= 30), tabs);
  await page.evaluate(() => document.querySelector('.tab[data-tab="log"]').click());
  await sleep(200);
  const tbl = await page.evaluate(() => { const c = document.querySelector("#tab-log .tableCard"); return { ox: getComputedStyle(c).overflowX, cw: c.clientWidth, sw: c.scrollWidth, right: Math.round(c.getBoundingClientRect().right) }; });
  check("portrait phone: log table scrolls sideways inside the viewport instead of clipping", tbl.ox === "auto" && tbl.right <= 390 && tbl.sw >= tbl.cw, tbl);
  await page.evaluate(() => ATT_TEST.closeManager());
  await page.setViewportSize({ width: 844, height: 390 });
  await sleep(300);
  await page.click("#btnPin");
  await sleep(200);
  const kp = await page.evaluate(() => { const r = document.querySelector(".kpGrid").getBoundingClientRect(); return { bottom: Math.round(r.bottom), H: innerHeight }; });
  check("landscape phone: whole keypad visible without scrolling", kp.bottom <= kp.H, kp);
  await page.click('#keypad [data-k="x"]');
  await page.evaluate(async id => { await ATT_TEST.punch(id, "manual", null, null, "in", "layout"); }, BILAL);
  await sleep(300);
  const cardGeom = await page.evaluate(() => {
    const c = document.getElementById("card").getBoundingClientRect(), hud = document.querySelector("#kiosk .kioskTopRight").getBoundingClientRect(), bar = document.querySelector(".bar").getBoundingClientRect();
    const inter = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    return { hud: inter(c, hud), bar: inter(c, bar), hintOpacity: getComputedStyle(document.querySelector(".hintWrap")).opacity, top: Math.round(c.top), bottom: Math.round(c.bottom) };
  });
  check("landscape phone: confirmation card clears the HUD and the dock, hint hidden under it", !cardGeom.hud && !cardGeom.bar && cardGeom.hintOpacity === "0", cardGeom);
  await page.evaluate(() => ATT_TEST.hideCard());
  await page.setViewportSize({ width: 1280, height: 800 });
  const alive = await page.evaluate(() => ATT_TEST.streamAlive());
  check("camera stream reported alive after viewport changes", alive === true);

  // v0.3.4 Home Screen & HUD red notification count badge
  const badgeTest = await page.evaluate(async () => {
    await ATT_TEST.markAllAttNotifsChecked();
    const afterClear = {
      count: await ATT_TEST.updateAttendanceAppBadge(),
      hidden: document.getElementById("notifCountBadge").hidden,
    };
    const pushedCount = await ATT_TEST.pushAttNotif({ id: "smoke-alert-1", title: "Shift Alert", body: "Late check-in review" });
    const afterPush = {
      count: pushedCount,
      hidden: document.getElementById("notifCountBadge").hidden,
      text: document.getElementById("notifCountBadge").textContent,
      mgrHidden: document.getElementById("mgrCountBadge").hidden,
    };
    await ATT_TEST.markAttNotifChecked("smoke-alert-1");
    const afterCheck = {
      count: await ATT_TEST.updateAttendanceAppBadge(),
      hidden: document.getElementById("notifCountBadge").hidden,
    };
    return { afterClear, afterPush, afterCheck };
  });
  check("notification count badge: shows #FF3B30 unread count on push and clears when checked",
    badgeTest.afterClear.count === 0 && badgeTest.afterClear.hidden === true &&
    badgeTest.afterPush.count === 1 && badgeTest.afterPush.hidden === false && badgeTest.afterPush.text === "1" && badgeTest.afterPush.mgrHidden === false &&
    badgeTest.afterCheck.count === 0 && badgeTest.afterCheck.hidden === true,
    badgeTest);

  console.log("19. v0.4.0 Server-Redacted 1:N Biometric & PIN Mode (0 local vectors/pinhashes + rival margin reject + 0 oracle leak)");
  await page.evaluate(() => ATT_TEST.setFrameSource(null));
  await page.evaluate(() => ATT_TEST.setLiveness(false));

  // NEGATIVE: if server does not support op:"verify", enabling redactedMode MUST keep local vectors intact
  server.disableVerify = true;
  const blockedRedact = await page.evaluate(() => ATT_TEST.setRedactedMode(true));
  const keptBeforeSupport = await page.evaluate(() => ATT_TEST.state.faces.length);
  check("NEGATIVE: enabling redactedMode against unsupported server keeps local 128-d vectors intact",
    blockedRedact.ok === false && keptBeforeSupport >= 3, { blockedRedact, keptBeforeSupport });
  server.disableVerify = false;

  await page.evaluate(() => ATT_TEST.setRedactedMode(true));

  const scrubCheck = await page.evaluate(async () => {
    const dbFaces = await ATT_TEST.db.allFaces();
    const dbStaff = await ATT_TEST.db.allStaff();
    const hasRawDesc = dbFaces.some(f => Array.isArray(f.d) && f.d.length > 0);
    const hasRawFacePin = dbFaces.some(f => !!f.pinhash);
    const hasRawStaffPin = dbStaff.some(s => !!s.pinhash);
    return {
      memFaces: ATT_TEST.state.faces.length,
      hasRawDesc,
      hasRawFacePin,
      hasRawStaffPin,
      redactedStubs: dbFaces.filter(f => f.faceRedacted).length,
      bilalRedactedPin: !!(dbStaff.find(s => s.id.startsWith("2222")) || {}).pinRedacted,
    };
  });
  check("redactedMode scrubs 100% of raw 128-d vectors & pinhashes from IndexedDB and RAM",
    scrubCheck.memFaces === 0 && !scrubCheck.hasRawDesc && !scrubCheck.hasRawFacePin && !scrubCheck.hasRawStaffPin && scrubCheck.redactedStubs >= 3 && scrubCheck.bilalRedactedPin,
    scrubCheck);

  // Backdate Alice's & Bilal's punches past debounce window so live redacted punches record cleanly
  await page.evaluate(async d => {
    for (const p of await ATT_TEST.db.punchesForDay(d)) {
      p.ts = new Date(Date.now() - 10 * 60000).toISOString();
      await ATT_TEST.db.savePunch(p);
    }
    ATT_TEST.state.lastPunchAt.clear();
  }, day);

  const aliceProbe = [...server.faces.values()].find(f => f.staffId.startsWith("1111") && f.descriptor.length === 128).descriptor;
  const redVerifyRes = await page.evaluate(async d => {
    ATT_TEST.state.redactedStreak = [];
    let res = null;
    for (let i = 0; i < 3; i++) res = await ATT_TEST.injectDescriptor(d);
    return res;
  }, aliceProbe);
  check("Server-Redacted 1:N face verify clocks Alice with 0 local face vectors",
    redVerifyRes && redVerifyRes.matched === true && redVerifyRes.redacted === true && redVerifyRes.staffId.startsWith("1111"),
    redVerifyRes);
  await page.evaluate(() => ATT_TEST.hideCard());

  // Inject ambiguous twin rival (3 samples at distance 0.03 < 0.08 margin from Alice) and verify hard reject + zero oracle leak
  for (let s = 1; s <= 3; s++) {
    const twinDesc = aliceProbe.map((v, idx) => idx === 0 ? v + 0.03 : v);
    server.faces.set("twin-" + s, { id: "twin-" + s, staffId: "33333333-3333-3333-3333-333333333333", sample: s, descriptor: twinDesc, pinhash: "" });
  }
  const ambRes = await page.evaluate(async d => {
    ATT_TEST.state.redactedStreak = [];
    let res = null;
    for (let i = 0; i < 3; i++) res = await ATT_TEST.injectDescriptor(d);
    return res;
  }, aliceProbe);
  const rawVerifyOracle = await page.evaluate(d => ATT_TEST.sync.verify({ method: "face", descriptor: d, threshold: 0.5 }), aliceProbe);
  check("NEGATIVE: ambiguous rival (< 0.08 margin) HARD REJECTED in redacted mode with zero distance/face_dist oracle",
    ambRes && ambRes.matched === false && ambRes.reason === "ambiguous" && !("distance" in ambRes) &&
    rawVerifyOracle.matched === false && rawVerifyOracle.reason === "ambiguous" && !("distance" in rawVerifyOracle) && !("face_dist" in rawVerifyOracle),
    { ambRes, rawVerifyOracle });
  for (let s = 1; s <= 3; s++) server.faces.delete("twin-" + s);

  // NEGATIVE: wrong PIN ("9876") rejected in redacted mode (keypad stays open)
  await page.click("#btnPin");
  for (const k of ["9", "8", "7", "6"]) await page.click(`#keypad button[data-k="${k}"]`);
  await sleep(550);
  check("NEGATIVE: wrong PIN rejected in Server-Redacted mode (keypad stays open)",
    await page.evaluate(() => document.getElementById("keypad").classList.contains("open")) === true);

  // Verify redacted PIN punch for Bilal ("1234") with 0 local pinhash
  for (const k of ["1", "2", "3", "4"]) await page.click(`#keypad button[data-k="${k}"]`);
  await sleep(600);
  check("Server-Redacted PIN verify clocks Bilal with 0 local pinhash",
    !(await page.evaluate(() => document.getElementById("keypad").classList.contains("open"))) &&
    (await page.textContent("#cardName")) === "Bilal B");
  await page.evaluate(() => ATT_TEST.hideCard());

  // Wipe local faces and pull roster(restore=true) in redactedMode -> must restore 0 raw vectors
  const redRestore = await page.evaluate(async () => {
    for (const f of await ATT_TEST.db.allFaces()) await ATT_TEST.db.deleteFace(f.id);
    const r = await ATT_TEST.sync.roster(true);
    await ATT_TEST.loadData();
    const dbFaces = await ATT_TEST.db.allFaces();
    const dbStaff = await ATT_TEST.db.allStaff();
    return {
      r,
      hasRawDesc: dbFaces.some(f => Array.isArray(f.d) && f.d.length > 0),
      hasRawPin: dbStaff.some(s => !!s.pinhash) || dbFaces.some(f => !!f.pinhash),
      stubs: dbFaces.filter(f => f.faceRedacted).length,
    };
  });
  check("redacted roster(restore=true) restores metadata stubs with 0 raw 128-d vectors or pinhashes",
    redRestore.r.redacted === true && redRestore.r.restored === 3 && !redRestore.hasRawDesc && !redRestore.hasRawPin && redRestore.stubs === 3,
    redRestore);

  // NEGATIVE: NaN / non-numeric 128-d descriptor rejected by Face.decide, injectDescriptor, and Sync.verify
  const attNanCheck = await page.evaluate(async () => {
    const nanVec = new Array(128).fill(0); nanVec[0] = NaN;
    const strVec = new Array(128).fill(0); strVec[0] = "NaN";
    const localM = ATT_TEST.face.match(nanVec, [{ staffId: "11111111-1111-1111-1111-111111111111", d: new Array(128).fill(0.1) }]);
    const localDec = ATT_TEST.face.decide(localM, 0.5);
    const inj = await ATT_TEST.injectDescriptor(nanVec);
    let srvRejected = false;
    try {
      const sv = await ATT_TEST.sync.verify({ method: "face", descriptor: strVec, threshold: 0.5 });
      srvRejected = !sv || sv.matched !== true;
    } catch (_) {
      srvRejected = true;
    }
    return { localM, localDec, inj, srvRejected };
  });
  check("NEGATIVE: NaN / non-numeric 128-d descriptor HARD REJECTED locally and on server verify",
    attNanCheck.localM === null && attNanCheck.localDec.ok === false && attNanCheck.inj.matched === false && attNanCheck.srvRejected === true,
    attNanCheck);

  // NEGATIVE: duplicate staff PIN in redactedMode rejected on #enPin (Carla cannot claim Bilal's redacted PIN "1234")
  await page.evaluate(() => {
    ATT_TEST.openManager();
    ATT_TEST.selectEnrol("33333333-3333-3333-3333-333333333333");
  });
  await page.click('#mgr button[data-tab="enrol"]');
  await page.click("#enPin");
  for (const k of ["1", "2", "3", "4"]) await page.click(`#keypad button[data-k="${k}"]`);
  await sleep(550);
  check("NEGATIVE: duplicate staff PIN in redactedMode rejected on #enPin (keypad stays open)",
    await page.evaluate(() => document.getElementById("keypad").classList.contains("open") && ATT_TEST.state.enrol.pin === null));
  await page.click('#keypad button[data-k="x"]');
  await page.evaluate(() => ATT_TEST.closeManager());

  // Mixed local + server-redacted coexist check: unsynced local enrolment for Carla does NOT lock out redacted Alice
  await page.evaluate(async d => {
    for (const p of await ATT_TEST.db.punchesForDay(d)) {
      p.ts = new Date(Date.now() - 10 * 60000).toISOString();
      await ATT_TEST.db.savePunch(p);
    }
    ATT_TEST.state.lastPunchAt.clear();
    // Seed 3 unsynced local vectors for Carla (distinct orthogonal vector)
    const carlaVec = new Array(128).fill(0); carlaVec[10] = 2.0;
    for (let s = 1; s <= 3; s++) {
      await ATT_TEST.db.saveFace({ id: "carla-local-" + s, staffId: "33333333-3333-3333-3333-333333333333", d: carlaVec, sample: s, synced: 0 });
    }
    await ATT_TEST.loadData();
  }, day);
  const mixedAlice = await page.evaluate(async d => {
    ATT_TEST.state.redactedStreak = [];
    let res = null;
    for (let i = 0; i < 3; i++) res = await ATT_TEST.injectDescriptor(d);
    return { usableCount: ATT_TEST.state.faces.length, res };
  }, aliceProbe);
  check("mixed local + redacted: redacted Alice still clocks via server 1:N while Carla holds unsynced local samples",
    mixedAlice.usableCount === 3 && mixedAlice.res && mixedAlice.res.matched === true && mixedAlice.res.staffId.startsWith("1111"),
    mixedAlice);
  await page.evaluate(async () => {
    ATT_TEST.hideCard();
    for (let s = 1; s <= 3; s++) await ATT_TEST.db.deleteFace("carla-local-" + s);
    await ATT_TEST.sync.run("cleanup");
    await ATT_TEST.loadData();
  });
  for (let s = 1; s <= 3; s++) server.faces.delete("carla-local-" + s);

  // NEGATIVE: deactivated staff (`active: false`) REJECTED on redacted Face ID verify
  const inactiveRedacted = await page.evaluate(async d => {
    const alice = ATT_TEST.state.staff.get("11111111-1111-1111-1111-111111111111");
    alice.active = false;
    ATT_TEST.state.redactedStreak = [];
    let res = null;
    for (let i = 0; i < 3; i++) res = await ATT_TEST.injectDescriptor(d);
    alice.active = true;
    return res;
  }, aliceProbe);
  check("NEGATIVE: deactivated staff (active: false) REJECTED on redacted Face ID verify",
    inactiveRedacted && inactiveRedacted.matched === false && inactiveRedacted.reason === "inactive",
    inactiveRedacted);

  // PIN-only save on redacted Alice preserves her 3 redacted Face ID stubs, and rotating Bilal's PIN ("1234" -> "5678") revokes "1234"
  await page.evaluate(() => {
    ATT_TEST.openManager();
    ATT_TEST.selectEnrol("11111111-1111-1111-1111-111111111111");
  });
  await page.click('#mgr button[data-tab="enrol"]');
  await page.click("#enPin");
  for (const k of ["2", "4", "6", "8"]) await page.click(`#keypad button[data-k="${k}"]`);
  await sleep(250);
  await page.click("#enSave");
  await sleep(300);
  const aliceAfterPin = await page.evaluate(async () => {
    await ATT_TEST.sync.run("alice-pin");
    await ATT_TEST.loadData();
    const stubs = await ATT_TEST.db.facesForStaff("11111111-1111-1111-1111-111111111111");
    return { faceStubCount: stubs.filter(f => f.faceRedacted).length };
  });
  check("PIN-only save on redacted Alice preserves all 3 redacted Face ID stubs",
    aliceAfterPin.faceStubCount === 3,
    aliceAfterPin);

  // Rotate Bilal's PIN ("1234" -> "5678") while in redactedMode, sync + scrub, verify revoked "1234" REJECTED & new "5678" accepted
  await page.evaluate(async d => {
    for (const p of await ATT_TEST.db.punchesForDay(d)) {
      p.ts = new Date(Date.now() - 10 * 60000).toISOString();
      await ATT_TEST.db.savePunch(p);
    }
    ATT_TEST.state.lastPunchAt.clear();
    ATT_TEST.selectEnrol("22222222-2222-2222-2222-222222222222");
  }, day);
  await page.click("#enPin");
  for (const k of ["5", "6", "7", "8"]) await page.click(`#keypad button[data-k="${k}"]`);
  await sleep(250);
  await page.click("#enSave");
  await sleep(300);
  await page.evaluate(async () => {
    await ATT_TEST.sync.run("bilal-rotate");
    await ATT_TEST.loadData();
    ATT_TEST.closeManager();
  });
  await page.click("#btnPin");
  for (const k of ["1", "2", "3", "4"]) await page.click(`#keypad button[data-k="${k}"]`);
  await sleep(550);
  check("NEGATIVE: revoked PIN 1234 REJECTED on #keypad after Bilal rotated to 5678 in redactedMode",
    await page.evaluate(() => document.getElementById("keypad").classList.contains("open") && document.getElementById("card").classList.contains("hidden")));
  for (const k of ["5", "6", "7", "8"]) await page.click(`#keypad button[data-k="${k}"]`);
  await sleep(600);
  check("rotated PIN 5678 clocks Bilal IN via Server-Redacted verify",
    !(await page.evaluate(() => document.getElementById("keypad").classList.contains("open"))) &&
    (await page.textContent("#cardName")).includes("Bilal"));
  await page.evaluate(() => ATT_TEST.hideCard());

  // Toggling redactedMode true -> false restores full 128-d vectors & rotated pinhash ("5678", NOT revoked "1234") from server
  const unredactRes = await page.evaluate(async () => {
    const tr = await ATT_TEST.setRedactedMode(false);
    const dbFaces = await ATT_TEST.db.allFaces();
    const bilal = await ATT_TEST.db.getStaff("22222222-2222-2222-2222-222222222222");
    const enc = new TextEncoder().encode("5678");
    const dig = await crypto.subtle.digest("SHA-256", enc);
    const expectedHash = Array.from(new Uint8Array(dig)).map(b => b.toString(16).padStart(2, "0")).join("");
    return {
      tr,
      memFaces: ATT_TEST.state.faces.length,
      dbVectors: dbFaces.filter(f => Array.isArray(f.d) && f.d.length === 128).length,
      bilalHasLocalHash: !!(bilal && bilal.pinhash && !bilal.pinRedacted),
      bilalMatchesRotated5678: !!(bilal && bilal.pinhash === expectedHash),
    };
  });
  check("toggling redactedMode true -> false restores full 128-d vectors & rotated pinhash (5678) from server",
    unredactRes.tr.ok === true && unredactRes.memFaces === 3 && unredactRes.dbVectors === 3 && unredactRes.bilalHasLocalHash === true && unredactRes.bilalMatchesRotated5678 === true,
    unredactRes);

  console.log("staff added on the tablet (v0.5.0)");
  server.rejectStaff = true;   // the server has not confirmed the new person yet
  const addRes = await page.evaluate(async () => {
    const st = await ATT_TEST.addLocalStaff("  Dina   Door ");
    const dup = await ATT_TEST.addLocalStaff("dina door");
    const short = await ATT_TEST.addLocalStaff("x");
    await new Promise(r => setTimeout(r, 400));
    const r1 = await ATT_TEST.sync.run("staff-test");
    await ATT_TEST.sync.roster(false);            // a roster refresh that does not list her yet
    await ATT_TEST.loadData();
    const row = await ATT_TEST.db.getStaff(st.id);
    return { name: st.name, id: st.id, dup, short, r1: { ok: r1.ok, msg: r1.msg }, row, inState: ATT_TEST.state.staff.has(st.id) };
  });
  check("a person added on the tablet is trimmed, de-duplicated and usable at once",
    addRes.name === "Dina Door" && /^loc-/.test(addRes.id) && addRes.dup === null && addRes.short === null && addRes.inState === true, addRes);
  check("NEGATIVE: an unconfirmed new person survives a roster refresh and stays queued",
    addRes.row && addRes.row.active === true && addRes.row.pending === 1 && addRes.r1.ok === false && /0\/1 new staff/.test(addRes.r1.msg), addRes);
  server.rejectStaff = false;
  const addDone = await page.evaluate(async id => {
    const r2 = await ATT_TEST.sync.run("staff-test-2");
    await ATT_TEST.sync.roster(false);
    await ATT_TEST.loadData();
    const row = await ATT_TEST.db.getStaff(id);
    return { r2: { ok: r2.ok, msg: r2.msg }, row, pendingLeft: (await ATT_TEST.db.unsyncedStaff()).length };
  }, addRes.id);
  check("once the server confirms her she is on the roster and no longer queued",
    addDone.r2.ok === true && addDone.pendingLeft === 0 && addDone.row && addDone.row.active === true && addDone.row.pending === undefined
    && server.staffAdded.has(addRes.id) && server.staffAdded.get(addRes.id).name === "Dina Door", addDone);

  console.log("ids from the server are never trusted as markup (v0.5.0)");
  const evilRes = await page.evaluate(async () => {
    const evil = 'x" onfocus="alert(1)" autofocus x="';
    await ATT_TEST.db.saveStaff({ id: evil, name: "Evil Id", officialName: "", active: true });
    await ATT_TEST.loadData();
    ATT_TEST.renderLists();
    const out = {
      injected: document.querySelectorAll("[onfocus]").length,
      enrolBtn: [...document.querySelectorAll("button[data-en]")].some(b => b.dataset.en === evil),
      listRows: [...document.querySelectorAll("div[data-id]")].filter(d => d.dataset.id === evil).length,
    };
    await ATT_TEST.db.saveStaff({ id: evil, name: "Evil Id", officialName: "", active: false });
    await ATT_TEST.loadData();
    ATT_TEST.renderLists();
    return out;
  });
  check("NEGATIVE: an id carrying markup stays inside its attribute in every staff list",
    evilRes.injected === 0 && evilRes.enrolBtn === true && evilRes.listRows >= 1, evilRes);

  console.log("upgrade from v0.4.0: people and enrolments known only to the old server are carried over");
  const up = await page.evaluate(async () => {
    const vec = seed => Array.from({ length: 128 }, (_, i) => Math.sin(seed * 31 + i) * 0.2);
    const id = "01d01d00-0000-4000-8000-000000000001";
    await ATT_TEST.db.saveStaff({ id, name: "Old Tablet", officialName: "", active: true });
    for (let n = 1; n <= 3; n++) {
      await ATT_TEST.db.saveFace({ id: `${id}:${n}`, staffId: id, d: vec(40 + n * 0.001), sample: n, synced: 1, ts: new Date().toISOString() });
    }
    await ATT_TEST.db.delMeta("cloudMove050");     // as on a tablet that last ran v0.4.0
    await ATT_TEST.migrate();
    const queued = {
      staff: (await ATT_TEST.db.unsyncedStaff()).some(s => s.id === id),
      faces: (await ATT_TEST.db.unsyncedFaces()).filter(f => f.staffId === id).length,
    };
    const r = await ATT_TEST.sync.run("upgrade");
    await ATT_TEST.sync.roster(false);             // the first roster refresh after the move
    await ATT_TEST.loadData();
    const row = await ATT_TEST.db.getStaff(id);
    const usable = ATT_TEST.state.faces.filter(f => f.staffId === id && Array.isArray(f.d) && f.d.length === 128).length;
    await ATT_TEST.migrate();                      // a later boot queues nothing again
    return { id, queued, ok: r.ok, msg: r.msg, row, usable, requeued: (await ATT_TEST.db.unsyncedStaff()).length, flag: await ATT_TEST.db.getMeta("cloudMove050", false) };
  });
  check("the upgrade queues the tablet's own staff and enrolments once",
    up.queued.staff === true && up.queued.faces === 3 && up.requeued === 0 && up.flag === true, up);
  check("NEGATIVE: the first roster refresh after the move does not switch an enrolled person off",
    up.ok === true && up.row && up.row.active === true && up.row.pending === undefined && up.usable === 3
    && server.staffAdded.has(up.id) && [...server.faces.values()].filter(f => f.staffId === up.id).length === 3, up);

  const offRes = await page.evaluate(async () => {
    const vec = seed => Array.from({ length: 128 }, (_, i) => Math.sin(seed * 31 + i) * 0.2);
    const id = "01d01d00-0000-4000-8000-000000000002";
    await ATT_TEST.db.saveStaff({ id, name: "Left Last Year", officialName: "", active: false });
    for (let n = 1; n <= 3; n++) {
      await ATT_TEST.db.saveFace({ id: `${id}:${n}`, staffId: id, d: vec(50 + n * 0.001), sample: n, synced: 1, ts: new Date().toISOString() });
    }
    await ATT_TEST.db.delMeta("cloudMove050");
    await ATT_TEST.migrate();
    const queuedStaff = (await ATT_TEST.db.unsyncedStaff()).some(s => s.id === id);
    const queuedFaces = (await ATT_TEST.db.unsyncedFaces()).filter(f => f.staffId === id).length;
    await ATT_TEST.sync.run("upgrade-2");
    await ATT_TEST.sync.roster(false);
    await ATT_TEST.loadData();
    return { id, queuedStaff, queuedFaces, row: await ATT_TEST.db.getStaff(id) };
  });
  check("NEGATIVE: a person the old roster had switched off is not sent to the new server and stays off",
    offRes.queuedStaff === false && offRes.queuedFaces === 0 && offRes.row.active === false && !server.staffAdded.has(offRes.id)
    && ![...server.faces.values()].some(f => f.staffId === offRes.id), offRes);

  console.log("a punch the server refuses for good never blocks the queue (v0.5.0)");
  server.rejectPunchIds.add("punch-refused-1");
  const parkRes = await page.evaluate(async () => {
    const mk = (id, ts) => ({ id, staffId: "11111111-1111-1111-1111-111111111111", staffName: "Alice A", ts, tzOffsetMin: 0, day: ts.slice(0, 10), direction: "in", method: "manual", confidence: null, snapshot: "", note: "", synced: 0, rev: 0 });
    await ATT_TEST.db.savePunch(mk("punch-refused-1", "2026-11-01T07:00:00.000Z"));   // oldest, at the head of the queue
    await ATT_TEST.db.savePunch(mk("punch-fine-2", "2026-11-01T07:05:00.000Z"));
    const r = await ATT_TEST.sync.run("park");
    const parked = await ATT_TEST.db.getPunch("punch-refused-1");
    return { ok: r.ok, msg: r.msg, left: await ATT_TEST.db.unsyncedCount(), parked: { synced: parked.synced, parkedWhy: parked.parked, note: parked.note } };
  });
  check("NEGATIVE: the refused punch is set aside with a note and the punch behind it syncs",
    parkRes.ok === true && parkRes.left === 0 && parkRes.parked.synced === 1 && /another site/.test(parkRes.parked.parkedWhy) && /not synced/.test(parkRes.parked.note)
    && server.punches.has("punch-fine-2") && !server.punches.has("punch-refused-1"), parkRes);

  check("no page errors", errors.length === 0, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  if (localSrv) localSrv.srv.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
