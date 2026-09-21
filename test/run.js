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
