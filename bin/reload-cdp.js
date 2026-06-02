#!/usr/bin/env node
'use strict';

const { connect } = require('../lib/cdp');

const port = process.env.CDP_PORT || '9222';
const clientUrl = process.env.CLIENT_URL || 'https://app.slack.com/client';
const JSON_OUTPUT = process.argv.includes('--json');

(async () => {
  const deadline = Date.now() + 10000;
  const cdp = await connect({ port });
  try {
    await cdp.send('Page.enable');
    const href = await cdp.evaluate('location.href');
    href.includes('app.slack.com')
      ? await cdp.send('Page.reload', { ignoreCache: true })
      : await cdp.send('Page.navigate', { url: clientUrl });
    const s = await cdp.waitReady(deadline);
    if (JSON_OUTPUT) {
      console.log(JSON.stringify({
        buildNumber: s.buildNumber,
        versionTs: s.versionTs,
        versionHash: s.versionHash,
      }));
    } else {
      console.log(`ready build ${s.buildNumber} (${s.versionHash.slice(0, 12)})`);
    }
  } finally { cdp.close(); }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
