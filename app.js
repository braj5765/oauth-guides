// OAuth app guides v2 - vanilla JS, no build step, no dependencies.
//
// Routes (hash based, so any static host works):
//   #/                    home: search + library
//   #/guide/<slug>        a curated library guide
//   #/generate/<query>    runs /api/generate, shows progress, then redirects to...
//   #/g/<data>            a generated guide encoded in the URL itself (deflate-raw + base64url)
//   #/generated           fallback for browsers without CompressionStream: guide held in memory
//   #/about               About & limits
//
// Security model: guide data is untrusted (it comes from a model, or from a URL anyone can craft).
// 1) cleanGuide() rebuilds every guide into a fixed shape of bounded strings; unknown fields are dropped.
// 2) The DOM is only ever built with createElement/textContent (see h()); there is no innerHTML anywhere.
// 3) Links pass safeUrl(): http(s) only, always rel="noopener noreferrer".

const main = document.getElementById('main');
let library = [];
let libraryState = 'loading';       // loading | ok | error
let libraryPromise = null;
let generated = null;               // in-memory fallback when the URL can't carry the guide
let justGenerated = false;          // so the first view of a fresh guide differs from opening a shared link
let cleanups = [];
let firstRender = true;
let renderSeq = 0;
let routeToken = 0;                 // lets a slow response notice that the user already moved on

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Per-field confidence: a guide has one time.confidence, but its setup text often says "(inferred ...)" while the approval wait is documented.
// Read the wording first so the chip never claims more than the text does.
const fieldConf = (text, base) => /\binferred\b/i.test(text || '') ? 'inferred' : (/^\s*no official figure\b/i.test(text || '') && !/\binferred\b/i.test(text || '') ? 'unverified' : base);
// ---------------------------------------------------------------- DOM helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

// Icons are drawn by hand on a 24px grid. Each entry is a list of shapes: a string is a stroked path,
// {d, fill} a filled path, {c:[x,y,r], dash, fill} a circle.
const ICONS = {
  search: [{ c: [11, 11, 7] }, 'm20 20-3.5-3.5'],
  sun: [{ c: [12, 12, 4] }, 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'],
  moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
  back: ['M15 6l-6 6 6 6'],
  external: ['M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  doc: ['M7 3h7l5 5v13H7z', 'M14 3v5h5M10 13h6M10 17h6'],
  ok: [{ c: [12, 12, 9] }, 'm8 12 3 3 5-6'],
  half: [{ c: [12, 12, 9] }, { d: 'M12 3a9 9 0 0 1 0 18z', fill: true }],
  dashed: [{ c: [12, 12, 9], dash: true }],
  check: ['m5 12 4 4 10-10'],
  agent: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 16v4M17 18h4'],
  user: [{ c: [12, 8, 4] }, 'M4 21a8 8 0 0 1 16 0'],
  either: ['M7 7h12l-3-3M17 17H5l3 3'],
  warn: ['M12 3l10 18H2z', 'M12 10v5M12 18v.01'],
  info: [{ c: [12, 12, 9] }, 'M12 11v5M12 8v.01'],
  x: [{ c: [12, 12, 9] }, 'm9 9 6 6M15 9l-6 6'],
  spin: ['M21 12a9 9 0 1 1-6.2-8.55'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'm9 12 2.5 2.5L16 10'],
  dot: [{ c: [12, 12, 3.5], fill: true }],
  idle: [{ c: [12, 12, 8], dash: true }],
};
const NS = 'http://www.w3.org/2000/svg';
function icon(name, cls) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (cls) svg.setAttribute('class', cls);
  for (const s of ICONS[name] || []) {
    const isStr = typeof s === 'string';
    const el = document.createElementNS(NS, isStr || s.d ? 'path' : 'circle');
    if (isStr) el.setAttribute('d', s);
    else if (s.d) el.setAttribute('d', s.d);
    else { el.setAttribute('cx', s.c[0]); el.setAttribute('cy', s.c[1]); el.setAttribute('r', s.c[2]); if (s.dash) el.setAttribute('stroke-dasharray', '3.2 3.2'); }
    if (!isStr && s.fill) el.setAttribute('fill', 'currentColor');
    svg.append(el);
  }
  return svg;
}

const safeUrl = u => (typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u) ? u : null);
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const shortUrl = u => String(u).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
function link(children, url, attrs) {
  const ok = safeUrl(url);
  return ok ? h('a', { href: ok, target: '_blank', rel: 'noopener noreferrer', ...(attrs || {}) }, children) : h('span', attrs, children);
}

// ---------------------------------------------------------------- guide data: validate + normalise
const LEVELS = ['easy', 'moderate', 'hard'];
const CONF = {
  documented: { label: 'Documented', icon: 'ok', tip: 'Documented: stated in the provider\'s official documentation.' },
  inferred: { label: 'Inferred', icon: 'half', tip: 'Inferred: reasoned from the docs, not stated outright. Check before relying on it.' },
  unverified: { label: 'Unverified', icon: 'dashed', tip: 'Unverified: could not be confirmed from official sources.' },
};
const S = (v, max = 1500) => (typeof v === 'string' ? v.slice(0, max).trim() : typeof v === 'number' ? String(v) : '');
const conf = v => (CONF[v] ? v : '');
const list = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);

