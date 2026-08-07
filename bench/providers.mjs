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
import { loadPolicy as loadPermissions } from '../lib/permissions.mjs';

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
    supportsStream: true,
    // Verified boundaries: workspace-write lands inside the working directory and is
    // rejected outside it ("patch rejected: writing outside of the project"); the system
    // temp dir is writable in both modes; network is blocked in both.
    // Never expose danger-full-access — it removes the only boundary here.
    supportsEffort: true,
    supportsNetwork: true,
    supportsResume: true,
    args: ({ model, prompt, schemaPath, write, stream, effort, network, resume }) => {
      const a = ['exec'];
      // `resume` continues an existing session instead of starting cold. The house rule
      // it serves: an agent that died mid-run should be RESUMED, not relaunched — the
      // context it already paid for survives in the session, and re-reading the repo is
      // the expensive part.
      //
      // ⚠️ `resume` IS A DIFFERENT SUBCOMMAND WITH A DIFFERENT OPTION SET, and missing that
      // broke this flag from 0.6.0 until it was measured against codex-cli 0.146.1.
      // Two traps, both of which produce misleading errors:
      //   1. Grammar is `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` — the id is a
      //      POSITIONAL, so options must precede it.
      //   2. `resume` does NOT accept --sandbox at all. Emitting it produced "unexpected
      //      argument '--sandbox'", which reads like a bug somewhere unrelated.
      // The sandbox still has to be stated: dropping it would resume under whatever the
      // user's config happens to default to, losing a security boundary silently. The
      // equivalent `resume` accepts is the config override, verified working.
      if (resume) {
        a.push('resume', '-c', `sandbox_mode="${write ? 'workspace-write' : 'read-only'}"`);
      } else {
        a.push('--sandbox', write ? 'workspace-write' : 'read-only');
      }
      a.push('--skip-git-repo-check', '-m', model);
      // `--json` turns stdout into JSONL events instead of prose. It is what makes a long
      // run watchable — without it codex prints a banner, goes silent for minutes, and
      // dumps everything at the end, which is indistinguishable from a hang.
      if (stream) a.push('--json');
      if (effort) a.push('-c', `model_reasoning_effort=${effort}`);
      // Network stays OFF by default and is scoped to workspace-write, which is codex's
      // own boundary — there is no equivalent knob for the read-only sandbox.
      if (network) a.push('-c', 'sandbox_workspace_write.network_access=true');
      if (schemaPath) a.push('--output-schema', schemaPath);
      // Positional session id goes last, immediately before the prompt. "--last" is an
      // ordinary flag, so it is safe here too.
      if (resume) a.push(resume === 'last' ? '--last' : resume);
      a.push(prompt);
      return a;
    },
    /**
     * One JSONL line -> a normalized event, or null for lines we don't surface.
     *
     * Shapes verified against codex-cli 0.146.1 (`codex exec --json`):
     *   {"type":"thread.started","thread_id":"..."}
     *   {"type":"turn.started"}
     *   {"type":"item.started"|"item.completed","item":{"type":"agent_message"|"file_change"
     *      |"command_execution"|"reasoning"|"todo_list"|"web_search", ...}}
     *   {"type":"turn.completed","usage":{...}}  |  {"type":"turn.failed","error":{...}}
     *
     * Unknown `type`s are ignored rather than guessed at: a new event kind must not make
     * the run look like it failed. Anything that carries the model's prose sets
     * `answer`, which is what the caller stitches into the final text.
     */
    parseEvent: (line) => {
      let e;
      try { e = JSON.parse(line); } catch { return null; }
      if (!e || typeof e !== 'object') return null;

      if (e.type === 'thread.started') return { kind: 'start', id: e.thread_id ?? null };
      if (e.type === 'turn.failed') {
        const msg = e.error?.message ?? e.error ?? 'turn failed';
        return { kind: 'error', text: String(msg) };
      }
      if (e.type === 'turn.completed') {
        const u = e.usage ?? {};
        const total = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
        return { kind: 'done', text: total ? `${total.toLocaleString('en-US')} tokens` : '' };
      }

      if (e.type !== 'item.completed' && e.type !== 'item.started') return null;
      const it = e.item ?? {};
      const started = e.type === 'item.started';

      switch (it.type) {
        case 'agent_message':
          // Only completed messages carry the full text; a started one is an empty shell.
          if (started) return null;
          return { kind: 'message', text: it.text ?? '', answer: it.text ?? '' };
        case 'reasoning':
          if (started) return null;
          return { kind: 'thinking', text: (it.text ?? '').split('\n')[0] };
        case 'file_change': {
          if (started) return null; // report the write once, when it landed
          const paths = (it.changes ?? []).map((c) => `${c.kind === 'add' ? '+' : c.kind === 'delete' ? '-' : '~'} ${c.path}`);
          return { kind: 'edit', text: paths.join(', ') };
        }
        case 'command_execution': {
          const cmd = (it.command ?? '').replace(/^\/bin\/(?:ba)?sh -lc\s+/, '');
          if (started) return { kind: 'run', text: cmd };
          // Only surface completions that FAILED. A successful command already reported
          // itself on `started`; echoing it again doubles the noise for no information.
          if (it.exit_code === 0 || it.exit_code == null) return null;
          return { kind: 'run-failed', text: `exit ${it.exit_code}: ${cmd}` };
        }
        case 'web_search':
          if (started) return null;
          return { kind: 'search', text: it.query ?? '' };
        default:
          return null;
      }
    },
  },

  // OpenCode — one harness, many backends. This is the entry that opens the plugin up:
  // OpenRouter, Ollama, OpenAI, Google and anything OpenAI-compatible all arrive through
  // this single adapter, so harness and model stop being welded together.
  // Verified against opencode 1.18.14 on 2026-08-07.
  //
  // 🔴 ITS BOUNDARY IS A POLICY, NOT A SANDBOX. Measured, not assumed:
  //   - Without --auto, the Write TOOL aimed outside the working directory is refused
  //     ("permission requested: external_directory (...); auto-rejecting").
  //   - But `printf 'x' > /path/outside/file` through the SHELL tool SUCCEEDED, with no
  //     --auto. The permission layer checks arguments it can see; a path buried in a
  //     command string is invisible to it.
  //   - --auto removes even the first guard: a file outside the workspace was overwritten.
  //
  // Write is nonetheless available, because the hole has a shape and the shape has a fix:
  // an allowlist. crossmodel injects a bash policy whose floor is `"*": "ask"`, and in a
  // non-interactive run there is nobody to ask, so an unrecognised command is refused.
  // That puts the shell back under the same policy as the file tools. See lib/permissions.
  //
  // ⚠️ Enforced by OpenCode, in process — strong, and still not codex. codex fails the
  // write at the syscall regardless of what the model decides. Route work that must not
  // touch the tree to codex; route work that benefits from OpenRouter's model catalogue
  // here, and review the diff either way.
  opencode: {
    kind: 'cli',
    bin: 'opencode',
    supportsSchema: false,
    supportsWrite: true,
    supportsEffort: true, // --variant, provider-specific (high, max, minimal)
    supportsResume: true, // --session <id> / --continue
    args: ({ model, prompt, effort, resume, write, cwd }) => {
      // `plan` is OpenCode's read-only agent and refused both a file write and a shell
      // write in testing, so read-only runs get the agent AND the policy rather than
      // relying on either alone. Writing needs `build`.
      // Never pass --auto: its own help calls it dangerous, and the measurement shows why.
      const a = ['run', '--agent', write ? 'build' : 'plan', '-m', model];
      // 🔴 --dir IS NOT OPTIONAL, and leaving it out is not a cosmetic bug.
      // Every other provider here takes its working directory from the spawned process.
      // OpenCode does not: measured with the child's cwd set to a target repo and the
      // PARENT sitting in /tmp, it wrote /tmp/NEW.txt. It resolves writes against the
      // inherited environment, not getcwd(), so the only thing that actually aims it is
      // this flag. Without it a --write run lands in whatever directory the caller
      // happened to be in — silently, and outside anything the user named.
      if (cwd) a.push('--dir', cwd);
      if (effort) a.push('--variant', effort);
      if (resume) a.push(...(resume === 'last' ? ['--continue'] : ['--session', resume]));
      a.push(prompt);
      return a;
    },
    // ⚠️ OPENCODE_CONFIG_CONTENT, not OPENCODE_CONFIG, and the difference is the whole
    // point. Config precedence is: global < OPENCODE_CONFIG < PROJECT opencode.json <
    // OPENCODE_CONFIG_CONTENT. Passing the policy via OPENCODE_CONFIG would let a
    // project-level opencode.json in the very repo being swept override it — a repo you
    // do not control could hand itself `"permission": "allow"`. The inline form loads
    // after the project config and therefore wins.
    env: ({ write, cwd }) => {
      const { policy, error } = loadPermissions({ write });
      if (error) console.error(`crossmodel: ${error} — falling back to the built-in policy.`);
      return {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(policy),
        // Belt and braces with --dir. PWD is inherited from the parent shell and is the
        // most likely thing OpenCode consulted when it wrote to the wrong directory;
        // leaving it pointing somewhere else is asking for that bug to come back.
        ...(cwd ? { PWD: cwd } : {}),
      };
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
  // Verified working on 2026-08-07: no auth, no API key, no cost. The point of shipping
  // one is that a provider nobody can type into --model is a provider nobody uses — the
  // mistake gemini and ollama have been making here since day one.
  // `opencode models` lists what your install actually offers; add the rest via config.
  flash:  { provider: 'opencode', model: 'opencode/deepseek-v4-flash-free' },
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

function runCli(bin, args, timeoutMs, cwd, onLine, extraEnv) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Line buffer for streaming mode. A chunk boundary can land mid-JSON, so lines are
    // only handed over once terminated — parsing partial chunks is how a stream reader
    // starts "losing" events that were in fact delivered intact.
    let pending = '';
    // ⚠️ stdin MUST be 'ignore'. Codex prints "Reading additional input from stdin..."
    // and blocks forever if the pipe stays open — you get only the banner back, which
    // looks like a parse error rather than a hang. Cost an hour once; don't undo it.
    //
    // `cwd` is load-bearing: it is the directory the agent can read, and (with write)
    // the only one it can edit.
    const p = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
      // Some providers take their boundary from configuration rather than a sandbox, and
      // configuration arrives through the environment. See the opencode entry.
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => {
      done = true;
      p.kill('SIGKILL');
      resolve({ ok: false, ms: Date.now() - t0, error: `timed out after ${timeoutMs}ms`, text: out });
    }, timeoutMs);
    p.stdout.on('data', (d) => {
      out += d;
      if (!onLine) return;
      pending += d;
      const lines = pending.split('\n');
      pending = lines.pop() ?? ''; // last element is the unterminated remainder
      for (const line of lines) if (line.trim()) onLine(line);
    });
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
      // A final line without a trailing newline is still a line. Dropping it would lose
      // exactly the event that matters most: the last one.
      if (onLine && pending.trim()) { onLine(pending); pending = ''; }
      resolve({
        ok: code === 0,
        ms: Date.now() - t0,
        text: out,
        // Kept even on success: a provider can exit 0 and still have said something on
        // stderr that explains an empty answer. Discarding it there loses the diagnosis.
        stderr: err,
        error: code === 0 ? null : `exit ${code}: ${err.slice(0, 300)}`,
      });
    });
  });
}

