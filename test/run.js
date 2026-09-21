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
