// The diary as it is kept on this device.
//
// Stage 1 keeps a copy here and reads from it so the diary opens without a
// signal; the server is still the one that decides what is true. Photos are
// not here yet — the service worker still holds those.

(function (global) {
  const DB_NAME = 'our-diary';
  const DB_VERSION = 1;
  const ENTRIES = 'entries';
  const META = 'meta';

  let opening = null;

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!global.indexedDB) { reject(new Error('no indexedDB')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab wants a newer version (stage 2) or to delete the store:
        // let go, or it waits on this tab forever. The next call opens afresh.
        db.onversionchange = () => { db.close(); opening = null; };
        // The browser closed it (site data cleared): forget it, or every
        // later call fails on a dead connection for the life of the tab.
        db.onclose = () => { opening = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('indexedDB refused to open'));
      req.onblocked = () => reject(new Error('indexedDB blocked'));
    });
    // a failed open must not be remembered, or a retry can never succeed
    opening.catch(() => { opening = null; });
    return opening;
  }

  function run(storeName, mode, work) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const out = work(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
  }

  const Store = {
    async usable() {
      try { await open(); return true; } catch { return false; }
    },

    allEntries() {
      return run(ENTRIES, 'readonly', (s) => s.getAll());
    },

    // One transaction: if any part of it fails the copy is left as it was.
    replaceAll(entries) {
      return run(ENTRIES, 'readwrite', (s) => {
        s.clear();
        for (const e of entries) if (e && e.id) s.put(e);
      });
    },

    async getMeta(key) {
      const r = await run(META, 'readonly', (s) => s.get(key));
      return r === null ? undefined : r;
    },

    setMeta(key, value) {
      return run(META, 'readwrite', (s) => { s.put(value, key); });
    },
  };

  global.Store = Store;
})(window);
