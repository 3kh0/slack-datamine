#!/usr/bin/env node
/*
 * datamine.js — slack datamine via full webpack manifest. node 24 or bun
 *
 * >tfw authed html drops build id (data-*) + .u loader naming every chunk (~1350)
 * parse it, dl ALL from public cdn (no auth lmao), brotli decode, extract apiMethods/flags/uiStrings -> ./build/
 * overwrites each run. git history + per-build tags = changelog, clones stay smol
 *
 * source: --html <file> (vps headless) or live cdp (local)
 * READ ONLY: public cdn bundles + build id from html
 *
 *   node datamine.js --html page.html
 *   node datamine.js               # full mine via cdp (local)
 *   --limit N --loaded-only --force --concurrency N --port N
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = __dirname;
const BUILD_DIR = path.join(ROOT, 'build');
const CHUNK_CACHE = process.env.CORPUS_DIR || path.join(ROOT, 'corpus', '_chunks');

const MBYTES = (() => {
  const v = (process.env.CORPUS_MAX_BYTES || '').trim();
  if (!v) return 10 * 1024 ** 3;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(v);
  if (!m) return 10 * 1024 ** 3;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
})();

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const HTML_FILE = opt('--html', null);
const PORT = opt('--port', process.env.CDP_PORT || '9222');
const LIMIT = +opt('--limit', 0);
const CONCURRENCY = +opt('--concurrency', 16);
const LOADED_ONLY = flag('--loaded-only');
const FORCE = flag('--force');
const log = (s = '') => process.stdout.write(s + '\n');
const die = (m) => { process.stderr.write('\n❌ ' + m + '\n'); process.exit(1); };
const sortUniq = (a) => [...new Set(a)].sort();

const API_NS = ['conversations', 'chat', 'users', 'channels', 'groups', 'im', 'mpim',
  'files', 'admin', 'apps', 'team', 'teams', 'emoji', 'reactions', 'search', 'views',
  'workflows', 'canvases', 'bots', 'dnd', 'pins', 'stars', 'usergroups', 'calls', 'auth',
  'oauth', 'rtm', 'reminders', 'bookmarks', 'functions', 'assistant', 'tooling',
  'subscriptions', 'dialog', 'migration', 'lists', 'slackconnect', 'enterprise',
  'rooms', 'calendar', 'drafts', 'screenhero', 'channelSections', 'moderation', 'saved',
  'sharedInvites', 'workObjects', 'solutions', 'records', 'links', 'retail', 'features', 'entities'];
const RE_API = new RegExp(`['"]((?:${API_NS.join('|')})\\.[a-zA-Z][a-zA-Z0-9_.]{1,48})['"]`, 'g');
const RE_ID = /['"]([a-z][a-z0-9_]{3,60})['"]/g;
// feature flags (no localization cancer)
const RE_FLAG = /(?:_enabled|_disabled|_gate|_killswitch|_rollout)$|^(?:enable|disable|ff|exp)_|experiment|rollout_|^is_[a-z0-9_]+_enabled$|^feature_/;
const RE_VARIANT = /['"]([a-z][a-z0-9_]{5,50}(?:_treatment|_control|_holdback|_variant[a-z0-9_]*|_v[0-9]))['"]/g;
const RE_ERR = /['"]((?:not|invalid|cant|cannot|already|missing|too_many|over|expired|unsupported|restricted|no)_[a-z0-9_]{2,44}|[a-z][a-z0-9_]{2,30}_not_found|name_taken|rate_limited)['"]/g;
const RE_SLASH = /['"](\/[a-z][a-z0-9_-]{2,24})['"]/g;
const SLASH_DENY = new Set(['api', 'files', 'v1', 'v2', 'v3', 'static', 'client', 'ssb', 'help',
  'signin', 'archives', 'services', 'beacon', 'robots', 'methods', 'img', 'downloads', 'oauth',
  'admin', 'apps', 'customize', 'intl', 'account', 'home', 'www', 'cdn', 'assets']);
const RE_SCOPE = /['"]([a-z][a-z._]+:(?:read|write|history|manage|bot|user|admin)(?::[a-z]+)?)['"]/g;
const RE_EVENT = /(?:"element_name"|element_name|"clog_event"):"([a-z0-9_]{4,50})"/g;
const RE_ACTION = /[,{]action:"([a-z0-9_]{4,50})"/g;
// taxos behind CONSTANTS (WP.contact_card etc), never as "type:foo" strings
// anchor on one known + window scan to auto catch newfags. one per enum below
const RE_SELFMAP = /([a-zA-Z][a-zA-Z0-9_]{2,40}):"\1"/g; // camelCase! (obviously)
const windowed = (js, anchor, pair, add, r = 2500) => {
  for (const a of js.matchAll(anchor)) {
    const w = js.slice(Math.max(0, a.index - r), a.index + r);
    for (const m of w.matchAll(pair)) add(m[1]);
  }
};
// flat check (works for some reason)
const RE_API_CALL = /\bmethod:"([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)"/g; // method:x.y calls (all ns)
const RE_ARGS = /\bmethod:"([a-z][a-zA-Z.]+)",args:\{([^{}]{0,400})\}/g; // method + flat arg obj body
const RE_ARGKEY = /([a-zA-Z_][a-zA-Z0-9_]*):/g;
const RE_FN = /\b([a-z][a-z_]{2,40}):"(Fn[0-9A-Z]{4,8})"/g; // wf builtin name -> FnID
const RE_SPAN = /(?:createSpan|createChildSpan|createAndReportSpan|createAndCloseSpan|startSpan|traceFn)\(\{name:"([^"]{3,60})"/g;
const RE_ICON = /(?:\bicon|\biconName):"([a-z][a-z0-9-]{2,40})"/g;
const RE_ACCEL = /accelerator:"([^"]{2,40})"/g;
const RE_DEVCMD = /\{name:"([a-z][a-z_]{2,30})",description:"([^"]{4,120})",[^{}]*needsReload/g;
const RE_STR = /['"]([^'"\\\n]{8,200})['"]/g;

const EXTRACTORS = [
  { key: 'apiMethods', file: 'api-methods.txt', run: (js, add) => {
    for (const m of js.matchAll(RE_API_CALL)) add(m[1]); // method:"x.y" — all ns
    for (const m of js.matchAll(RE_API)) add(m[1]); // bare "ns.method" literals (ternary/obj key)
  } },
  { key: 'apiArgs', file: 'api-args.txt', run: (js, add) => {
    for (const m of js.matchAll(RE_ARGS)) for (const k of m[2].matchAll(RE_ARGKEY)) add(`${m[1]}:${k[1]}`);
  } },
  { key: 'featureFlags', file: 'feature-flags.txt', run: (js, add) => { for (const m of js.matchAll(RE_ID)) if (RE_FLAG.test(m[1])) add(m[1]); } },
  { key: 'experiments', file: 'experiments.txt', run: (js, add) => { for (const m of js.matchAll(RE_VARIANT)) add(m[1]); } },
  { key: 'errorCodes', file: 'error-codes.txt', run: (js, add) => { for (const m of js.matchAll(RE_ERR)) add(m[1]); } },
  { key: 'slashCommands', file: 'slash-commands.txt', run: (js, add) => { for (const m of js.matchAll(RE_SLASH)) if (!SLASH_DENY.has(m[1].slice(1))) add(m[1]); } },
  { key: 'oauthScopes', file: 'oauth-scopes.txt', run: (js, add) => { for (const m of js.matchAll(RE_SCOPE)) add(m[1]); } },
  { key: 'analyticsEvents', file: 'analytics-events.txt', run: (js, add) => { for (const m of js.matchAll(RE_EVENT)) add(m[1]); for (const m of js.matchAll(RE_ACTION)) add(m[1]); } },
  // enum registries (consts, anchored window so newfags pop up)
  { key: 'workflowFunctions', file: 'workflow-functions.txt', run: (js, add) => { for (const m of js.matchAll(RE_FN)) add(`${m[1]}:${m[2]}`); } },
  { key: 'workflowEvents', file: 'workflow-events.txt', run: (js, add) => windowed(js, /APP_MENTIONED:"app_mentioned"/g, /[A-Z][A-Z0-9_]{3,40}:"([a-z][a-z0-9_]+)"/g, add) },
  { key: 'notificationTypes', file: 'notification-types.txt', run: (js, add) => windowed(js, /thread_v2:"replies"/g, /([a-z][a-z0-9_]{3,40}):"[a-z][a-z_]+"/g, add) },
  { key: 'aiFeatures', file: 'ai-features.txt', run: (js, add) => windowed(js, /slackbotAiContext:"slackbotAiContext"/g, RE_SELFMAP, add) },
  { key: 'mcpActions', file: 'mcp-actions.txt', run: (js, add) => windowed(js, /tool_call:"wrench"/g, /([a-z][a-z0-9_]{3,40}):"[a-z][a-z_-]+"/g, add) },
  { key: 'blockKitTypes', file: 'block-kit-types.txt', run: (js, add) => windowed(js, /rich_text:"rich_text"/g, RE_SELFMAP, add) },
  // tracing / instr spans
  { key: 'traceSpans', file: 'trace-spans.txt', run: (js, add) => { for (const m of js.matchAll(RE_SPAN)) add(m[1]); } },
  { key: 'iconNames', file: 'icon-names.txt', run: (js, add) => { for (const m of js.matchAll(RE_ICON)) if (!m[1].includes('__')) add(m[1]); } },
  { key: 'keyboardShortcuts', file: 'keyboard-shortcuts.txt', run: (js, add) => { for (const m of js.matchAll(RE_ACCEL)) add(m[1]); } },
  { key: 'devCommands', file: 'dev-commands.txt', run: (js, add) => { for (const m of js.matchAll(RE_DEVCMD)) add(`${m[1]}: ${m[2]}`); } },
  { key: 'uiStrings', file: 'ui-strings.txt', run: (js, add) => {
    for (const m of js.matchAll(RE_STR)) {
      const s = m[1];
      if (s.split(/\s+/).length < 2) continue; // 2+ words min
      if (/[{}<>=`]|:\/\/|=>|\b(?:function|var|return)\b/.test(s)) continue; // not code
      if (/[/\\]|__|--/.test(s)) continue; // no paths or classes
      if (!/[a-z]/.test(s)) continue;
      if (!/^[A-Z“"']/.test(s) && !/[.!?]$/.test(s)) continue; // sentence-ish
      add(s);
    }
  } },
];

const byKey = (fn) => Object.fromEntries(EXTRACTORS.map((e) => [e.key, fn(e)]));
const newSets = () => byKey(() => new Set());
const extractInto = (js, sets) => { for (const e of EXTRACTORS) e.run(js, (x) => sets[e.key].add(x)); };

async function fetchChunk(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      try { return zlib.brotliDecompressSync(buf).toString('utf8'); } catch {}
      try { return zlib.gunzipSync(buf).toString('utf8'); } catch {}
      return buf.toString('utf8');
    } catch (e) {
      if (i >= tries || /HTTP 4\d\d/.test(e.message)) throw e; // end 404s
      await new Promise((r) => setTimeout(r, 250 * i));
    }
  }
}

async function parseManifest(html) {
  const attr = (n) => (html.match(new RegExp(`data-${n}="([^"]*)"`)) || [])[1] || null;
  const first = (...res) => res.map((re) => html.match(re)?.[1]).find(Boolean) || null;
  const manifestSrc = first(/"(https:\/\/a\.slack-edge\.com\/[^"]*webpack\.manifest\.([0-9a-f]+)\.min\.js)"/);
  const manifestHash = manifestSrc?.match(/webpack\.manifest\.([0-9a-f]+)\.min\.js/)?.[1];
  const build = {
    buildNumber: attr('build-number') || (manifestHash ? `manifest-${manifestHash.slice(0, 12)}` : null),
    versionTs: attr('version-ts') || first(/"version_ts":([0-9]+)/, /version_ts\s*=\s*"([0-9]+)"/),
    versionHash: attr('version-hash') || first(/version_uid\s*=\s*"([0-9a-f]+)"/, /"version_uid":"([0-9a-f]+)"/) || manifestHash,
    cdn: attr('cdn') || (html.match(/https:\/\/a\.slack-edge\.com\/bv[0-9-]+br\//) || [])[0],
  };
  const key = build.versionTs ? `?cacheKey=gantry-${build.versionTs}` : '';
  const files = new Set();
  for (const m of html.matchAll(/if\("([^"]+)"===e\)return"gantry-v2-async-"\+e\+"\.([0-9a-f]{8,})\.min\.js/g))
    files.add(`gantry-v2-async-${m[1]}.${m[2]}.min.js`); // async chunks from .u loader
  for (const m of html.matchAll(/([a-zA-Z0-9_-]+\.[0-9a-f]{16,}\.min\.js)/g)) files.add(m[1]); // entry

  if (manifestSrc && files.size < 100) return { build: { ...build, partialManifest: true }, chunks: [] };

  return { build, chunks: [...files].map((f) => ({ file: f, url: `${build.cdn}${f}${manifestSrc ? '' : key}` })) };
}

async function getHtml() {
  if (HTML_FILE) return { html: fs.readFileSync(HTML_FILE, 'utf8'), loaded: [] };
  const { connect } = require('./lib/cdp');
  const cdp = await connect({ port: PORT });
  try {
    return await cdp.evaluate(`(() => ({
      html: document.documentElement.outerHTML,
      loaded: [...new Set(performance.getEntriesByType('resource').map(r=>r.name).filter(n=>/\\.min\\.js/.test(n)))],
    }))()`);
  } finally { cdp.close(); }
}

const readLines = (f) => { try { return fs.readFileSync(path.join(BUILD_DIR, f), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const writeLines = (f, a) => fs.writeFileSync(path.join(BUILD_DIR, f), a.length ? a.join('\n') + '\n' : '');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(BUILD_DIR, f), 'utf8')); } catch { return null; } };
const hashText = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const diffValues = (oldList, newList) => {
  const oldSet = new Set(oldList), newSet = new Set(newList);
  return {
    added: newList.filter((x) => !oldSet.has(x)),
    removed: oldList.filter((x) => !newSet.has(x)),
  };
};
const cappedDiff = (oldList, newList, limit = 25) => {
  const d = diffValues(oldList, newList);
  return {
    addedCount: d.added.length,
    removedCount: d.removed.length,
    added: d.added.slice(0, limit),
    removed: d.removed.slice(0, limit),
  };
};
const chunkName = (file) => file.replace(/\.[0-9a-f]{8,}\.min\.js$/, '');
const chunkKind = (file) => file.startsWith('gantry-v2-async-') ? 'async'
  : file.startsWith('gantry-v2') ? 'entry' : 'other';
const groupBy = (list, keyFn) => {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
};
const buildNumberGap = (previous, current) => {
  if (!/^[0-9]+$/.test(previous || '') || !/^[0-9]+$/.test(current || '')) return null;
  const prev = Number(previous), cur = Number(current);
  if (!Number.isSafeInteger(prev) || !Number.isSafeInteger(cur) || cur <= prev + 1) return null;
  return {
    previous: String(previous),
    current: String(current),
    count: cur - prev - 1,
    missing: Array.from({ length: cur - prev - 1 }, (_, i) => String(prev + i + 1)),
  };
};
const cachePath = (file) => {
  const exact = path.join(CHUNK_CACHE, file);
  if (fs.existsSync(exact)) return exact;
  if (file.startsWith('gantry-v2-async-')) {
    const legacy = path.join(CHUNK_CACHE, file.replace(/^gantry-v2-async-/, ''));
    if (fs.existsSync(legacy)) return legacy;
  }
  return exact;
};

const pruneCache = (capBytes) => {
  if (!capBytes || capBytes <= 0) return;
  let entries;
  try {
    entries = fs.readdirSync(CHUNK_CACHE).map((name) => {
      const fp = path.join(CHUNK_CACHE, name);
      const st = fs.statSync(fp);
      return { fp, size: st.size, mtime: st.mtimeMs };
    });
  } catch { return; }
  let total = entries.reduce((a, e) => a + e.size, 0);
  if (total <= capBytes) return;
  entries.sort((a, b) => a.mtime - b.mtime);
  let removed = 0, freed = 0;
  for (const e of entries) {
    if (total <= capBytes) break;
    try { fs.unlinkSync(e.fp); total -= e.size; freed += e.size; removed++; } catch {}
  }
  log(`   cache prune: dropped ${removed} stale chunks, freed ${(freed / 1024 ** 2).toFixed(0)}MB (cap ${(capBytes / 1024 ** 3).toFixed(1)}GB)`);
};
const findMatching = (s, start, open = '{', close = '}') => {
  let depth = 0, quote = null, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
};
const splitTopLevel = (s) => {
  const parts = [];
  let start = 0, depth = 0, quote = null, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (start < s.length) parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
};
const splitKeyValue = (s) => {
  let depth = 0, quote = null, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ':' && depth === 0) return [s.slice(0, i), s.slice(i + 1)];
  }
  return null;
};
const parseWebpackModules = (js) => {
  const push = js.indexOf('.push([');
  const start = js.indexOf('{', push >= 0 ? push : 0);
  if (start < 0) return new Map([['(chunk)', js]]);
  const end = findMatching(js, start);
  if (end < 0) return new Map([['(chunk)', js]]);
  const modules = new Map();
  for (const entry of splitTopLevel(js.slice(start + 1, end))) {
    const kv = splitKeyValue(entry);
    if (!kv) continue;
    const key = kv[0].trim().replace(/^['"]|['"]$/g, '');
    if (key) modules.set(key, kv[1].trim());
  }
  return modules.size ? modules : new Map([['(chunk)', js]]);
};
const extractStringLiterals = (js) => {
  const out = [];
  for (const m of js.matchAll(/'((?:\\.|[^'\\]){3,180})'|"((?:\\.|[^"\\]){3,180})"/g)) {
    const s = (m[1] || m[2] || '').replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\'/g, "'").trim();
    if (!/[A-Za-z]/.test(s)) continue;
    if (/^[0-9a-f]{12,}$/i.test(s) || /^#[0-9a-f]{3,8}$/i.test(s)) continue;
    out.push(s);
  }
  return sortUniq(out);
};
const extractNames = (js) => {
  const deny = new Set(['prototype', 'constructor', 'undefined', 'exports', 'default', 'length', 'apply', 'call', 'bind']);
  const out = [];
  for (const re of [/\.([A-Za-z_$][A-Za-z0-9_$]{3,60})/g, /(?:^|[,{])([A-Za-z_$][A-Za-z0-9_$]{3,60}):/g, /function ([A-Za-z_$][A-Za-z0-9_$]{3,60})/g]) {
    for (const m of js.matchAll(re)) {
      const s = m[1];
      if (deny.has(s) || /^[A-Z]?$/.test(s)) continue;
      out.push(s);
    }
  }
  return sortUniq(out);
};
const moduleExtractors = (js) => {
  const sets = newSets();
  extractInto(js, sets);
  return byKey((e) => sortUniq([...sets[e.key]]));
};
const moduleDelta = (oldBody, newBody) => {
  const oldExtracted = moduleExtractors(oldBody), newExtracted = moduleExtractors(newBody);
  return {
    hash: { previous: hashText(oldBody), current: hashText(newBody) },
    bytes: { previous: Buffer.byteLength(oldBody), current: Buffer.byteLength(newBody), delta: Buffer.byteLength(newBody) - Buffer.byteLength(oldBody) },
    strings: cappedDiff(extractStringLiterals(oldBody), extractStringLiterals(newBody), 30),
    names: cappedDiff(extractNames(oldBody), extractNames(newBody), 30),
    extractors: byKey((e) => {
      const d = cappedDiff(oldExtracted[e.key], newExtracted[e.key], 20);
      return { addedCount: d.addedCount, removedCount: d.removedCount, added: d.added, removed: d.removed };
    }),
  };
};
const moduleChanges = (oldModules, newModules) => {
  const oldIds = [...oldModules.keys()].sort(), newIds = [...newModules.keys()].sort();
  const raw = diffValues(oldIds, newIds);
  const changedIds = oldIds.filter((id) => newModules.has(id) && hashText(oldModules.get(id)) !== hashText(newModules.get(id)))
    .map((id) => ({
      id,
      delta: Buffer.byteLength(newModules.get(id)) - Buffer.byteLength(oldModules.get(id)),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const changed = changedIds.slice(0, 25)
    .map(({ id }) => ({ id, ...moduleDelta(oldModules.get(id), newModules.get(id)) }));
  return {
    previous: oldIds.length,
    current: newIds.length,
    addedCount: raw.added.length,
    removedCount: raw.removed.length,
    changedCount: changedIds.length,
    added: raw.added.slice(0, 50),
    removed: raw.removed.slice(0, 50),
    changed,
  };
};
const chunkSnapshot = (file) => {
  const cp = cachePath(file);
  try {
    const js = fs.readFileSync(cp, 'utf8');
    const sets = newSets();
    extractInto(js, sets);
    const modules = parseWebpackModules(js);
    return {
      file,
      cachePath: cp,
      bytes: Buffer.byteLength(js),
      modules,
      counts: byKey((e) => sets[e.key].size),
      values: byKey((e) => sortUniq([...sets[e.key]])),
    };
  } catch (e) {
    return { file, missing: true, error: e.message || String(e) };
  }
};
const chunkExtractionDelta = (fromFiles, toFiles) => {
  if (fromFiles.length !== 1 || toFiles.length !== 1) return null;
  const from = chunkSnapshot(fromFiles[0]), to = chunkSnapshot(toFiles[0]);
  if (from.missing || to.missing) return { from, to };
  return {
    from: { file: from.file, bytes: from.bytes, counts: from.counts },
    to: { file: to.file, bytes: to.bytes, counts: to.counts },
    bytesDelta: to.bytes - from.bytes,
    modules: moduleChanges(from.modules, to.modules),
    extractors: byKey((e) => {
      const d = diffValues(from.values[e.key], to.values[e.key]);
      return {
        previous: from.values[e.key].length,
        current: to.values[e.key].length,
        added: d.added.length,
        removed: d.removed.length,
      };
    }),
  };
};
const chunkDelta = (previousChunks, currentChunks) => {
  const raw = diffValues(previousChunks, currentChunks);
  const addedByName = groupBy(raw.added, chunkName), removedByName = groupBy(raw.removed, chunkName);
  const changedNames = [...addedByName.keys()].filter((name) => removedByName.has(name)).sort();
  const changed = changedNames.map((name) => {
    const from = removedByName.get(name), to = addedByName.get(name);
    return { name, from, to, analysis: chunkExtractionDelta(from, to) };
  });
  const changedSet = new Set(changedNames);
  const added = raw.added.filter((file) => !changedSet.has(chunkName(file)));
  const removed = raw.removed.filter((file) => !changedSet.has(chunkName(file)));
  const countByKind = (files) => files.reduce((acc, file) => {
    const kind = chunkKind(file);
    acc[kind] = (acc[kind] || 0) + 1;
    return acc;
  }, {});
  return {
    previous: previousChunks.length,
    current: currentChunks.length,
    added,
    removed,
    changed,
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      rawAdded: raw.added.length,
      rawRemoved: raw.removed.length,
      byKind: {
        added: countByKind(added),
        removed: countByKind(removed),
        changed: countByKind(changed.flatMap((c) => c.to)),
      },
    },
  };
};
const logChunkDetails = (delta) => {
  for (const c of delta.chunks.changed.slice(0, 12)) {
    const analysis = c.analysis && !c.analysis.from?.missing && !c.analysis.to?.missing
      ? ` (${c.analysis.bytesDelta >= 0 ? '+' : ''}${c.analysis.bytesDelta} bytes)`
      : '';
    log(`   chunk ${c.name}${analysis} updated`);
    if (!c.analysis || c.analysis.from?.missing || c.analysis.to?.missing) {
      log('      chunk body inspection unavailable; cached files missing or some shit');
      continue;
    }
    const m = c.analysis.modules;
    log(`      modules ${m.previous} -> ${m.current}: ${m.changedCount} changed, ${m.addedCount} added, ${m.removedCount} removed`);
    if (m.added.length) log(`      new module ids: ${m.added.slice(0, 8).join(', ')}${m.addedCount > 8 ? ', ...' : ''}`);
    if (m.removed.length) log(`      killed module ids: ${m.removed.slice(0, 8).join(', ')}${m.removedCount > 8 ? ', ...' : ''}`);
    for (const mod of m.changed.slice(0, 4)) {
      const signalCount = EXTRACTORS.reduce((n, e) => n + mod.extractors[e.key].addedCount + mod.extractors[e.key].removedCount, 0);
      log(`      module ${mod.id}: ${mod.bytes.previous} -> ${mod.bytes.current} bytes (${mod.bytes.delta >= 0 ? '+' : ''}${mod.bytes.delta}), strings +${mod.strings.addedCount}/-${mod.strings.removedCount}, names +${mod.names.addedCount}/-${mod.names.removedCount}, extractor signals ${signalCount}`);
      const extractorSignals = EXTRACTORS
        .map((e) => [e.key, mod.extractors[e.key]])
        .filter(([, d]) => d.addedCount || d.removedCount)
        .slice(0, 4);
      for (const [key, d] of extractorSignals) {
        const values = [...d.added.map((x) => `+${x}`), ...d.removed.map((x) => `-${x}`)].slice(0, 6);
        log(`         ${key}: +${d.addedCount}/-${d.removedCount}${values.length ? ` (${values.join(', ')})` : ''}`);
      }
      if (mod.strings.added.length) log(`         new strings: ${mod.strings.added.slice(0, 3).join(' | ')}`);
      if (mod.strings.removed.length) log(`         yeeted strings: ${mod.strings.removed.slice(0, 3).join(' | ')}`);
      if (mod.names.added.length) log(`         new names: ${mod.names.added.slice(0, 6).join(', ')}`);
      if (mod.names.removed.length) log(`         killed names: ${mod.names.removed.slice(0, 6).join(', ')}`);
    }
  }
  if (delta.chunks.added.length) log(`   new chunks: ${delta.chunks.added.slice(0, 12).join(', ')}${delta.chunks.added.length > 12 ? ', ...' : ''}`);
  if (delta.chunks.removed.length) log(`   gone chunks: ${delta.chunks.removed.slice(0, 12).join(', ')}${delta.chunks.removed.length > 12 ? ', ...' : ''}`);
};

(async () => {
  log(`\n⛏️  datamining slack — ${HTML_FILE ? `html:${HTML_FILE}` : `cdp:${PORT}`}`);
  const src = await getHtml();
  const { build, chunks: manifest } = await parseManifest(src.html);
  if (build.partialManifest) die('only public webpack.manifest html, use real client html or cdp');
  if (!build.buildNumber || !build.versionHash || !build.cdn) die('no build metadata in html, need slack client html or manifest script');

  let chunks = manifest;
  if (LOADED_ONLY) {
    const key = build.versionTs ? `?cacheKey=gantry-${build.versionTs}` : '';
    chunks = (src.loaded || []).map((u) => ({ file: u.split('/').pop().split('?')[0], url: u.split('?')[0] + key }));
  }
  if (LIMIT) chunks = chunks.slice(0, LIMIT);
  log(`   build ${build.buildNumber} (ts ${build.versionTs}, hash ${(build.versionHash || '').slice(0, 12)}…) — ${manifest.length} chunks total, grabbing ${chunks.length}`);

  // fetch + decode + extract (concurrent as fuck)
  fs.mkdirSync(CHUNK_CACHE, { recursive: true });
  const sets = newSets();
  const failedChunks = [];
  let fetched = 0, cached = 0, done = 0, i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
    while (i < chunks.length) {
      const { file, url } = chunks[i++];
      const cp = path.join(CHUNK_CACHE, file);
      try {
        let js;
        if (!FORCE && fs.existsSync(cp)) { js = fs.readFileSync(cp, 'utf8'); try { const t = new Date(); fs.utimesSync(cp, t, t); } catch {} cached++; }
        else { js = await fetchChunk(url); fs.writeFileSync(cp, js); fetched++; }
        extractInto(js, sets);
      } catch (e) { failedChunks.push({ file, error: e.message || String(e) }); }
      if (++done % 250 === 0) log(`   …${done}/${chunks.length}`);
    }
  }));
  const failed = failedChunks.length;
  log(`   ${fetched} grabbed, ${cached} from cache${failed ? `, ${failed} bricked` : ''}`);
  for (const { file, error } of failedChunks.sort((a, b) => a.file.localeCompare(b.file)).slice(0, 20)) {
    log(`   chunk ${file} bricked (${error})`);
  }
  if (failed > 20) log(`   ... ${failed - 20} more chunks fucked`);
  pruneCache(MBYTES);

  // diff it up
  const previousMeta = readJson('meta.json');
  const prevHash = previousMeta?.versionHash || null;
  const sameVersion = prevHash === build.versionHash;
  const prev = byKey((e) => readLines(e.file));
  const prevChunks = readLines('chunks.txt');
  const result = byKey((e) => sortUniq([...sets[e.key]]));
  const currentChunks = sortUniq(chunks.map((c) => c.file));
  const delta = {
    build: {
      buildNumber: build.buildNumber,
      versionTs: build.versionTs,
      versionHash: build.versionHash,
      cdnBase: build.cdn,
      manifestChunks: manifest.length,
      minedChunks: chunks.length,
      failedChunks: failed,
      counts: byKey((e) => result[e.key].length),
    },
    previousBuild: previousMeta ? {
      buildNumber: previousMeta.buildNumber,
      versionTs: previousMeta.versionTs,
      versionHash: previousMeta.versionHash,
      manifestChunks: previousMeta.manifestChunks,
      minedChunks: previousMeta.minedChunks,
      failedChunks: previousMeta.failedChunks,
      counts: previousMeta.counts || {},
    } : null,
    buildNumberGap: previousMeta ? buildNumberGap(previousMeta.buildNumber, build.buildNumber) : null,
    failedChunkFiles: failedChunks.map((c) => c.file).sort(),
    failedChunkErrors: failedChunks.sort((a, b) => a.file.localeCompare(b.file)),
    chunks: chunkDelta(prevChunks, currentChunks),
    extractors: byKey((e) => {
      const d = diffValues(prev[e.key], result[e.key]);
      return { previous: prev[e.key].length, current: result[e.key].length, added: d.added, removed: d.removed };
    }),
  };
  const hasDataDelta = delta.chunks.counts.rawAdded || delta.chunks.counts.rawRemoved
    || EXTRACTORS.some((e) => delta.extractors[e.key].added.length || delta.extractors[e.key].removed.length);
  const metaPath = path.join(BUILD_DIR, 'meta.json');
  const shouldWriteBuildArtifacts = !sameVersion || hasDataDelta;

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  for (const e of EXTRACTORS) writeLines(e.file, result[e.key]);
  writeLines('chunks.txt', currentChunks);
  if (shouldWriteBuildArtifacts || !fs.existsSync(metaPath)) {
    fs.writeFileSync(metaPath, JSON.stringify({
      buildNumber: build.buildNumber, versionTs: build.versionTs, versionHash: build.versionHash,
      cdnBase: build.cdn, capturedDate: new Date().toISOString().slice(0, 10),
      manifestChunks: manifest.length, minedChunks: chunks.length, failedChunks: failed,
      failedChunkFiles: failedChunks.map((c) => c.file).sort(),
      counts: byKey((e) => result[e.key].length),
    }, null, 2) + '\n');
  }

  log('─'.repeat(60));
  log('   ' + EXTRACTORS.map((e) => `${e.key} ${result[e.key].length}`).join(' | '));
  if (delta.buildNumberGap) log(`⚠️  missed these builds: ${delta.buildNumberGap.missing.join(', ')}`);
  if (delta.chunks.counts.rawAdded || delta.chunks.counts.rawRemoved) {
    log(`   chunks: ${delta.chunks.counts.changed} changed, ${delta.chunks.counts.added} added, ${delta.chunks.counts.removed} removed`);
    logChunkDetails(delta);
  }
  if (prevHash && prevHash !== build.versionHash) {
    log('vs last build: ' + EXTRACTORS.map((e) => {
      const d = delta.extractors[e.key];
      return `+${d.added.length}/-${d.removed.length} ${e.key}`;
    }).join(', '));
  }
  log(`✅ build/ updated!`);
})().catch((e) => die(e.stack || e.message || String(e)));
