// OAuth app guides - vanilla JS, no build step.
// Flow: hash route -> render(). "#/" = home, "#/guide/<slug>" = library guide, "#/generated" = last generated guide.

const main = document.getElementById('main');
let library = [];            // summaries from /guides/index.json
let generated = null;        // last guide returned by /api/generate (kept in memory only)

// ---------- tiny DOM helper: builds elements with textContent, so guide text can never inject HTML ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
// Only allow http(s) links; generated guides are untrusted.
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : null);
const link = (text, url) => safeUrl(url) ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text) : document.createTextNode(text);

const LABELS = { documented: 'Documented', inferred: 'Inferred', unverified: 'Unverified' };
const GLYPH = { documented: '✓', inferred: '~', unverified: '?' };
function chip(level) {
  if (!LABELS[level]) return null;
  return h('span', { class: 'chip ' + level, title: LABELS[level] + ' claim' }, GLYPH[level] + ' ' + LABELS[level]);
}
const WHO = { agent: 'Agent can do', you: 'You do', either: 'Either' };

function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 1800);
}

// ---------- library ----------
async function loadLibrary() {
  try {
    const r = await fetch('/guides/index.json');
    library = r.ok ? await r.json() : [];
  } catch { library = []; }
}
const norm = s => (s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').trim();
function findInLibrary(q) {
  q = norm(q);
  if (!q) return null;
  return library.find(g => {
    const host = norm(g.provider_url).split('/')[0];
    return q === g.slug || q === g.app.toLowerCase() || (host && q.split('/')[0] === host) || q.includes(g.slug);
  });
}

// ---------- home ----------
function renderHome() {
  document.title = 'OAuth App Guides';
  const input = h('input', { id: 'q', type: 'text', name: 'q', autocomplete: 'off', placeholder: 'e.g. Notion, or notion.so', 'aria-describedby': 'hint' });
  const results = h('div', { 'aria-live': 'polite' });
  const form = h('form', { class: 'search', role: 'search', onsubmit: e => { e.preventDefault(); submitQuery(input.value, results); } },
    h('label', { for: 'q', class: 'meta', style: 'flex-basis:100%' }, 'App name or website'),
    input, h('button', { type: 'submit' }, 'Get the guide'));
  const cards = library.length
    ? h('ul', { class: 'cards' }, library.map(g => h('li', null, h('a', { class: 'card', href: '#/guide/' + g.slug },
        h('h3', null, g.app),
        h('span', { class: 'badge ' + g.difficulty }, g.difficulty),
        h('p', null, g.summary),
        h('dl', null, h('dt', null, 'Setup'), h('dd', null, g.setup), h('dt', null, 'Approval'), h('dd', null, g.approval_wait))))))
    : h('p', { class: 'meta' }, 'The guide library could not be loaded.');
  main.replaceChildren(
    h('h1', null, 'Set up a provider OAuth app, and get it approved.'),
    h('p', { class: 'lede' }, 'Plain-language steps, what an agent can do for you, what only you can do, and where approval usually gets stuck.'),
    form,
    h('p', { id: 'hint', class: 'hint' }, 'Type an app we cover to open its guide. Anything else is researched and generated on the spot.'),
    results,
    h('h2', null, 'Guides in the library'),
    cards);
}

async function submitQuery(value, results) {
  const q = value.trim();
  if (!q) { results.replaceChildren(h('p', { class: 'status error' }, 'Enter an app name or website first.')); return; }
  const hit = findInLibrary(q);
  if (hit) { location.hash = '#/guide/' + hit.slug; return; }

  // Not in library: call the generator. The progress list is a visual cue; the real work is one request.
  const stages = ['Finding the official developer docs', 'Reading the OAuth and approval pages', 'Drafting the guide and labelling confidence'];
  let i = 0;
  const list = h('ul', { class: 'progress' });
  const paint = () => list.replaceChildren(...stages.map((s, n) => h('li', { class: n < i ? 'done' : n === i ? 'now' : '' }, s)));
  paint();
  results.replaceChildren(h('div', { class: 'status' }, h('strong', null, 'Generating a guide for "' + q + '"'), list));
  const timer = setInterval(() => { if (i < stages.length - 1) { i++; paint(); } }, 4000);
  try {
    const res = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
    if ([404, 405, 501].includes(res.status)) throw new Error('The generator is not connected yet. Try one of the library guides below.');
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error(((data && data.error) || 'The generator returned an error (' + res.status + ').') + (data && data.reason ? ' ' + data.reason : ''));
    generated = data.guide || data;
    if (!generated.steps) throw new Error('The generator returned something that is not a guide.');
    location.hash = '#/generated';
    if (location.hash === '#/generated') render();
  } catch (err) {
    results.replaceChildren(h('div', { class: 'status error', role: 'alert' },
      h('strong', null, 'Could not generate a guide. '), err.message || String(err),
      h('div', { class: 'actions' }, h('button', { class: 'secondary', type: 'button', onclick: () => submitQuery(q, results) }, 'Try again'))));
  } finally { clearInterval(timer); }
}

// ---------- guide ----------
async function renderGuideRoute(slug) {
  main.replaceChildren(h('p', { class: 'meta', role: 'status' }, 'Loading guide...'));
  try {
    const r = await fetch('/guides/' + encodeURIComponent(slug) + '.json');
    if (!r.ok) throw new Error();
    renderGuide(await r.json(), false);
  } catch {
    main.replaceChildren(h('p', { class: 'status error', role: 'alert' }, 'No guide found for "' + slug + '". '), h('a', { href: '#/' }, 'Back to home'));
  }
}

function renderGuide(g, isGenerated) {
  document.title = g.app + ' OAuth guide';
  const lvl = (g.difficulty && g.difficulty.level) || 'unknown';
  const t = g.time || {};
  const glance = h('div', { class: 'glance' },
    h('div', { class: 'grid' },
      h('div', null, h('div', { class: 'k' }, 'Difficulty'), h('div', { class: 'v' }, lvl)),
      h('div', null, h('div', { class: 'k' }, 'Setup time'), h('div', { class: 'v' }, t.setup || 'unknown'), chip(t.confidence)),
      h('div', null, h('div', { class: 'k' }, 'Approval wait'), h('div', { class: 'v' }, t.approval_wait || 'unknown'), chip(t.confidence))),
    g.difficulty && g.difficulty.rationale ? h('p', { class: 'meta', style: 'margin:12px 0 0' }, g.difficulty.rationale) : null);

  const ap = g.approval;
  const approval = ap ? h('section', { class: 'block', 'aria-labelledby': 'h-approval' },
    h('h2', { id: 'h-approval' }, ap.required ? 'Approval is required' : (ap.confidence === 'unverified' ? 'Approval: not confirmed' : 'No approval review needed'), ' ', chip(ap.confidence)),
    ap.what_is_reviewed ? h('p', null, h('strong', null, 'What is reviewed: '), ap.what_is_reviewed) : null,
    ap.process ? h('p', null, h('strong', null, 'Process: '), ap.process) : null) : null;

  const avy = g.agent_vs_you;
  const split = avy ? h('section', { class: 'block', 'aria-labelledby': 'h-split' },
    h('h2', { id: 'h-split' }, 'What an agent can do vs. what only you can'),
    h('div', { class: 'split' },
      h('div', { class: 'panel agent' }, h('h3', null, 'Agent can do'), h('ul', null, (avy.agent_can || []).map(x => h('li', null, x)))),
      h('div', { class: 'panel you' }, h('h3', null, 'You do'), h('ul', null, (avy.you_must || []).map(x => h('li', null, x)))))) : null;

  const steps = h('section', { class: 'block', 'aria-labelledby': 'h-steps' },
    h('h2', { id: 'h-steps' }, 'Steps'),
    h('ol', { class: 'steps' }, (g.steps || []).map(s => {
      const who = WHO[s.who] ? s.who : 'either';
      return h('li', { class: 'step ' + who },
        h('div', { class: 'n', 'aria-hidden': 'true' }, String(s.n)),
        h('div', null,
          h('span', { class: 'who ' + who }, WHO[who]),
          h('h3', null, s.title),
          h('p', null, s.detail),
          s.url ? h('p', { class: 'meta' }, 'Official page: ', link(s.url, s.url)) : null));
    })));

  const reqs = (g.requirements || []).length ? h('section', { class: 'block', 'aria-labelledby': 'h-req' },
    h('h2', { id: 'h-req' }, 'Before you start'),
    h('ul', { class: 'plain' }, g.requirements.map(r => h('li', null, r.text, chip(r.confidence))))) : null;

  const blockers = (g.blockers || []).length ? h('section', { class: 'block', 'aria-labelledby': 'h-block' },
    h('h2', { id: 'h-block' }, 'Where people get stuck'),
    g.blockers.map(b => h('div', { class: 'blocker' }, h('p', null, h('strong', null, b.issue), chip(b.confidence)), h('p', null, h('strong', null, 'What to do: '), b.what_to_do)))) : null;

  const unc = (g.uncertainties || []).length ? h('section', { class: 'block', 'aria-labelledby': 'h-unc' },
    h('h2', { id: 'h-unc' }, 'Not confirmed'), h('ul', { class: 'plain' }, g.uncertainties.map(u => h('li', null, u)))) : null;

  const src = (g.sources || []).length ? h('section', { class: 'block', 'aria-labelledby': 'h-src' },
    h('h2', { id: 'h-src' }, 'Sources'),
    h('ul', { class: 'plain' }, g.sources.map(s => h('li', null, link(s.title || s.url, s.url), s.official === false ? h('span', { class: 'chip inferred' }, 'third-party') : null, s.used_for ? h('span', { class: 'meta' }, ' - ' + s.used_for) : null)))) : null;

  const copyLink = h('button', { class: 'secondary', type: 'button', onclick: () => copy(isGenerated ? null : location.href) }, 'Copy link');
  const copyMd = h('button', { class: 'secondary', type: 'button', onclick: () => copy(toMarkdown(g), 'Markdown copied') }, 'Copy as Markdown');

  main.replaceChildren(
    h('a', { class: 'back', href: '#/' }, '← All guides'),
    h('header', { class: 'guide-head' },
      h('h1', null, g.app, ' OAuth app'),
      h('p', { class: 'sum' }, g.summary),
      h('div', { class: 'badges' },
        h('span', { class: 'badge ' + lvl }, lvl),
        h('span', { class: 'badge note' }, g.tested ? 'Hands-on tested' : 'Docs-based, not hands-on tested'),
        isGenerated ? h('span', { class: 'badge note' }, 'Generated, not curated') : null),
      h('div', { class: 'actions' }, copyLink, copyMd),
      isGenerated ? h('p', { class: 'meta' }, 'Generated guides have no shareable link. Use Copy as Markdown to share this one.') : null),
    glance,
    h('p', { class: 'legend' }, 'Confidence labels: ', chip('documented'), ' stated in official docs. ', chip('inferred'), ' reasoned from docs, not stated. ', chip('unverified'), ' could not be confirmed.'),
    split, steps, approval, reqs, blockers, unc, src,
    h('p', { class: 'meta', style: 'margin-top:32px' }, 'Last checked: ' + (g.last_checked || 'unknown') + '. ', link('Provider site', g.provider_url), ' · ', link('Developer docs', g.developer_docs_url)));
  main.focus();
  window.scrollTo(0, 0);
}

async function copy(text, msg) {
  if (text == null) { toast('No shareable link for generated guides'); return; }
  try { await navigator.clipboard.writeText(text); toast(msg || 'Link copied'); }
  catch { window.prompt('Copy this:', text); }
}

function toMarkdown(g) {
  const c = x => (x ? ' _(' + x + ')_' : '');
  const L = [];
  L.push('# ' + g.app + ' OAuth app guide', '', g.summary, '');
  L.push('- Difficulty: ' + g.difficulty.level + ' - ' + g.difficulty.rationale);
  L.push('- Setup time: ' + g.time.setup + c(g.time.confidence));
  L.push('- Approval wait: ' + g.time.approval_wait + c(g.time.confidence));
  L.push('- ' + (g.tested ? 'Hands-on tested' : 'Docs-based, not hands-on tested') + '. Last checked ' + g.last_checked, '');
  if (g.approval) L.push('## Approval' + c(g.approval.confidence), '', (g.approval.required ? 'Required. ' : 'Not required. ') + (g.approval.what_is_reviewed || ''), '', g.approval.process || '', '');
  L.push('## Steps', '');
  for (const s of g.steps) L.push(s.n + '. **' + s.title + '** [' + (WHO[s.who] || 'Either') + '] ' + s.detail + (s.url ? ' (' + s.url + ')' : ''));
  L.push('', '## Requirements', '', ...g.requirements.map(r => '- ' + r.text + c(r.confidence)));
  L.push('', '## Blockers', '', ...g.blockers.map(b => '- **' + b.issue + '**' + c(b.confidence) + ': ' + b.what_to_do));
  L.push('', '## Agent can do', '', ...g.agent_vs_you.agent_can.map(x => '- ' + x));
  L.push('', '## You must do', '', ...g.agent_vs_you.you_must.map(x => '- ' + x));
  L.push('', '## Not confirmed', '', ...g.uncertainties.map(x => '- ' + x));
  L.push('', '## Sources', '', ...g.sources.map(s => '- [' + s.title + '](' + s.url + ')' + (s.used_for ? ' - ' + s.used_for : '')));
  return L.join('\n') + '\n';
}

// ---------- router ----------
function render() {
  const m = location.hash.match(/^#\/guide\/([\w-]+)$/);
  if (m) renderGuideRoute(m[1]);
  else if (location.hash === '#/generated' && generated) renderGuide(generated, true);
  else renderHome();
}
window.addEventListener('hashchange', render);
loadLibrary().then(render);
