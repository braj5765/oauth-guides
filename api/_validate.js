// Small hand-written validator for the guide schema in SCHEMA.md (no dependencies).
const CONF = ['documented', 'inferred', 'unverified'];
const LEVEL = ['easy', 'moderate', 'hard'];
const WHO = ['agent', 'you', 'either'];
const isStr = v => typeof v === 'string' && v.trim().length > 0;
const isUrl = v => typeof v === 'string' && /^https?:\/\/[^\s]+$/i.test(v);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Returns an array of human-readable problems; empty array = valid.
function validateGuide(g) {
  const e = [];
  if (!isObj(g)) return ['guide is not an object'];
  for (const k of ['slug', 'app', 'summary']) if (!isStr(g[k])) e.push(`${k} must be a non-empty string`);
  if (isStr(g.slug) && !/^[a-z0-9][a-z0-9-]{0,60}$/.test(g.slug)) e.push('slug must be lowercase letters, digits, hyphens');
  for (const k of ['provider_url', 'developer_docs_url']) if (!isUrl(g[k])) e.push(`${k} must be an http(s) URL`);
  if (!isObj(g.difficulty) || !LEVEL.includes(g.difficulty.level) || !isStr(g.difficulty.rationale)) e.push('difficulty needs level (easy|moderate|hard) and rationale');
  const t = g.time;
  if (!isObj(t) || !isStr(t.setup) || !isStr(t.approval_wait) || !CONF.includes(t.confidence)) e.push('time needs setup, approval_wait, confidence (documented|inferred|unverified)');
  const a = g.approval;
  if (!isObj(a) || typeof a.required !== 'boolean' || !isStr(a.what_is_reviewed) || !isStr(a.process) || !CONF.includes(a.confidence)) e.push('approval needs required(boolean), what_is_reviewed, process, confidence');
  if (!Array.isArray(g.steps) || g.steps.length < 1) e.push('steps must be a non-empty array');
  else g.steps.forEach((s, i) => {
    if (!isObj(s)) return e.push(`steps[${i}] not an object`);
    if (s.n !== i + 1) e.push(`steps[${i}].n must be ${i + 1}`);
    if (!isStr(s.title) || !isStr(s.detail)) e.push(`steps[${i}] needs title and detail`);
    if (!WHO.includes(s.who)) e.push(`steps[${i}].who must be agent|you|either`);
    if (!isUrl(s.url)) e.push(`steps[${i}].url must be an http(s) URL`);
  });
  if (!Array.isArray(g.requirements)) e.push('requirements must be an array');
  else g.requirements.forEach((r, i) => { if (!isObj(r) || !isStr(r.text) || !CONF.includes(r.confidence)) e.push(`requirements[${i}] needs text and valid confidence`); });
  if (!Array.isArray(g.blockers)) e.push('blockers must be an array');
  else g.blockers.forEach((b, i) => { if (!isObj(b) || !isStr(b.issue) || !isStr(b.what_to_do) || !CONF.includes(b.confidence)) e.push(`blockers[${i}] needs issue, what_to_do, valid confidence`); });
  const av = g.agent_vs_you;
  if (!isObj(av) || !Array.isArray(av.agent_can) || !Array.isArray(av.you_must) || ![...av.agent_can, ...av.you_must].every(isStr)) e.push('agent_vs_you needs string arrays agent_can and you_must');
  if (!Array.isArray(g.uncertainties) || !g.uncertainties.every(isStr)) e.push('uncertainties must be an array of strings');
  if (!Array.isArray(g.sources) || g.sources.length < 1) e.push('sources must be a non-empty array');
  else g.sources.forEach((s, i) => { if (!isObj(s) || !isStr(s.title) || !isUrl(s.url) || !isStr(s.used_for)) e.push(`sources[${i}] needs title, url, used_for`); });
  if (g.tested !== false) e.push('tested must be false');
  if (!isStr(g.last_checked) || !/^\d{4}-\d{2}-\d{2}$/.test(g.last_checked)) e.push('last_checked must be YYYY-MM-DD');
  return e;
}
module.exports = { validateGuide };