// --------------------------------------------------------------------- API

// `started: false` marks a PRE-FLIGHT rejection — an argument guard fired and no process
// was ever spawned. Callers need the distinction: a post-mortem about partial edits or a
// resumable session is actively misleading when nothing ran.
function fail(entry, error) {
  return { ok: false, ms: 0, text: '', error, model: entry.model, provider: entry.provider, started: false };
}

/**
 * Call a model by alias.
 * @param {string} alias   key of MODELS (e.g. 'luna')
 * @param {string} prompt  the instruction
 * @param {{timeoutMs?: number, schemaPath?: string, cwd?: string, write?: boolean,
 *          effort?: string, network?: boolean, resume?: string,
 *          onEvent?: (e: {kind: string, text?: string, id?: string|null}) => void}} [opts]
 *        cwd      directory the model may read, and the only one it may edit
 *        write    allow edits inside cwd; requires cwd
 *        effort   reasoning effort (provider-specific vocabulary, e.g. low|medium|high|xhigh)
 *        network  let the agent reach the network; requires write, off by default
 *        resume   session id to continue, or "last" for the most recent
 *        onEvent  called as the run progresses (file written, command run, message).
 *                 Providers without a machine-readable event stream simply never call it,
 *                 so passing it is always safe — you get progress where it exists and
 *                 silence where it doesn't, never an error.
 * @returns {Promise<{ok, ms, text, error, model, provider, streamed: boolean}>}
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
  // Each capability is announced, never assumed. Silently dropping `--effort` would mean
  // believing a run was reasoning harder than it was — the kind of wrong belief that is
  // worse than an error, because you act on it.
  if (opts.effort && provider.supportsEffort !== true) {
    return fail(entry, `provider "${entry.provider}" has no reasoning-effort control in crossmodel; drop --effort.`);
  }
  if (opts.network && provider.supportsNetwork !== true) {
    return fail(entry, `provider "${entry.provider}" has no network toggle in crossmodel; drop --network.`);
  }
  if (opts.resume && provider.supportsResume !== true) {
    return fail(entry, `provider "${entry.provider}" cannot resume a session in crossmodel; drop --resume.`);
  }
  // Network is a workspace-write-scoped setting in codex, so "read-only WITH network" is
  // not expressible — asking for it would produce a flag that quietly does nothing.
  //
  // 🔴 And the obvious escape hatch does not work. Measured 2026-08-06: running
  // workspace-write with `sandbox_workspace_write.writable_roots` pointed at a scratch
  // directory did NOT confine anything — the agent overwrote a file in the cwd anyway.
  // So do not "fix" this by narrowing writable_roots and granting network; that would
  // hand out repo write access while the flag name promises otherwise. The safe pattern
  // is the one in the message: copy what the agent must read into a throwaway directory
  // and point --cwd there, so the only thing it can damage is the copy.
  if (opts.network && !opts.write) {
    return fail(
      entry,
      '--network requires --write (codex scopes the toggle to its workspace-write sandbox).\n' +
        '  For a read-only sweep that still needs the internet, stage what it must read in a\n' +
        '  throwaway directory and point --cwd there — the original tree is then untouchable.',
    );
  }

  if (opts.schemaPath && provider.supportsSchema === false) {
    // Not fatal — just make sure nobody believes the output was schema-constrained.
    console.error(`crossmodel: "${entry.provider}" does not support --schema; the request was sent without it.`);
    opts = { ...opts, schemaPath: undefined };
  }

  // Streaming is opt-in by the caller AND opt-in by the provider: asking for progress from
  // a CLI that has no event stream must degrade to a normal silent run, never to an error.
  const stream = Boolean(opts.onEvent) && provider.supportsStream === true && typeof provider.parseEvent === 'function';

  const ctx = {
    model: entry.model,
    prompt,
    schemaPath: opts.schemaPath,
    // Most providers take the working directory from the spawned process and never look
    // at this. OpenCode has to be aimed explicitly — see its entry.
    cwd: opts.cwd,
    write: opts.write,
    stream,
    effort: opts.effort,
    network: opts.network,
    resume: opts.resume,
  };

  // In streaming mode stdout is JSONL, so the raw blob is no longer the answer — the answer
  // is what the agent_message events carried. Stitch it as the events arrive.
  const answer = [];
  const onLine = stream
    ? (line) => {
        const e = provider.parseEvent(line);
        if (!e) return;
        if (e.answer) answer.push(e.answer);
        try { opts.onEvent(e); } catch { /* a broken reporter must not kill the run */ }
      }
    : undefined;

  // A provider may need environment as well as arguments — for OpenCode the permission
  // policy travels that way, because it is the only channel a swept repo cannot override.
  const extraEnv = typeof provider.env === 'function' ? provider.env(ctx) : undefined;

  const r = await runCli(provider.bin, provider.args(ctx), opts.timeoutMs ?? 2_400_000, opts.cwd, onLine, extraEnv);

  // Falling back to the raw stdout when nothing parsed keeps a protocol change from
  // silently turning a successful run into an empty answer.
  const text = stream && answer.length ? answer.join('\n\n').trim() : r.text;

  // 🔴 EXIT 0 WITH NO ANSWER IS NOT SUCCESS.
  // Measured against opencode 1.18.14: ask it for something its permission layer refuses
  // and it prints the denial ("permission requested: external_directory; auto-rejecting")
  // to STDERR, writes nothing to stdout, and exits 0. crossmodel read the empty stdout as
  // the answer and reported a successful run — a blocked call and a working one were
  // indistinguishable, which is the exact failure this project exists to prevent.
  // The denial is not lost, it is just on the other stream; surface it as the reason.
  if (r.ok && !String(text).trim()) {
    const diag = String(r.stderr ?? '').trim();
    return {
      ...r,
      ok: false,
      text: '',
      error:
        `exited 0 but produced no answer after ${r.ms}ms` +
        (diag
          ? `. The provider said this on stderr:\n  ${diag.slice(0, 600).replace(/\n/g, '\n  ')}`
          : ' and wrote nothing to stderr either — the run may have been blocked or cut short.'),
      streamed: stream,
      model: entry.model,
      provider: entry.provider,
    };
  }

  return { ...r, text, streamed: stream, model: entry.model, provider: entry.provider };
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
