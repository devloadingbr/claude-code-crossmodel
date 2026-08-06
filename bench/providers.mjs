// Provider registry — two transports, one interface.
//
//   kind: 'cli'   spawn a local command (Claude Code, Codex, Gemini, Ollama, ...)
//   kind: 'http'  POST to an OpenAI-compatible /chat/completions endpoint
//                 (OpenRouter, Together, Groq, vLLM, LM Studio, ...)
//
// Everything downstream (the benchmark, the delegate agent) talks to `callModel()`
// and never knows which transport it got. Adding a provider is a data change.
//
// Extend without editing this file: drop a `crossmodel.config.json` next to it.
// See `crossmodel.config.example.json`.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);

// ---------------------------------------------------------------- providers

export const BUILTIN_PROVIDERS = {
  // Claude Code in headless mode. Uses your Anthropic subscription/API quota.
  claude: {
    kind: 'cli',
    bin: 'claude',
    // ⚠️ ORDER MATTERS. `--tools` is variadic and will swallow whatever follows it,
    // so the prompt MUST come before it. `--tools ""` disables every built-in tool,
    // which is what makes this a fair measurement of the model rather than of the
    // harness (otherwise Claude can run bash and test its own code first).
    args: ({ model, prompt }) => ['-p', prompt, '--model', model, '--tools', ''],
  },

  // OpenAI Codex CLI. Uses your ChatGPT subscription quota — a separate pool from
  // Anthropic's. This is the whole point of the plugin.
  codex: {
    kind: 'cli',
    bin: 'codex',
    // `write` opts into workspace-write. Verified: writes land inside the workspace and
    // are rejected outside it ("patch rejected: writing outside of the project") — the
    // documented exception is the system temp dir, which is writable in both modes.
    // Never expose danger-full-access; that removes the only boundary here.
    args: ({ model, prompt, schemaPath, write }) => {
      const a = ['exec', '--sandbox', write ? 'workspace-write' : 'read-only',
                 '--skip-git-repo-check', '-m', model];
      if (schemaPath) a.push('--output-schema', schemaPath);
      a.push(prompt);
      return a;
    },
  },

  // Google Gemini CLI.
  gemini: {
    kind: 'cli',
    bin: 'gemini',
    args: ({ model, prompt }) => ['-m', model, '-p', prompt],
  },

  // Local models via Ollama. Quota: your own hardware.
  ollama: {
    kind: 'cli',
    bin: 'ollama',
    args: ({ model, prompt }) => ['run', model, prompt],
  },

  // OpenRouter — one key, hundreds of models. OpenAI-compatible.
  openrouter: {
    kind: 'http',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    headers: {
      'HTTP-Referer': 'https://github.com/devloadingbr/claude-code-crossmodel',
      'X-Title': 'crossmodel',
    },
  },

  // Any other OpenAI-compatible endpoint (Together, Groq, vLLM, LM Studio...).
  // Point OPENAI_COMPAT_BASE_URL at it.
  'openai-compatible': {
    kind: 'http',
    baseUrlEnv: 'OPENAI_COMPAT_BASE_URL',
    apiKeyEnv: 'OPENAI_COMPAT_API_KEY',
  },
};

// Short aliases -> { provider, model }. Aliases are what you type everywhere else.
export const BUILTIN_MODELS = {
  opus:   { provider: 'claude', model: 'claude-opus-5' },
  sonnet: { provider: 'claude', model: 'claude-sonnet-5' },
  haiku:  { provider: 'claude', model: 'claude-haiku-4-5-20251001' },
  sol:    { provider: 'codex',  model: 'gpt-5.6-sol' },
  terra:  { provider: 'codex',  model: 'gpt-5.6-terra' },
  luna:   { provider: 'codex',  model: 'gpt-5.6-luna' },
};

// ------------------------------------------------------------ user overrides

function loadUserConfig() {
  for (const name of ['crossmodel.config.json', '../crossmodel.config.json']) {
    const p = path.resolve(ROOT, name);
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      console.error(`crossmodel: ignoring malformed ${name}: ${e.message}`);
    }
  }
  return {};
}

const userCfg = loadUserConfig();

export const PROVIDERS = { ...BUILTIN_PROVIDERS, ...(userCfg.providers ?? {}) };
export const MODELS = { ...BUILTIN_MODELS, ...(userCfg.models ?? {}) };

// ------------------------------------------------------------------ transport

function runCli(bin, args, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // ⚠️ stdin MUST be 'ignore'. Codex prints "Reading additional input from stdin..."
    // and blocks forever if the pipe stays open — you get only the banner back and it
    // looks like a parse error, not a hang. Cost us an hour; don't undo it.
    //
    // `cwd` is load-bearing for agentic CLIs: it is the directory they can read. A sweep
    // ("which files touch X") is just a call with the right cwd — no need to paste code
    // into the prompt at all.
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => {
      done = true;
      p.kill('SIGKILL');
      resolve({ ok: false, ms: Date.now() - t0, error: `timed out after ${timeoutMs}ms`, text: out });
    }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => {
      if (done) return;
      clearTimeout(timer);
      const hint = e.code === 'ENOENT' ? ` (is "${bin}" installed and on PATH?)` : '';
      resolve({ ok: false, ms: Date.now() - t0, error: e.message + hint, text: '' });
    });
    p.on('close', (code) => {
      if (done) return;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        ms: Date.now() - t0,
        text: out,
        error: code === 0 ? null : `exit ${code}: ${err.slice(0, 300)}`,
      });
    });
  });
}

