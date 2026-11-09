'use strict';

const unesc = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const strings = (s) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unesc(m[1]));
function* hits(js, s) { for (let i = js.indexOf(s); i >= 0; i = js.indexOf(s, i + s.length)) yield i; }
const grab = (js, add, re, f = (m) => m[1]) => { for (const m of js.matchAll(re)) { const s = f(m); if (s !== false) add(s); } };
const dedupe = (v, sep, i = 0) => { const s = new Set(v.filter((x) => x.includes(sep)).map((x) => x.split(sep)[i])); return v.filter((x) => x.includes(sep) || !s.has(x)); };
const RE_PAIR = /(?:^|,)(?:([A-Za-z_$][\w$]*)|"([^"]+)"):"((?:[^"\\]|\\.)*)"/g;
const enums = (js, add, ...specs) => {
  for (const [a, f] of specs) {
    let p;
    for (const i of hits(js, a[0])) {
      const s = js.lastIndexOf('{', i), e = js.indexOf('}', i), t = s !== p && s >= 0 && e >= 0 && e - s <= 2e5 && js.slice(s + 1, e);
      p = s;
      if (t && a.every((x) => t.includes(x))) grab(t, add, RE_PAIR, (m) => f(m[1] ?? m[2], unesc(m[3])));
    }
  }
};
const same = (t, ...n) => [n.map((x) => `${x}:"${x}"`), (k, v) => k === v && `${t}: ${v}`];
const val = (t) => (k, v) => (t ? `${t}: ${v}` : v);
const balanced = (js, open, max = 4000) => {
  for (let i = open, e = Math.min(js.length, open + max), d = 0, q = false; i < e; i++) {
    const c = js[i];
    if (q) c === '\\' ? i++ : (q = c !== '"');
    else if (c === '"') q = true;
    else if (c === '{') d++;
    else if (c === '}' && !--d) return js.slice(open, i + 1);
  }
  return '';
};
const opener = (js, idx) => {
  for (let i = idx, e = Math.max(0, idx - 3000), d = 0; i >= e; i--) if (js[i] === '}') d++; else if (js[i] === '{' && !d--) return i;
  return -1;
};

const LOCALE = /(?<![A-Za-z])(?:[a-z]{2}-(?:[A-Z]{2}|LA|419)|zh-Hans|zh-Hant)(?![A-Za-z])/g;
const ID_LIKE = /(?<![A-Z0-9])[UWTBE][A-Z0-9]{8,}(?![A-Z0-9])/, SOUND = /\.(?:mp3|ogg|wav|m4a|aac|opus)$/, LOTTIE = /^lottie.*\.json$/;
const loc = (s) => s.replace(LOCALE, '{locale}');
const norm = (f) => loc(f.replace(/(?:-[0-9a-f]{7}|\.[0-9a-f]{8}|\.[0-9a-f]{16})(?=(?:\.bin)?\.[a-z0-9]+$)/, ''));
let last, memo;
const once = (js, k, fn) => { if (js !== last) [last, memo] = [js, {}]; return (memo[k] ??= fn()); };
const files = (js) => once(js, 'files', () => (js.includes('.p+"') ? [...js.matchAll(/\.p\+"([^"?#]{3,240})"/g)].map((m) => m[1]) : []));
const chunks = (js) => once(js, 'chunks', () => [...hits(js, '.e("')].flatMap((i) => {
  if (!/[\w$]/.test(js[i - 1]) || /[\w$]/.test(js[i - 2])) return [];
  const e = js.indexOf('")', i + 4), n = e >= 0 && e - i <= 210 && js.slice(i + 4, e);
  return n && /^[\w@.+-]{2,200}$/.test(n) && /[.\],)]/.test(js[e + 2]) ? [n] : [];
}));
const media = (js, add, ok) => { for (const f of files(js)) if (ok(f)) add(norm(f)); };

const CLOG_KEYS = Object.fromEntries(Object.entries({
  element: 'elementName element_name ui_element_name uiElement ui_element', step: 'uiStep ui_step', step_variant: 'stepVariant step_variant',
  component: 'uiComponentName ui_component_name ui_component', component_variant: 'uiComponentVariant ui_component_variant', page: 'uiPage ui_page', entry_point: 'entryPoint entry_point',
}).flatMap(([v, ks]) => ks.split(' ').map((k) => [k, v])));
const V = '([A-Za-z][\\w.:-]{1,100})';
const RE_CLOG = new RegExp(`(?<=[{,("])(${Object.keys(CLOG_KEYS).join('|')})"?:(?:"${V}"|[\\w$.!]{1,40}\\?"${V}":"${V}")`, 'g');
const CLOG_SELF = new Set(Object.keys(CLOG_KEYS).flatMap((k) => [k, k.toLowerCase()]));
const CLOG_ENUM_SIG = [
  ['action', ['IMPRESSION', 'CLICK', 'SWIPE_LEFT']],
  ['action_status', ['EMPTY_RESULTS', 'REQUIRES_ACTION']],
  ['element_type', ['BUTTON', 'TILE', 'BANNER', 'PURE_COMPONENT']],
];
const RE_TSENUM = /\(\(([\w$])=\{\}\)\[\1\.[A-Za-z_$][\w$]*=-?\d+\]="[^"]*"(?:,\1\[\1\.[A-Za-z_$][\w$]*=-?\d+\]="[^"]*")*,\1\)/g;
const RE_TRACING = /(?:(?:startSpan|createChildSpan|createSpan|createAndReportSpan|createAndCloseSpan|createRootSpan|startTraceSpan|createBasicTraceSpan|traceFn|reportMetricSpan|_startSpan)\((?:\{name:)?|(traceName:|createMetricsTrace\(\{label:)|(\.store\(\{name:)|(\.measureAndClear\("[^"]{1,100}",))"([^"\\]{2,100})"/g;
const RE_KBHELP = /\{title:[\w$]+\.t\("((?:[^"\\]|\\.){1,80})"\),keys:\[("[^\]]{1,200})\]([^{}]{0,400})\}/g;
const RE_ACCEL = /[{,]id:"([^"]{2,80})"[^{}]{0,200}?,accelerator:"([^"]{2,40})"|accelerator:"([^"]{2,40})"/g;

const DBG = new Set('exportToGlobalDebugger exportToGlobalDebuggerWithGetter exportToTeamDebugger exportToEveryTeamDebugger exposeSelectorForDebug'.split(' '));
const RE_IMPCALL = /\(0,([\w$]+)\.([\w$]{1,3})\)\((?:[\w$.]{1,30},)?"([A-Za-z][\w.]{1,80})"/g;
const modules = (js) => [...hits(js, ':(function(')].flatMap((i) => {
  const id = js.slice(Math.max(0, i - 16), i).match(/[{,]"?([\w$+/=-]{1,12})"?$/), ps = id && js.slice(i + 1, i + 40).match(/^\(function\(\w+(?:,\w+(?:,(\w+))?)?\)\{/);
  return ps ? [[i, id[1], ps[1] || 'n']] : [];
});
const owner = (mods, i) => { let lo = 0, hi = mods.length; while (lo < hi) { const m = (lo + hi) >> 1; if (mods[m][0] <= i) lo = m + 1; else hi = m; } return mods[lo - 1]; };

const AI_KW = /(?:^|_)(?:ai|agents?|agentic|agentforce|mcp|slackbot|slackbotai|llm|genai|einstein|copilot|chatgpt|openai|anthropic|claude|gemini|gpt|skills?|prompts?|assistant|recap|recaps)(?:_|$)/;
const MCP_NS = /^(?:tools|resources|prompts|notifications|tasks|sampling|elicitation|completion|roots|logging|ui\/notifications)\/[a-zA-Z_/-]+$|^ui\/(?:initialize|message|open-link|resource-teardown|request-display-mode|update-model-context|size-changed)$/;

module.exports = Object.entries({
  analyticsEvents: (js, add) => {
    for (const m of js.matchAll(RE_CLOG)) for (const v of m[2] ? [m[2]] : [m[3], m[4]]) if (!CLOG_SELF.has(v.toLowerCase())) add(`${CLOG_KEYS[m[1]]}: ${v}`);
    for (const i of hits(js, 'contexts:{')) grab(balanced(js, i + 9, 3000), add, /[{,](action|step|trigger):"([a-z][\w.:-]{1,100})"/g, (m) => !CLOG_SELF.has(m[2]) && `${m[1]}: ${m[2]}`);
  },
  analyticsEventIds: [(js, add) => grab(js, add, /(?:\beventId:|\.track\()(\d{2,8})\b/g, (m) => {
    const e = m.index + m[0].length, o = m[0][0] !== '.' ? opener(js, m.index) : js.indexOf('{', e) === e + 1 ? e + 1 : -1, s = o >= 0 && balanced(js, o).match(/\bui_?[sS]tep"?:"([A-Za-z][\w.:-]{1,100})"/);
    return s ? `${m[1]}: ${s[1]}` : m[1];
  }), (v) => dedupe(v, ':')],
  analyticsEnums: (js, add) => {
    if (js.includes('IMPRESSION')) for (const m of js.matchAll(RE_TSENUM)) {
      const p = [...m[0].matchAll(/\.([A-Za-z_$][\w$]*)=(-?\d+)\]/g)], n = new Set(p.map((x) => x[1])), s = CLOG_ENUM_SIG.find(([, need]) => need.every((x) => n.has(x)));
      if (s) for (const [, k, v] of p) add(`${s[0]}: ${k}=${+v}`);
    }
  },
  traceSpans: (js, add) => grab(js, add, RE_TRACING, (m) => `${m[1] ? 'trace' : m[2] ? 'metric' : m[3] ? 'measure' : 'span'}: ${m[4]}`),
  keyboardShortcuts: (js, add) => js.includes('keys:["key_') && grab(js, add, RE_KBHELP, (m) => {
    let keys = '', p = false;
    for (const k of strings(m[2])) { const q = k.startsWith('key_'); keys += (keys && q && p ? '+' : keys ? ' ' : '') + (q ? k.slice(4) : k.trim()); p = q; }
    const id = m[3].match(/(?:^|,)id:"([^"]+)"/);
    return `${squash(unesc(m[1]))}${id ? ` [${id[1]}]` : ''}: ${keys}`;
  }),
  keyBindings: [(js, add) => {
    if (!js.includes('keys:["')) return;
    grab(js, add, /keys:\[("[^\]]{1,200})\]/g, (m) => {
      const i = m.index, k = strings(m[1]), id = js.slice(Math.max(0, i - 90), i).match(/[{,]id:"([^"]{2,80})",$/)?.[1], s = k.join(' | ');
      return ',{'.includes(js[i - 1]) && !k.some((x) => x.startsWith('key_')) && (id || js.startsWith(',handler', i + m[0].length)) && (id ? `${id}: ${s}` : s);
    });
    grab(js, add, RE_ACCEL, (m) => (m[1] ? `${m[1]}: ${m[2]}` : m[3]));
  }, (v) => dedupe(v, ': ', 1)],
  devCommands: (js, add) => js.includes('needsReload') && grab(js, add, /\{name:"([a-z][\w-]{1,60})",description:"((?:[^"\\]|\\.){4,400})",type:"\w+"/g, (m) => `${m[1]}: ${squash(unesc(m[2]))}`),
  slackDebug: [(js, add) => {
    let mods;
    const at = (i) => owner((mods ??= modules(js)), i);
    if (js.includes('function exportToGlobalDebugger')) for (const m of js.matchAll(/\.d\([\w$]+,\{\},\{([^{}]*exportToGlobalDebugger[^{}]*)\}\)/g)) {
      const d = at(m.index);
      if (d) grab(m[1], add, /([\w$]+):([\w$]+)/g, (p) => DBG.has(p[2]) && `\0D${d[1]}.${p[1]}`);
    }
    for (const m of js.matchAll(RE_IMPCALL)) {
      const d = at(m.index), imp = d && js.slice(d[0], Math.min(m.index, d[0] + 6000)).match(new RegExp(`[\\s,;{]${m[1].replace(/\$/g, '\\$')}=${d[2]}\\("([^"]+)"\\)`));
      if (imp) add(`\0C${imp[1]}.${m[2]}\0${m[3]}`);
    }
  }, (v) => {
    const d = new Set(v.filter((x) => x.startsWith('\0D')).map((x) => x.slice(2)));
    return [...new Set(v.filter((x) => x.startsWith('\0C')).map((x) => x.slice(2).split('\0')).filter(([r]) => d.has(r)).map(([, n]) => n))].sort();
  }],
  blockKitTypes: (js, add) => js.includes('rich_text"') && enums(js, add,
    same('block', 'divider', 'actions', 'section'),
    same('element', 'static_select', 'plain_text_input'),
    [['PREFORMATTED:"rich_text_preformatted"'], val('rich_text')],
    same('view', 'modal', 'home', 'workflow_step'),
    same('dispatch_action_trigger', 'on_enter_pressed')),
  workflowFunctions: (js, add) => {
    for (const i of hits(js, ':"Fn')) {
      const k = js.slice(Math.max(0, i - 61), i).match(/(?<![\w$])([a-z][a-z0-9_]{2,60})$/)?.[1], v = js.slice(i + 2, i + 12).match(/^(Fn[0-9A-Z]{4,8})"/);
      if (k && v && k !== 'function_id') add(`${k}: ${v[1]}`);
    }
  },
  workflowEvents: (js, add) => enums(js, add, [['APP_MENTIONED:"app_mentioned"'], val()]),
  workflowTriggerTypes: (js, add) => enums(js, add, [['WEBHOOK:"webhook"', 'SCHEDULED:"scheduled"', 'SHORTCUT:"shortcut"'], val()]),
  workflowTypes: (js, add) => js.includes('slack#/') && grab(js, add, /"(slack#\/(?:types|functions|events|entities)\/[a-z0-9_#/]+)"/g),
  notificationTypes: (js, add) => js.includes('at_user_group') && enums(js, add,
    [['AtUserGroup:"at_user_group"', 'ThreadV2:"thread_v2"'], val()],
    [['thread_v2:"replies"', 'at_user:"mentions"'], (k) => k]),
  aiFeatures: (js, add) => grab(js, add, /["']([a-z][a-z0-9_]{2,80})["']/g, (m) => AI_KW.test(m[1]) && m[1]),
  slackbotEntryPoints: (js, add) => enums(js, add, [['AskSlackbot:"ask-slackbot"', 'SlackbotAiNuxTrigger:'], (k, v) => `${k}: ${v}`]),
  mcpActions: (js, add) => {
    if (!js.includes('tools/') && !js.includes('ui/notifications/')) return;
    grab(js, add, /\bmethod:"([a-z]+\/[a-zA-Z_/-]+)"/g, (m) => `method: ${m[1]}`);
    grab(js, add, /"((?:tools|resources|prompts|notifications|tasks|sampling|elicitation|completion|roots|logging|ui)\/[a-zA-Z_/-]+)"/g, (m) => MCP_NS.test(m[1]) && `method: ${m[1]}`);
    enums(js, add, [['tool_call:"wrench"'], (k) => `app_log_kind: ${k}`]);
  },
  planFeatures: (js, add) => js.includes('availabilityByPlanLevel:') && grab(js, add, /\{key:"([a-z0-9_]+)",category:"([a-z0-9_]+)",name:[\w$]+\.t\("((?:[^"\\]|\\.)*)"\)/g, (m) => {
    const at = js.indexOf('availabilityByPlanLevel:{', m.index), n = js.indexOf(',category:"', m.index + m[0].length);
    const p = at < 0 || (n >= 0 && n < at) ? [] : [...balanced(js, at + 24).matchAll(/([a-z_]+):\{isAvailable:(!0|!1|[\w$.]+)(?:,limitation:(null|\{label:[\w$]+\.t\("((?:[^"\\]|\\.)*)"\)|[^,}]+))?/g)]
      .map((x) => `${x[1]}=${x[2] === '!1' ? 'no' : x[2] !== '!0' ? 'dynamic' : x[4] ? `limited(${unesc(x[4])})` : x[3] && x[3] !== 'null' ? 'limited' : 'yes'}`);
    return `${m[1]} [${m[2]}]: ${unesc(m[3])}${p.length ? ` — ${p.join(' ')}` : ''}`;
  }),
  megaphones: (js, add) => enums(js, add,
    [['IN_PRODUCT_COACHMARK:"in_product_coachmark"', 'SIDEBAR_FOOTER:"sidebar_footer"'], val('space')],
    [['SIDEBAR_BENEFITS_ACTIVE_TRIAL_TAB:"sidebar_benefits_active_trial_tab"'], val('notification')]),
  helpArticles: [(js, add) => {
    if (!js.includes('rticle')) return;
    grab(js, add, /(?:\b(?:articleId|article_id|helpArticleId|ctaArticleId|helpArticle:\{id)\s*:\s*|renderHelpLink\()(0x[0-9a-f]{5,13}|\d{6,15})\b/g, (m) => `${+m[1]}`);
    if (js.includes('help/articles/')) grab(js, add, /help\/articles\/(\d{6,15})(?:-([A-Za-z0-9-]*[A-Za-z0-9]))?/g, (m) => (m[2] ? `${m[1]}: ${m[2]}` : m[1]));
  }, (v) => dedupe(v, ':').sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b))],
  lottieAnimations: (js, add) => {
    if (!js.includes('lottie')) return;
    media(js, add, (f) => LOTTIE.test(f));
    for (const c of chunks(js)) if (LOTTIE.test(c)) add(loc(c));
  },
  sounds: (js, add) => media(js, add, (f) => SOUND.test(f) && !ID_LIKE.test(f)),
  assets: (js, add) => media(js, add, (f) => !LOTTIE.test(f) && !SOUND.test(f) && !ID_LIKE.test(f) && /\.[a-z0-9]{2,8}$/.test(f)),
  chunkNames: (js, add) => {
    const h = js.slice(0, 2000).match(/rspackChunk[\w$]*\|\|=\[\]\)\.push\(\[\[("[^\]]+)\]/);
    for (const c of [...(h ? strings(h[1]) : []), ...chunks(js)]) add(c);
  },
  iconNames: (js, add) => grab(js, add, /\b(?:icon|iconName|iconType|startIcon|endIcon|leadingIcon|trailingIcon)"?:(?:\{name:)?"([a-z][a-z0-9-]{1,40})"/g),
}).map(([key, e]) => { const [run, post] = [e].flat(); return { key, file: `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}.txt`, run, post }; });
