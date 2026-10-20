# Deploying to Vercel

The site is static files plus one serverless function (`api/generate.js`). No build step, no dependencies.

## 1. Get two free keys (default setup: Groq + Tavily)
- **Groq (the model):** https://console.groq.com > API Keys > Create. Copy it as `GROQ_API_KEY`.
- **Tavily (web search):** https://tavily.com > sign up > copy the key as `TAVILY_API_KEY`.
- Why not Gemini by default: on 2026-10-20 Google's pricing page lists *Grounding with Google Search* as "Not available" on the Gemini free tier, and free-tier content is used to improve Google's products. Gemini is still supported (`LLM_PROVIDER=gemini`) if you have a paid key.
- Free-tier limits and terms change; check both sites yourself. Only public documentation is sent through these services - never paste private data into the live generator.

## 2. Deploy
1. Push this folder (`app/`) to a Git repo (or use `npx vercel` from inside `app/`).
2. On vercel.com: **Add New > Project > Import** the repo. If the repo root is the parent folder, set **Root Directory** to `app`.
3. Framework Preset: **Other**. Leave build and output settings empty.
4. Open **Settings > Environment Variables** and add (Production, Preview, Development): `LLM_PROVIDER=groq`, `GROQ_API_KEY` and `TAVILY_API_KEY`. See `.env.example`.
5. **Deploy**. Env var changes only apply to new deployments, so redeploy after editing them.

## 3. Verify
- Local test, no key needed: `node scripts/test-generate.js` should print `18 passed, 0 failed`.
- Live check (replace the domain):
  `curl -s -X POST https://YOUR-APP.vercel.app/api/generate -H 'content-type: application/json' -d '{"query":"notion.so"}'`
- Expected: `{"guide":{...}}`. A `503` with "not configured" means a key is missing; `404` with `{error, reason}` means no official docs were found; `429` is the rate limit (5 requests / 10 min per IP, 300/day overall).
- Function time limit is set to 60 s in `vercel.json` (the research + write pipeline makes 2-3 model calls).

## Notes
- Rate limiting is in memory per function instance, so it is a speed bump, not a hard guarantee. Add Vercel KV or Upstash Redis if abuse appears.
- Generated guides are docs-based only (`tested: false`) and are not stored.
