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
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadPolicy as loadPermissions } from './permissions.mjs';
import { USER_DIR } from './mode.mjs';

// ⚠️ fileURLToPath, never `new URL(...).pathname`. A URL pathname is percent-encoded, so a
// plugin installed under a directory containing a space resolves to ".../my%20dir/..." —
// a path that does not exist. The failure is silent: existsSync says no, the loop moves on,
// and the user's config is ignored without a word. (It also breaks on Windows, where
// pathname yields "/C:/...".)
const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- providers
//
// args({ model, prompt, schemaPath, write, }) -> string[]
//   schemaPath  request structured output (only some CLIs support it)
//   write       allow edits inside the working directory

export const BUILTIN_PROVIDERS = {
  // Claude Code CLI, headless. A quota pool of its own — the one to SAVE when Claude Code
  // is the orchestrator, and a pool worth SPENDING when Cursor (or anything else) is.
  //
  // Two invocations, because they measure different things:
  //   • no cwd, no write — the benchmark baseline. `--tools ""` disables every built-in
  //     tool so the battery scores the model, not the harness (otherwise Claude can run
  //     bash and test its own code before answering).
  //   • cwd or write — a real subagent. Tools stay on so it can sweep, and
  //     `--dangerously-skip-permissions` is passed in BOTH cases: measured 2026-08-13,
  //     a cwd sweep without it exited 0 with "preciso que você aprove o bash" — a
  //     blocked call reported as success, the failure this project exists to prevent.
  //     Headless has nobody to click Allow. Claude has no read-only OS sandbox we can
  //     honour, so the git rule stays a contract: after `--write`, read `git log`.
  // ⚠️ ORDER MATTERS on the bench path: `--tools` is variadic and swallows whatever
  // follows it, so the prompt MUST come first.
  // ⚠️ The git rule is a contract, not a lock. Claude's CLI can `git commit` under
  // skip-permissions; after a `--write` run, read `git -C <dir> log` as well as the diff.
  // `--network` is refused rather than accepted: skip-permissions already has network,
  // and there is no separate knob to honour.
  claude: {
    kind: 'cli',
    bin: 'claude',
    supportsSchema: false,
    supportsWrite: true,
    args: ({ model, prompt, write, cwd }) => {
      const a = ['-p', prompt, '--model', model];
      if (!write && !cwd) {
        a.push('--tools', '');
        return a;
      }
      a.push('--dangerously-skip-permissions');
      return a;
    },
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
  // crossmodel injects a bash allowlist whose floor is `"*": "ask"`, which in a
  // non-interactive run means refused. That removes the easy paths. It does NOT close the
  // hole, and saying otherwise here was wrong for several releases:
  //
  //   MEASURED 2026-08-12, with the policy in force: `echo BACKUP > /outside/file` from
  //   the agent's shell exited 0 and overwrote a file outside the workspace. A `cat` of
  //   that same path WAS refused as external_directory — the guard sees paths it is
  //   handed, and a path inside a command string is not handed to it.
  //
  // ⚠️ So --write here means "the agent was asked to stay inside --cwd, and the easy ways
  // out are blocked" — a strong convention, not a boundary. Write is still offered because
  // the orchestrator reviews the diff before anything is committed, and because OpenRouter's
  // catalogue arrives through this adapter and nothing else. Route work that MUST NOT touch
  // the tree to codex or grok, whose sandboxes fail the write at the syscall.
  // See lib/permissions.mjs for the full list of allowlisted commands that carry the hole.
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

  // xAI Grok Build. A third quota pool (SuperGrok / X Premium+), and the SECOND provider
  // here whose boundary is a real OS sandbox rather than a policy: Landlock on Linux,
  // Seatbelt on macOS. That puts it in codex's tier, not opencode's.
  //
  // 🟡 ARGUMENT SHAPE IS FROM THE PUBLISHED DOCS (docs.x.ai/build, read 2026-08-12), NOT
  // FROM A RUN. The CLI is not installed on the machine this was written on, so unlike the
  // codex and opencode entries nothing here is measured. Verify before trusting it:
  //   crossmodel --model grok --cwd /tmp/probe "List the files you can see."
  // Everything marked UNVERIFIED below is a specific thing to check while you are there.
  grok: {
    kind: 'cli',
    bin: 'grok',
    supportsSchema: false,
    supportsWrite: true,
    // UNVERIFIED: `--output-format streaming-json` exists and emits newline-delimited
    // events, but the event schema is not documented, and a guessed parseEvent would
    // silently drop the answer. Left off until someone captures real output and writes
    // parseEvent against it — crossmodel degrades to the tree-diff no-op check meanwhile.
    supportsStream: false,
    supportsEffort: true,
    // A write run uses the `workspace` profile, which allows network unconditionally, and
    // there is no profile that writes to the CWD with network blocked. So --network is not
    // a thing crossmodel can honour here — refused rather than accepted and ignored.
    supportsNetwork: false,
    supportsResume: true,
    args: ({ model, prompt, cwd, write, effort, resume }) => {
      const a = ['-p', prompt, '-m', model];
      // grok's profiles, from its docs:
      //   off        unrestricted everything (its default)
      //   workspace  writes CWD + ~/.grok + temp, reads everywhere, network allowed
      //   strict     reads AND writes confined to CWD, child network blocked
      //   read-only  reads everywhere, writes only ~/.grok and temp, network blocked
      //
      // `workspace` for a write run — the profile they literally label "normal
      // development", and the one that matches how the agent is meant to work: edit in the
      // directory you were given, read whatever you need to understand it, run the build.
      // NOT `strict`: confining reads to the CWD stops an agent from reading a sibling
      // package or a global config it needs, and buys nothing the orchestrator's review of
      // the diff does not already cover.
      // `read-only` for a sweep, because a sweep is a question.
      //
      // ⚠️ Child-network blocking under read-only is enforced on LINUX ONLY — on macOS it
      // is a no-op. And `workspace` allows network unconditionally, which is why grok
      // cannot honour --network separately; see supportsNetwork below.
      a.push('--sandbox', write ? 'workspace' : 'read-only');
      // Headless permission mode is "ask", and with no TTY there is nobody to ask, so every
      // tool call would be refused and the run would come back empty. The sandbox is the
      // boundary here — same bargain codex makes with workspace-write — so approval inside
      // it is granted rather than negotiated.
      if (write) a.push('--always-approve');
      // Required in scripts: without it the CLI runs a background update check.
      a.push('--no-auto-update', '--no-alt-screen');
      if (cwd) a.push('--cwd', cwd);
      if (effort) a.push('--effort', effort);
      if (resume) a.push(...(resume === 'last' ? ['--continue'] : ['--resume', resume]));
      return a;
    },
    // 🔴 KNOWN GAP — grok CAN COMMIT, and codex cannot.
    // codex makes `.git/` read-only inside workspace-write, which is what enforces the
    // house rule "delegated models never commit" at the syscall. grok's `strict` profile
    // makes the whole CWD writable, `.git/` included. The CLI does have `--deny <RULE>`
    // for this, but the rule syntax is undocumented on the pages consulted and a guessed
    // rule that silently matches nothing is worse than no rule — it would read as a
    // boundary while being decoration.
    // Until the syntax is verified against a real install: review `git -C <dir> log` after
    // a grok --write run, not just the diff.
  },

  // Cursor CLI. A fourth quota pool: the Cursor subscription, which is metered separately
  // from Anthropic's, OpenAI's and xAI's — and which carries models from all of them, so
  // one subscription here can reach Grok, GPT and Claude without a second bill.
  //
  // Worth being clear about what this is NOT: Cursor is a harness, like opencode. The
  // alias names a model inside somebody else's agent loop, and the boundary is whatever
  // that loop enforces. Run `agent --list-models` to see what your plan actually offers;
  // do not invent model strings.
  //
  // Argument shape verified against `agent --help` on 2026.08.11-e8db854. What a run has
  // NOT yet confirmed is the behaviour: whether `--mode ask` really refuses an edit, and
  // whether `--sandbox enabled` actually holds a write inside --workspace. Until it does,
  // treat the confinement claim as documentation.
  cursor: {
    kind: 'cli',
    // ⚠️ The binary really is called `agent`, which is about as generic as a name on PATH
    // can get. If something else on this machine owns that name, override `bin` in
    // crossmodel.config.json rather than renaming anything system-wide.
    bin: 'agent',
    supportsSchema: false,
    supportsWrite: true,
    // UNVERIFIED: `--output-format stream-json` exists, its event schema does not appear in
    // the docs. Off until someone captures real output — a guessed parser drops answers.
    supportsStream: false,
    // 🟡 Cursor DOES have reasoning effort — it is just not a flag. The tier is baked into
    // the model id (`cursor-grok-4.6-low` … `-xhigh`, each with an optional `-fast`), which
    // `agent --list-models` spells out. `--model 'name[effort=high]'` is also accepted for
    // "parameterized" models, but which ids qualify is not stated anywhere, and a bracket
    // on a model that does not take one is an error at the worst moment.
    // So --effort is announced as unsupported and REFUSED rather than dropped: pick the
    // tier by choosing the alias. A silently ignored --effort would mean believing a run
    // reasoned harder than it did, which is worse than an error because you act on it.
    supportsEffort: false,
    // 🔴 --sandbox takes `enabled` or `disabled` and nothing else — there is no network
    // knob and no read-only/strict distinction. "Read-only with network" and "write without
    // network" are simply not expressible here, so --network is refused rather than
    // accepted and ignored.
    supportsNetwork: false,
    supportsResume: true,
    args: ({ model, prompt, cwd, write, resume }) => {
      const a = ['-p'];
      // 🔴 `-p` IS NOT READ-ONLY. The parameter reference is explicit: it "has access to all
      // tools, including write and shell". A sweep would therefore be writable unless the
      // mode says otherwise, which is the opposite of every other provider here. `ask` is
      // Cursor's read-only mode; passing it is not optional.
      // `--force` under write, `--mode ask` for a sweep. That is the whole permission
      // story here, and it is a MODE, not a boundary: `ask` means "this is a question",
      // not "this agent is untrusted". Headless has nobody to approve a tool call, so
      // without --force a write run either hangs or comes back having done nothing.
      if (write) a.push('--force'); else a.push('--mode', 'ask');
      //
      // 🔴 --sandbox IS DELIBERATELY NOT PASSED. crossmodel used to send `--sandbox
      // enabled` on every write and let the run die when it would not start, on the theory
      // that a weaker boundary than the caller expects is worse than no run. That theory
      // was wrong here, for two reasons.
      //
      // It made delegated work weaker than the same work done by hand: Cursor's own
      // default is allowlist mode, so `agent` writes fine on a machine where
      // `crossmodel --model cgrok --write` refused outright. A wrapper that forbids what
      // the tool permits is a wrapper people route around.
      //
      // And the thing it refused over is a packaging bug, not a risk. DIAGNOSED 2026-08-13
      // from the kernel audit log:
      //   apparmor="DENIED" operation="capable" profile="cursor_sandbox_agent_cli"
      //   comm="newuidmap" capability=dac_override
      // Cursor ships /etc/apparmor.d/cursor-sandbox with a profile scoped to
      // /home/*/.local/share/cursor-agent/versions/*/cursorsandbox, granting sys_admin,
      // setuid and setgid but NOT dac_override — which `newuidmap`, the setuid helper that
      // writes the namespace uid map, needs. Their profile, their gap; the machine is fine
      // (plain `unshare --user --map-root-user` works, and the IDE profile is unaffected).
      //
      // The boundary that was doing the real work all along is the orchestrator reading
      // the diff, plus a throwaway worktree. Use `--worktree`.
      if (write) a.push('--sandbox', 'disabled');
      // Headless has nobody to answer a workspace-trust prompt, and the run would hang.
      a.push('--trust', '--output-format', 'text', '--model', model);
      // Like opencode's --dir and grok's --cwd: the working directory is a FLAG, not the
      // spawned process's cwd. crossmodel sets both.
      if (cwd) a.push('--workspace', cwd);
      if (resume) a.push(...(resume === 'last' ? ['--continue'] : [`--resume=${resume}`]));
      // Confirmed against the binary: `Usage: agent [options] [command] [prompt...]`, and
      // `-p, --print` carries `(default: false)`, so it is a boolean and the prompt is a
      // trailing positional. The docs' own example (`agent -p "..." --model ...`) reads as
      // if -p took the value, which is why this was worth checking rather than assuming.
      a.push(prompt);
      return a;
    },
    // Never pass --api-key: it would put the secret in argv, where any other user on the
    // machine can read it out of `ps`. CURSOR_API_KEY in the environment is inherited by
    // the child already.
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
  // xAI's coding model, named in the Grok Build launch post. Only ONE alias ships, on
  // purpose: `grok models` lists what your subscription actually offers, and inventing
  // alias names for models nobody here has called is how gemini and ollama ended up as
  // entries that fail on first use. Add the rest via crossmodel.config.json.
  grok:   { provider: 'grok', model: 'grok-build-0.1' },
  // Grok 4.6 through a Cursor subscription — one bill, somebody else's model. Worth
  // shipping alongside the direct xAI alias because a Cursor subscription is a pool many
  // people already have, while Grok Build's own CLI needs a second one.
  // Model id read from `agent --list-models` on 2026-08-13, not guessed — the first draft
  // of this line said "grok-4.6" and no such id exists. The trailing tier is the reasoning
  // effort: -low, -medium, -high, -xhigh, each with an optional -fast. Add the tiers you
  // actually use to crossmodel.config.json; `agent --list-models` is the authority.
  cgrok: { provider: 'cursor', model: 'cursor-grok-4.6-high' },
};

// ------------------------------------------------------------ user overrides

// 🔴 $HOME FIRST, AND THAT ORDER IS THE WHOLE POINT.
// An installed plugin lives at .../cache/<mkt>/<plugin>/<VERSION>/, so every update creates
// a new directory and everything the user wrote into the old one is gone. lib/mode.mjs
// spells this out and moves mode.json and routing.json to $HOME for exactly that reason —
// and the model registry, the one file people hand-edit most, was left behind in the
// versioned tree for several releases. Upgrading silently reverted you to the built-in
// aliases. The plugin-local paths stay as a fallback so existing installs keep working.
export const CONFIG_NAMES = [
  path.join(USER_DIR, 'crossmodel.config.json'),
  // Relative to lib/ now, and these two still mean the SAME legacy locations they meant
  // when this file lived in bench/: <plugin>/bench/ and <plugin>/. Getting them wrong on
  // the move would silently stop finding an existing user config.
  '../bench/crossmodel.config.json',
  '../crossmodel.config.json',
];

function loadUserConfig() {
  for (const name of CONFIG_NAMES) {
    const p = path.isAbsolute(name) ? name : path.resolve(ROOT, name);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      // Valid JSON is not a valid config. `null`, an array, or a bare string all parse
      // cleanly and then blow up on the first property access — an uncaught TypeError from
      // inside a library, which reads as a crossmodel bug rather than your typo.
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        console.error(`crossmodel: ${p} must be a JSON object — it was IGNORED.`);
        continue;
      }
      return { ...raw, _path: p };
    } catch (e) {
      // Never fall back silently — a malformed config that quietly reverts to defaults
      // is exactly the failure this project exists to prevent.
      console.error(`crossmodel: ${p} is malformed and was IGNORED — ${e.message}`);
    }
  }
  return {};
}

