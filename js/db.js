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
        db.createObjectStore("staff", { keyPath: "id" }); // {id, name, officialName, pinhash, active, pending, activeSet, srev}
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
  punchCount() {
    return openDB().then(db => new Promise((resolve, reject) => {
      const r = db.transaction("punches").objectStore("punches").count();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
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

  // Punches the server names as refused for good (their id already belongs to another site, which
  // happens only after a tablet was moved to a different site). They are set aside with a note so
  // they can never hold up the punches behind them; the row stays in the Log.
  parkPunches(ids, why) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction("punches", "readwrite");
      const s = t.objectStore("punches");
      ids.forEach(id => {
        const g = s.get(id);
        g.onsuccess = () => {
          const r = g.result; if (!r) return;
          r.synced = 1;
          r.parked = why || "refused by the server";
          r.note = ((r.note ? r.note + " · " : "") + "not synced: " + r.parked).slice(0, 200);
          s.put(r);
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
  markFacesSynced(ids, opts) {
    const scrub = !!(opts && opts.scrubLocal);
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(["faces", "staff"], "readwrite");
      const s = t.objectStore("faces");
      const stStore = t.objectStore("staff");
      ids.forEach(id => {
        const g = s.get(id);
        g.onsuccess = () => {
          const r = g.result;
          if (!r) return;
          r.synced = 1;
          if (scrub) {
            if (Array.isArray(r.d) && r.d.length === 128) {
              delete r.d;
              r.faceRedacted = true;
            }
            if (r.pinhash) {
              delete r.pinhash;
              r.pinRedacted = true;
              if (r.staffId) {
                const sg = stStore.get(r.staffId);
                sg.onsuccess = () => {
                  const st = sg.result;
                  if (st) {
                    st.hasPin = true;
                    st.pinRedacted = true;
                    delete st.pinhash;
                    stStore.put(st);
                  }
                };
              }
            }
          }
          s.put(r);
        };
      });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  },

  scrubLocalBiometrics() {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(["faces", "staff"], "readwrite");
      const fs = t.objectStore("faces");
      const ss = t.objectStore("staff");
      const unsyncedStaff = new Set();
      const allF = fs.getAll();
      allF.onsuccess = () => {
        const rows = allF.result || [];
        rows.forEach(r => {
          if (!r.synced) {
            if (r.staffId) unsyncedStaff.add(r.staffId);
            return;
          }
          let dirty = false;
          if (Array.isArray(r.d) && r.d.length > 0) {
            r.faceRedacted = r.d.length === 128 || !!r.faceRedacted;
            delete r.d;
            dirty = true;
          }
          if (r.pinhash) {
            r.pinRedacted = true;
            delete r.pinhash;
            dirty = true;
          }
          if (dirty) fs.put(r);
        });
        const allS = ss.getAll();
        allS.onsuccess = () => {
          (allS.result || []).forEach(st => {
            if (unsyncedStaff.has(st.id)) return;
            if (st.pinhash) {
              st.hasPin = true;
              st.pinRedacted = true;
              delete st.pinhash;
              ss.put(st);
            }
          });
        };
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  },

  // staff roster (mirror of the site's active employments)
  saveStaff(st) { return tx("staff", "readwrite", s => s.put(st)); },
  allStaff() { return cursorAll("staff"); },
  getStaff(id) { return tx("staff", "readonly", s => s.get(id)); },
  // revs (optional) = {id: srev} read just before the roster was requested. A person switched off
  // or on at the door after that carries a newer srev: the list is older than the switch, even if
  // the switch has synced since, so the local value stands until the next refresh.
  replaceStaff(list, revs) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction("staff", "readwrite");
      const s = t.objectStore("staff");
      const keep = new Set(list.map(x => x.id));
      const switchedSince = row => !!revs && (row.srev || 0) !== (revs[row.id] || 0);
      const all = s.getAll();
      all.onsuccess = () => {
        const old = new Map(all.result.map(x => [x.id, x]));
        list.forEach(x => {
          const prev = old.get(x.id) || {};
          // never let an absent server field (pinhash: undefined) erase a local value
          const clean = {}; Object.keys(x).forEach(k => { if (x[k] !== undefined) clean[k] = x[k]; });
          // The server says who is switched off (active: false). A switch made on this tablet that
          // has not reached the server yet (pending + activeSet) wins until the next sync carries it.
          const localSwitch = (prev.pending === 1 && prev.activeSet === true) || (prev.id !== undefined && switchedSince(prev));
          const active = localSwitch ? prev.active !== false : x.active !== false;
          s.put(Object.assign({}, prev, clean, { active }));
        });
        // A person added on this tablet and not yet accepted by the server (pending) is not in the
        // server's list yet, so the refresh must not switch them off.
        all.result.forEach(x => { if (!keep.has(x.id) && x.pending !== 1 && !switchedSince(x)) { x.active = false; s.put(x); } });
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  },
  // One-time, on the upgrade to v0.5.0: mark every active person and every enrolment that still holds
  // its data on this tablet as not yet sent, so they reach the new server. Rows that were already
  // scrubbed (Server-Redacted mode) hold nothing to send and are left alone.
  requeueForCloudMove() {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(["faces", "staff"], "readwrite");
      const fs = t.objectStore("faces");
      const ss = t.objectStore("staff");
      const allS = ss.getAll();
      allS.onsuccess = () => {
        // People the old roster had switched off stay off: neither they nor their enrolments are sent.
        const off = new Set();
        (allS.result || []).forEach(st => {
          if (st.active === false) { off.add(st.id); return; }
          if (st.pending !== 1) { st.pending = 1; ss.put(st); }
        });
        const allF = fs.getAll();
        allF.onsuccess = () => {
          (allF.result || []).forEach(f => {
            if (off.has(f.staffId)) return;
            const hasData = (Array.isArray(f.d) && f.d.length === 128) || !!f.pinhash;
            if (hasData && f.synced !== 0) { f.synced = 0; fs.put(f); }
          });
        };
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  },
  // Staff added, or switched off or on, on this tablet that the server has not confirmed yet.
  unsyncedStaff(limit) {
    return cursorAll("staff").then(rows => rows.filter(s => s.pending === 1).slice(0, limit || 1e9));
  },
  // revs = {id: srev} as sent; a person switched off or on while the request was in flight
  // carries a newer srev and stays pending so the newer switch is pushed on the next run.
  markStaffSynced(ids, revs) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction("staff", "readwrite");
      const s = t.objectStore("staff");
      ids.forEach(id => {
        const g = s.get(id);
        g.onsuccess = () => {
          const r = g.result; if (!r) return;
          if (revs && (r.srev || 0) !== (revs[id] || 0)) return;
          delete r.pending; delete r.activeSet; s.put(r);
        };
      });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  },
  // Change fields of one staff row in a single transaction (read, fn(row), write), so a switch
  // made at the same moment is never overwritten with an older copy of the row.
  patchStaff(id, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction("staff", "readwrite");
      const s = t.objectStore("staff");
      let out = null;
      const g = s.get(id);
      g.onsuccess = () => { const r = g.result; if (!r) return; fn(r); s.put(r); out = r; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    }));
  },
  // Switch a person off or back on at the door. One transaction, so a sync that finishes at the
  // same moment cannot be overwritten with an older copy of the row. Resolves to the saved row.
  setStaffActive(id, on) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction("staff", "readwrite");
      const s = t.objectStore("staff");
      let out = null;
      const g = s.get(id);
      g.onsuccess = () => {
        const r = g.result; if (!r) return;
        r.active = !!on;
        r.activeSet = true;
        r.pending = 1;
        r.srev = (r.srev || 0) + 1;
        s.put(r);
        out = r;
      };
      t.oncomplete = () => resolve(out);
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
