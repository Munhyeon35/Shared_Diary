// Drives a headless Chrome over the DevTools Protocol.
// Start Chrome yourself with --remote-debugging-port=9222, then point
// CDP_URL at it. Node's built-in fetch and WebSocket are all this needs.
//
// Every withBrowser() call runs in a browser context of its own — its own
// storage, service worker and tabs — made fresh and thrown away afterwards.
// A tab one test leaves open (holding an IndexedDB connection, say) can then
// never reach the next test, and no test depends on what an earlier one left.

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
// Chrome answers every call in well under a second; one that has not
// answered in this long never will, and waiting on it hangs the whole suite.
const CALL_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = [];
  let id = 0;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(new Error(`${p.method}: ${JSON.stringify(m.error)}`)) : p.resolve(m.result);
      return;
    }
    for (const fn of listeners) fn(m);
  });
  // nothing will ever answer a call that was waiting on a closed socket
  ws.addEventListener('close', () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`${p.method}: the connection to Chrome closed before it answered`));
    }
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer from Chrome at ${CDP_URL}`)), CALL_TIMEOUT_MS);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`cannot reach Chrome at ${CDP_URL}`)); });
  });
  const send = (method, params = {}, { sessionId, timeout = CALL_TIMEOUT_MS } = {}) =>
    new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`${method}: not connected to Chrome`));
        return;
      }
      const mid = ++id;
      const timer = setTimeout(() => {
        pending.delete(mid);
        reject(new Error(`${method}: no answer from Chrome in ${timeout} ms`));
      }, timeout);
      pending.set(mid, { resolve, reject, method, timer });
      ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ws, send, on: (fn) => listeners.push(fn) };
}

// The contexts in use, so an interrupted run can still throw them away.
const live = new Set();

async function dispose(ctx) {
  live.delete(ctx);
  if (ctx.contextId) {
    await ctx.cdp.send('Target.disposeBrowserContext', { browserContextId: ctx.contextId }, { timeout: 3000 })
      .catch(() => {});
  }
  ctx.cdp.ws.close();
}

// Ctrl-C would otherwise skip every finally and leave the tabs open.
process.on('SIGINT', () => {
  console.log('\ninterrupted — closing the test browser contexts');
  Promise.all([...live].map(dispose)).finally(() => process.exit(130));
});

async function withBrowser(fn) {
  const version = await (await fetch(`${CDP_URL}/json/version`, {
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  })).json();
  // Contexts are made on the browser's own socket, not a tab's.
  const cdp = await connect(version.webSocketDebuggerUrl);
  const ctx = { cdp, contextId: null };
  live.add(ctx);
  try {
    // disposeOnDetach: if this process dies before its finally runs, Chrome
    // throws the context away itself the moment this socket drops.
    ({ browserContextId: ctx.contextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true }));
    const page = await openTab(cdp, ctx.contextId, []);
    return await fn(page);
  } finally {
    await dispose(ctx);
  }
}

// A tab in the given context. Tabs of one context share storage, like two
// tabs of the app open on the same phone, and share one list of page errors.
async function openTab(cdp, contextId, errors) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: contextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params, opts = {}) => cdp.send(method, params, { ...opts, sessionId });
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description
        || m.params.exceptionDetails.text);
    }
    // a dialog with nobody to answer it blocks the page forever
    if (m.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');

  const page = {
    errors,
    sleep,
    // raw DevTools call on this tab, for what the helpers below do not cover
    send,
    // another tab in this same context — same origin storage as this one
    openTab: () => openTab(cdp, contextId, errors),
    async goto(url = APP_URL) {
      await send('Page.navigate', { url });
      await sleep(1200);
    },
    async reload() {
      await send('Page.reload');
      await sleep(1200);
    },
    // Runs `expr` in every new document, before the page's own scripts —
    // survives reload, unlike an injection made with eval() after the fact.
    before(expr) {
      return send('Page.addScriptToEvaluateOnNewDocument', { source: expr });
    },
    async eval(expr) {
      const evaluate = (expression) => send('Runtime.evaluate', {
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
      return send('Network.emulateNetworkConditions', {
        offline: !!on, latency: 0,
        downloadThroughput: on ? 0 : -1,
        uploadThroughput: on ? 0 : -1,
      });
    },
    viewport(width, height) {
      return send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: width < 800,
      });
    },
  };
  return page;
}

module.exports = { withBrowser, APP_URL, CDP_URL, sleep };