const userCfg = loadUserConfig();

export const CONFIG_PATH = userCfg._path ?? null;
export const PROVIDERS = { ...BUILTIN_PROVIDERS, ...(userCfg.providers ?? {}) };
export const MODELS = { ...BUILTIN_MODELS, ...(userCfg.models ?? {}) };

// ------------------------------------------------------------------ transport

// ── how a run is allowed to end ──────────────────────────────────────────────────────
// 🔴 THERE IS NO WALL-CLOCK DEADLINE BY DEFAULT, AND THAT IS THE POINT.
// Measured against real use: the failure that actually costs money here is not a hung
// provider — it is a deadline chosen by whoever wrote the command. An orchestrator that
// guesses "10 minutes should be enough" kills a 25-minute implementation run at minute 10,
// and the tokens already spent are gone with nothing to show. That happened repeatedly;
// a genuinely hung provider did not.
//
// So duration is not the signal. SILENCE is. A run emitting events is alive no matter how
// long it takes; a run that has produced no byte on either pipe for a long stretch is dead
// or wedged. `idleMs` kills only the second kind, and any byte on stdout OR stderr resets
// it — which covers providers with an event stream (codex) and providers that merely print
// as they go (opencode, grok).
//
// 🔴 AND THE IDLE WATCHDOG IS OFF BY DEFAULT TOO. It shipped at 20 minutes for about an
// hour, and that default was wrong for a reason worth writing down: SILENCE ONLY MEANS
// SOMETHING WHEN THERE IS A STREAM TO BE SILENT ON. With `--no-stream`, or with any
// provider that has no event output, a healthy run prints nothing at all until it finishes
// — an adversarial review on luna runs ~40 minutes that way. A watchdog on bytes would have
// killed a working run and called it wedged, which is the same failure as the guessed
// deadline, wearing a better argument.
//
// So nothing kills a run automatically. What replaces it is visibility, not a timer: the
// CLI already prints a heartbeat naming how long the silence has lasted, and Ctrl-C now
// takes the whole process group down. A human or an orchestrator watching that line can
// decide; a clock cannot.
//
// `--idle-timeout <ms>` is there for unattended batches, where nobody is reading the
// heartbeat and a wedged run would sit burning a slot until someone noticed.
export const DEFAULT_IDLE_MS = 0; // no automatic kill; opt in with --idle-timeout

