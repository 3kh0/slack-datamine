'use strict';

const SPECS = [
  ['exp', 'body', /\bgetGroupForUserImpl\([\w$]+,([\w$]+)/],
  ['exp', 'name', /^getAssignmentByName$/, 1],
  ['session', 'name', /^(?:getToggleGroupForSession|isToggleEnabledForSession)$/, 0],
  ['sessionRegister', 'name', /^registerSessionToggleConfig$/, 0],
  ['user', 'name', /^getUserPref$/, 1],
  ['team', 'body', /\.teamPrefs\?\.\[[\w$]+\]\?\.\[([\w$]+)\]/],
  ['org', 'body', /\.enterprisePrefs\?\.(?:org|locked|unlocked)_prefs\?\.\[([\w$]+)\]/],
  ['onboarding', 'body', /\.onboarding\?\.\[([\w$]+)\]/],
  ['featureAccess', 'body', /\.featureAccess\?\.\[([\w$]+)\]/],
  ['user', 'meta', /^(?:setUserPref|setUserPrefByApi|saveSunroofUserPref)$/, 'p'],
  ['onboarding', 'meta', /^setOnboardingData$/, 'p'],
];

const RE_MOD = /:\(function\(([\w$]*)(?:,([\w$]+))?(?:,([\w$]+))?\)\{/g;
const RE_IMP = /=([\w$]{1,4})\("([^"\\]{1,12})"\)/g;
const RE_SCONST = /="([^"\\]{1,200})"/g;
const RE_ENUM = /=\{((?:[\w$]+:"[^"\\]*",?){2,})\}/g;
const RE_ENUMPAIR = /([\w$]+):"([^"\\]*)"/g;
const RE_SIMPLEARGS = /\((?:([\w$.]+|"[^"\\]*")(?:,([\w$.]+|"[^"\\]*")(?:,(!?[\w$.]+|"[^"\\]*"))?)?)?\)/y;
const RE_PROTO = /\{0:\{fullName_:"(proto\.(?:rollouts\.[A-Za-z]+|experiment\.ClientExperimentSpec))"\}/g;
const RE_CALL = /\(0,([\w$]+)\.([\w$]+)\)\(/g;
const RE_EXPMAP = /\.d\(([\w$]{1,4}),\{/g;
const RE_NAMEVAL = /^[a-z][a-z0-9_]*[a-z0-9]$/;
const RE_GROUPVAL = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const RE_HINT = /getGroupForUserImpl|\.teamPrefs\?\.\[|\.enterprisePrefs\?\.|\.onboarding\?\.\[|\.featureAccess\?\.\[/;
const RE_ROLENAME = new RegExp(SPECS.filter((s) => s[1] === 'name').map((s) => s[2].source).join('|'));

const isId = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const identBefore = (s, i) => { let k = i; while (k > 0 && isId(s.charCodeAt(k - 1))) k--; return s.slice(k, i); };
const esc = (s) => s.replace(/\$/g, '\\$');
const slot = (m, k, C = Map) => m.has(k) ? m.get(k) : m.set(k, new C()).get(k);
const memo = (f) => { let k, v; return (x) => { if (x !== k) { v = f(x); k = x; } return v; }; };
const isName = (r) => r && (r[0] === '@' || RE_NAMEVAL.test(r.slice(1)));

const str = (s, k, end) => { for (const c = s.charCodeAt(k++); k < end; k++) { const q = s.charCodeAt(k); if (q === 92) k++; else if (q === c) break; } return k; };
function skip(s, i, lim = 200000) {
  const end = Math.min(s.length, i + lim);
  for (let k = i, d = 0; k < end; k++) {
    const c = s.charCodeAt(k);
    if (c === 34 || c === 39 || c === 96) k = str(s, k, end);
    else if (c === 40 || c === 91 || c === 123) d++;
    else if ((c === 41 || c === 93 || c === 125) && --d === 0) return k + 1;
  }
  return -1;
}
function split(s) {
  const out = []; let d = 0, st = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 34 || c === 39 || c === 96) k = str(s, k, s.length);
    else if (c === 40 || c === 91 || c === 123) d++;
    else if (c === 41 || c === 93 || c === 125) d--;
    else if (c === 44 && !d) { out.push(s.slice(st, k)); st = k + 1; }
  }
  if (st < s.length) out.push(s.slice(st));
  return out;
}
const inner = (s, i, lim) => { const e = skip(s, i, lim); return e < 0 ? null : s.slice(i + 1, e - 1); };
const backTo = (s, k, lo, open, close) => { for (let d = 0; k >= lo; k--) if (s[k] === close) d++; else if (s[k] === open && --d === 0) break; return k; };
const paramsOf = (s) => {
  const m = /^(?:async)?\(([^()]*)\)=>|^(?:async )?([\w$]+)=>|^function(?: [\w$]+)?\(([^()]*)\)/.exec(s);
  return m && (m[2] ?? m[1] ?? m[3]).split(',').map((x) => x.replace(/=.*$/, '').trim());
};

function ref(md, a) {
  if (!a) return null;
  if (a[0] === '"') { const v = a.slice(1, -1); return v.includes('\\') ? null : '=' + v; }
  if (/^[\w$]+$/.test(a)) { const v = md.consts.get(a); return v ? '=' + v : null; }
  const m = /^([\w$]+)\.([\w$]+)$/.exec(a); if (!m) return null;
  const ev = md.enums.get(a), im = md.imports.get(m[1]);
  return ev != null ? '=' + ev : im ? '@' + im + '.' + m[2] : null;
}

function parseModules(js) {
  const mods = [];
  const mk = (id, start, h) => ({ id, start, req: h?.[3] || h?.[2] || h?.[1], exp: h?.[2], imports: new Map(), consts: new Map(), enums: new Map(), enumObjs: new Map() });
  for (const m of js.matchAll(RE_MOD)) {
    let id, k = m.index;
    if (js[k - 1] === '"') { const q = js.lastIndexOf('"', k - 2); if (q < 0 || k - q > 14) continue; id = js.slice(q + 1, k - 1); k = q; }
    else { id = identBefore(js, k); if (!id) continue; k -= id.length; }
    if (js[k - 1] === '{' || js[k - 1] === ',') mods.push(mk(id, k, m));
  }
  if (!mods.length) mods.push(mk('?', 0, /^\(?function\(([\w$]*)(?:,([\w$]+))?(?:,([\w$]+))?\)\{/.exec(js)));
  mods.forEach((m, k) => { m.end = mods[k + 1]?.start ?? js.length; });
  return mods;
}

function declsOf(md, body) {
  if (md.decls) return md.decls;
  const d = md.decls = new Map();
  for (const m of body.matchAll(/=[{[(a-z"]/g)) {
    if (!isId(body.charCodeAt(m.index - 1))) continue;
    const name = identBefore(body, m.index), pc = body[m.index - name.length - 1];
    if (!d.has(name) && '{,; ('.includes(pc)) d.set(name, m.index + 1);
  }
  for (const m of body.matchAll(/function ([\w$]+)\(/g)) if (!d.has(m[1])) d.set(m[1], m.index);
  return d;
}

function groupsAround(body, start, end) {
  const b = body.slice(Math.max(0, start - 60), start), a = body.slice(end, end + 400), o = a.indexOf('{');
  const gs = [], q = (re, s) => { const m = re.exec(s); if (m) gs.push(m[1]); };
  q(/"([^"\\]{1,41})"[!=]==?(?:\(0,[\w$]+\.[\w$]+\)\([\w$]+=>)?$/, b); q(/^(?:\?\.group)?\)*[!=]==?"([^"\\]{1,41})"/, a); q(/^\)*\?\?"([^"\\]{1,41})"/, a);
  if (o >= 0 && /switch\($/.test(b)) for (const c of (inner(body, end + o, 20000) || '').matchAll(/case"([^"\\]{1,41})":/g)) gs.push(c[1]);
  const v = /(?:^|[^\w$.])([\w$]+)=$/.exec(b)?.[1];
  if (v) for (const c of a.matchAll(new RegExp(`(?:[^\\w$.]${esc(v)}[!=]==?"([^"\\\\]{1,41})"|"([^"\\\\]{1,41})"[!=]==?${esc(v)}(?![\\w$]))`, 'g'))) gs.push(c[1] || c[2]);
  return gs.filter((g) => RE_GROUPVAL.test(g));
}

function findBinder(body, i, ident) {
  const lo = Math.max(0, i - 600), w = body.slice(lo, i), toks = ['=>', 'function', 'for(let'];
  const back = (s, from) => { const r = w.lastIndexOf(s, from - lo); return r < 0 ? -1 : r + lo; };
  let re;
  const has = (ps) => ps.findIndex((x) => x === ident || (x[0] === '{' && (re ||= new RegExp(`[:{,]${esc(ident)}(?:[,}=]|$)`)).test(x)) || x.startsWith(ident + '='));
  const at = toks.map((t) => back(t, i));
  for (;;) {
    const p = Math.max(at[0], at[1], at[2]); if (p < lo) return null;
    const j = at.indexOf(p); at[j] = p > lo ? back(toks[j], p - 1) : -1;
    if (!j) {
      let ps, s0;
      if (body[p - 1] === ')') { const k = backTo(body, p - 1, lo, '(', ')'); if (k < lo) continue; ps = split(body.slice(k + 1, p - 1)); s0 = k; }
      else { const id = identBefore(body, p); if (!id) continue; ps = [id]; s0 = p - id.length; }
      const np = has(ps); if (np < 0) continue;
      const pre = body.slice(Math.max(0, s0 - 60), s0).replace(/async ?$/, '');
      const m = /([\w$]+)\.(?:forEach|map|flatMap|some|every|filter|find|findIndex|reduce)\($/.exec(pre); if (m) return { arr: m[1] };
      const f = /(?:^|[^\w$.])([\w$]+)[=:]$/.exec(pre);
      return f ? { name: f[1], ps, np } : {};
    }
    if (j === 1) {
      const m = /^function ?([\w$]*)\(([^()]*)\)/.exec(body.slice(p, p + 300)); if (!m) continue;
      const ps = split(m[2]), np = has(ps); if (np < 0) continue;
      return m[1] ? { name: m[1], ps, np } : {};
    }
    const m = /^for\(let ?([\w$]+|\{[^{}]*\}) ?of ([\w$]+)\)/.exec(body.slice(p, p + 300)); if (!m) continue;
    if (m[1] === ident) return { arr: m[2] };
    const pm = m[1][0] === '{' && new RegExp(`([\\w$]+):${esc(ident)}(?![\\w$])`).exec(m[1]); if (pm) return { arr: m[2], prop: pm[1] };
  }
}

const analyze = memo((js) => {
  const tags = new Set(), exportsOf = new Map(), done = new Set(), mods = parseModules(js), hint = js.includes('?.[');
  const tag = (...a) => tags.add('\0' + a.join('\x01'));
  const modAt = (i) => { let lo = 0, hi = mods.length - 1, r = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (mods[m].start <= i) { r = m; lo = m + 1; } else hi = m - 1; } return mods[r]; };
  const scan = (re, f) => { for (const m of js.matchAll(re)) { const n = identBefore(js, m.index); if (n) f(m, n); } };
  const calls = (md, body, names, keyOf) => { for (const c of body.matchAll(new RegExp(`[^\\w$.](${names.map(esc).join('|')})\\(`, 'g'))) emitCall(md, body, c.index + c[0].length - 1, keyOf(c[1]), c.index + 1); };
  const expOf = (md, name) => {
    if (!md.revExp) {
      const r = md.revExp = new Map();
      for (const [e, { val, local }] of exportsOf.get(md) || []) if (local) r.set(local, e); else if (val.includes('=>') && !r.has(e)) r.set(e, e);
    }
    return md.revExp.get(name);
  };

  scan(RE_IMP, (m, n, md = modAt(m.index)) => md.req === m[1] && md.imports.set(n, m[2]));
  scan(RE_SCONST, (m, n) => {
    const k = m.index - n.length, pc = js[k - 1];
    if (pc !== ',' && !(pc === ' ' && /(?:let|const|var) $/.test(js.slice(k - 6, k)))) return;
    const md = modAt(m.index), p = md.consts.get(n); md.consts.set(n, p === undefined || p === m[1] ? m[1] : null);
  });
  scan(RE_ENUM, (m, n, md = modAt(m.index)) => {
    const pairs = [...m[1].matchAll(RE_ENUMPAIR)].map((p) => [p[1], p[2]]);
    for (const [k, v] of pairs) md.enums.set(n + '.' + k, v);
    md.enumObjs.set(n, pairs);
  });
  if (js.includes('.meta={name:"')) scan(/\.meta=\{name:"([\w$]+)"/g, (m, n, md = modAt(m.index)) => (md.metas ||= new Map()).set(n, m[1]));

  for (const m of js.matchAll(RE_EXPMAP)) {
    const md = modAt(m.index);
    if (md.req !== identBefore(js, m.index) || (md.exp && md.exp !== m[1])) continue;
    const map = slot(exportsOf, md);
    for (let n = 0, i = m.index + m[0].length - 1; n < 2 && js[i] === '{'; n++) {
      const e = skip(js, i); if (e < 0) break;
      for (const ent of split(js.slice(i + 1, e - 1))) {
        const k = ent.indexOf(':'); if (k < 0) continue;
        const val = ent.slice(k + 1);
        map.set(ent.slice(0, k).replace(/"/g, ''), { val, local: /^(?:\(\)=>)?([\w$]+)$/.exec(val)?.[1] });
      }
      i = js[e] === ',' ? e + 1 : e;
    }
  }

  for (const [md, map] of exportsOf) {
    const body = js.slice(md.start, md.end), hinted = hint && body.includes('?.[') && RE_HINT.test(body), cfg = body.includes(':{}');
    for (const [exp, { val, local }] of map) {
      const key = md.id + '.' + exp, sv = val[0] === '"' ? val.slice(1, -1) : local && md.consts.get(local);
      if (sv && RE_NAMEVAL.test(sv)) tag('S', key, sv);
      for (const [k, v] of md.enumObjs.get(local) || []) tag('S', key + '.' + k, v);
      const role = hinted || (local && (RE_ROLENAME.test(local) || md.metas?.has(local)));
      if (!role && !(local && cfg)) continue;
      const di = local && declsOf(md, body).get(local);
      if (cfg && body[di] === '{') emitObject(md, body, di, key);
      const def = local ? di !== undefined && body.slice(di, di + 600) : val;
      if (!role || !def) continue;
      const src = { name: local, meta: md.metas?.get(local) };
      for (const [r, kind, re, p] of SPECS) {
        const m = kind === 'body' && re.exec(def), pos = m ? paramsOf(def)?.indexOf(m[1]) ?? -1 : src[kind] && re.test(src[kind]) ? p : -1;
        if (pos === -1) continue;
        tag('D', r, key, pos);
        if (local) calls(md, body, [local], () => key);
      }
    }
  }

  function emitCall(md, body, i, key, start) {
    RE_SIMPLEARGS.lastIndex = i;
    const sm = RE_SIMPLEARGS.exec(body);
    let end, args;
    if (sm) { end = i + sm[0].length; args = []; for (let k = 1; sm[k] != null; k++) args.push(sm[k]); }
    else if (!body.slice(i, i + 200).includes('"') || (end = skip(body, i, 4000)) < 0) return;
    else args = split(body.slice(i + 1, end - 1));
    for (let pos = 0; pos < 2 && pos < args.length; pos++) {
      const a = args[pos];
      if ((pos ? args.length <= 3 && !args[0].includes('"') : args.length === 1) && /^[\w$]+$/.test(a) && wrap(md, body, i, end, key, pos, a, start)) continue;
      const r = ref(md, a);
      if (!isName(r)) continue;
      const gs = groupsAround(body, start, end), g = ref(md, args[pos + 1]);
      if (g?.[0] === '=' && RE_GROUPVAL.test(g.slice(1))) gs.push('?' + g.slice(1));
      tag('C', key, pos, r, gs.join(','));
    }
    const pm = args[0]?.[0] === '{' && args[0].includes('pref:') && /[{,]pref:("[^"\\]*"|[\w$]+(?:\.[\w$]+)?)[,}]/.exec(args[0]), pr = pm && ref(md, pm[1]);
    if (isName(pr)) tag('C', key, 'p', pr, '');
    const oi = args.length === 1 && /^[\w$]{2,}$/.test(args[0]) && declsOf(md, body).get(args[0]);
    if (body[oi] === '{' && /^\{(?:\[[\w$.]+\]|[\w$]+|"[^"]+"):\{/.test(body.slice(oi, oi + 120))) { const ok = md.id + '#' + args[0]; tag('R', key, ok); emitObject(md, body, oi, ok); }
  }
  function wrap(md, body, i, end, key, pos, ident, start) {
    const b = findBinder(body, i, ident); if (!b) return false;
    if (b.arr) emitArray(md, body, b, key, pos);
    else if (b.name) {
      const { name, ps, np } = b, id = md.id + '#' + name, ex = expOf(md, name), w = ex ? md.id + '.' + ex : id;
      const m = /^\)*[!=]==?([\w$]+)/.exec(body.slice(end, end + 60)) || /(?:^|[^\w$.])([\w$]+)[!=]==?$/.exec(body.slice(Math.max(0, start - 40), start));
      tag('W', w, key, pos, np, m ? ps.indexOf(m[1]) : -1);
      if (!done.has(id)) { done.add(id); (md.pending ||= new Map()).set(name, w); }
    }
    return true;
  }
  function emitArray(md, body, { arr, prop }, key, pos) {
    const s = declsOf(md, body).get(arr), a = body[s] === '[' && inner(body, s);
    if (!a) return;
    if (prop) for (const m of a.matchAll(new RegExp(`${prop}:("[^"\\\\]*"|[\\w$.]+)(?:,enabledGroup:"([^"\\\\]*)")?`, 'g'))) { const r = ref(md, m[1]); if (r) tag('C', key, pos, r, m[2] && RE_GROUPVAL.test(m[2]) ? m[2] : ''); }
    else for (const el of split(a)) { const r = ref(md, el.trim()); if (isName(r)) tag('C', key, pos, r, ''); }
  }
  function emitObject(md, body, i, okey) {
    const ents = split(inner(body, i) || '');
    if (!ents.length || ents.length > 2000) return;
    const parsed = [];
    for (const ent of ents) {
      if (ent.startsWith('...')) { const r = ref(md, ent.slice(3)); if (r?.[0] === '@') parsed.push(['*' + r.slice(1), '']); continue; }
      const k = ent.indexOf(':'), kk = ent.slice(0, k), v = ent.slice(k + 1);
      if (k < 0 || v[0] !== '{') return;
      const r = kk[0] === '[' ? ref(md, kk.slice(1, -1)) : '=' + kk.replace(/"/g, ''), tg = /treatmentGroups:\[([^\]]*)\]/.exec(v);
      if (r) parsed.push([r, tg ? [...tg[1].matchAll(/"([^"\\]+)"/g)].map((x) => x[1]).join(',') : '']);
    }
    for (const [r, g] of parsed) tag('O', okey, r, g);
  }

  for (const md of mods) {
    if (!md.imports.size && !md.pending) continue;
    const body = js.slice(md.start, md.end);
    for (const c of body.matchAll(RE_CALL)) { const im = md.imports.get(c[1]); if (im) emitCall(md, body, c.index + c[0].length - 1, im + '.' + c[2], c.index); }
    for (let n = 0; md.pending?.size && n < 6; n++) { const p = md.pending; md.pending = null; calls(md, body, [...p.keys()], (x) => p.get(x)); }
  }
  if (js.includes('fullName_:"proto.')) for (const m of js.matchAll(RE_PROTO)) {
    const short = m[1].split('.').pop();
    for (const f of (inner(js, m.index, 400000) || '').matchAll(/[{,](\d+):\{name_:"([a-z0-9_]+)"/g)) if (f[1] !== '0') tag('N', 'quip', `${short}: ${f[2]}`);
  }
  const FA = ',{storeKey:"featureAccess"';
  for (let k = js.indexOf(FA); k >= 0; k = js.indexOf(FA, k + 1)) {
    if (js[k - 1] !== '}') continue;
    const o = backTo(js, k - 1, Math.max(1, k - 199999), '{', '}');
    for (const ent of split(js.slice(o + 1, k - 1))) { const m = /^"?([a-z0-9_]+)"?:\{/.exec(ent); if (m) tag('N', 'featureAccess', m[1]); }
  }
  if (js.includes('gantryPaths:')) for (const m of js.matchAll(/experiments:\{((?:(?:standalone|enterprise):"[a-z0-9_]+",?)+)\}/g)) for (const v of m[1].matchAll(/:"([a-z0-9_]+)"/g)) tag('N', 'exp', v[1], 'on');
  return [...tags];
});

let lastReg = null;
const addRole = (D, k, r) => { const s = slot(D, k, Set); return !s.has(r) && s.add(r); };
function resolveAll(values) {
  const D = new Map(), S = new Map(), O = new Map(), L = { C: [], R: [], W: [], N: [] }, out = new Map();
  for (const v of values) {
    if (v.charCodeAt(0) !== 0) continue;
    const p = v.slice(1).split('\x01');
    if (p[0] === 'D') addRole(D, p[2] + '|' + p[3], p[1]);
    else if (p[0] === 'S') S.set(p[1], p[2]);
    else if (p[0] === 'O') slot(O, p[1], Array).push([p[2], p[3]]);
    else L[p[0]]?.push(p);
  }
  const defs = D.size > 0;
  if (!defs && lastReg) for (const [k, v] of lastReg) D.set(k, new Set(v));
  for (let changed = true, n = 0; changed && n < 5; n++) {
    changed = false;
    for (const [, key, target, pos, np] of L.W) for (const r of D.get(target + '|' + pos) || []) if (addRole(D, key + '|' + np, r)) changed = true;
  }
  if (defs) lastReg = D;
  const deref = (r) => r[0] === '=' ? r.slice(1) : r[0] === '@' ? S.get(r.slice(1)) : null;
  const put = (role, name, gs) => { if (!name || !RE_NAMEVAL.test(name)) return; const s = slot(slot(out, role), name, Set); for (const g of gs) if (g) s.add(g); };
  const objKeys = (ok, depth = 0) => (O.get(ok) || []).flatMap(([r, g]) => r[0] !== '*' ? [[deref(r), g]] : depth < 4 ? objKeys(r.slice(1), depth + 1) : []);
  for (const [, key, pos, r, gs] of L.C) for (const role of D.get(key + '|' + pos) || []) put(role, deref(r), gs.split(','));
  for (const [, role, name, g] of L.N) if (role === 'quip') slot(out, 'quip').set(name, new Set()); else put(role, name, [g]);
  for (const [, key, ok] of L.R) if (D.get(key + '|0')?.has('sessionRegister')) for (const [name, g] of objKeys(ok)) put('session', name, g.split(','));
  return out;
}

const fmt = (m, groups = true) => [...(m || [])].map(([n, gs]) => {
  const g = [...new Set([...gs].map((x) => x.replace(/^\?/, '')))].sort();
  return groups && g.length ? `${n}: ${g.join(', ')}` : n;
}).sort();

const run = (js, add) => { for (const t of analyze(js)) add(t); };
const resolved = memo(resolveAll);
const list = (k, groups) => (v) => fmt(resolved(v).get(k), groups);

module.exports = [
  ['experiments', 'experiments.txt', list('exp')],
  ['featureFlags', 'feature-flags.txt', list('quip', false)],
  ['sessionToggles', 'session-toggles.txt', list('session')],
  ['featureAccess', 'feature-access.txt', list('featureAccess', false)],
  ['prefs', 'prefs.txt', (v) => ['user', 'team', 'org', 'onboarding'].flatMap((k) => fmt(resolved(v).get(k), false).map((n) => `${k}: ${n}`)).sort()],
].map(([key, file, post]) => ({ key, file, run, post }));
module.exports.analyze = analyze;
module.exports.resolveAll = resolveAll;