// Rebuilds a guide into the exact shape the renderer expects. Returns null if it is not usable.
function cleanGuide(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const app = S(raw.app, 80);
  const steps = list(raw.steps, 40).filter(s => s && typeof s === 'object' && S(s.title, 200)).map((s, i) => ({
    n: Number.isFinite(+s.n) ? +s.n : i + 1,
    title: S(s.title, 200), detail: S(s.detail, 1500),
    who: ['agent', 'you', 'either'].includes(s.who) ? s.who : 'either',
    url: safeUrl(S(s.url, 500)) || '',
  }));
  if (!app || !steps.length) return null;
  const txt = (item, key) => (typeof item === 'string' ? S(item) : item && typeof item === 'object' ? S(item[key]) : '');
  const d = raw.difficulty && typeof raw.difficulty === 'object' ? raw.difficulty : {};
  const t = raw.time && typeof raw.time === 'object' ? raw.time : {};
  const a = raw.approval && typeof raw.approval === 'object' ? raw.approval : null;
  const v = raw.agent_vs_you && typeof raw.agent_vs_you === 'object' ? raw.agent_vs_you : {};
  return {
    slug: S(raw.slug, 60), app,
    provider_url: safeUrl(S(raw.provider_url, 500)) || '', developer_docs_url: safeUrl(S(raw.developer_docs_url, 500)) || '',
    summary: S(raw.summary, 1200),
    difficulty: { level: LEVELS.includes(d.level) ? d.level : 'unknown', rationale: S(d.rationale, 1200) },
    time: { setup: S(t.setup, 600), approval_wait: S(t.approval_wait, 600), confidence: conf(t.confidence) },
    approval: a ? { required: a.required === true, what_is_reviewed: S(a.what_is_reviewed, 1500), process: S(a.process, 1800), confidence: conf(a.confidence) } : null,
    steps,
    requirements: list(raw.requirements, 30).map(r => ({ text: txt(r, 'text'), confidence: r && typeof r === 'object' ? conf(r.confidence) : '' })).filter(r => r.text),
    blockers: list(raw.blockers, 30).map(b => ({ issue: txt(b, 'issue'), what_to_do: b && typeof b === 'object' ? S(b.what_to_do) : '', confidence: b && typeof b === 'object' ? conf(b.confidence) : '' })).filter(b => b.issue),
    agent_vs_you: { agent_can: list(v.agent_can, 30).map(x => S(x)).filter(Boolean), you_must: list(v.you_must, 30).map(x => S(x)).filter(Boolean) },
    uncertainties: list(raw.uncertainties, 30).map(x => S(x)).filter(Boolean),
    sources: list(raw.sources, 40).filter(s => s && typeof s === 'object').map(s => ({ title: S(s.title, 200), url: safeUrl(S(s.url, 600)) || '', used_for: S(s.used_for, 300), official: s.official !== false })).filter(s => s.title || s.url),
    tested: raw.tested === true,
    last_checked: S(raw.last_checked, 40),
  };
}

// ---------------------------------------------------------------- share links: guide <-> URL hash
// JSON -> UTF-8 -> deflate-raw -> base64url. The guide lives in the link; no server stores anything.
const canShare = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
const MAX_ENCODED = 120000;   // characters accepted from a URL
const MAX_JSON = 400000;      // bytes allowed after inflating (guards against zip bombs)

async function encodeGuide(g) {
  if (!canShare) return null;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(g));
    const out = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    let bin = '';
    for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
    const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return b64.length <= MAX_ENCODED ? b64 : null;
  } catch { return null; }
}
async function decodeGuide(b64) {
  if (!canShare || !/^[A-Za-z0-9_-]+$/.test(b64) || b64.length > MAX_ENCODED) return null;
  try {
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_JSON) { reader.cancel(); return null; }
      parts.push(value);
    }
    const all = new Uint8Array(total); let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return cleanGuide(JSON.parse(new TextDecoder().decode(all)));
  } catch { return null; }
}

