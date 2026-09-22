const { withBrowser, APP_URL, CDP_URL } = require('./cdp');

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
function check(cond, message) {
  if (!cond) throw new Error(message);
}

// What is on screen, not just what is in memory: the date bar, the header's
// day count, and how many things the book shows once opened at the newest day
// the diary holds. goTo() only offers to save an unsaved page, and this never
// runs on one, so it cannot write.
const onScreen = (page) => page.eval(`(async () => {
  const shown = { date: $('dateLabel').textContent, badge: $('daysBadge').textContent, newestDay: null };
  const newest = state.entries.map((e) => e.date).sort().pop();
  if (newest && !state.dirty) {
    await goTo(newest);
    shown.newestDay = document.querySelectorAll('.book .ci').length;
  }
  return shown;
})()`);
const checkDrawn = (shown, when) => {
  check(shown.date !== '', `no date was drawn ${when}`);
  check(/^Day \d+ of our diary$/.test(shown.badge), `the day count read "${shown.badge}" ${when}`);
  check(shown.newestDay > 0, `the newest day drew nothing ${when}`);
};

// ---- the app must at least come up ----
test('the app loads and draws the book', async (page) => {
  await page.goto();   // localStorage only exists once we are on the app's origin
  await page.eval(`localStorage.setItem('code','loveu');localStorage.setItem('name','me')`);
  await page.reload();
  check(await page.eval(`document.title`) === 'Our Diary', 'wrong title');
  checkDrawn(await onScreen(page), 'on opening');
  check(page.errors.length === 0, 'page errors: ' + page.errors.join(' | '));
});

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
  // offline: since Task 3, a reload also fires refresh(), which writes
  // whatever the server returns into the store. Without this the write-through
  // races this exact check and the store is no longer empty by the time we look.
  await page.offline(true);
  await page.reload();
  check((await page.eval(`(await Store.allEntries()).length`)) === 0, 'a fresh store was not empty');
  await page.offline(false);

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

// ---- the store must let go when another tab needs it, and recover after ----
test('store: an open tab does not block a newer version of the store from opening', async (page) => {
  await asMe(page);
  await page.eval(`Store.usable()`);   // this tab now holds its connection, as a stage-1 tab would
  const next = await page.openTab();   // e.g. stage 2 opening in a second tab of the same phone
  await next.goto();
  const r = await next.eval(`new Promise((res) => {
    const q = indexedDB.open('our-diary', 2);
    q.onsuccess = () => { q.result.close(); res('upgraded'); };
    q.onerror = () => res('failed: ' + q.error);
    setTimeout(() => res('still blocked after 3 s'), 3000);
  })`);
  check(r === 'upgraded', 'opening the store at version 2 was ' + r);
});

test('store: a connection closed under the app is opened again, not left dead', async (page) => {
  await asMe(page);
  check(await page.eval(`Store.usable()`) === true, 'the store did not open to begin with');
  // what "clear site data" does to an open tab: the browser closes its connection
  await page.send('Storage.clearDataForOrigin', { origin: new URL(APP_URL).origin, storageTypes: 'indexeddb' });
  await page.sleep(300);
  const r = await page.eval(`Store.allEntries().then((a) => 'read ' + a.length, (e) => 'rejected: ' + e)`);
  check(r.startsWith('read '), 'after its connection was closed the store ' + r);
});

// ---- eval() wraps top-level await on evidence, not on a text guess ----
test('eval: a multi-statement expression with "await" inside a string is left alone', async (page) => {
  await page.goto();
  const r = await page.eval(`const note = 'please await this'; note === 'please await this'`);
  check(r === true, 'multi-statement eval with "await" inside a string literal broke: got ' + r);
});

test('eval: a genuine top-level await is still wrapped and resolved', async (page) => {
  await page.goto();
  const r = await page.eval(`(await Promise.resolve(21)) * 2`);
  check(r === 42, 'top-level await was not resolved: got ' + r);
});

// ---- the harness itself: it must never hang, and tests must not share storage ----
test('harness: a call Chrome never answers fails, naming the call, instead of hanging', async (page) => {
  await page.goto();
  let err = null;
  try {
    await page.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true }, { timeout: 500 });
  } catch (e) { err = e.message; }
  check(err && err.includes('Runtime.evaluate'), 'a call that never got an answer gave: ' + err);
});

