'use strict';

const re = (f = '') => (s, ...v) => new RegExp(String.raw(s, ...v), f);
const METHOD = String.raw`[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+`;
const ID = String.raw`"([^"\\]{1,8})"|(\d{1,6})`;
const FN = String.raw`function\(([\w$]*)(?:,([\w$]*))?(?:,([\w$]+))?\)\{`;
const CMD = String.raw`(\/[a-z][a-z0-9_-]{0,40})`;
const CALLEE = String.raw`\(0,([\w$]+)(?:\((?:${ID})\))?\.([\w$]+)\)`;
const RE_METHOD = re()`^${METHOD}$`;
const RE_SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const RE_ERR = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const RE_SLASH = /^\/[a-z][a-z0-9_]{0,40}$/;
const RE_REF = /^[A-Za-z][\w.:\/-]*$/;
const RE_HDR = re('g')`:\(${FN}`;
const RE_HDR_KEY = re()`[,{](?:${ID}|([\w$]{4,5}))$`;
const RE_BODYHDR = re()`^\s*\(?${FN}`;
const RE_IMPORT = re('g')`=([\w$]+)\((?:${ID})\)`;
const RE_CONST = /="([^"\\]{1,200})"(?=[,;])/g;
const RE_EXPORT = /\.d\([\w$]+,\{/g;
const RE_CALL = re('g')`${CALLEE}\(`;
const RE_CALLARG = re()`^(?:"(${METHOD})"\)|("[a-z][a-z0-9_]{1,80}"|[\w$]+\.[\w$]+|[\w$]+),(?:[\w$(]|async))`;
const RE_FETCHER_HEAD = re()`(?:([\w$]+)=)?${CALLEE}\("(\w+)$`;
const RE_FETCHER_TAIL = /^Fetcher",("[^"]+"|[\w$]+)(,\{[^{}]*\})?\)/;
const RE_METHODKEY = re('g')`\bmethod:("${METHOD}"|[\w$]+(?:\.[\w$]+)?)(?=[,}])`;
const RE_IDENT = /\.d\([\w$]+,\{\},\{([\w$]+):([\w$]+)=>\2\}\)/g;
const RE_RTMDEF = /[{,]([\w$]+):\(\)=>(add\w*RtmHandler)\b/g;
const RE_STRARR = /\["[^"\\\n]{1,120}"(?:,"[^"\\\n]{1,120}")+\]/g;
const RE_METHODMAP = re('g')`\{"${METHOD}":`;
const RE_SELFENUM = /\{(?:(?:"[^"]+"|[\w$]+):"[a-z][a-z0-9_]*",?){2,}\}/g;
const RE_ANCHOR = /Fetcher",|\.error\b|error:"|subtype\b|getMessageSubtype\(|function isAutomatedSubtype\(|:\{paths:\[|\{path:"|slack:\/\/|tinyspeck\.com|slack-github\.com|slack-corp\.com|quip\.(?:tools|codes|systems)|sfdc\.sh|salesforce\.com|\.slack\.com|ame:"\/|\.cmd\b|cmd:"\/|:(?:read|write|history|manage|customize|basic|join|invoke|admin|connect)[."]/g;
const RE_ROUTE_KEY = /[{,](\[[\w$]+\.[\w$]+\]|\[[\w$]+\]|[\w$]+|"[^"]+")$/;
const RE_CMD = re()`^(?:ame:|cmd:|\.cmd===?)"${CMD}"`;
const RE_CMD_BACK = re()`"${CMD}"===[\w$?.]*$`;
const RE_URL = /^["`]((?:https?:)?\/\/((?:\$\{[^}]{1,40}\}\.)?[a-z0-9.-]+)(?::\d+)?((?:\/|\?)[^"`\s\\]*)?)["`]/;
const RE_INTERNAL = /(?:^|\.)(?:tinyspeck\.com|slack-github\.com|slack-corp\.com|quip\.tools|quip\.codes|quip\.systems|sfdc\.sh|internal\.salesforce\.com|inside\.salesforce\.com)$|^(?:dev\d*|qa\d*|staging|slack-pde)\.slack\.com$|^(?:iis-(?:stage|qa)\.digital\.salesforce\.com|staging\.quip\.com)$/;
const SCOPE_NS = new Set(['admin', 'app_mentions', 'assistant', 'bookmarks', 'calls', 'canvases', 'channels', 'chat', 'commands', 'conversations', 'datastore', 'dnd', 'emoji', 'files', 'groups', 'identity', 'im', 'incoming-webhook', 'links', 'lists', 'metadata', 'mpim', 'openid', 'pins', 'reactions', 'reminders', 'remote_files', 'search', 'stars', 'team', 'tokens', 'triggers', 'usergroups', 'users', 'users.profile', 'workflow', 'hosting', 'bot', 'auditlogs']);
const ARG_SKIP = new Set(['abortSignal', 'expectedErrors', 'reason', 'timeout']);
const Q = '"\'`', OPEN = '{[(', CLOSE = '}])';

function skip(s, j, stop) {
  for (const c = s[j++]; j < stop && s[j] !== c; j++) {
    if (s[j] === '\\') j++;
    else if (c === '`' && s[j] === '$' && s[j + 1] === '{') { j++; for (let d = 1; d && ++j < stop;) d += (s[j] === '{') - (s[j] === '}'); }
  }
  return j;
}
function objEnd(s, i, max) {
  for (let j = i, d = 0, stop = Math.min(s.length, i + max); j < stop; j++) {
    const c = s[j];
    if (Q.includes(c)) j = skip(s, j, stop);
    else if (OPEN.includes(c)) d++;
    else if (CLOSE.includes(c) && !--d) return j;
  }
  return -1;
}
function objKeys(s, i, max = 4000) {
  const keys = [];
  for (let j = i, d = 0, want = false, stop = Math.min(s.length, i + max); j < stop; j++) {
    const c = s[j];
    if (Q.includes(c)) {
      if (d === 1 && want) { const k = /^"([^"\\]+)"(?=:)/.exec(s.slice(j, j + 80)); k && keys.push(k[1]); want = false; }
      j = skip(s, j, stop);
    } else if (OPEN.includes(c)) { if (++d === 1) want = true; }
    else if (CLOSE.includes(c)) { if (!--d) return keys; }
    else if (d === 1 && c === ',') want = true;
    else if (d === 1 && want) {
      want = false;
      const k = /^([A-Za-z_$][\w$]*)(?=[:,}])/.exec(s.slice(j, j + 80));
      if (k) { keys.push(k[1]); j += k[0].length - 1; }
    }
  }
  return null;
}
function strPairs(s) {
  const out = [];
  for (let j = 0, d = 0; j < s.length; j++) {
    const c = s[j];
    if (Q.includes(c)) j = skip(s, j, s.length);
    else if (CLOSE.includes(c)) d--;
    else if ((OPEN.includes(c) ? ++d : c === ',' && d) === 2) {
      const k = /^([\w$]+):"([^"\\]*)"(?=[,}])/.exec(s.slice(j + 1, j + 160));
      if (k) { out.push([k[1], k[2]]); j += k[0].length; }
    }
  }
  return out;
}
const snake = (k) => (k.match(/[A-Z]{2,}(?=[A-Z][a-z]|[0-9]|_|$)|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g) || [k]).join('_').toLowerCase();
const strs = (s) => [...s.matchAll(/"([^"\\]*)"/g)].map((x) => x[1]);
const cap = (r, s) => r.exec(s)?.[1];
const isMethod = (s) => RE_METHOD.test(s);
const isRef = (v) => v[0] === '~';
const mod = (id, req, start) => ({ id, req, start, imp: new Map(), loc: new Map(), exp: null });

let cache = {};
function analyze(js) {
  if (js === cache.js) return cache.R;
  const R = Object.fromEntries('methods args errors refs rtm subtypes routes deepLinks internalUrls slash scopes'.split(' ').map((k) => [k, []]));
  const before = (i, n) => js.slice(Math.max(0, i - n), i), after = (i, n) => js.slice(i, i + n);
  const ident = (i) => { let j = i; while (j > 0 && /[\w$]/.test(js[j - 1])) j--; return j < i && !/[.\w$]/.test(js[j - 1] || '') ? js.slice(j, i) : null; };
  const put = (k, ...l) => { for (const v of l) v && R[k].push(v); };
  const putE = (m, k, v) => v && v.length <= 100 && RE_REF.test(v) && R.refs.push(`~E|${m.id}|${k}|${v}`);
  const err = (c) => c && RE_ERR.test(c) && R.errors.push(`|${c}`);
  const argsAt = (i) => { const r = /^,(?:[\w$]+:[^,{}]{1,60},){0,4}args:\{/.exec(after(i, 400)), k = r && objKeys(js, i + r[0].length - 1); return k ? k.filter((x) => x !== 'token').join(',') : ''; };
  const mods = [];
  for (const h of js.matchAll(RE_HDR)) { const k = RE_HDR_KEY.exec(before(h.index, 10)); k && mods.push(mod(k[1] || k[2] || k[3], h[3] || null, h.index - k[0].length)); }
  if (!mods.length) { const m = RE_BODYHDR.exec(js); mods.push(mod('?', m && m[3], 0)); }
  const modAt = (i) => { let l = 0, h = mods.length - 1; while (l < h) { const m = (l + h + 1) >> 1; mods[m].start <= i ? l = m : h = m - 1; } return mods[l]; };
  const ref = (m, v) => {
    if (v[0] === '"') return v.slice(1, -1);
    const [a, e] = v.split('.'), t = m.imp.get(a);
    return e ? t && `@${t}|${e}` : m.loc.get(v);
  };
  for (const x of js.matchAll(RE_IMPORT)) { const m = modAt(x.index), v = m.req === x[1] && ident(x.index); v && m.imp.set(v, x[2] || x[3]); }
  for (const x of js.matchAll(RE_CONST)) {
    const v = ident(x.index), b = v && before(x.index - v.length, 6);
    if (b && (b.endsWith(',') || /(?:^|[^\w$])(?:let|var|const) $/.test(b))) { const m = modAt(x.index); m.loc.has(v) || m.loc.set(v, x[1]); }
  }
  for (const x of js.matchAll(RE_EXPORT)) {
    const m = modAt(x.index); if (m.req !== ident(x.index)) continue;
    const a = x.index + 2, e = objEnd(js, a, 200000), seg = m.seg = js.slice(a, e > 0 ? e : a + 4000);
    m.exp ||= new Map();
    for (const p of seg.matchAll(/[{,]([\w$]+):(?:\(\)=>)?([\w$]+)(?=[,}])/g)) m.exp.set(p[1], p[2]);
    for (const [k, v] of strPairs(seg)) putE(m, k, v);
    for (const p of seg.matchAll(RE_RTMDEF)) R.refs.push(`~H|${m.id}|${p[1]}`);
  }
  for (const m of mods) if (m.exp) for (const [e, l] of m.exp) putE(m, e, m.loc.get(l));
  for (const x of js.matchAll(RE_METHODKEY)) {
    const v = ref(modAt(x.index), x[1]);
    if (!v || v[0] !== '@' && !isMethod(v)) continue;
    const a = argsAt(x.index + x[0].length);
    if (v[0] === '@') R.methods.push(`~R|${v.slice(1)}|${a}`);
    else { R.methods.push(v); if (a) for (const k of a.split(',')) R.args.push(`${v}|${k}`); }
  }
  for (const x of js.matchAll(RE_IDENT)) R.refs.push(`~I|${modAt(x.index).id}|${x[1]}`);
  for (const x of js.matchAll(RE_STRARR)) {
    const l = strs(x[0]), k = l.length >= 3 && l.every(isMethod) ? 'methods' : l.every((s) => RE_SLASH.test(s)) && 'slash';
    k && R[k].push(`~A|${l}`);
  }
  for (const x of js.matchAll(RE_METHODMAP)) { const k = objKeys(js, x.index, 20000); k?.length >= 2 && k.every(isMethod) && R.methods.push(`~A|${k}`); }
  for (const x of js.matchAll(RE_SELFENUM)) {
    const ps = [...x[0].matchAll(/(?:"([^"]+)"|([\w$]+)):"([^"]+)"/g)];
    if (ps.every(([, a, b, v]) => snake(a || b) === v || (a || b) === v.toUpperCase())) R.errors.push(`~O|${ps.map((p) => p[3])}`);
  }
  for (const x of js.matchAll(RE_CALL)) {
    const i = x.index + x[0].length, c = js[i];
    if (c !== '{' && c !== '"' && !/[\w$]/.test(c)) continue;
    const m = modAt(x.index), t = x[2] || x[3] || m.imp.get(x[1]); if (!t) continue;
    const p = `${t}|${x[4]}`;
    if (c === '{') { const k = objKeys(js, i); k?.length && R.args.push(`~U|${p}|${k}`); continue; }
    const y = RE_CALLARG.exec(after(i, 130)); if (!y) continue;
    if (y[1]) R.methods.push(`~C|${p}|${y[1]}`);
    else { const v = ref(m, y[2]); v && (v[0] === '@' || RE_SNAKE.test(v)) && R.rtm.push(`~h|${p}|${v}`); }
  }
  const seen = new Set();
  for (const { index: i, 0: t } of js.matchAll(RE_ANCHOR)) {
    if (t === 'Fetcher",') {
      const h = RE_FETCHER_HEAD.exec(before(i, 160)), y = RE_FETCHER_TAIL.exec(after(i, 300)), m = modAt(i), v = h && y && ref(m, y[1]);
      if (!v || !isMethod(v)) continue;
      R.methods.push(v);
      if (h[1] && m.exp) for (const [e, l] of m.exp) l === h[1] && R.refs.push(`~F|${m.id}|${e}|${v}|${+!/camelCaseInput:(?:!1|false)/.test(y[2] || '')}`);
      if (m.seg) { for (const o of m.seg.matchAll(/[{,][\w$]+:\{((?:[A-Z][A-Za-z0-9]*:"[a-z][a-z0-9_.-]*",?)+)\}/g)) for (const c of strs(o[1])) R.errors.push(`${v}|${c}`); m.seg = null; }
    } else if (t === '.error') {
      const a = /^\.error(?:===?"([a-z][a-z0-9_]{2,80})"|\)\{((?:case"[a-z][a-z0-9_]+":)+))/.exec(after(i, 400));
      err(a?.[1]);
      if (a?.[2] && /switch\([\w$?.]*$/.test(js.slice(i - 40, i))) for (const c of a[2].matchAll(/case"([^"]+)":/g)) err(c[1]);
      err(cap(/"([a-z][a-z0-9_]{2,80})"===[\w$?.]*$/, before(i, 100)));
    } else if (t === 'error:"') /[{,]$/.test(js[i - 1]) && err(cap(/^error:"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"/, after(i, 90)));
    else if (t === 'getMessageSubtype(') put('subtypes', cap(/"([a-z][a-z0-9_]{1,60})"===$/, before(i, 70)), cap(/^getMessageSubtype\([\w$]+\)===?"([a-z][a-z0-9_]{1,60})"/, after(i, 120)));
    else if (t === 'subtype') {
      if (js[i - 1] !== '.') continue;
      const a = after(i, 80), arr = /^subtype\)/.test(a) && cap(/\[((?:"[a-z][a-z0-9_]+",?)+)\](?:\.includes\(|,)[\w$]+\??\.$/, before(i, 3000));
      if (arr) { R.subtypes.push(...strs(arr)); continue; }
      const c = /"([a-z][a-z0-9_]{2,60})"===([\w$.?]*)\??\.$/.exec(before(i, 120))?.slice(1) || [cap(/^subtype===?"([a-z][a-z0-9_]{2,60})"/, a), cap(/([\w$.?]*)\??\.$/, before(i, 80))];
      if (!c[0]) continue;
      const [, f, g] = [...before(i, 400).matchAll(/function ([\w$]{3,})\(|(?:let |const |var |,)([\w$]{3,})=(?:\([^()]*\)|[\w$]+)=>/g)].pop() || [];
      if (/(?:message|msg|Message|Msg)\??$/.test(c[1] || '') || /(?:Msg|Message)s?(?:[A-Z]|$)|Subtype|^make\w+Object$/.test(f || g || '')) R.subtypes.push(c[0]);
    } else if (t === 'function isAutomatedSubtype(') {
      const m = modAt(i);
      for (const x of js.slice(m.start, mods[mods.indexOf(m) + 1]?.start ?? js.length).matchAll(/\[((?:"[a-z][a-z0-9_]+",?)+)\]/g)) R.subtypes.push(...strs(x[1]));
    } else if (t === ':{paths:[') {
      const k = cap(RE_ROUTE_KEY, before(i, 80)), e = k ? objEnd(js, i + 8, 20000) : -1;
      if (e < 0) continue;
      const n = k[0] === '[' ? ref(modAt(i), k.slice(1, -1)) : k.replace(/"/g, '');
      for (const p of strs(js.slice(i + 8, e + 1))) R.routes.push(n && n[0] === '@' ? `~P|${n.slice(1)}|${p}` : `${n || '?'} ${p}`);
    } else if (t === '{path:"') { const y = cap(/^\{path:"([a-z][a-z0-9_-]*)",id:/, after(i, 80)); y && R.routes.push(`page /${y}`); }
    else if (t === 'slack://') {
      const y = /^slack:\/\/([a-z][a-z0-9_-]*)\/?(\?[^"`\s]*)?["`]/.exec(after(i, 300));
      if (!y || !/["`]$/.test(js[i - 1])) continue;
      const q = [...new Set([...(y[2] || '').slice(1).matchAll(/(?:^|&)([a-z_]+)=/g)].map((p) => p[1]))].sort().join('&');
      R.deepLinks.push(`slack://${y[1]}${q && '?' + q}`);
    } else if (t === 'ame:"/' || t === 'cmd:"/' || t === '.cmd') {
      if (t !== 'ame:"/' || /[nN]/.test(js[i - 1])) put('slash', cap(RE_CMD, after(i, 60)));
      if (t === '.cmd') put('slash', cap(RE_CMD_BACK, before(i, 80)));
    } else if (t[0] === ':') {
      const b = cap(/[:\[,(]"((?:[a-z]+\.)?[a-z-]+(?:_[a-z]+)*)$/, before(i, 40)), a = SCOPE_NS.has(b) && cap(/^:([a-z]+(?:\.[a-z_]+)*)"/, after(i, 60));
      a && R.scopes.push(`${b}:${a}`);
    } else {
      const w = before(i, 200), q = Math.max(w.lastIndexOf('"'), w.lastIndexOf('`')), s = i - w.length + q;
      if (q < 0 || seen.has(s)) continue;
      seen.add(s);
      const x = RE_URL.exec(after(s, 600));
      const u = x && RE_INTERNAL.test(x[2].replace(/^\$\{[^}]*\}\./, '')) && x[1].replace(/\$\{[^}]*\}/g, '{}').replace(/\b[CDGTUWE][A-Z0-9]{8,12}\b/g, '{id}').replace(/\/p\d{16}\b/g, '/p{ts}').replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/^\/\//, 'https://');
      u && !/[A-Za-z0-9_-]{32,}/.test(u) && R.internalUrls.push(u);
    }
  }
  cache = { js, R };
  return R;
}

const cut = (v) => { const [t, a, b, ...r] = v.split('|'); return [t, `${a}|${b}`, ...r]; };
const pair = (v) => { const i = v.indexOf('|'); return [v.slice(0, i), v.slice(i + 1)]; };
const group = (M, k, v) => (M.get(k) || M.set(k, new Set()).get(k)).add(v);
const lists = (vals, t) => vals.filter((v) => v.startsWith(t)).map((v) => v.slice(3).split(','));
const grow = (ls, S, ok, T = S) => { for (const l of ls) ok(l.filter((s) => S.has(s)).length, l.length) && l.forEach((s) => T.add(s)); return T; };
const uniq = (l) => [...new Set(l)].sort();
function index(vals) {
  const X = { F: new Map(), E: new Map(), I: new Set(), H: new Set() };
  for (const v of vals) if (isRef(v)) { const [t, k, c, d] = cut(v); t === '~F' ? X.F.set(k, [c, d === '1']) : t === '~E' ? X.E.set(k, c) : X[t[1]]?.add(k); }
  return X;
}
function resolveApi(vals) {
  const X = index(vals), methods = new Set([...X.F.values()].map(([m]) => m)), args = new Map();
  for (const v of vals) {
    if (!isRef(v)) { isMethod(v) && methods.add(v); continue; }
    const [t, k, c] = cut(v), m = t === '~R' && (X.E.get(k) || X.F.get(k)?.[0]);
    if (m && isMethod(m)) { methods.add(m); c && c.split(',').forEach((a) => group(args, m, a)); }
    else if (t === '~C' && X.I.has(k)) methods.add(c);
  }
  grow(lists(vals, '~A|'), methods, (k, n) => k >= 2 && k / n >= 0.3);
  return { X, methods, args };
}
const pairsOut = (M) => [...M].map(([m, s]) => `${m}: ${[...s].sort().join(', ')}`).sort();
const errorPairs = (vals) => { const M = new Map(); for (const v of vals) v.indexOf('|') > 0 && !isRef(v) && group(M, ...pair(v)); return M; };

const feed = (spec) => (js, a) => { const r = analyze(js); for (const k in spec) for (const v of r[k]) (!spec[k] || spec[k].test(v)) && a(v); };
const EXTRACTORS = [
  { key: 'apiMethods', file: 'api-methods.txt', run: feed({ methods: 0, refs: 0 }), post: (vals) => [...resolveApi(vals).methods].sort() },
  { key: 'apiArgs', file: 'api-args.txt',
    run: feed({ args: 0, refs: 0, methods: /^~/ }),
    post: (vals) => {
      const { X, args } = resolveApi(vals.filter(isRef));
      for (const v of vals) {
        if (v.startsWith('~U|')) { const [, k, c] = cut(v), f = X.F.get(k); f && c.split(',').forEach((a) => ARG_SKIP.has(a) || group(args, f[0], f[1] ? snake(a) : a)); }
        else if (!isRef(v)) group(args, ...pair(v));
      }
      return pairsOut(args);
    } },
  { key: 'apiErrors', file: 'api-errors.txt', run: feed({ errors: /^[^~|]/ }), post: (vals) => pairsOut(errorPairs(vals)) },
  { key: 'errorCodes', file: 'error-codes.txt',
    run: feed({ errors: 0 }),
    post: (vals) => {
      const strong = new Set([...errorPairs(vals).values()].flatMap((s) => [...s]));
      const known = new Set(vals.filter((v) => !isRef(v)).map((v) => pair(v)[1]));
      return [...grow(lists(vals, '~O|'), strong, (k, n) => k >= 2 && k / n >= 0.4, known)].filter((s) => RE_SNAKE.test(s)).sort();
    } },
  { key: 'rtmEvents', file: 'rtm-events.txt',
    run: feed({ rtm: 0, refs: /^~[HE]\|/ }),
    post: (vals) => {
      const X = index(vals);
      return uniq(vals.filter((v) => v.startsWith('~h|')).map((v) => { const [, k, c, d] = cut(v); return X.H.has(k) && (c[0] === '@' ? X.E.get(`${c.slice(1)}|${d}`) : c); }).filter((e) => e && RE_SNAKE.test(e)));
    } },
  { key: 'messageSubtypes', file: 'message-subtypes.txt', run: feed({ subtypes: 0 }) },
  { key: 'routes', file: 'client-routes.txt',
    run: feed({ routes: 0, refs: /^~E\|/ }),
    post: (vals) => {
      const { E } = index(vals);
      return uniq(vals.filter((v) => !isRef(v) || v.startsWith('~P|')).map((v) => { const [t, k, c] = cut(v); return t === '~P' ? `${E.get(k) || '?'} ${c}` : v; }));
    } },
  { key: 'deepLinks', file: 'deep-links.txt', run: feed({ deepLinks: 0 }) },
  { key: 'internalUrls', file: 'internal-urls.txt', run: feed({ internalUrls: 0 }) },
  { key: 'slashCommands', file: 'slash-commands.txt',
    run: feed({ slash: 0 }),
    post: (vals) => [...grow(lists(vals, '~A|'), new Set(vals.filter((v) => !isRef(v))), (k, n) => k >= 1 && n >= 2)].sort() },
  { key: 'oauthScopes', file: 'oauth-scopes.txt', run: feed({ scopes: 0 }) },
];
module.exports = EXTRACTORS;
module.exports._internal = { analyze, objKeys, objEnd, snake };