async function runHttp(provider, { model, prompt }, timeoutMs) {
  const t0 = Date.now();
  const baseUrl = provider.baseUrl ?? process.env[provider.baseUrlEnv];
  if (!baseUrl) {
    return { ok: false, ms: 0, error: `no base URL (set $${provider.baseUrlEnv})`, text: '' };
  }
  const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : null;
  if (provider.apiKeyEnv && !key) {
    return { ok: false, ms: 0, error: `missing API key (set $${provider.apiKeyEnv})`, text: '' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(provider.headers ?? {}),
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      return { ok: false, ms, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, text: '' };
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? '';
    if (!text) return { ok: false, ms, error: 'empty completion in response', text: '' };
    return { ok: true, ms, text, error: null };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message,
      text: '',
    };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------------- API

/**
 * Call a model by alias. Transport is resolved from the registry.
 * @param {string} alias      key of MODELS (e.g. 'luna', 'opus')
 * @param {string} prompt     the instruction
 * @param {{timeoutMs?: number, schemaPath?: string, cwd?: string}} [opts]
 *        schemaPath — only honoured by providers whose CLI supports it (codex).
 *        cwd        — directory the model may read. CLI providers only; ignored on http,
 *                     which has no filesystem at all. This is what makes repo sweeps work.
 * @returns {Promise<{ok, ms, text, error, model, provider, canReadFiles}>}
 */
export async function callModel(alias, prompt, opts = {}) {
  const entry = MODELS[alias];
  if (!entry) throw new Error(`unknown model alias: ${alias}. Known: ${Object.keys(MODELS).join(', ')}`);
  const provider = PROVIDERS[entry.provider];
  if (!provider) throw new Error(`model "${alias}" points at unknown provider "${entry.provider}"`);

  const timeoutMs = opts.timeoutMs ?? 240_000;
  const ctx = { model: entry.model, prompt, schemaPath: opts.schemaPath, write: opts.write };
  const isHttp = provider.kind === 'http';

  // Fail loudly rather than silently ignoring a cwd the transport cannot honour —
  // a sweep that quietly ran against nothing is worse than one that refused.
  if (opts.cwd && isHttp) {
    return {
      ok: false, ms: 0, text: '',
      error: `"${alias}" uses the http transport, which has no filesystem access — it cannot sweep ${opts.cwd}. Use a CLI-backed model.`,
      model: entry.model, provider: entry.provider, canReadFiles: false,
    };
  }

  // Writing without an explicit directory would let the agent edit wherever the parent
  // process happens to be standing. The scope has to be stated, never inherited.
  if (opts.write && !opts.cwd) {
    return {
      ok: false, ms: 0, text: '',
      error: 'write mode requires an explicit cwd — refusing to inherit the caller\'s directory as the writable scope.',
      model: entry.model, provider: entry.provider, canReadFiles: !isHttp,
    };
  }
  if (opts.write && isHttp) {
    return {
      ok: false, ms: 0, text: '',
      error: `"${alias}" uses the http transport and has no filesystem — it cannot write.`,
      model: entry.model, provider: entry.provider, canReadFiles: false,
    };
  }

  const r = isHttp
    ? await runHttp(provider, ctx, timeoutMs)
    : await runCli(provider.bin, provider.args(ctx), timeoutMs, opts.cwd);

  return { ...r, model: entry.model, provider: entry.provider, canReadFiles: !isHttp };
}

/** Can this alias read files from a working directory? (agentic CLI vs stateless HTTP) */
export function canReadFiles(alias) {
  const entry = MODELS[alias];
  return entry ? PROVIDERS[entry.provider]?.kind !== 'http' : false;
}

/** Which aliases are actually usable right now (binary present / key set). */
export async function availableModels() {
  const out = {};
  for (const [alias, entry] of Object.entries(MODELS)) {
    const p = PROVIDERS[entry.provider];
    if (!p) { out[alias] = { ok: false, why: `unknown provider ${entry.provider}` }; continue; }
    if (p.kind === 'http') {
      const hasUrl = p.baseUrl || process.env[p.baseUrlEnv];
      const hasKey = !p.apiKeyEnv || process.env[p.apiKeyEnv];
      out[alias] = hasUrl && hasKey
        ? { ok: true, why: `http ${entry.provider}` }
        : { ok: false, why: !hasUrl ? `set $${p.baseUrlEnv}` : `set $${p.apiKeyEnv}` };
    } else {
      const probe = await runCli(process.platform === 'win32' ? 'where' : 'which', [p.bin], 5000);
      out[alias] = probe.ok
        ? { ok: true, why: `cli ${p.bin}` }
        : { ok: false, why: `"${p.bin}" not on PATH` };
    }
  }
  return out;
}

// -------------------------------------------------------------- extractors

/** Last valid JSON object in a blob of text, optionally filtered by a predicate. */
export function extractJSON(text, isValid = () => true) {
  const candidates = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}' && --depth === 0) { candidates.push(text.slice(i, j + 1)); break; }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(candidates[i]);
      if (isValid(o)) return o;
    } catch { /* try the previous one */ }
  }
  return null;
}

/** First fenced code block, or the raw text if it already looks like code. */
export function extractCode(text) {
  const m = text.match(/```(?:javascript|js|typescript|ts|mjs)?\s*\n([\s\S]*?)```/);
  if (m) return m[1].trim();
  if (/\b(export|function|const)\b/.test(text)) return text.trim();
  return null;
}
