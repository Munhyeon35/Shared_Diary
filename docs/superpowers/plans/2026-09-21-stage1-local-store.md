# Stage 1: Local Store and Offline Read — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a copy of the diary on the phone so it opens and reads without a signal, while the server stays the source of truth.

**Architecture:** A new `public/store.js` wraps IndexedDB behind four calls. The app draws from that copy first, then pulls from the server and writes what it gets back into the copy. Writes still go through the existing API — nothing about saving changes in this stage. A browser test harness lands first so every later task has something to assert with.

**Tech Stack:** Vanilla JS, IndexedDB, zero dependencies. Tests drive headless Chrome over the DevTools Protocol using node's built-in `fetch` and `WebSocket` — no test framework, no npm packages.

**Spec:** `docs/superpowers/specs/2026-09-21-local-first-snapshot-sync-design.md`

## Global Constraints

- **Zero runtime dependencies.** No npm packages in the app or the tests. Node's built-ins only.
- **No ES modules in `index.html` this stage.** The page has one classic `<script>` and the CDP tests reach its top-level functions (`state`, `goTo`, `renderMine`) as globals. `store.js` is a classic script exposing `window.Store`. Modules arrive in stage 2 with `snapshot.js`, which must be node-importable.
- **Writes are unchanged.** `savePage`, the stickers call and photo upload keep going to the existing API. This stage only changes where reads come from.
- **Photos stay on the service worker cache.** The spec moves photos into IndexedDB under content hashes — that is stage 2. Photos already work offline through `sw.js`; do not touch that here.
- **Local data is never cleared on a failed fetch.** A network error must leave the copy alone.
- **Divergence from the spec, deliberate:** the spec's failure table says the app must refuse to open when IndexedDB is unavailable. That rule belongs to stage 2, when the phone holds the only copy. In stage 1 the server still has everything, so an unusable IndexedDB degrades to today's behaviour — online-only — and the app opens normally.
- Server runs as `COUPLE_CODE=loveu PORT=3000 node server.js`.

---

### Task 1: Browser test harness

Later tasks assert on IndexedDB and offline rendering, neither of which exists in node. This task builds the harness that drives a real browser, and proves it works against the app as it stands today.

**Files:**
- Create: `test/cdp.js`
- Create: `test/run.js`
- Modify: `README.md` (add a "테스트" section)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `withBrowser(fn)` — opens a tab, calls `fn(page)`, always closes the tab. Returns `fn`'s value.
  - `page.goto(url)` → `Promise<void>`
  - `page.reload()` → `Promise<void>`
  - `page.eval(expr)` → `Promise<any>` — evaluates in the page, awaits promises, throws on page exceptions
  - `page.offline(on)` → `Promise<void>`
  - `page.sleep(ms)` → `Promise<void>`
  - `test(name, fn)` and `check(cond, message)` from `test/run.js`
  - Env: `CDP_URL` (default `http://127.0.0.1:9222`), `APP_URL` (default `http://localhost:3000`)

- [ ] **Step 1: Write the harness**

Create `test/cdp.js`:

```js
// Drives a headless Chrome over the DevTools Protocol.
// Start Chrome yourself with --remote-debugging-port=9222, then point
// CDP_URL at it. Node's built-in fetch and WebSocket are all this needs.

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  const errors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description
        || m.params.exceptionDetails.text);
    }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error(`cannot reach Chrome at ${CDP_URL}`)));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, send, errors };
}

async function withBrowser(fn) {
  const target = await (await fetch(
    `${CDP_URL}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' },
  )).json();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  // a dialog with nobody to answer it blocks the page forever
  cdp.ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      cdp.send('Page.handleJavaScriptDialog', { accept: true });
    }
  });

  const page = {
    errors: cdp.errors,
    sleep,
    async goto(url = APP_URL) {
      await cdp.send('Page.navigate', { url });
      await sleep(1200);
    },
    async reload() {
      await cdp.send('Page.reload');
      await sleep(1200);
    },
    async eval(expr) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error('page threw: '
          + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      return r.result.value;
    },
    offline(on) {
      return cdp.send('Network.emulateNetworkConditions', {
        offline: !!on, latency: 0,
        downloadThroughput: on ? 0 : -1,
        uploadThroughput: on ? 0 : -1,
      });
    },
    viewport(width, height) {
      return cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: width < 800,
      });
    },
  };

  try {
    return await fn(page);
  } finally {
    cdp.ws.close();
    await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
  }
}

