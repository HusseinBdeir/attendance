// BHFIRMS Attendance kiosk — local storage layer (IndexedDB)
// Every punch and every enrolment lands here first; the tablet never waits
// on the network. sync.js reads index synced == 0 and pushes when online.

const DB_NAME = "bhfatt";
const DB_VER = 1;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("punches")) {
        const s = db.createObjectStore("punches", { keyPath: "id" });
        s.createIndex("day", "day");        // local yyyy-mm-dd
        s.createIndex("synced", "synced");  // 0 | 1
        s.createIndex("staff", "staffId");
      }
      if (!db.objectStoreNames.contains("faces")) {
        const f = db.createObjectStore("faces", { keyPath: "id" });
        f.createIndex("synced", "synced");
        f.createIndex("staff", "staffId");
      }
      if (!db.objectStoreNames.contains("staff")) {
        db.createObjectStore("staff", { keyPath: "id" }); // {id, name, officialName, pinhash, active}
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "k" });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req instanceof IDBRequest ? req.result : req);
    t.onerror = () => reject(t.error);
  }));
}

function cursorAll(store, index, range) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const out = [];
    const os = db.transaction(store).objectStore(store);
    const src = index ? os.index(index) : os;
    const cur = src.openCursor(range || null);
    cur.onsuccess = e => {
      const c = e.target.result;
      if (c) { out.push(c.value); c.continue(); } else resolve(out);
    };
    cur.onerror = () => reject(cur.error);
  }));
}

const DBX = {
  // punches
  savePunch(p) { return tx("punches", "readwrite", s => s.put(p)); },
  getPunch(id) { return tx("punches", "readonly", s => s.get(id)); },
  deletePunch(id) { return tx("punches", "readwrite", s => s.delete(id)); },
  punchesForDay(day) { return cursorAll("punches", "day", IDBKeyRange.only(day)); },
  punchesForDays(days) { return Promise.all(days.map(d => cursorAll("punches", "day", IDBKeyRange.only(d)))).then(a => [].concat(...a)); },
  unsyncedPunches(limit) {
    return cursorAll("punches", "synced", IDBKeyRange.only(0))
      .then(rows => rows.sort((a, b) => a.ts.localeCompare(b.ts)).slice(0, limit || 1e9));
  },
  unsyncedCount() {
    return openDB().then(db => new Promise((resolve, reject) => {
      const r = db.transaction("punches").objectStore("punches").index("synced").count(IDBKeyRange.only(0));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  },
  // revs = {id: rev} as sent; a row edited (flipped) while the request was in
  // flight carries a newer rev and stays unsynced so the edit is pushed next run.
  markPunchesSynced(ids, revs) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction("punches", "readwrite");
      const s = t.objectStore("punches");
      ids.forEach(id => {
        const g = s.get(id);
        g.onsuccess = () => {
          const r = g.result; if (!r) return;
          if (revs && (r.rev || 0) !== (revs[id] || 0)) return;
          r.synced = 1; s.put(r);
        };
      });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  },

  // faces (enrolment samples)
  saveFace(f) { return tx("faces", "readwrite", s => s.put(f)); },
  allFaces() { return cursorAll("faces"); },
  facesForStaff(staffId) { return cursorAll("faces", "staff", IDBKeyRange.only(staffId)); },
  deleteFace(id) { return tx("faces", "readwrite", s => s.delete(id)); },
  unsyncedFaces(limit) {
    return cursorAll("faces", "synced", IDBKeyRange.only(0)).then(r => r.slice(0, limit || 1e9));
  },
  markFacesSynced(ids) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction("faces", "readwrite");
      const s = t.objectStore("faces");
      ids.forEach(id => {
        const g = s.get(id);
        g.onsuccess = () => { if (g.result) { g.result.synced = 1; s.put(g.result); } };
      });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  },

  // staff roster (mirror of the site's active employments)
  saveStaff(st) { return tx("staff", "readwrite", s => s.put(st)); },
  allStaff() { return cursorAll("staff"); },
  getStaff(id) { return tx("staff", "readonly", s => s.get(id)); },
  replaceStaff(list) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction("staff", "readwrite");
      const s = t.objectStore("staff");
      const keep = new Set(list.map(x => x.id));
      const all = s.getAll();
      all.onsuccess = () => {
        const old = new Map(all.result.map(x => [x.id, x]));
        list.forEach(x => {
          const prev = old.get(x.id) || {};
          // never let an absent server field (pinhash: undefined) erase a local value
          const clean = {}; Object.keys(x).forEach(k => { if (x[k] !== undefined) clean[k] = x[k]; });
          s.put(Object.assign({}, prev, clean, { active: true }));
        });
        all.result.forEach(x => { if (!keep.has(x.id)) { x.active = false; s.put(x); } });
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  },

  // meta (settings)
  getMeta(k, dflt) { return tx("meta", "readonly", s => s.get(k)).then(r => (r ? r.v : dflt)); },
  setMeta(k, v) { return tx("meta", "readwrite", s => s.put({ k, v })); },
  delMeta(k) { return tx("meta", "readwrite", s => s.delete(k)); },

  wipe() {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(["punches", "faces", "staff", "meta"], "readwrite");
      ["punches", "faces", "staff", "meta"].forEach(n => t.objectStore(n).clear());
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  },
};
