// Canned guide used only by LLM_PROVIDER=mock (tests). Not used in production.
module.exports = {
  slug: 'example', app: 'Example', provider_url: 'https://example.com', developer_docs_url: 'https://docs.example.com/oauth/register',
  summary: 'Example registers OAuth apps in its developer console. Mock data for tests.',
  difficulty: { level: 'easy', rationale: 'Self-serve form.' },
  time: { setup: '15-30 minutes (inferred)', approval_wait: 'no official figure', confidence: 'inferred' },
  approval: { required: true, what_is_reviewed: 'Scopes.', process: 'Submit for review.', confidence: 'documented' },
  steps: [
    { n: 1, title: 'Open console', detail: 'Sign in.', who: 'you', url: 'https://docs.example.com/oauth/register' },
    { n: 2, title: 'Submit review', detail: 'Request scopes.', who: 'you', url: 'https://docs.example.com/oauth/review' },
  ],
  requirements: [{ text: 'Redirect URI over HTTPS', confidence: 'documented' }],
  blockers: [{ issue: 'Review time unknown', what_to_do: 'Apply early.', confidence: 'unverified' }],
  agent_vs_you: { agent_can: ['Draft redirect URIs'], you_must: ['Log in', 'Submit review'] },
  uncertainties: ['No official review time.'],
  sources: [{ title: 'Register', url: 'https://docs.example.com/oauth/register', used_for: 'steps' }, { title: 'Review', url: 'https://docs.example.com/oauth/review', used_for: 'review' }],
  tested: false, last_checked: '2026-10-20',
};