// ---------------------------------------------------------------- small UI pieces
function setMeta(title, desc) {
  document.title = title;
  const set = (sel, val) => { const m = document.querySelector(sel); if (m) m.setAttribute('content', val); };
  set('meta[name="description"]', desc);
  set('meta[property="og:title"]', title);
  set('meta[property="og:description"]', desc);
}
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 1800);
}
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { window.prompt('Copy this:', text); }
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function level(lv, withWord) {
  const l = LEVELS.includes(lv) ? lv : 'unknown';
  return h('span', { class: 'lvl lvl-' + l },
    l === 'unknown' ? null : h('span', { class: 'meter ' + l, 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    h('span', null, cap(l)), withWord ? h('span', { class: 'sr' }, ' difficulty') : null);
}
function chip(c) {
  if (!CONF[c]) return null;
  return h('span', { class: 'chip ' + c, title: CONF[c].tip }, icon(CONF[c].icon), CONF[c].label);
}
function thirdPartyChip() {
  return h('span', { class: 'chip third', title: 'Not an official provider page. Treat it as a hint and confirm in the provider\'s own docs.' }, icon('info'), 'Third-party');
}
// "30-60 minutes to create the app (inferred; ...)" -> "30-60 minutes to create the app". Full text stays in the details.
function brief(s, max = 44) {
  if (!s) return 'Not stated';
  let t = s.split(/;| \(| - | – | — |, per /)[0].trim();
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return t;
}
function formatDate(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const d = new Date(s + 'T00:00:00Z'); if (!isNaN(d)) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
  return s || 'unknown';
}
function stateCard({ kind, ic, title, body, why, actions }) {
  const box = h('section', { class: 'state' + (kind === 'err' ? ' err' : ''), role: kind === 'err' ? 'alert' : null },
    h('div', { class: 'ico' }, icon(ic)),
    h('h2', { tabindex: '-1' }, title),
    body ? h('p', null, body) : null,
    why ? h('p', { class: 'why' }, why) : null,
    h('div', { class: 'acts' }, actions));
  return box;
}
const goHome = () => h('a', { class: 'btn', href: '#/' }, icon('back'), 'Back to library');

function skeleton() {
  return h('div', { class: 'skel', 'aria-hidden': 'true' },
    h('div', { class: 'sk h1' }), h('div', { class: 'sk p' }), h('div', { class: 'sk p s' }),
    h('div', { class: 'sk tiles' }), h('div', { class: 'sk block' }), h('div', { class: 'sk block' }), h('div', { class: 'sk block' }));
}

// ---------------------------------------------------------------- theme
const themeBtn = document.getElementById('theme');
const dark = matchMedia('(prefers-color-scheme: dark)');
function currentTheme() { return document.documentElement.dataset.theme || (dark.matches ? 'dark' : 'light'); }
function paintTheme() {
  const t = currentTheme();
  themeBtn.replaceChildren(icon(t === 'dark' ? 'sun' : 'moon'));
  themeBtn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}
themeBtn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* private mode: the choice just won't persist */ }
  paintTheme();
});
dark.addEventListener('change', paintTheme);
paintTheme();

// ---------------------------------------------------------------- library
function loadLibrary() {
  libraryState = 'loading';
  libraryPromise = fetch('/guides/index.json')
    .then(r => { if (!r.ok) throw new Error(); return r.json(); })
    .then(d => { library = Array.isArray(d) ? d.filter(g => g && typeof g.slug === 'string' && /^[\w-]+$/.test(g.slug) && typeof g.app === 'string').map(g => ({
      slug: g.slug, app: S(g.app, 80), summary: S(g.summary, 600), provider_url: safeUrl(S(g.provider_url, 500)) || '',
      difficulty: LEVELS.includes(g.difficulty) ? g.difficulty : 'unknown', setup: S(g.setup, 80), approval_wait: S(g.approval_wait, 120) })) : []; libraryState = 'ok'; })
    .catch(() => { library = []; libraryState = 'error'; });
  return libraryPromise;
}
const norm = s => (s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').trim();
function findInLibrary(q) {
  q = norm(q);
  if (!q) return null;
  return library.find(g => {
    const host = norm(g.provider_url).split('/')[0];
    const first = g.app.toLowerCase().split(/[\s(]/)[0];
    return q === g.slug || q === g.app.toLowerCase() || q === first || (host && q.split('/')[0] === host);
  });
}

// ---------------------------------------------------------------- home
function renderHome() {
  setMeta('OAuth App Guides', 'Setup steps, approval waits and blockers for provider OAuth apps, with every claim labelled documented, inferred or unverified.');
  const input = h('input', { id: 'q', type: 'text', name: 'q', autocomplete: 'off', spellcheck: 'false', maxlength: '80',
    placeholder: 'App name or website', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'sugg',
    'aria-autocomplete': 'list', 'aria-label': 'App name or website', 'aria-describedby': 'q-note' });
  const note = h('p', { id: 'q-note', class: 'field-note', 'aria-live': 'polite' });
  const box = h('ul', { id: 'sugg', class: 'sugg', role: 'listbox', 'aria-label': 'Suggestions', hidden: true });
  let items = [], active = -1;

  const go = q => {
    q = q.trim();
    if (q.length < 2) { note.textContent = 'Type at least 2 characters: an app name or its website.'; input.focus(); return; }
    if (q.length > 80) { note.textContent = 'That is too long. Use the app name or its main domain.'; return; }
    note.textContent = '';
    const hit = findInLibrary(q);
    location.hash = hit ? '#/guide/' + hit.slug : '#/generate/' + encodeURIComponent(q);
  };
  const close = () => { box.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const mark = () => {
    [...box.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) input.setAttribute('aria-activedescendant', 'opt-' + active); else input.removeAttribute('aria-activedescendant');
  };
  const open = () => {
    const q = norm(input.value);
    const hits = library.filter(g => !q || g.app.toLowerCase().includes(q) || g.slug.includes(q) || norm(g.provider_url).includes(q)).slice(0, 5);
    items = hits.map(g => ({ g }));
    if (q && !hits.some(g => g.app.toLowerCase() === q)) items.push({ gen: input.value.trim() });
    if (!items.length) return close();
    box.replaceChildren(...items.map((it, i) => it.g
      ? h('li', { id: 'opt-' + i, role: 'option', 'aria-selected': 'false' }, h('span', { class: 'nm' }, it.g.app), level(it.g.difficulty, true), h('span', { class: 'sub' }, hostOf(it.g.provider_url) + ' · in the library'))
      : h('li', { id: 'opt-' + i, role: 'option', class: 'gen', 'aria-selected': 'false' }, h('span', { class: 'nm' }, 'Generate a guide for “' + it.gen + '”'), h('span', { class: 'sub' }, 'Not in the library. An agent reads the docs, about 20-60 seconds.'))));
    [...box.children].forEach((li, i) => li.addEventListener('click', () => pick(i)));
    box.hidden = false; input.setAttribute('aria-expanded', 'true'); active = -1; mark();
  };
  const pick = i => { const it = items[i]; close(); if (it.g) location.hash = '#/guide/' + it.g.slug; else go(it.gen); };

  input.addEventListener('input', () => { note.textContent = ''; open(); });
  input.addEventListener('focus', open);
  input.addEventListener('blur', () => setTimeout(close, 120));
  box.addEventListener('mousedown', e => e.preventDefault());
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (box.hidden) open();
      if (!items.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; mark();
    } else if (e.key === 'Escape') close();
    else if (e.key === 'Enter') { e.preventDefault(); if (!box.hidden && active >= 0) pick(active); else go(input.value); }
  });

  const form = h('form', { role: 'search', 'aria-label': 'Find a guide', onsubmit: e => { e.preventDefault(); go(input.value); } },
    h('div', { class: 'field' }, icon('search'), input, h('kbd', { 'aria-hidden': 'true', title: 'Press / to search' }, '/'), h('button', { class: 'btn primary', type: 'submit' }, 'Get guide')));
  const examples = ['Notion', 'Dropbox', 'Salesforce'];
  const tryRow = h('div', { class: 'try' }, h('span', null, 'Try:'),
    examples.map(n => h('button', { type: 'button', onclick: () => { input.value = n; go(n); } }, n)));

  const how = h('ol', { class: 'how', 'aria-label': 'How it works' },
    [['search', 'Search for an app', 'Library apps open instantly. Anything else is researched on the spot.'],
     ['agent', 'An agent reads the official docs', 'It cites the pages it used and flags anything that is not from the provider.'],
     ['shield', 'Get a guide you can audit', 'Every claim is labelled documented, inferred or unverified.']]
      .map(([ic, t, d]) => h('li', null, h('span', { class: 'node' }, icon(ic)), h('div', null, h('h3', null, t), h('p', null, d)))));

  let cards;
  if (libraryState === 'error') {
    cards = stateCard({ kind: 'err', ic: 'warn', title: 'The library could not be loaded', body: 'You can still search for any app above; the guide will be generated.',
      actions: [h('button', { class: 'btn', type: 'button', onclick: () => loadLibrary().then(render) }, 'Try again')] });
  } else {
    cards = h('ul', { class: 'cards' },
      library.map(g => h('li', null, h('a', { class: 'card', href: '#/guide/' + g.slug },
        h('div', { class: 'card-top' }, h('div', null, h('h3', null, g.app), h('div', { class: 'host' }, hostOf(g.provider_url))), level(g.difficulty, true)),
        h('p', { class: 'sum' }, g.summary),
        h('dl', null, h('div', null, h('dt', null, 'Setup time'), h('dd', null, g.setup || 'Not stated')), h('div', null, h('dt', null, 'Approval wait'), h('dd', null, g.approval_wait || 'Not stated')))))),
      h('li', null, h('button', { type: 'button', class: 'card ghost', onclick: () => { window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' }); input.focus(); } },
        h('h3', null, 'Not here?'), h('p', null, 'Search any app above and an agent will build a guide from its official docs.'))));
  }

  const onSlash = e => { if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); } };
  document.addEventListener('keydown', onSlash);
  cleanups.push(() => document.removeEventListener('keydown', onSlash));

  main.replaceChildren(h('div', { class: 'wrap' },
    h('section', { class: 'hero' },
      h('h1', { tabindex: '-1' }, 'Know what it takes to get your OAuth app approved.'),
      h('p', { class: 'lede' }, 'Search any app. Get the setup steps, the approval wait and the likely blockers, with every claim labelled by how well the docs back it.'),
      h('div', { class: 'finder' }, form, box, note, tryRow)),
    how,
    h('div', { class: 'sec-head' }, h('h2', null, 'Guides in the library'), h('span', null, library.length ? library.length + ' apps, checked against official docs' : '')),
    cards));
}

// ---------------------------------------------------------------- generating
const STAGES = [
  { t: 0, name: 'Searching official docs', d: 'Finding the provider\'s developer pages for OAuth and app review.' },
  { t: 6, name: 'Reading pages', d: 'Pulling the setup, scope and approval details from what it found.' },
  { t: 16, name: 'Writing the guide', d: 'Turning it into steps, requirements and blockers.' },
  { t: 40, name: 'Checking sources', d: 'Making sure each claim points at a page it actually read.' },
];
const fmt = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

function renderGenerate(rawQ) {
  let q = '';
  try { q = decodeURIComponent(rawQ); } catch { q = rawQ; }
  q = q.slice(0, 80);
  const token = ++routeToken;
  const ctl = new AbortController();
  cleanups.push(() => ctl.abort());
  setMeta('Generating a guide for ' + q, 'Generating an OAuth app guide from official documentation.');

  const live = h('div', { class: 'sr', role: 'status', 'aria-live': 'polite' });
  const elapsed = h('span', { class: 'mono' }, '0:00');
  const fill = h('div', { class: 'bar-fill' });
  const rows = STAGES.map(s => h('li', { 'data-s': 'todo' }, icon('idle'), h('div', null, h('span', null, s.name), h('span', { class: 'd' }, s.d))));
  const late = h('p', { class: 'field-note', style: 'color:var(--muted)' });
  const cancel = h('a', { class: 'btn', href: '#/' }, 'Cancel');

  main.replaceChildren(h('div', { class: 'wrap' }, h('div', { class: 'gen' },
    h('h1', { tabindex: '-1' }, 'Generating a guide for ', h('span', { class: 'q' }, q)),
    h('div', { class: 'gen-meta' }, h('span', null, 'Elapsed ', elapsed), h('span', null, 'Usually 20-60 seconds'), cancel),
    h('div', { class: 'bar-track', 'aria-hidden': 'true' }, fill),
    h('ol', { class: 'stages', 'aria-label': 'Progress' }, rows),
    h('p', { class: 'meta-note', style: 'margin-top:12px;color:var(--faint);font-size:var(--t-xs)' }, 'Stages are an estimate of the usual order. The server replies once, when the guide is ready.'),
    late, live, skeleton())));
  main.querySelector('h1').focus({ preventScroll: true });

  let stage = -1; const t0 = Date.now();
  const paint = n => {
    rows.forEach((r, i) => {
      const s = i < n ? 'done' : i === n ? 'now' : 'todo';
      if (r.dataset.s !== s) { r.dataset.s = s; r.firstChild.replaceWith(icon(s === 'done' ? 'ok' : s === 'now' ? 'spin' : 'idle', s === 'now' && !reduceMotion() ? 'spin' : '')); }
    });
  };
  const tick = () => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    elapsed.textContent = fmt(sec);
    fill.style.transform = 'scaleX(' + Math.min(sec / 60, 0.95) + ')';
    let n = 0; STAGES.forEach((s, i) => { if (sec >= s.t) n = i; });
    if (n !== stage) { stage = n; paint(n); live.textContent = 'Step ' + (n + 1) + ' of ' + STAGES.length + ': ' + STAGES[n].name + '. Usually 20 to 60 seconds.'; }
    if (sec === 75) { late.textContent = 'Taking longer than usual. It is still working; you can keep waiting or cancel.'; live.textContent = late.textContent; }
  };
  tick();
  const timer = setInterval(tick, 1000);
  cleanups.push(() => clearInterval(timer));

  const fail = (title, body, why) => {
    if (token !== routeToken) return;
    clearInterval(timer);
    main.replaceChildren(h('div', { class: 'wrap' }, stateCard({ kind: 'err', ic: 'x', title, body, why,
      actions: [h('button', { class: 'btn primary', type: 'button', onclick: () => renderGenerate(rawQ) }, 'Try again'), goHome()] })));
    main.querySelector('h2').focus({ preventScroll: true });
  };

  (async () => {
    let res, data = null;
    try {
      res = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }), signal: ctl.signal });
      data = await res.json().catch(() => null);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      return fail('Could not reach the generator', 'Check your connection and try again. Library guides still work offline from this page.', null);
    }
    if (token !== routeToken) return;
    const msg = data && typeof data.error === 'string' ? S(data.error, 300) : '';
    const why = data && typeof data.reason === 'string' ? S(data.reason, 500) : '';
    if (!res.ok) {
      const fallback = [404, 405, 501].includes(res.status) && !msg ? 'The guide generator is not connected on this server' : res.status === 504 ? 'The request timed out' : res.status === 429 ? 'Too many requests' : 'The generator returned an error (' + res.status + ')';
      return fail(msg || fallback, msg ? null : 'Library guides still work. You can try again in a moment.', why || null);
    }
    const g = cleanGuide(data && data.guide);
    if (!g) return fail('The generator returned something that is not a usable guide', 'This is usually a one-off. Try again.', why || null);

    rows.forEach(r => { r.dataset.s = 'done'; r.firstChild.replaceWith(icon('ok')); });
    fill.style.transform = 'scaleX(1)'; clearInterval(timer);
    live.textContent = 'Guide ready.';
    const enc = await encodeGuide(g);
    await new Promise(r => setTimeout(r, reduceMotion() ? 0 : 250));
    if (token !== routeToken) return;
    justGenerated = true; generated = g;
    location.replace('#/' + (enc ? 'g/' + enc : 'generated'));   // replace, so Back skips the progress screen
  })();
}

