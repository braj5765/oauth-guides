// Provider-swappable LLM layer. Choose with env LLM_PROVIDER = groq (default, with Tavily search) | gemini | openrouter | mock.
// Every provider exposes the same two functions:
//   research(app)               -> { notes: string, sources: [{title, url}] }   (finds + reads official docs)
//   writeJson(system, user)     -> string                                        (raw model text; caller parses/validates)
// Keys are read ONLY from environment variables; a missing key throws a clear ConfigError.

const { RESEARCH_PROMPT } = require('./_prompt');

class ConfigError extends Error {}
const need = name => {
  const v = (process.env[name] || '').trim();
  if (!v) throw new ConfigError(`Server is missing the ${name} environment variable. See README-DEPLOY.md.`);
  // A pasted key must be one token. Never echo the value itself.
  if (/\s/.test(v)) throw new ConfigError(`The ${name} environment variable contains spaces or line breaks (it was probably pasted more than once). Re-enter it as a single value and redeploy.`);
  return v;
};
async function postJson(url, headers, body, label) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (!r.ok) {
      const msg = (data && (data.error?.message || data.message)) || text.slice(0, 200);
      const e = new Error(`${label} returned ${r.status}: ${msg}`); e.status = r.status; throw e;
    }
    return data;
  } finally { clearTimeout(timer); }
}

// ---------- Gemini: Google Search grounding via the Interactions API ----------
// Format taken from ai.google.dev docs (checked 2026-10-20): POST /v1beta/interactions,
// header x-goog-api-key, body {model, input, system_instruction, tools:[{type:"google_search"}]},
// response {status, steps:[{type:"model_output", content:[{type:"text", text, annotations:[{type:"url_citation", url, title}]}]}]}.
// Docs do not confirm grounding + JSON output in one call, so research (grounded) and writeJson (no tools) are separate calls.
// CAVEAT: the pricing page lists Search grounding as "Not available" on the free tier for Flash text models; see README-DEPLOY.md.
const gemini = {
  async call(body) {
    const key = need('GEMINI_API_KEY');
    const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    return postJson('https://generativelanguage.googleapis.com/v1beta/interactions', { 'x-goog-api-key': key }, { model, ...body }, 'Gemini');
  },
  extract(data) {
    let text = ''; const sources = [];
    for (const step of (data && data.steps) || []) {
      if (step.type !== 'model_output') continue;
      for (const c of step.content || []) {
        if (c.type === 'text' && c.text) text += c.text;
        for (const a of c.annotations || []) if (a.type === 'url_citation' && a.url) sources.push({ title: a.title || a.url, url: a.url });
      }
    }
    return { text, sources };
  },
  async research(app) {
    const data = await this.call({ input: RESEARCH_PROMPT.replace('{APP}', app), tools: [{ type: 'google_search' }] });
    const { text, sources } = this.extract(data);
    return { notes: text, sources };
  },
  async writeJson(system, user) {
    const data = await this.call({ system_instruction: system, input: user });
    return this.extract(data).text;
  },
};

// ---------- Tavily search (free tier) + OpenAI-compatible chat (Groq / OpenRouter) ----------
async function tavilyResearch(app) {
  const key = need('TAVILY_API_KEY');
  const queries = [`${app} developer OAuth 2.0 register app official documentation`, `${app} OAuth app review verification approval requirements`];
  const results = [];
  for (const q of queries) {
    const d = await postJson('https://api.tavily.com/search', { Authorization: `Bearer ${key}` },
      { query: q, search_depth: 'basic', max_results: 5, include_raw_content: false }, 'Tavily');
    results.push(...(d.results || []));
  }
  const seen = new Set(); const sources = []; const parts = [];
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue; seen.add(r.url);
    sources.push({ title: r.title || r.url, url: r.url });
    parts.push(`SOURCE: ${r.url}\nTITLE: ${r.title}\n${(r.content || '').slice(0, 1500)}`);
  }
  const notes = parts.length
    ? 'Search snippets (prefer official provider domains; ignore blogs):\n\n' + parts.join('\n\n')
    : 'NO OFFICIAL DOCS FOUND (search returned no results)';
  return { notes, sources };
}
function openAiCompat(label, url, keyName, defaultModel, modelEnv, extraHeaders = {}) {
  return {
    research: tavilyResearch,
    async writeJson(system, user) {
      const key = need(keyName);
      const d = await postJson(url, { Authorization: `Bearer ${key}`, ...extraHeaders }, {
        model: process.env[modelEnv] || defaultModel, temperature: 0.1,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
      }, label);
      return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    },
  };
}
const groq = openAiCompat('Groq', 'https://api.groq.com/openai/v1/chat/completions', 'GROQ_API_KEY', 'llama-3.3-70b-versatile', 'GROQ_MODEL');
const openrouter = openAiCompat('OpenRouter', 'https://openrouter.ai/api/v1/chat/completions', 'OPENROUTER_API_KEY', 'meta-llama/llama-3.3-70b-instruct:free', 'OPENROUTER_MODEL');

// ---------- Mock (tests; no network, no key) ----------
// Tests can set globalThis.__MOCK = { notes, sources, outputs: [string, ...] } to script responses.
const mock = {
  async research(app) {
    const m = globalThis.__MOCK || {};
    if (m.notes !== undefined) return { notes: m.notes, sources: m.sources || [] };
    return { notes: `Official notes for ${app}. See https://docs.example.com/oauth/register and https://docs.example.com/oauth/review`,
      sources: [{ title: 'Register', url: 'https://docs.example.com/oauth/register' }, { title: 'Review', url: 'https://docs.example.com/oauth/review' }] };
  },
  async writeJson() {
    const m = globalThis.__MOCK || {};
    m.calls = (m.calls || 0) + 1; globalThis.__MOCK = m;
    if (m.outputs) return m.outputs[Math.min(m.calls - 1, m.outputs.length - 1)];
    return JSON.stringify(require('./_mock-guide'));
  },
};

const PROVIDERS = { gemini, groq, openrouter, mock };
function getProvider() {
  const name = (process.env.LLM_PROVIDER || 'groq').toLowerCase();
  if (!PROVIDERS[name]) throw new ConfigError(`Unknown LLM_PROVIDER "${name}". Use gemini, groq, openrouter or mock.`);
  return PROVIDERS[name];
}
module.exports = { getProvider, ConfigError };
