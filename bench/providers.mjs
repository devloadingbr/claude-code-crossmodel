// Provider registry — CLI only, by design.
//
// crossmodel talks to *agentic CLIs*: tools that run in a working directory and can
// read the tree, run commands, and (when allowed) edit files. That capability is the
// whole point. A stateless HTTP endpoint can only see the prompt text, which makes it a
// different and much weaker product — so it is out of scope rather than half-supported.
//
// Adding a provider is a data change: give it a `bin` and an `args()` builder, or drop a
// `crossmodel.config.json` next to this file. See crossmodel.config.example.json.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);

// ---------------------------------------------------------------- providers
//
// args({ model, prompt, schemaPath, write, }) -> string[]
//   schemaPath  request structured output (only some CLIs support it)
//   write       allow edits inside the working directory

export const BUILTIN_PROVIDERS = {
  // Claude Code, headless. Spends your Anthropic quota — the pool we are trying to save,
  // so it is here mainly as the benchmark baseline.
  claude: {
    kind: 'cli',
    bin: 'claude',
    supportsSchema: false,
    supportsWrite: false, // headless Claude writes via its own tools; not modelled here
    // ⚠️ ORDER MATTERS. `--tools` is variadic and swallows whatever follows it, so the
    // prompt MUST come first. `--tools ""` disables every built-in tool, which is what
    // makes the benchmark measure the model instead of the harness (otherwise Claude can
    // run bash and test its own code before answering).
    args: ({ model, prompt }) => ['-p', prompt, '--model', model, '--tools', ''],
  },

  // OpenAI Codex CLI. Authenticates with a ChatGPT subscription — a quota pool separate
  // from Anthropic's. This is the reason the plugin exists.
  codex: {
    kind: 'cli',
    bin: 'codex',
    supportsSchema: true,
    supportsWrite: true,
    // Verified boundaries: workspace-write lands inside the working directory and is
    // rejected outside it ("patch rejected: writing outside of the project"); the system
    // temp dir is writable in both modes; network is blocked in both.
    // Never expose danger-full-access — it removes the only boundary here.
    args: ({ model, prompt, schemaPath, write }) => {
      const a = ['exec', '--sandbox', write ? 'workspace-write' : 'read-only',
                 '--skip-git-repo-check', '-m', model];
      if (schemaPath) a.push('--output-schema', schemaPath);
      a.push(prompt);
      return a;
    },
  },

  // Google Gemini CLI. 🟡 Argument shape not yet verified against a real install —
  // see issue #1. Fix and send a PR if it is wrong.
  gemini: {
    kind: 'cli',
    bin: 'gemini',
    supportsSchema: false,
    supportsWrite: false,
    args: ({ model, prompt }) => ['-m', model, '-p', prompt],
  },

  // Local models via Ollama. Quota: your own hardware. 🟡 Also unverified.
  ollama: {
    kind: 'cli',
    bin: 'ollama',
    supportsSchema: false,
    supportsWrite: false,
    args: ({ model, prompt }) => ['run', model, prompt],
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

export const CONFIG_NAMES = ['crossmodel.config.json', '../crossmodel.config.json'];

function loadUserConfig() {
  for (const name of CONFIG_NAMES) {
    const p = path.resolve(ROOT, name);
    if (!existsSync(p)) continue;
    try {
      return { ...JSON.parse(readFileSync(p, 'utf8')), _path: p };
    } catch (e) {
      // Never fall back silently — a malformed config that quietly reverts to defaults
      // is exactly the failure this project exists to prevent.
      console.error(`crossmodel: ${name} is malformed and was IGNORED — ${e.message}`);
    }
  }
  return {};
}

const userCfg = loadUserConfig();

export const CONFIG_PATH = userCfg._path ?? null;
export const PROVIDERS = { ...BUILTIN_PROVIDERS, ...(userCfg.providers ?? {}) };
export const MODELS = { ...BUILTIN_MODELS, ...(userCfg.models ?? {}) };

// ------------------------------------------------------------------ transport

function runCli(bin, args, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // ⚠️ stdin MUST be 'ignore'. Codex prints "Reading additional input from stdin..."
    // and blocks forever if the pipe stays open — you get only the banner back, which
    // looks like a parse error rather than a hang. Cost an hour once; don't undo it.
    //
    // `cwd` is load-bearing: it is the directory the agent can read, and (with write)
    // the only one it can edit.
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

// --------------------------------------------------------------------- API

function fail(entry, error) {
  return { ok: false, ms: 0, text: '', error, model: entry.model, provider: entry.provider };
}

/**
 * Call a model by alias.
 * @param {string} alias   key of MODELS (e.g. 'luna')
 * @param {string} prompt  the instruction
 * @param {{timeoutMs?: number, schemaPath?: string, cwd?: string, write?: boolean}} [opts]
 *        cwd    directory the model may read, and the only one it may edit
 *        write  allow edits inside cwd; requires cwd
 * @returns {Promise<{ok, ms, text, error, model, provider}>}
 */
export async function callModel(alias, prompt, opts = {}) {
  const entry = MODELS[alias];
  if (!entry) throw new Error(`unknown model alias: ${alias}. Known: ${Object.keys(MODELS).join(', ')}`);
  const provider = PROVIDERS[entry.provider];
  if (!provider) throw new Error(`model "${alias}" points at unknown provider "${entry.provider}"`);

  // Writing without an explicit directory would let the agent edit wherever the parent
  // process happens to be standing. Scope must be stated, never inherited.
  if (opts.write && !opts.cwd) {
    return fail(entry, 'write mode requires an explicit cwd — refusing to inherit the caller\'s directory as the writable scope.');
  }
  if (opts.write && provider.supportsWrite === false) {
    return fail(entry, `provider "${entry.provider}" has no write mode wired up in crossmodel; run without --write.`);
  }
  if (opts.schemaPath && provider.supportsSchema === false) {
    // Not fatal — just make sure nobody believes the output was schema-constrained.
    console.error(`crossmodel: "${entry.provider}" does not support --schema; the request was sent without it.`);
    opts = { ...opts, schemaPath: undefined };
  }

  const ctx = { model: entry.model, prompt, schemaPath: opts.schemaPath, write: opts.write };
  const r = await runCli(provider.bin, provider.args(ctx), opts.timeoutMs ?? 240_000, opts.cwd);
  return { ...r, model: entry.model, provider: entry.provider };
}

/** Which aliases are usable right now (binary present on PATH). */
export async function availableModels() {
  const which = process.platform === 'win32' ? 'where' : 'which';
  const cache = new Map();
  const out = {};
  for (const [alias, entry] of Object.entries(MODELS)) {
    const p = PROVIDERS[entry.provider];
    if (!p) { out[alias] = { ok: false, why: `unknown provider "${entry.provider}"` }; continue; }
    if (!cache.has(p.bin)) cache.set(p.bin, (await runCli(which, [p.bin], 5000)).ok);
    out[alias] = cache.get(p.bin)
      ? { ok: true, why: p.bin, write: p.supportsWrite !== false }
      : { ok: false, why: `"${p.bin}" not on PATH` };
  }
  return out;
}

/** Providers whose binary is installed — used by the setup skill. */
export async function detectProviders() {
  const which = process.platform === 'win32' ? 'where' : 'which';
  const found = {};
  for (const [name, p] of Object.entries(PROVIDERS)) {
    found[name] = { bin: p.bin, installed: (await runCli(which, [p.bin], 5000)).ok, write: p.supportsWrite !== false };
  }
  return found;
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