// ---------------------------------------------------------------- guide page
const WHO = {
  agent: { label: 'Agent can do this', icon: 'agent' },
  you: { label: 'You do this', icon: 'user' },
  either: { label: 'Agent or you', icon: 'either' },
};

function verdict(g) {
  const n = g.steps.length, c = k => g.steps.filter(s => s.who === k).length;
  const parts = [];
  parts.push(h('b', null, g.difficulty.level === 'unknown' ? 'Difficulty not rated.' : cap(g.difficulty.level) + '.'));
  if (g.approval) parts.push(g.approval.confidence === 'unverified' ? ' Whether approval is required is unconfirmed.' : g.approval.required ? ' Provider approval is required.' : ' No provider review is needed to get started.');
  parts.push(' An agent can do ' + c('agent') + ' of ' + n + ' steps alone; ' + c('either') + ' can be shared and ' + c('you') + ' are yours.');
  if (g.blockers.length) parts.push(' ' + g.blockers.length + ' known blocker' + (g.blockers.length === 1 ? '' : 's') + ' below.');
  return h('p', { class: 'verdict' }, parts);
}

function toMarkdown(g, isGenerated) {
  const c = x => (x ? ' _(' + x + ')_' : '');
  const L = ['# ' + g.app + ' OAuth app guide', '', g.summary, ''];
  if (isGenerated) L.push('> Generated by a model from public documentation, not curated. Check the sources before relying on it.', '');
  L.push('- Difficulty: ' + g.difficulty.level + (g.difficulty.rationale ? ' - ' + g.difficulty.rationale : ''));
  L.push('- Setup time: ' + (g.time.setup || 'not stated') + c(fieldConf(g.time.setup, g.time.confidence)));
  L.push('- Approval wait: ' + (g.time.approval_wait || 'not stated') + c(fieldConf(g.time.approval_wait, g.time.confidence)));
  L.push('- ' + (g.tested ? 'Hands-on tested' : 'Docs-based, not hands-on tested') + '. Last checked ' + (g.last_checked || 'unknown'), '');
  if (g.approval) L.push('## Approval' + c(g.approval.confidence), '', (g.approval.required ? 'Required. ' : 'Not required. ') + g.approval.what_is_reviewed, '', g.approval.process, '');
  L.push('## Steps', '');
  g.steps.forEach(s => L.push(s.n + '. **' + s.title + '** [' + WHO[s.who].label + '] ' + s.detail + (s.url ? ' (' + s.url + ')' : '')));
  L.push('', '## Requirements', '', ...g.requirements.map(r => '- ' + r.text + c(r.confidence)));
  L.push('', '## Blockers', '', ...g.blockers.map(b => '- **' + b.issue + '**' + c(b.confidence) + (b.what_to_do ? ': ' + b.what_to_do : '')));
  L.push('', '## Agent can do', '', ...g.agent_vs_you.agent_can.map(x => '- ' + x));
  L.push('', '## You must do', '', ...g.agent_vs_you.you_must.map(x => '- ' + x));
  L.push('', '## Not confirmed', '', ...g.uncertainties.map(x => '- ' + x));
  L.push('', '## Sources', '', ...g.sources.map(s => '- ' + (s.url ? '[' + (s.title || s.url) + '](' + s.url + ')' : s.title) + (s.official ? '' : ' (third-party)') + (s.used_for ? ' - ' + s.used_for : '')));
  return L.join('\n') + '\n';
}

