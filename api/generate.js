// POST /api/generate  {query}  ->  200 {guide}  |  4xx/5xx {error, reason?}
// Pipeline: sanitize -> rate limit -> research (official docs) -> write JSON -> validate -> repair once -> source check.
const { getProvider, ConfigError } = require('./_llm');
const { WRITE_PROMPT, REPAIR_PROMPT } = require('./_prompt');
const { validateGuide } = require('./_validate');

const MAX_BODY = 2048;          // bytes
const MAX_QUERY = 80;           // chars
const RATE = { windowMs: 10 * 60 * 1000, perIp: 5, dailyGlobal: 300 };  // protects the free-tier quota
const hits = new Map();         // ip -> [timestamps]; in-memory, resets on cold start (documented trade-off)
const daily = { day: '', n: 0 };

function rateLimit(ip, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (daily.day !== day) { daily.day = day; daily.n = 0; }
  if (daily.n >= RATE.dailyGlobal) return { ok: false, retryAfter: 3600, why: 'Daily capacity reached. Please try again tomorrow.' };
  const recent = (hits.get(ip) || []).filter(t => now - t < RATE.windowMs);
  if (recent.length >= RATE.perIp) return { ok: false, retryAfter: Math.ceil((RATE.windowMs - (now - recent[0])) / 1000), why: 'Too many requests. Please wait a few minutes.' };
  recent.push(now); hits.set(ip, recent); daily.n++;
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < RATE.windowMs)) hits.delete(k);
  return { ok: true };
}
const resetLimits = () => { hits.clear(); daily.n = 0; };

