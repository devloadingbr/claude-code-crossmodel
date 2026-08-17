// Which harness is calling us — used so a delegation notice stays silent on the
// SAME quota pool (Claude Code → claude, Cursor → cursor) and announces every
// other one. Wrong silence is how you drain a pool without noticing; wrong noise
// is how you learn to ignore the notice.
//
// Cursor first: when Cursor loads Claude Code plugins both families of env vars
// can be set, and the orchestrator in that case is Cursor.

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'cursor' | 'claude' | 'unknown'}
 */
export function orchestratorHost(env = process.env) {
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT || env.CURSOR_EXTENSION_HOST_ROLE) return 'cursor';
  if (env.CLAUDE_CODE || env.CLAUDE_PLUGIN_ROOT) return 'claude';
  return 'unknown';
}

/**
 * True when calling this provider would spend the orchestrator's own pool.
 * Unknown host → never same-pool, so we announce rather than guess silence.
 */
export function samePool(provider, host) {
  if (host === 'claude' && provider === 'claude') return true;
  if (host === 'cursor' && provider === 'cursor') return true;
  return false;
}

export const QUOTA_LABEL = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  grok: 'xAI',
  gemini: 'Google',
  agy: 'Antigravity',
  ollama: 'local hardware',
  // Harnesses, not vendors. Naming the harness would answer the wrong question: with
  // opencode the bill lands on OpenRouter or Ollama or whoever backs the model string, and
  // with cursor it lands on the Cursor subscription regardless of whose model it is.
  cursor: 'Cursor subscription',
  opencode: "the backend's",
};