test("harness: a tab another test leaves open cannot reach this test's storage", async (page) => {
  await asMe(page);
  await page.eval(`Store.usable()`);   // this tab now holds an IndexedDB connection, as a leaked tab would
  const seen = await withBrowser(async (other) => {
    await other.goto();
    return other.eval(`(async () => ({
      code: localStorage.getItem('code'),
      deleted: await new Promise((res) => {
        const q = indexedDB.deleteDatabase('our-diary');
        q.onsuccess = () => res('deleted');
        q.onblocked = () => res('blocked');
      }),
    }))()`);
  });
  check(seen.code === null, "a fresh test saw the other test's login: " + seen.code);
  check(seen.deleted === 'deleted', 'deleting its own store was ' + seen.deleted);
});

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

// ---- the startup pull: the page is on screen, and can be written in, while it is out ----
test('a slow startup pull keeps what was laid on the page meanwhile', async (page) => {
  await asMe(page);   // the copy now holds the diary, so the next load draws before it pulls
  // Hold the pull until the test lets it go, and refuse any write outright,
  // so nothing in here can reach the diary on the server.
  await page.before(`(() => {
    const f = window.fetch;
    let release;
    const held = new Promise((r) => { release = r; });
    window.__releasePull = release;
    window.__pullsLanded = 0;
    window.fetch = (u, o = {}) => {
      if ((o.method || 'GET') !== 'GET') return Promise.reject(new Error('test: no writes'));
      if (!String(u).includes('/api/entries')) return f(u, o);
      return held.then(() => f(u, o)).then((r) => { window.__pullsLanded++; return r; });
    };
  })()`);
  await page.reload();
  check(await page.eval(`$('dateLabel').textContent`) !== '', 'the page was not drawn from the copy before the pull');
  // a sticker laid on my page, the way the tray lays one
  await page.eval(`addItem('mine', { k: 'sticker', v: '⭐', ...dropSpot(state.items.length) }); true`);
  await page.eval(`__releasePull(); true`);
  await page.sleep(800);
  const after = await page.eval(`({
    landed: __pullsLanded,
    kept: state.items.some((it) => it.v === '⭐'),
    drawn: !!document.querySelector('#editor .ci-sticker'),
    dirty: state.dirty,
    note: $('savedNote').textContent,
  })`);
  check(after.landed > 0, 'the held pull never landed');
  check(after.kept && after.drawn, 'the sticker laid during the pull is gone from the page');
  check(after.dirty === true, 'the page no longer counts as unsaved, so leaving it will not warn');
  check(after.note === 'Unsaved', `the page says "${after.note}", not "Unsaved"`);
});

test('a store that never answers does not hold up the server', async (page) => {
  await page.goto();
  await page.eval(`localStorage.setItem('code','loveu');localStorage.setItem('name','me')`);
  // an open that neither succeeds nor fails, ever
  await page.before(`Object.defineProperty(indexedDB, 'open', { value: () => ({}) })`);
  await page.reload();
  await page.sleep(1800);   // 3 s since the reload began
  check(await page.eval(`state.entries.length`) > 0, 'the server pull never happened');
  checkDrawn(await onScreen(page), 'with a store that never answers');
  // keeping the copy is best effort, so a pull must not wait on it either
  const pull = await page.eval(`Promise.race([
    refresh().then(() => 'settled'),
    new Promise((r) => setTimeout(() => r('was still waiting on the store after 2 s'), 2000)),
  ])`);
  check(pull === 'settled', 'a pull ' + pull);
});

test('a copy that answers late does not overwrite what the server already sent', async (page) => {
  await asMe(page);
  // a copy older than the server: a single made-up page
  await page.eval(`Store.replaceAll([{ id: 'stale00000000001', author: 'me', date: '2026-01-01', items: [] }])`);
  // The store now takes 2.5 s to open — past the wait for it, and past the pull.
  await page.before(`(() => {
    const open = IDBFactory.prototype.open;
    Object.defineProperty(indexedDB, 'open', { value: (...args) => {
      const slow = {};
      setTimeout(() => {
        const req = open.apply(indexedDB, args);
        req.onupgradeneeded = () => { slow.result = req.result; slow.onupgradeneeded && slow.onupgradeneeded(); };
        req.onsuccess = () => { slow.result = req.result; slow.onsuccess && slow.onsuccess(); };
        req.onerror = () => { slow.error = req.error; slow.onerror && slow.onerror(); };
        req.onblocked = () => { slow.onblocked && slow.onblocked(); };
      }, 2500);
      return slow;
    }});
  })()`);
  await page.reload();
  await page.sleep(2800);   // 4 s since the reload began: the copy has answered by now
  const ids = await page.eval(`state.entries.map((e) => e.id)`);
  check(ids.length > 0, 'nothing was pulled');
  check(!ids.includes('stale00000000001'), 'the late copy replaced what the server sent: ' + ids.join(','));
});

