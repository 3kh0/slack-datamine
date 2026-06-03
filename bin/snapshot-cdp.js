#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connect, sleep } = require('../lib/cdp');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const port = opt('--port', process.env.CDP_PORT || '9222');
const clientUrl = opt('--client-url', process.env.CLIENT_URL || 'https://app.slack.com/client');
const snapshotDir = opt('--dir', process.env.SNAPSHOT_DIR || path.join('queue', 'html'));
const timeoutMs = Number(opt('--timeout-ms', process.env.CDP_READY_TIMEOUT_MS || '10000'));
const fetchTimeoutMs = Number(opt('--fetch-timeout-ms', process.env.FETCH_CLIENT_TIMEOUT_MS || '5000'));
const skipHash = opt('--skip-hash', process.env.SKIP_VERSION_HASH || '');
const fetchClient = argv.includes('--fetch-client') || process.env.FETCH_CLIENT_HTML === '1';
const noReloadFallback = argv.includes('--no-reload-fallback');

const safe = (value) => String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
const attr = (html, name) => (html.match(new RegExp(`data-${name}="([^"]*)"`)) || [])[1] || null;
const timeoutSignal = (ms) => {
  if (!ms || ms <= 0) return undefined;
  if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return controller.signal;
};
const skipped = (ready, reason) => ({
  buildNumber: ready.buildNumber,
  versionTs: ready.versionTs,
  versionHash: ready.versionHash,
  htmlFile: '',
  existed: false,
  skipped: true,
  reason,
});

async function captureSnapshot(cdp, deadline, { includeHtml = false } = {}) {
  while (Date.now() < deadline) {
    try {
      const snapshot = await cdp.evaluate(`(() => {
        const el = document.documentElement;
        if (!el) return null;
        const d = el.dataset;
        return {
          href: location.href,
          app: d.app || null,
          buildNumber: d.buildNumber || null,
          versionTs: d.versionTs || null,
          versionHash: d.versionHash || null,
          ready: document.readyState,
          html: ${includeHtml ? 'el.outerHTML' : 'null'},
        };
      })()`);
      if (snapshot?.href?.includes('app.slack.com')
        && snapshot.app === 'client-v2'
        && snapshot.versionHash
        && snapshot.ready === 'complete'
        && (!includeHtml || snapshot.html)) return snapshot;
    } catch {}
    await sleep(500);
  }
  throw new Error('Slack client HTML was not ready before the CDP snapshot timeout');
}

const cookieMatches = (cookie, url) => {
  const host = url.hostname;
  const domain = (cookie.domain || '').replace(/^\./, '');
  return domain && (host === domain || host.endsWith(`.${domain}`));
};

async function fetchClientSnapshot(cdp) {
  await cdp.send('Network.enable').catch(() => {});
  const url = new URL(clientUrl);
  const cookieJar = await cdp.send('Network.getAllCookies');
  const cookies = (cookieJar.cookies || [])
    .filter((cookie) => cookieMatches(cookie, url))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
  if (!cookies) throw new Error(`No Slack cookies available from CDP for ${url.hostname}`);

  const res = await fetch(clientUrl, {
    headers: {
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'User-Agent': 'Mozilla/5.0 SlackDatamine/1.0',
      'Cookie': cookies,
    },
    redirect: 'follow',
    signal: timeoutSignal(fetchTimeoutMs),
  });
  if (!res.ok) throw new Error(`Slack client HTML fetch returned HTTP ${res.status}`);

  const html = await res.text();
  const snapshot = {
    href: res.url || clientUrl,
    app: attr(html, 'app'),
    buildNumber: attr(html, 'build-number'),
    versionTs: attr(html, 'version-ts'),
    versionHash: attr(html, 'version-hash'),
    ready: 'complete',
    html,
  };

  if (!snapshot.href.includes('app.slack.com')
    || snapshot.app !== 'client-v2'
    || !snapshot.versionHash
    || !snapshot.html.includes('gantry-v2-async-')) {
    throw new Error('Direct Slack client fetch did not return full authenticated client HTML');
  }

  return snapshot;
}

(async () => {
  const deadline = Date.now() + timeoutMs;
  const cdp = await connect({ port });
  try {
    let ready;
    if (fetchClient) {
      try {
        ready = await fetchClientSnapshot(cdp);
      } catch (e) {
        if (noReloadFallback) throw e;
        console.error(`direct client fetch failed; falling back to CDP reload (${e.message || e})`);
      }
    }

    if (!ready) {
      await cdp.send('Page.enable');
      const href = await cdp.evaluate('location.href');
      if (href.includes('app.slack.com')) await cdp.send('Page.reload', { ignoreCache: true });
      else await cdp.send('Page.navigate', { url: clientUrl });
      ready = await captureSnapshot(cdp, deadline);
    }

    let hash = ready.versionHash || 'unknown';

    if (skipHash && hash === skipHash) {
      console.log(JSON.stringify(skipped(ready, 'current')));
      return;
    }

    if (!ready.html) ready = await captureSnapshot(cdp, deadline, { includeHtml: true });
    const html = ready.html;
    hash = ready.versionHash || 'unknown';
    if (skipHash && hash === skipHash) {
      console.log(JSON.stringify(skipped(ready, 'current')));
      return;
    }

    const name = [
      safe(ready.buildNumber),
      safe(ready.versionTs || 'no-ts'),
      safe(hash.slice(0, 12)),
    ].join('-');

    fs.mkdirSync(snapshotDir, { recursive: true });
    const htmlFile = path.resolve(snapshotDir, `${name}.html`);
    const metaFile = `${htmlFile}.json`;
    const existed = fs.existsSync(htmlFile);

    if (!existed) {
      const tmpFile = `${htmlFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmpFile, html);
      fs.renameSync(tmpFile, htmlFile);
      fs.writeFileSync(metaFile, JSON.stringify({
        capturedAt: new Date().toISOString(),
        buildNumber: ready.buildNumber,
        versionTs: ready.versionTs,
        versionHash: ready.versionHash,
        href: ready.href,
        htmlFile,
        htmlBytes: Buffer.byteLength(html),
      }, null, 2) + '\n');
    }

    console.log(JSON.stringify({
      buildNumber: ready.buildNumber,
      versionTs: ready.versionTs,
      versionHash: ready.versionHash,
      htmlFile,
      existed,
      skipped: false,
    }));
  } finally {
    cdp.close();
  }
})().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
