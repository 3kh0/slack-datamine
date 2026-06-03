#!/usr/bin/env node
'use strict';

const cp = require('node:child_process');

const hash = process.argv[2] || '';
if (!hash) process.exit(1);

let commits = [];
try {
  commits = cp.execFileSync('git', ['log', '--format=%H', '--', 'build/meta.json'], { encoding: 'utf8' })
    .trim()
    .split(/\n+/)
    .filter(Boolean);
} catch {
  process.exit(1);
}

for (const commit of commits) {
  try {
    const meta = JSON.parse(cp.execFileSync('git', ['show', `${commit}:build/meta.json`], { encoding: 'utf8' }));
    if (meta.versionHash === hash) {
      if (process.argv.includes('--print')) {
        console.log(JSON.stringify({
          commit,
          buildNumber: meta.buildNumber,
          versionTs: meta.versionTs,
          versionHash: meta.versionHash,
        }));
      }
      process.exit(0);
    }
  } catch {}
}

process.exit(1);