module.exports = { withBrowser, APP_URL, CDP_URL, sleep };
```

- [ ] **Step 2: Write the runner with one real assertion**

Create `test/run.js`:

```js
const { withBrowser, APP_URL, CDP_URL } = require('./cdp');

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
function check(cond, message) {
  if (!cond) throw new Error(message);
}

// ---- the app must at least come up ----
test('the app loads and draws the book', async (page) => {
  await page.goto();   // localStorage only exists once we are on the app's origin
  await page.eval(`localStorage.setItem('code','loveu');localStorage.setItem('name','me')`);
  await page.reload();
  check(await page.eval(`!!document.querySelector('.book')`), 'the book did not draw');
  check(await page.eval(`document.title`) === 'Our Diary', 'wrong title');
  check(page.errors.length === 0, 'page errors: ' + page.errors.join(' | '));
});

(async () => {
  console.log(`chrome ${CDP_URL}   app ${APP_URL}\n`);
  let failed = 0;
  for (const c of cases) {
    try {
      await withBrowser(c.fn);
      console.log(`  pass  ${c.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${c.name}\n        ${e.message}`);
    }
  }
  console.log(failed ? `\n${failed} failed` : `\n${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 3: Start Chrome and the server, then run it**

```bash
# Chrome with the debug port open (adjust the binary for your machine)
"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --disable-gpu --remote-debugging-port=9222 \
  --user-data-dir='C:\Temp\diary-test' about:blank &

cd /home/mh/repository/Shared_Diary
COUPLE_CODE=loveu PORT=3000 node server.js &

node test/run.js
```

Expected: `1 passed`.

If Chrome runs on Windows while node runs in WSL, node cannot reach `127.0.0.1:9222`. Run the suite with the Windows node instead:
`"/mnt/c/Program Files/nodejs/node.exe" test\run.js`

- [ ] **Step 4: Document how to run it**

Add to `README.md`, after the 실행 section:

```markdown
## 테스트

브라우저 동작을 실제 Chrome으로 검증합니다. 의존성은 없습니다.

```bash
# 1. 디버그 포트를 연 Chrome
chrome --headless=new --remote-debugging-port=9222 about:blank &

# 2. 서버
COUPLE_CODE=loveu PORT=3000 node server.js &

# 3. 테스트
node test/run.js
```

`CDP_URL`, `APP_URL` 환경변수로 주소를 바꿀 수 있습니다.
```

- [ ] **Step 5: Commit**

```bash
git add test README.md
git commit -m "Add a browser test harness

The next tasks assert on IndexedDB and on what the app draws with no
network, neither of which node can see. This drives a real Chrome over
the DevTools protocol using only built-ins.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The local store

**Files:**
- Create: `public/store.js`
- Modify: `public/index.html:10-13` (load the script before the main one)
- Modify: `test/run.js` (add the store tests)

**Interfaces:**
- Consumes: `withBrowser`, `test`, `check` from Task 1.
- Produces, on `window.Store`:
  - `Store.usable()` → `Promise<boolean>` — false when IndexedDB is missing or blocked
  - `Store.allEntries()` → `Promise<Array<object>>` — every stored entry; `[]` when empty
  - `Store.replaceAll(entries)` → `Promise<void>` — clears and rewrites in **one** transaction
  - `Store.getMeta(key)` → `Promise<any>` — `undefined` when absent
  - `Store.setMeta(key, value)` → `Promise<void>`

- [ ] **Step 1: Write the failing tests**

Add to `test/run.js`, above the runner IIFE:

```js
// ---- the local store ----
const asMe = async (page) => {
  await page.goto();
  await page.eval(`localStorage.setItem('code','loveu');localStorage.setItem('name','me')`);
  await page.reload();
};

test('store: reports itself usable', async (page) => {
  await asMe(page);
  check(await page.eval(`Store.usable()`) === true, 'Store.usable() was not true');
});

test('store: starts empty, round-trips entries', async (page) => {
  await asMe(page);
  await page.eval(`indexedDB.deleteDatabase('our-diary')`);
  await page.reload();
  check((await page.eval(`(await Store.allEntries()).length`)) === 0, 'a fresh store was not empty');

  await page.eval(`Store.replaceAll([
    {id:'aaaaaaaaaaaaaaaa', author:'me',     date:'2026-09-01', items:[]},
    {id:'bbbbbbbbbbbbbbbb', author:'yeojin', date:'2026-09-01', items:[]}
  ])`);
  const got = await page.eval(`(async () => {
    const all = await Store.allEntries();
    return all.map(e => e.id + ':' + e.author).sort().join(',');
  })()`);
  check(got === 'aaaaaaaaaaaaaaaa:me,bbbbbbbbbbbbbbbb:yeojin', 'round trip gave ' + got);
});

test('store: replaceAll clears what was there before', async (page) => {
  await asMe(page);
  await page.eval(`Store.replaceAll([{id:'1111111111111111', author:'me', date:'2026-09-01', items:[]}])`);
  await page.eval(`Store.replaceAll([{id:'2222222222222222', author:'me', date:'2026-09-02', items:[]}])`);
  const ids = await page.eval(`(async () => (await Store.allEntries()).map(e => e.id).join(','))()`);
  check(ids === '2222222222222222', 'old entries survived replaceAll: ' + ids);
});

test('store: meta round-trips and survives a reload', async (page) => {
  await asMe(page);
  await page.eval(`Store.setMeta('headId', 'abc123')`);
  await page.reload();
  const v = await page.eval(`Store.getMeta('headId')`);
  check(v === 'abc123', 'meta came back as ' + JSON.stringify(v));
  check(await page.eval(`Store.getMeta('nope')`) === undefined, 'a missing key was not undefined');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node test/run.js`
Expected: the four store tests FAIL with `page threw: ReferenceError: Store is not defined`.

- [ ] **Step 3: Write the store**

Create `public/store.js`:

```js
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
      req.onsuccess = () => resolve(req.result);
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
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
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
```

- [ ] **Step 4: Load it before the main script**

In `public/index.html`, the last line of `<head>` is the `<title>`. Add the script tag immediately after `<link rel="apple-touch-icon" ...>` and before `<title>`:

```html
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<script src="/store.js"></script>
<title>Our Diary</title>
```

The file goes at `public/store.js`, flat — **not** under `public/lib/`. `server.js`
resolves static files with `path.basename(p)`, which flattens `/lib/store.js` to
`store.js`; a subdirectory returns 404. This was checked against the running server.

Do not weaken that basename call to make subdirectories work — it is what stops
`../` traversal. If stage 2 wants the `lib/` layout the spec describes, it needs a
routing change that resolves the path and then verifies it stayed inside `public/`,
with a traversal test to go with it.

- [ ] **Step 5: Run the tests**

Run: `node test/run.js`
Expected: `5 passed`.

- [ ] **Step 6: Commit**

```bash
git add public/store.js public/index.html test/run.js
git commit -m "Keep a copy of the diary on the device

IndexedDB behind four calls: read all entries, replace them wholesale in
one transaction, and a small meta store for what the sync layer will need
in stage 2. Nothing reads from it yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Draw from the copy, then catch up with the server

**Files:**
- Modify: `public/index.html` — `refresh()` and `enterMain()`
- Modify: `test/run.js`

**Interfaces:**
- Consumes: `Store.allEntries`, `Store.replaceAll` from Task 2.
- Produces:
  - `loadLocal()` → `Promise<number>` — fills `state.entries` from the copy, returns how many it found
  - `updateDaysBadge()` → `void` — extracted from `refresh()` so both paths can call it
  - `refresh()` → `Promise<void>` — pulls from the server, writes through to the copy. Throws when the network fails, as it does today.

- [ ] **Step 1: Write the failing test**

Add to `test/run.js`:

```js
test('what the server returns is written into the copy', async (page) => {
  await asMe(page);
  await page.eval(`indexedDB.deleteDatabase('our-diary')`);
  await page.reload();
  await page.sleep(800);
  const same = await page.eval(`(async () => {
    const local = (await Store.allEntries()).map(e => e.id).sort().join(',');
    const server = state.entries.map(e => e.id).sort().join(',');
    return { local, server, match: local === server && server.length > 0 };
  })()`);
  check(same.server.length > 0, 'the server returned nothing — is it running with the three entries?');
  check(same.match, `copy ${same.local} did not match server ${same.server}`);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node test/run.js`
Expected: FAIL — `copy  did not match server <ids>`, because nothing writes to the copy yet.

- [ ] **Step 3: Split the badge out of `refresh()`**

In `public/index.html`, replace the whole `refresh()` function:

```js
async function refresh() {
  const { entries } = await api('/api/entries');
  state.entries = entries;
  const dates = entries.map((e) => e.date).sort();
  if (dates.length) {
    const days = Math.floor((Date.now() - parseDate(dates[0])) / 86400000) + 1;
    $('daysBadge').textContent = `Day ${days} of our diary`;
  }
}
```

with:

```js
function updateDaysBadge() {
  const dates = state.entries.map((e) => e.date).sort();
  if (!dates.length) return;
  const days = Math.floor((Date.now() - parseDate(dates[0])) / 86400000) + 1;
  $('daysBadge').textContent = `Day ${days} of our diary`;
}

// The copy on this device, drawn before we go asking the server.
async function loadLocal() {
  try {
    const local = await Store.allEntries();
    if (local.length) { state.entries = local; updateDaysBadge(); }
    return local.length;
  } catch { return 0; }            // no store is survivable in stage 1
}

async function refresh() {
  const { entries } = await api('/api/entries');   // throws with no network
  state.entries = entries;
  updateDaysBadge();
  // keeping the copy is best effort: failing to write it must not fail the pull
  try { await Store.replaceAll(entries); } catch (e) { console.warn('local copy not written', e); }
}
```

- [ ] **Step 4: Draw the copy before pulling**

Replace `enterMain()`:

```js
async function enterMain() {
  $('setup').classList.add('hidden');
  $('main').classList.remove('hidden');
  state.date = localDate();
  try { await refresh(); } catch {}
  renderSpread();
}
```

with:

```js
async function enterMain() {
  $('setup').classList.add('hidden');
  $('main').classList.remove('hidden');
  state.date = localDate();
  await loadLocal();
  renderSpread();                  // the diary is on screen before the network is asked
  try { await refresh(); renderSpread(); } catch {}
}
```

- [ ] **Step 5: Run the tests**

Run: `node test/run.js`
Expected: `6 passed`.

- [ ] **Step 6: Commit**

```bash
git add public/index.html test/run.js
git commit -m "Draw the diary from the copy, then catch up with the server

The page no longer waits on the network to show anything, and every pull
writes what it got into the copy. Writing the copy is best effort: a store
that will not take it must not fail the pull.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Read it with no signal

**Files:**
- Modify: `public/index.html` — an offline marker, and the two background refresh callers
- Modify: `test/run.js`

**Interfaces:**
- Consumes: `loadLocal`, `refresh` from Task 3.
- Produces: `setOnline(ok)` → `void` — shows or hides `#offlineTag`.

- [ ] **Step 1: Write the failing tests**

Add to `test/run.js`:

```js
test('offline: the diary still opens and shows its entries', async (page) => {
  await asMe(page);
  await page.sleep(800);
  const before = await page.eval(`state.entries.length`);
  check(before > 0, 'no entries to begin with — is the server running with data?');

  await page.offline(true);
  await page.reload();
  await page.sleep(600);
  check(await page.eval(`!!document.querySelector('.book')`), 'the book did not draw offline');
  const after = await page.eval(`state.entries.length`);
  check(after === before, `offline showed ${after} entries, online had ${before}`);
  await page.offline(false);
});

test('offline: says so, and the copy is not wiped', async (page) => {
  await asMe(page);
  await page.sleep(800);
  await page.offline(true);
  await page.reload();
  await page.sleep(600);
  check(await page.eval(`!document.getElementById('offlineTag').hidden`), 'no offline marker');
  const kept = await page.eval(`(async () => (await Store.allEntries()).length)()`);
  check(kept > 0, 'the copy was emptied while offline');

  await page.offline(false);
  await page.eval(`refresh()`);
  await page.sleep(400);
  check(await page.eval(`document.getElementById('offlineTag').hidden`), 'still marked offline after reconnecting');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node test/run.js`
Expected: both FAIL — `page threw: TypeError: Cannot read properties of null (reading 'hidden')`.

- [ ] **Step 3: Add the marker to the header**

In `public/index.html`, the header reads:

```html
  <header>
    <h1>Our Diary <span class="heart">♥</span></h1>
    <span id="daysBadge"></span>
  </header>
```

Replace it with:

```html
  <header>
    <h1>Our Diary <span class="heart">♥</span></h1>
    <span id="offlineTag" hidden>오프라인</span>
    <span id="daysBadge"></span>
  </header>
```

Add the style next to the `#daysBadge` rule:

```css
  #offlineTag {
    margin-left: auto; font-size: 11px; font-weight: 700;
    color: var(--on-me); background: var(--ink-soft);
    padding: 2px 8px; border-radius: 20px;
  }
```

- [ ] **Step 4: Flip the marker where the network is actually tried**

Add next to `updateDaysBadge()`:

```js
function setOnline(ok) { $('offlineTag').hidden = !!ok; }
```

In `refresh()`, mark the outcome. Replace the body:

```js
async function refresh() {
  const { entries } = await api('/api/entries');   // throws with no network
  state.entries = entries;
  updateDaysBadge();
  // keeping the copy is best effort: failing to write it must not fail the pull
  try { await Store.replaceAll(entries); } catch (e) { console.warn('local copy not written', e); }
}
```

with:

```js
async function refresh() {
  let entries;
  try {
    ({ entries } = await api('/api/entries'));
  } catch (e) {
    setOnline(false);
    throw e;
  }
  setOnline(true);
  state.entries = entries;
  updateDaysBadge();
  // keeping the copy is best effort: failing to write it must not fail the pull
  try { await Store.replaceAll(entries); } catch (err) { console.warn('local copy not written', err); }
}
```

- [ ] **Step 5: Run the tests**

Run: `node test/run.js`
Expected: `8 passed`.

- [ ] **Step 6: Commit**

```bash
git add public/index.html test/run.js
git commit -m "Open the diary with no signal, and say when there is none

The copy is drawn first, so a dead network now costs the header a marker
rather than the whole page. A failed pull leaves the copy untouched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Survive a store that will not open

Private windows, a browser set to block site data, and a full disk all make IndexedDB fail. In stage 1 the server still has everything, so the app must carry on without the copy rather than refuse to open.

**Files:**
- Modify: `test/run.js`

**Interfaces:**
- Consumes: everything from Tasks 2–4. No production code changes are expected — `loadLocal` already swallows its error and `refresh` already treats writing the copy as best effort. This task proves it.

- [ ] **Step 1: Write the failing test**

Add to `test/run.js`:

```js
test('a store that will not open costs the copy, not the app', async (page) => {
  await page.goto();
  await page.eval(`localStorage.setItem('code','loveu');localStorage.setItem('name','me')`);
  // break IndexedDB before the app's script runs
  await page.eval(`(() => {
    const open = indexedDB.open.bind(indexedDB);
    Object.defineProperty(indexedDB, 'open', { value: () => {
      const req = {};
      setTimeout(() => { req.error = new Error('blocked'); req.onerror && req.onerror(); }, 0);
      return req;
    }});
    sessionStorage.setItem('breakIDB', '1');
  })()`);
  await page.reload();
  await page.sleep(900);

  check(await page.eval(`!!document.querySelector('.book')`), 'the app refused to open');
  check(await page.eval(`state.entries.length`) > 0, 'the server pull did not happen');
  check(await page.eval(`Store.usable()`) === false, 'Store claimed to be usable');
  check(page.errors.length === 0, 'unhandled page errors: ' + page.errors.join(' | '));
});
```

- [ ] **Step 2: Run it**

Run: `node test/run.js`
Expected: PASS if Tasks 2–4 were built as written. If it fails on `unhandled page errors`, find the unguarded `Store` call named in the message and wrap it the way `loadLocal` does — return a harmless value rather than throwing.

The injected `indexedDB.open` above is replaced before reload, so it does not survive into the reloaded page. If the test passes for that reason rather than the real one, move the injection into `Page.addScriptToEvaluateOnNewDocument` by adding this to `test/cdp.js`'s `page`:

```js
    before(expr) {
      return cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: expr });
    },
```

and call `await page.before("Object.defineProperty(indexedDB,'open',{value:()=>{const r={};setTimeout(()=>{r.error=new Error('blocked');r.onerror&&r.onerror()},0);return r}})")` before `page.goto()`.

- [ ] **Step 3: Run the whole suite one more time**

Run: `node test/run.js`
Expected: `9 passed`.

- [ ] **Step 4: Check the real app by hand**

```bash
COUPLE_CODE=loveu PORT=3000 node server.js &
```

Open `http://localhost:3000`, confirm the diary draws, then turn the network off in DevTools and reload. The diary should still be there with the 오프라인 marker. Turn it back on; the marker should clear on the next refresh.

- [ ] **Step 5: Commit**

```bash
git add test/run.js test/cdp.js
git commit -m "Prove a broken IndexedDB only costs the copy

Private windows and browsers set to block site data both make the store
unopenable. The server still has everything in this stage, so the app
carries on without a copy instead of refusing to open.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Done when

- `node test/run.js` reports 9 passed
- The app opens and shows the diary with the network off
- Turning the network back on clears the 오프라인 marker
- Saving a page still works exactly as before — this stage changed no writes

## What stage 2 picks up

Snapshot and `parent`, the merge rules and tombstones, photos renamed to their content hash and moved into IndexedDB, the new server API, and migrating the three entries that live on the server today. `Store.getMeta`/`setMeta` exist for stage 2's `headId`; nothing uses them yet.

The spec's `public/lib/*.js` layout needs a static-routing change in `server.js`
before it can work — today `path.basename` flattens any subdirectory to a 404.
Stage 1 sidesteps this by keeping `store.js` flat.
