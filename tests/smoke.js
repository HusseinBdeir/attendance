// Headless smoke test for the attendance kiosk.
// Run:  node tests/smoke.js   (needs the repo served at http://localhost:8090)
// Uses playwright-core from codex-hub + the installed Chrome. The camera is
// replaced by injected frame sources (face crops from tests/faces/sample*.jpg);
// the API is a mocked route that behaves like the Dataverse flow (upsert on id).

const { chromium } = require("C:/Users/HusseinBdeir/bhfirms/codex-hub/node_modules/playwright-core");
const BASE = process.env.ATT_BASE || "http://localhost:8090";

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
  const browser = await chromium.launch({
    channel: "chrome", headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const ctx = await browser.newContext({ permissions: ["camera"], viewport: { width: 1280, height: 800 } });

  // ---- mock API (what the Power Automate flow will do) ----
  const server = { punches: new Map(), faces: new Map(), calls: [] };
  const roster = [
    { id: "11111111-1111-1111-1111-111111111111", name: "Alice A", officialName: "Alice Abbas" },
    { id: "22222222-2222-2222-2222-222222222222", name: "Bilal B", officialName: "Bilal Baz" },
    { id: "33333333-3333-3333-3333-333333333333", name: "Carla C", officialName: "" },
  ];
  await ctx.route("**/fakeapi", route => {
    const body = JSON.parse(route.request().postData() || "{}");
    server.calls.push(body.op);
    if (body.key !== "k") return route.fulfill({ status: 401, body: "bad key" });
    if (body.op === "roster") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, staff: roster, faces: body.restore ? [...server.faces.values()] : [] }) });
    }
    if (body.op === "sync") {
      (body.punches || []).forEach(p => server.punches.set(p.id, p));
      (body.faces || []).forEach(f => server.faces.set(f.id, f));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, punches: (body.punches || []).map(p => p.id), faces: (body.faces || []).map(f => f.id) }) });
    }
    route.fulfill({ status: 400, body: "bad op" });
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
    const img = new Image(); img.src = "/tests/faces/sample1.jpg"; await img.decode();
    window.__img = img;
    const r = await ATT_TEST.descriptorsFromImage(img);
    return r.map(x => ({ box: { x: x.box.x, y: x.box.y, width: x.box.width, height: x.box.height } }));
  });
  console.log("     faces found in sample1:", faces.length);
  check("at least 2 faces in the sample photo", faces.length >= 2, faces.length);
  // crop helper lives in the page: crop(faceIdx, pad, mirror, scale) -> canvas (re-installed after reloads)
  const installCrop = () => page.evaluate(async boxes => {
    if (!window.__img) { const img = new Image(); img.src = "/tests/faces/sample1.jpg"; await img.decode(); window.__img = img; }
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

  console.log("4b. test recognition readout + 5-sample cap + pose pictograms");
  await page.evaluate(() => { ATT_TEST.setFrameSource(window.__crop(0, 0.6, false, 1.0)); });
  await page.click("#enTest");
  await sleep(1500);
  const tOut = await page.textContent("#enTestOut");
  check("test recognition shows Alice accepted", /\u2713 Alice A/.test(tOut), tOut);
  await page.click("#enTest");
  check("stop test clears the readout", (await page.textContent("#enTestOut")) === "");
  // Bilal: five samples of face 1 walk through the five pictograms; a sixth is refused
  await page.evaluate(() => ATT_TEST.selectEnrol("22222222-2222-2222-2222-222222222222"));
  const poseTexts = [], guides = [], caps5 = [];
  for (const [pad, mirror, scale] of [[0.6, false, 1.0], [0.8, true, 0.9], [0.5, false, 1.2], [0.7, true, 1.0], [0.6, false, 0.8]]) {
    poseTexts.push(await page.textContent("#enPose"));
    guides.push(await page.evaluate(() => document.getElementById("enGuide").dataset.pose));
    caps5.push(await page.evaluate(async a => { ATT_TEST.setFrameSource(window.__crop(1, a[0], a[1], a[2])); return ATT_TEST.captureSample(); }, [pad, mirror, scale]));
  }
  check("5 samples captured for Bilal", caps5.every(Boolean), caps5);
  check("pose line counts 1 / 5 … 5 / 5", poseTexts[0].includes("1 / 5") && poseTexts[4].includes("5 / 5"), poseTexts);
  check("guide pictograms follow the pose order", guides.join(",") === "straight,left,right,up,smile", guides);
  check("guide shows done after the 5th", await page.evaluate(() => document.getElementById("enGuide").dataset.pose) === "done");
  check("6th capture refused + Capture disabled", (await page.evaluate(() => ATT_TEST.captureSample())) === false && await page.evaluate(() => document.getElementById("enCapture").disabled));
  check("LEFT pictogram carries a pulsing arrow", /class="arrow"/.test(await page.evaluate(() => ATT_TEST.poseSvg("left"))));
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
    const img = new Image(); img.src = "/tests/faces/sample2.jpg"; await img.decode();
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

  check("no page errors", errors.length === 0, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
