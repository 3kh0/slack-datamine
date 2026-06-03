'use strict';
// this funny script helps us interact with the Slack web client's CDP apis. very handy indeed!
// further reading: https://chromedevtools.github.io/devtools-protocol/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const commandTimeoutMs = Number(process.env.CDP_COMMAND_TIMEOUT_MS || '10000');

const withTimeout = (promise, ms, message, cleanup = () => {}) => {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(message));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

async function listTargets(port) {
  const url = `http://127.0.0.1:${port}/json/list`;
  let res;
  try { res = await fetch(url); } catch (e) {
    throw new Error(`CDP unreachable at ${url} (${e.message}). Is slack running with --remote-debugging-port=${port}?`);
  }
  if (!res.ok) throw new Error(`CDP endpoint returned HTTP ${res.status} for ${url}`);
  return (await res.json()).filter((t) => t.type === 'page');
}

async function waitReady(evaluate, deadline) {
  while (Date.now() < deadline) {
    try {
      const s = await evaluate(`(() => {
        const d = document.documentElement.dataset;
        return { href: location.href, app: d.app || null, buildNumber: d.buildNumber || null,
                 versionTs: d.versionTs || null, versionHash: d.versionHash || null,
                 ready: document.readyState };
      })()`);
      if (s.href.includes('app.slack.com') && s.app === 'client-v2' && s.versionHash && s.ready === 'complete') return s;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`slack did not wake the fuck up in time`);
}

async function connect({ port = '9222', urlFilter = 'app.slack.com' } = {}) {
  const deadline = Date.now() + 10000;
  const allowBlank = urlFilter === 'app.slack.com' && process.env.CDP_ALLOW_BLANK_TARGET !== '0';
  let targets = [], target, fallback = false;

  while (Date.now() < deadline) {
    targets = await listTargets(port);
    const matches = targets.filter((t) => (t.url || '').includes(urlFilter));
    target = matches.find((t) => t.url.startsWith('https://app.slack.com')) || matches[0];
    if (target) break;
    if (allowBlank && targets[0]) { target = targets[0]; fallback = true; break; }
    await sleep(1000);
  }

  if (!target) throw new Error(`No target url matched "${urlFilter}". Targets:\n`
    + targets.map((t, i) => `     [${i}] ${t.url}`).join('\n'));
  if (!target.webSocketDebuggerUrl) throw new Error('target has no webSocketDebuggerUrl??? (close any open devtools windows and try again?)');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await withTimeout(new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket connection failed')), { once: true });
  }), commandTimeoutMs, 'WebSocket connection timed out', () => ws.close());

  let id = 0;
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    let done = false;
    const onMsg = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== mid) return;
      done = true;
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('close', onClose);
      m.error ? rej(new Error(m.error.message || JSON.stringify(m.error))) : res(m.result);
    };
    const onClose = () => {
      if (done) return;
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('close', onClose);
      rej(new Error(`CDP socket closed while waiting for ${method}`));
    };
    ws.addEventListener('message', onMsg);
    ws.addEventListener('close', onClose, { once: true });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  const sendWithTimeout = (method, params = {}) => withTimeout(
    send(method, params),
    commandTimeoutMs,
    `CDP command timed out: ${method}`,
  );

  const evaluate = async (expression) => {
    const r = await sendWithTimeout('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  const navigate = async (url) => { await sendWithTimeout('Page.enable'); await sendWithTimeout('Page.navigate', { url }); };

  if (fallback) {
    await navigate(process.env.CLIENT_URL || 'https://app.slack.com/client');
    await waitReady(evaluate, deadline);
  }

  return { ws, target, send: sendWithTimeout, evaluate, navigate, waitReady: (d) => waitReady(evaluate, d), close: () => ws.close() };
}

module.exports = { listTargets, connect, waitReady, sleep };
