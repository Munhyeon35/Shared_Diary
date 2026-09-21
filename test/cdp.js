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
      const evaluate = (expression) => cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      const describe = (res) => res.exceptionDetails
        && (res.exceptionDetails.exception?.description || res.exceptionDetails.text);

      let r = await evaluate(expr);
      // A bare top-level `await` is a syntax error outside a module/REPL
      // context. Retry once, wrapped in an async IIFE — but only on
      // evidence (this first, unwrapped attempt actually failed to parse),
      // never by guessing from the source text: a multi-statement
      // expression that merely contains the word "await" (in a string,
      // say) must be left alone, since parentheses can't hold a statement
      // sequence. A syntax error always happens before any code runs, so
      // retrying here can't double up side effects.
      if (/SyntaxError/.test(describe(r) || '')) {
        const retry = await evaluate(`(async () => (${expr}))()`);
        if (!describe(retry)) r = retry;
      }

      if (r.exceptionDetails) {
        throw new Error('page threw: ' + describe(r));
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
