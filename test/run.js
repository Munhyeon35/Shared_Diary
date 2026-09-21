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

// ---- reading with no signal at all ----
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

  check(await page.eval(`!!document.querySelector('.book')`), 'the app refused to open');
  check(await page.eval(`state.entries.length`) > 0, 'the server pull did not happen');
  check(await page.eval(`Store.usable()`) === false, 'Store claimed to be usable');
  check(page.errors.length === 0, 'unhandled page errors: ' + page.errors.join(' | '));
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