function renderGuide(g, opts) {
  const isGen = !!opts.generated;
  setMeta(g.app + ' OAuth app guide', g.summary.slice(0, 200) || 'Setup steps, approval and blockers for the ' + g.app + ' OAuth app.');
  const A = g.agent_vs_you;
  const sections = [{ id: 'overview', label: 'Overview' }, { id: 'steps', label: 'Steps' }];
  if (A.agent_can.length || A.you_must.length) sections.push({ id: 'agent-vs-you', label: 'Agent vs You' });
  if (g.requirements.length) sections.push({ id: 'requirements', label: 'Requirements' });
  if (g.blockers.length) sections.push({ id: 'blockers', label: 'Blockers' });
  if (g.uncertainties.length) sections.push({ id: 'not-confirmed', label: 'Not confirmed' });
  sections.push({ id: 'sources', label: 'Sources' });

  const sec = (id, title, ...kids) => h('section', { id: 'sec-' + id, 'aria-labelledby': 'h-' + id }, h('h2', { id: 'h-' + id }, title), kids);

  // overview: the 5-second answer, then the reasoning behind it
  const t = g.time, ap = g.approval;
  const facts = h('section', { class: 'glance', 'aria-label': 'At a glance' },
    h('dl', { class: 'facts' },
      h('div', null, h('dt', null, 'Difficulty'), h('dd', null, level(g.difficulty.level))),
      h('div', null, h('dt', null, 'Setup time'), h('dd', null, (opts.short && opts.short.setup) || brief(t.setup, 60), fieldConf(t.setup, t.confidence) ? h('span', { class: 'more' }, chip(fieldConf(t.setup, t.confidence))) : null)),
      h('div', null, h('dt', null, 'Approval wait'), h('dd', null, (opts.short && opts.short.approval_wait) || brief(t.approval_wait, 60), fieldConf(t.approval_wait, t.confidence) ? h('span', { class: 'more' }, chip(fieldConf(t.approval_wait, t.confidence))) : null))),
    verdict(g));
  const approvalTitle = !ap ? null : ap.confidence === 'unverified' ? 'Provider approval: not confirmed' : ap.required ? 'Provider approval: required' : 'Provider approval: not required';
  const details = h('dl', { class: 'detail-list' },
    g.difficulty.rationale ? [h('div', null, h('dt', null, 'Why ' + (g.difficulty.level === 'unknown' ? 'this rating' : g.difficulty.level)), h('dd', null, g.difficulty.rationale))] : null,
    t.setup && t.setup !== brief(t.setup, 60) ? h('div', null, h('dt', null, 'Setup time, in full', chip(fieldConf(t.setup, t.confidence))), h('dd', null, t.setup)) : null,
    t.approval_wait && t.approval_wait !== brief(t.approval_wait, 60) ? h('div', null, h('dt', null, 'Approval wait, in full', chip(fieldConf(t.approval_wait, t.confidence))), h('dd', null, t.approval_wait)) : null,
    ap ? h('div', null, h('dt', null, approvalTitle, chip(ap.confidence)), h('dd', null, ap.what_is_reviewed || 'Not stated.')) : null,
    ap && ap.process ? h('div', null, h('dt', null, 'How approval works'), h('dd', null, ap.process)) : null);
  const legend = h('div', { class: 'legend' }, 'How to read the labels',
    h('ul', null, Object.keys(CONF).map(k => h('li', null, chip(k).cloneNode(true), { documented: 'Stated in official docs.', inferred: 'Reasoned from docs, not stated.', unverified: 'Could not be confirmed.' }[k]))));
  legend.querySelectorAll('.chip').forEach(c => c.removeAttribute('title'));

  const steps = sec('steps', 'Steps', h('ol', { class: 'timeline' }, g.steps.map(s => {
    const w = WHO[s.who];
    return h('li', { class: 'tl who-' + s.who },
      h('span', { class: 'dot', 'aria-hidden': 'true' }, String(s.n)),
      h('div', { class: 'tl-body' },
        h('div', { class: 'tl-head' }, h('h3', null, h('span', { class: 'sr' }, 'Step ' + s.n + ': '), s.title), h('span', { class: 'who who-' + s.who }, icon(w.icon), w.label)),
        s.detail ? h('p', null, s.detail) : null,
        s.url ? link([icon('link'), h('span', { class: 'sr' }, 'Official page: '), h('span', null, shortUrl(s.url))], s.url, { class: 'src-link' }) : null));
  })));

  const split = sec('agent-vs-you', 'What an agent can do, and what only you can',
    h('div', { class: 'split' },
      h('div', { class: 'pane agent' }, h('header', null, icon('agent'), 'An agent can do'), h('ul', null, A.agent_can.map(x => h('li', null, icon('check'), h('span', null, x))))),
      h('div', { class: 'pane you' }, h('header', null, icon('user'), 'Only you can do'), h('ul', null, A.you_must.map(x => h('li', null, icon('user'), h('span', null, x)))))));

  const reqs = sec('requirements', 'Before you start', h('ul', { class: 'reqs' }, g.requirements.map(r => h('li', null, icon('dot'), h('span', null, r.text, chip(r.confidence))))));
  const blockers = sec('blockers', 'Where people get stuck', h('div', { class: 'callouts' }, g.blockers.map(b =>
    h('div', { class: 'callout' },
      h('div', { class: 'callout-top' }, icon('warn'), h('p', null, h('strong', null, b.issue), chip(b.confidence))),
      b.what_to_do ? h('div', { class: 'callout-fix' }, icon('ok'), h('p', null, h('b', null, 'What to do'), b.what_to_do)) : null))));
  const unc = sec('not-confirmed', 'Not confirmed', h('ul', { class: 'unc' }, g.uncertainties.map(u => h('li', null, icon('dashed'), h('span', null, u)))));
  const sources = sec('sources', 'Sources', h('ul', { class: 'sources' }, g.sources.map(s => h('li', null,
    h('span', { class: 't' }, link(s.title || s.url, s.url), s.official ? null : thirdPartyChip()),
    s.url ? h('span', { class: 'u' }, shortUrl(s.url)) : null,
    s.used_for ? h('span', { class: 'for' }, s.used_for) : null))),
    h('div', { class: 'checked' }, h('span', null, 'Last checked ' + formatDate(g.last_checked)),
      g.provider_url ? link([hostOf(g.provider_url) || 'Provider site', ' ', icon('external')], g.provider_url) : null,
      g.developer_docs_url ? link(['Developer docs ', icon('external')], g.developer_docs_url) : null));

  // actions
  const linkBtn = h('button', { class: 'btn', type: 'button', onclick: () => {
    if (isGen && !canShare && !location.hash.startsWith('#/g/')) return toast('Share links need a newer browser. Use Copy as Markdown.');
    copyText(location.href, 'Link copied');
  } }, icon('link'), 'Copy link');
  if (isGen && !canShare) { linkBtn.disabled = true; linkBtn.title = 'This browser cannot pack a guide into a link. Use Copy as Markdown.'; }
  const mdBtn = h('button', { class: 'btn', type: 'button', onclick: () => copyText(toMarkdown(g, isGen), 'Markdown copied') }, icon('doc'), 'Copy as Markdown');

  const notice = isGen ? h('div', { class: 'notice', role: 'note' }, icon('warn'), h('div', null,
    h('strong', null, 'Generated, not curated. '),
    opts.shared ? 'This guide was opened from a shared link, so its content comes from the link itself and has not been checked by us. ' : 'A model wrote this from public documentation just now. ',
    'Open the sources before you rely on any claim.')) : null;

  const nav = h('nav', { class: 'snav', 'aria-label': 'On this page' }, h('ul', null, sections.map(s =>
    h('li', null, h('a', { href: '#sec-' + s.id, 'data-t': s.id, onclick: e => {
      e.preventDefault();
      const el = document.getElementById('sec-' + s.id);
      el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
    } }, s.label)))));

  main.replaceChildren(h('div', { class: 'wrap' },
    h('a', { class: 'crumb', href: '#/' }, icon('back'), 'All guides'),
    h('header', { class: 'g-head' },
      h('h1', { tabindex: '-1' }, g.app, ' OAuth app'),
      g.summary ? h('p', { class: 'sum' }, g.summary) : null,
      h('div', { class: 'g-meta' },
        h('div', { class: 'g-badges' },
          h('span', { class: 'tag only-m' }, level(g.difficulty.level, true)),
          h('span', { class: 'tag' + (g.tested ? '' : ' warn') }, icon('info'), g.tested ? 'Hands-on tested' : 'Docs-based, not hands-on tested'),
          h('span', { class: 'tag' }, 'Checked ' + formatDate(g.last_checked))),
        h('div', { class: 'g-actions' }, linkBtn, mdBtn)),
      notice,
      facts),
    h('div', { class: 'g-layout' }, nav,
      h('div', { class: 'g-body' }, sec('overview', 'Overview', details, legend), steps, (A.agent_can.length || A.you_must.length) ? split : null,
        g.requirements.length ? reqs : null, g.blockers.length ? blockers : null, g.uncertainties.length ? unc : null, sources))));

  // scroll-spy: the active section is the last one whose top has passed a line just under the sticky UI
  const links = new Map(sections.map(s => [s.id, nav.querySelector('a[data-t="' + s.id + '"]')]));
  const els = sections.map(s => document.getElementById('sec-' + s.id));
  let active = '', queued = false;
  const spy = () => {
    queued = false;
    const line = window.innerWidth >= 960 ? 140 : 130;
    let id = sections[0].id;
    els.forEach((el, i) => { if (el.getBoundingClientRect().top <= line) id = sections[i].id; });
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) id = sections[sections.length - 1].id;
    if (id === active) return;
    active = id;
    links.forEach((a, k) => (k === id ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
    const a = links.get(id), ul = a.closest('ul');
    if (ul.scrollWidth > ul.clientWidth) ul.scrollLeft = a.offsetLeft - (ul.clientWidth - a.offsetWidth) / 2;
  };
  const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(spy); } };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  cleanups.push(() => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); });
  spy();
}