// ---- reading with no signal at all ----
test('offline: the diary still opens and shows its entries', async (page) => {
  await asMe(page);
  await page.sleep(800);
  const before = await page.eval(`state.entries.length`);
  check(before > 0, 'no entries to begin with — is the server running with data?');

  await page.offline(true);
  await page.reload();
  await page.sleep(600);
  const after = await page.eval(`state.entries.length`);
  checkDrawn(await onScreen(page), 'offline');
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

// ---- the first visit must leave everything needed to open with no signal ----
test('the first visit caches the whole shell, store.js included', async (page) => {
  await page.goto();   // a fresh context has no service worker: this visit installs it
  await page.eval(`navigator.serviceWorker.ready.then(() => true)`);
  const missing = await page.eval(`(async () => {
    const out = [];
    for (const u of ['/', '/store.js']) if (!(await caches.match(u))) out.push(u);
    return out.join(', ');
  })()`);
  check(missing === '', 'not cached after the first visit: ' + missing);
});

test('logged in on the first visit, then opened with no signal, the diary still draws', async (page) => {
  await page.goto();   // first visit ever: the setup screen, and the service worker installs
  await page.eval(`navigator.serviceWorker.ready.then(() => true)`);
  // log in within this same page load, as the Enter button does — minus its POST
  await page.eval(`(async () => {
    state.code = 'loveu'; state.name = 'me';
    localStorage.setItem('code', 'loveu'); localStorage.setItem('name', 'me');
    await enterMain();
    return true;
  })()`);
  check(await page.eval(`Store.allEntries().then((a) => a.length)`) > 0, 'the first visit left no copy');

  await page.offline(true);   // the tab and its service worker both
  await page.reload();
  await page.sleep(600);
  check(await page.eval(`typeof Store`) === 'object', 'store.js did not load with no signal');
  checkDrawn(await onScreen(page), 'with no signal after the first visit');
  await page.offline(false);
});

// ---- a store that refuses to open must not refuse the app ----
test('a store that will not open costs the copy, not the app', async (page) => {
  await page.goto();   // establish the origin first so localStorage exists
  await page.eval(`localStorage.setItem('code','loveu');localStorage.setItem('name','me')`);
  // Registered via Page.addScriptToEvaluateOnNewDocument, this runs before
  // the page's own scripts on every future document load, including the
  // reload below — unlike an eval() injection, which a reload would erase
  // before store.js ever saw it.
  await page.before(`Object.defineProperty(indexedDB, 'open', { value: () => {
    const req = {};
    setTimeout(() => { req.error = new Error('blocked'); req.onerror && req.onerror(); }, 0);
    return req;
  }})`);
  await page.reload();
  await page.sleep(900);

  check(await page.eval(`state.entries.length`) > 0, 'the server pull did not happen');
  checkDrawn(await onScreen(page), 'without a store');
  check(await page.eval(`Store.usable()`) === false, 'Store claimed to be usable');
  check(page.errors.length === 0, 'unhandled page errors: ' + page.errors.join(' | '));
});

(async () => {
  console.log(`chrome ${CDP_URL}   app ${APP_URL}\n`);
  let failed = 0;
  for (const c of cases) {
    try {
      await withBrowser(async (page) => {
        await c.fn(page);
        // every test, whatever it checks, fails on an uncaught page error
        check(page.errors.length === 0, 'unhandled page errors: ' + page.errors.join(' | '));
      });
      console.log(`  pass  ${c.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${c.name}\n        ${e.message}`);
    }
  }
  console.log(failed ? `\n${failed} failed` : `\n${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