// Every live child, so one set of signal handlers can take them all down. Registered once
// at module scope rather than per call: the battery runs models in parallel, and adding two
// listeners per concurrent run trips Node's max-listeners warning.
const LIVE = new Set();

/** SIGKILL a child's whole process group, falling back to the child alone. */
function killTree(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

let signalsWired = false;
function wireSignals() {
  if (signalsWired) return;
  signalsWired = true;
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(sig, () => {
      for (const pid of LIVE) killTree(pid);
      process.exit(code);
    });
  }
}

function runCli(bin, args, timeoutMs, cwd, onLine, extraEnv, idleMs = DEFAULT_IDLE_MS) {
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
    //
    // `detached: true` puts the child in its own PROCESS GROUP so a kill can take the whole
    // tree. Killing only the direct child left the `npm test` it had spawned running after
    // crossmodel had already reported a timeout — and under --write that orphan keeps
    // writing into a tree the caller now believes is settled. The cost of detaching is that
    // the terminal's Ctrl-C no longer reaches the child, so the parent forwards it by hand
    // (see the signal handlers below). Both halves are required; neither works alone.
    const p = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      ...(cwd ? { cwd } : {}),
      // Some providers take their boundary from configuration rather than a sandbox, and
      // configuration arrives through the environment. See the opencode entry.
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });

    let out = '', err = '', done = false;

    // Ctrl-C must still stop the provider: a detached group outlives the parent and would
    // keep burning the provider's quota with nobody watching.
    LIVE.add(p.pid);
    wireSignals();

    let hardTimer = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      hardTimer = setTimeout(() => {
        done = true;
        killTree(p.pid);
        resolve({ ok: false, ms: Date.now() - t0, error: `timed out after ${timeoutMs}ms (explicit --timeout)`, text: out, timedOut: 'hard' });
      }, timeoutMs);
    }

    // Idle watchdog. Rearmed on every byte, so it measures silence, never duration.
    let idleTimer = null;
    const armIdle = () => {
      if (!(Number.isFinite(idleMs) && idleMs > 0)) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        done = true;
        killTree(p.pid);
        resolve({
          ok: false,
          ms: Date.now() - t0,
          error: `no output for ${Math.round(idleMs / 1000)}s — treated as wedged and killed. ` +
                 'Raise or disable this with --idle-timeout; it is NOT a limit on how long a run may take.',
          text: out,
          timedOut: 'idle',
        });
      }, idleMs);
    };
    armIdle();

    const finish = () => {
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      LIVE.delete(p.pid);
    };

    p.stdout.on('data', (d) => {
      armIdle();
      out += d;
      if (!onLine) return;
      pending += d;
      const lines = pending.split('\n');
      pending = lines.pop() ?? ''; // last element is the unterminated remainder
      for (const line of lines) if (line.trim()) onLine(line);
    });
    p.stderr.on('data', (d) => { armIdle(); err += d; });
    p.on('error', (e) => {
      if (done) return;
      finish();
      // E2BIG is reachable with a large --file: a single argv entry is capped around 128 KB
      // by the kernel, and the bare "spawn E2BIG" explains nothing at all.
      const hint = e.code === 'ENOENT'
        ? ` (is "${bin}" installed and on PATH?)`
        : e.code === 'E2BIG'
          ? ' (the prompt is too large to pass as a command-line argument — the kernel caps a single' +
            ' argv entry at roughly 128 KB. Shrink it, or point --cwd at the files and let the agent read them itself.)'
          : '';
      resolve({ ok: false, ms: Date.now() - t0, error: e.message + hint, text: '' });
    });
    p.on('close', (code) => {
      if (done) return;
      finish();
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
 * Every reason a call would be refused before a process is spawned, as a string, or null.
 *
 * Extracted so a CALLER can ask the question BEFORE doing anything with a side effect.
 * bin/crossmodel.mjs states the rule — "a check must never cost more than the thing it is
 * checking" — and then created a git worktree, a branch and a set of symlinks before
 * reaching these checks, so `--worktree x --write --network` on a provider without a
 * network toggle left the user cleaning up after an argument error. callModel still runs
 * them itself: this is a second door on the same room, not a replacement for the lock.
 */
export function capabilityError(alias, opts = {}) {
  const entry = MODELS[alias];
  if (!entry) return `unknown model alias: ${alias}. Known: ${Object.keys(MODELS).join(', ')}`;
  const provider = PROVIDERS[entry.provider];
  if (!provider) return `model "${alias}" points at unknown provider "${entry.provider}"`;

  if (opts.write && !opts.cwd) {
    return 'write mode requires an explicit cwd — refusing to inherit the caller\'s directory as the writable scope.';
  }
  if (opts.write && provider.supportsWrite === false) {
    return `provider "${entry.provider}" has no write mode wired up in crossmodel; run without --write.`;
  }
  // Each capability is announced, never assumed. Silently dropping `--effort` would mean
  // believing a run was reasoning harder than it was — the kind of wrong belief that is
  // worse than an error, because you act on it.
  if (opts.effort && provider.supportsEffort !== true) {
    return `provider "${entry.provider}" has no reasoning-effort control in crossmodel; drop --effort.`;
  }
  if (opts.network && provider.supportsNetwork !== true) {
    return `provider "${entry.provider}" has no network toggle in crossmodel; drop --network.`;
  }
  if (opts.resume && provider.supportsResume !== true) {
    return `provider "${entry.provider}" cannot resume a session in crossmodel; drop --resume.`;
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
    return '--network requires --write (codex scopes the toggle to its workspace-write sandbox).\n' +
      '  For a read-only sweep that still needs the internet, stage what it must read in a\n' +
      '  throwaway directory and point --cwd there — the original tree is then untouchable.';
  }
  return null;
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

  // Same checks bin/ runs before it creates anything. Duplicated on purpose: callModel is
  // a public entry point, and the battery calls it directly.
  const refusal = capabilityError(alias, opts);
  if (refusal) return fail(entry, refusal);

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

  // No wall-clock ceiling unless the caller asked for one — see DEFAULT_IDLE_MS above for
  // why duration is the wrong thing to bound.
  const r = await runCli(
    provider.bin,
    provider.args(ctx),
    opts.timeoutMs ?? null,
    opts.cwd,
    onLine,
    extraEnv,
    opts.idleMs ?? DEFAULT_IDLE_MS,
  );

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