// ---------------------------------------------------------------- other views
function renderAbout() {
  setMeta('About & limits - OAuth App Guides', 'What these guides are built from, what was not tested, and how generated guides and share links work.');
  const sec = (t, ...p) => [h('h2', null, t), p.map(x => (typeof x === 'string' ? h('p', null, x) : x))];
  main.replaceChildren(h('div', { class: 'wrap' }, h('article', { class: 'prose' },
    h('h1', { tabindex: '-1' }, 'About & limits'),
    h('p', null, 'These guides help a developer, or an agent working for one, set up a provider OAuth app and get it through review. They are written from official documentation and say plainly how sure they are.'),
    sec('What was checked', 'Each library guide was written from the provider\'s official docs. Every claim carries a confidence label and points at a source, and every guide shows the date it was last checked.'),
    sec('What was not', 'Nothing here was tried hands-on. No real OAuth app was created and no review was submitted. Approval times, console layouts and review rules change without notice. Where a provider publishes no figure, the guide says so and gives a labelled estimate.'),
    sec('Confidence labels',
      h('ul', null,
        h('li', null, chip('documented'), ' Stated in the provider\'s official documentation.'),
        h('li', null, chip('inferred'), ' Reasoned from the docs but not stated. Check it before relying on it.'),
        h('li', null, chip('unverified'), ' Could not be confirmed from official sources. These also appear under Not confirmed.'))),
    sec('Generated guides', 'For apps outside the library, a model reads public documentation and writes a guide. It is marked Generated, not curated. Sources that are not the provider\'s own are marked Third-party. Treat the result as a starting point and open the sources.'),
    sec('Share links', 'A generated guide cannot be saved on a server here, so Copy link packs the whole guide into the link itself. Anyone with the link sees the same guide, and nothing is stored. Because a link can be edited by anyone, guides opened from links are validated and labelled as shared.'),
    h('p', null, h('a', { href: '#/' }, 'Back to the library')))));
}
function renderNotFound(what) {
  setMeta('Not found - OAuth App Guides', 'This page does not exist.');
  main.replaceChildren(h('div', { class: 'wrap' }, stateCard({ ic: 'search', title: 'Nothing here', body: what || 'There is no page at this address. A shared link may have been cut off when it was pasted.', actions: [goHome()] })));
}