// "https://www.Notion.so/foo?x=1" -> "notion.so"; "My App!!" -> "my app"
function sanitizeQuery(raw) {
  if (typeof raw !== 'string') return null;
  let q = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q) || /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(q)) {
    try { q = new URL(/^[a-z]+:\/\//i.test(q) ? q : 'https://' + q).hostname; } catch { return null; }
  }
  q = q.replace(/^www\./i, '').replace(/[^\p{L}\p{N} .&+'_-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
  return q.length >= 2 ? q : null;
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body !== 'string' && !Buffer.isBuffer(req.body)) {
    if (JSON.stringify(req.body).length > MAX_BODY) return { tooBig: true };
    return { data: req.body };
  }
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) return { tooBig: true };
  let raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!raw && typeof req.on === 'function') {
    raw = await new Promise((resolve, reject) => {
      let s = '';
      req.on('data', c => { s += c; if (s.length > MAX_BODY) { resolve(null); req.destroy && req.destroy(); } });
      req.on('end', () => resolve(s)); req.on('error', reject);
    });
    if (raw === null) return { tooBig: true };
  }
  if (raw.length > MAX_BODY) return { tooBig: true };
  try { return { data: JSON.parse(raw) }; } catch { return { bad: true }; }
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

// ---- grounding check: every URL in the guide must come from the research stage ----
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
function allowedSet(research) {
  const urls = new Set(), hosts = new Set();
  const add = u => { urls.add(u.replace(/[).,;]+$/, '')); const h = host(u); if (h) hosts.add(h); };
  for (const s of research.sources) { add(s.url); if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s.title || '')) hosts.add(s.title.toLowerCase().replace(/^www\./, '')); }
  for (const m of (research.notes || '').matchAll(/https?:\/\/[^\s<>"')\]]+/g)) add(m[0]);
  return { urls, hosts };
}
const okUrl = (u, al) => al.urls.has(u) || (host(u) && al.hosts.has(host(u)));

function enforceSources(g, research) {
  const al = allowedSet(research);
  const dropped = [];
  const fallback = [...al.urls][0];
  if (!okUrl(g.developer_docs_url, al)) { dropped.push(g.developer_docs_url); g.developer_docs_url = fallback || g.provider_url; }
  g.sources = g.sources.filter(s => okUrl(s.url, al) || (dropped.push(s.url), false));
  for (const s of g.steps) if (!okUrl(s.url, al)) { dropped.push(s.url); s.url = g.developer_docs_url; }
  if (!okUrl(g.provider_url, al) && !g.sources.length) g.provider_url = g.developer_docs_url;
  if (dropped.length) g.uncertainties.push(`${dropped.length} link(s) from the draft were removed or replaced because they were not found in the documentation we actually read.`);
  return g.sources.length > 0;
}

async function generateGuide(app, provider) {
  const research = await provider.research(app);
  if (!research.notes || /NO OFFICIAL DOCS FOUND/i.test(research.notes) && research.sources.length === 0) {
    return { status: 404, body: { error: `We could not find official developer docs for "${app}".`, reason: 'The search step returned no official OAuth documentation. Try the product\'s exact name or its developer-docs domain.' } };
  }
  const allowed = [...allowedSet(research).urls].slice(0, 40);
  const user = `APP: ${app}\nTODAY: ${new Date().toISOString().slice(0, 10)}\n\nALLOWED URLS:\n${allowed.join('\n') || '(none)'}\n\nRESEARCH NOTES:\n${research.notes.slice(0, 14000)}`;

  let raw = await provider.writeJson(WRITE_PROMPT, user);
  let obj = parseJson(raw), problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {           // attempt 0 = first draft, 1 = single repair retry
    if (obj && typeof obj.error === 'string' && !obj.steps) {
      return { status: 404, body: { error: obj.error, reason: String(obj.reason || 'Official documentation could not be confirmed.') } };
    }
    if (obj) { obj.tested = false; obj.last_checked = new Date().toISOString().slice(0, 10); problems = validateGuide(obj); }
    else problems = ['output was not valid JSON'];
    if (!problems.length) break;
    if (attempt === 0) {
      raw = await provider.writeJson(WRITE_PROMPT, `${REPAIR_PROMPT}\n\nPROBLEMS:\n- ${problems.join('\n- ')}\n\nPREVIOUS OUTPUT:\n${String(raw).slice(0, 12000)}\n\n${user}`);
      obj = parseJson(raw);
    }
  }
  if (problems.length) return { status: 502, body: { error: 'The generator produced an invalid guide. Please try again.', reason: problems.slice(0, 3).join('; ') } };
  if (!enforceSources(obj, research) || validateGuide(obj).length) {
    return { status: 502, body: { error: 'The generated guide cited no verifiable sources, so it was discarded.', reason: 'No source URL matched the documentation that was read.' } };
  }
  return { status: 200, body: { guide: obj } };
}

async function handler(req, res) {
  const send = (code, body, headers = {}) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== 'POST') return send(405, { error: 'Use POST with {"query": "app name or website"}.' }, { Allow: 'POST' });
    const body = await readBody(req);
    if (body.tooBig) return send(413, { error: 'Request too large.' });
    if (body.bad || !body.data || typeof body.data !== 'object') return send(400, { error: 'Send JSON like {"query": "Notion"}.' });
    const app = sanitizeQuery(body.data.query);
    if (!app) return send(400, { error: 'Enter an app name or website (2-80 characters).' });
    const ip = String((req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown')).split(',')[0].trim();
    const rl = rateLimit(ip);
    if (!rl.ok) return send(429, { error: rl.why }, { 'Retry-After': String(rl.retryAfter) });
    const out = await generateGuide(app, getProvider());
    return send(out.status, out.body);
  } catch (err) {
    if (err instanceof ConfigError) return send(503, { error: 'The generator is not configured on this server.', reason: err.message });
    const upstream = err && err.status;
    if (upstream === 429) return send(503, { error: 'The AI provider is rate-limiting us (free tier). Please try again in a minute.' }, { 'Retry-After': '60' });
    // Never return upstream error text to the browser: it can contain request headers/keys. Log server-side only.
    console.error('generate upstream error:', String((err && err.message) || err).replace(/(gsk_|tvly-|sk-|AIza)[A-Za-z0-9_-]+/g, '$1***').slice(0, 300));
    return send(502, { error: 'Guide generation failed upstream. Please try again.', reason: 'The model or search service returned an error. If this keeps happening the service key or free-tier quota may need attention.' });
  }
}
module.exports = handler;
module.exports.handler = handler;
module.exports._test = { sanitizeQuery, rateLimit, resetLimits, parseJson, RATE, MAX_BODY };