async function renderLibraryGuide(slug) {
  const token = ++routeToken;
  main.replaceChildren(h('div', { class: 'wrap' }, h('a', { class: 'crumb', href: '#/' }, icon('back'), 'All guides'), skeleton()));
  try {
    const r = await fetch('/guides/' + encodeURIComponent(slug) + '.json');
    if (token !== routeToken) return;
    if (r.status === 404) return renderNotFound('There is no library guide called “' + slug + '”. Search for the app on the home page to generate one.');
    if (!r.ok) throw new Error();
    const g = cleanGuide(await r.json());
    if (token !== routeToken) return;
    if (!g) throw new Error();
    await libraryPromise;
    const hit = library.find(x => x.slug === slug);
    renderGuide(g, { generated: false, short: hit ? { setup: hit.setup, approval_wait: hit.approval_wait } : null });
    afterRender();
  } catch {
    if (token !== routeToken) return;
    main.replaceChildren(h('div', { class: 'wrap' }, stateCard({ kind: 'err', ic: 'warn', title: 'This guide could not be loaded', body: 'Check your connection and try again.',
      actions: [h('button', { class: 'btn primary', type: 'button', onclick: () => renderLibraryGuide(slug) }, 'Try again'), goHome()] })));
  }
}
async function renderShared(data) {
  const token = ++routeToken;
  main.replaceChildren(h('div', { class: 'wrap' }, skeleton()));
  const mine = justGenerated; justGenerated = false;
  const g = await decodeGuide(data);
  if (token !== routeToken) return;
  if (!g) {
    main.replaceChildren(h('div', { class: 'wrap' }, stateCard({ kind: 'err', ic: 'x', title: canShare ? 'This shared guide could not be opened' : 'This browser cannot open shared guides',
      body: canShare ? 'The link may have been cut off when it was copied, or the guide in it is not valid. Ask for the link again, or search for the app.' : 'Shared guides are packed with a browser feature this one lacks. Update your browser, or search for the app instead.',
      actions: [goHome()] })));
    return afterRender();
  }
  renderGuide(g, { generated: true, shared: !mine });
  afterRender();
}

// ---------------------------------------------------------------- router
function afterRender() {
  const h1 = main.querySelector('h1') || main.querySelector('h2');
  if (!firstRender) { window.scrollTo(0, 0); if (h1) h1.focus({ preventScroll: true }); }
  firstRender = false;
  document.querySelectorAll('nav.top a[data-nav]').forEach(a => {
    const on = (a.dataset.nav === 'about') === (location.hash === '#/about');
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
async function render() {
  cleanups.forEach(f => f()); cleanups = [];
  const seq = ++renderSeq;
  const hash = location.hash.startsWith('#/') ? location.hash : '#/';
  let m;
  if (hash === '#/') { await libraryPromise; if (seq !== renderSeq) return; renderHome(); }
  else if ((m = hash.match(/^#\/guide\/([\w-]{1,60})$/))) return renderLibraryGuide(m[1]).then(() => { /* afterRender runs inside */ });
  else if ((m = hash.match(/^#\/generate\/(.{1,300})$/))) renderGenerate(m[1]);
  else if ((m = hash.match(/^#\/g\/([\w-]+)$/))) return renderShared(m[1]);
  else if (hash === '#/generated' && generated) renderGuide(generated, { generated: true, shared: false });
  else if (hash === '#/about') renderAbout();
  else renderNotFound();
  afterRender();
}
window.addEventListener('hashchange', () => { if (location.hash === '' || location.hash.startsWith('#/')) render(); });
loadLibrary();
render();
