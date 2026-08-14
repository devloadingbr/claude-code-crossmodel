#!/usr/bin/env node
// crossmodel — call any registered model with one command.
//
//   crossmodel --model luna "Review this function and list only correctness defects"
//   crossmodel --model luna --file ./patch.diff "Review this diff"
//   crossmodel --list
//
// Every provider is an agentic CLI: it runs in a working directory, reads the tree, and
// with --write may edit inside it. The alias hides which binary that is.
//
// Exit codes:
//   0  success — the model's answer is on stdout
//   1  usage error (unknown alias, missing prompt)
//   2  the call failed (provider unavailable, timeout, non-zero exit)
//
// Exit code 2 matters: an error must never be mistaken for an answer. Anything
// consuming this must check the exit code before trusting stdout.

import { readFileSync, existsSync, appendFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { callModel, MODELS, availableModels, capabilityError, DEFAULT_IDLE_MS } from '../lib/providers.mjs';
import { readMode, writeMode, clearMode, parseUntil, describeUntil, MODE_PATH } from '../lib/mode.mjs';
import { codexUsage, describeWindow, describeReset, bar } from '../lib/usage.mjs';
import { teach, teachTarget } from '../lib/teach.mjs';
import { installCursor } from '../lib/install.mjs';

const argv = process.argv.slice(2);

// Every flag this build understands. Kept as data so an unrecognised `--something` can be
// REFUSED rather than skipped — see the check further down. Adding a flag means adding it
// here, which is the point: a flag the parser does not know about is a flag that silently
// does nothing.
const VALUE_FLAGS = new Set(['model', 'file', 'timeout', 'idle-timeout', 'schema', 'cwd', 'effort', 'resume', 'worktree', 'log', 'link', 'prefer', 'until']);
const BOOL_FLAGS = new Set(['write', 'network', 'quiet', 'no-stream', 'list', 'help', 'version', 'json', 'dry-run', 'no-enforce']);

const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  // A flag at the end of the line, or one followed by another flag, has no value. Returning
  // undefined made that indistinguishable from "not passed": `--timeout` alone fell back to
  // the default, and `--cwd` alone let the child inherit the caller's directory. Both are
  // silent, and the second one is a scope decision made by accident.
  if (v === undefined || v.startsWith('--')) {
    console.error(`crossmodel: --${name} needs a value${v === undefined ? ' (nothing followed it)' : `, got the flag "${v}"`}.`);
    process.exit(1);
  }
  return v;
};
const has = (name) => argv.includes(`--${name}`);

// The installed plugin lives under a versioned path and a shim usually picks the newest
// one, so "which build am I actually running" is a real question with a confusing answer.
// Printing it turns "that subcommand does not exist" into "you are on an older build".
const VERSION = (() => {
  try {
    // fileURLToPath, not `.pathname`: the latter is percent-encoded, so a plugin installed
    // under a path with a space reports its version as "unknown" — which then appears in
    // the unknown-subcommand error as "this build (unknown)", the exact useless message
    // that error was written to replace.
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(path.join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

if (has('version')) {
  console.log(`crossmodel ${VERSION}`);
  process.exit(0);
}

// ── `crossmodel mode` ────────────────────────────────────────────────────────────────
// Saver mode is a standing bias, not a one-off flag: while it is on, the routing hook
// injects a short "delegate by default" reminder into every turn instead of waiting for
// the #route trigger. Deadline-bounded so it cannot be left on by accident.
if (argv[0] === 'mode') {
  const sub = argv[1] ?? 'status';
  const now = new Date();

  if (sub === 'status') {
    const m = readMode(now);
    if (m.error) { console.error(`crossmodel: ${m.error}`); process.exit(2); }
    if (m.expired) { clearMode(); console.log(`saver mode: OFF (expired ${new Date(m.until).toLocaleString()})`); process.exit(0); }
    if (!m.active) { console.log('saver mode: OFF'); process.exit(0); }
    console.log(`saver mode: ON — ${describeUntil(m.until, now)}${m.model ? `, preferring "${m.model}"` : ''}`);
    console.log(`state: ${MODE_PATH}`);
    process.exit(0);
  }

  if (sub === 'off') {
    clearMode();
    console.log('saver mode: OFF');
    process.exit(0);
  }

  if (sub === 'on') {
    const untilRaw = flag('until');
    let until = null;
    if (untilRaw) {
      const d = parseUntil(untilRaw, now);
      // An unparseable deadline is an error, never "no deadline" — a typo must not
      // silently pin saver mode on forever.
      if (!d) {
        console.error(`crossmodel: cannot parse --until "${untilRaw}". Try 6h, 2d, sunday, or an ISO date.`);
        process.exit(1);
      }
      if (d.getTime() <= now.getTime()) {
        console.error(`crossmodel: --until "${untilRaw}" resolves to the past (${d.toLocaleString()}).`);
        process.exit(1);
      }
      until = d.toISOString();
    }

    const model = flag('prefer');
    if (model && !MODELS[model]) {
      console.error(`crossmodel: unknown model "${model}". Known: ${Object.keys(MODELS).join(', ')}`);
      process.exit(1);
    }

    writeMode({ active: true, until, model: model ?? null, startedAt: now.toISOString() });
    console.log(`saver mode: ON — ${describeUntil(until, now)}${model ? `, preferring "${model}"` : ''}`);
    console.log('Every turn now carries a short "delegate by default" reminder. Turn it off with: crossmodel mode off');
    process.exit(0);
  }

  console.error(`crossmodel: unknown "mode" subcommand "${sub}". Use: on | off | status`);
  process.exit(1);
}

// ── `crossmodel usage` ───────────────────────────────────────────────────────────────
// The number behind the whole premise. "Spend their quota instead of yours" is a claim
// you cannot check without it — and an empty pool announces itself as a refused run in
// the middle of a batch, which is the worst moment to find out.
// ── `crossmodel teach` ───────────────────────────────────────────────────────────────
// Writes a short primer into a project's CLAUDE.md, between markers, so it can be updated
// or removed without touching anything else. Deliberately NOT part of installing the
// plugin: CLAUDE.md is versioned and ships to everyone who clones the repo, so editing it
// is the user's call, made once, in the open.
if (argv[0] === 'teach') {
  const dest = teachTarget({ host: flag('host'), file: flag('file') });
  if (dest.error) {
    console.error(`crossmodel: ${dest.error}`);
    process.exit(1);
  }
  const target = dest.path;
  const existed = existsSync(target);

  if (has('dry-run')) {
    const { primer } = await import('../lib/teach.mjs');
    const av = await availableModels();
    process.stdout.write(`${primer(Object.entries(av).map(([alias, v]) => ({ alias, ...v })))}\n`);
    console.error(`\ncrossmodel: dry run — nothing written. Target would be ${target}.`);
    process.exit(0);
  }

  const av = await availableModels();
  const r = teach(target, Object.entries(av).map(([alias, v]) => ({ alias, ...v })));
  if (!r.ok) {
    console.error(`crossmodel: refusing to edit ${target} — ${r.error}`);
    process.exit(1);
  }

  console.error(`crossmodel: ${r.action} the crossmodel block in ${target}`);
  if (r.action === 'unchanged') {
    console.error('crossmodel: already up to date.');
  } else {
    console.error('crossmodel: only the text between the BEGIN/END markers is managed — edit around it freely.');
    // It is a tracked file in someone's repo. Saying how to look and how to undo costs one
    // line and saves the "what did that just do to my project" moment.
    const inRepo = spawnSync('git', ['-C', path.dirname(target), 'rev-parse', '--git-dir'], { encoding: 'utf8' }).status === 0;
    if (inRepo) console.error(`crossmodel: review it with \`git diff ${path.basename(target)}\` before committing.`);
    else if (existed) console.error('crossmodel: this file is not in a git repo — there is no undo but your own backup.');
  }
  process.exit(0);
}

// ── `crossmodel install` ─────────────────────────────────────────────────────────────
// Wire a host other than Claude Code. Explicit, like teach: never runs as a side
// effect of npm install, because the files live in $HOME and are the user's.
if (argv[0] === 'install') {
  const host = flag('host');
  if (!host) {
    console.error('crossmodel: install needs --host. Currently: --host cursor');
    process.exit(1);
  }
  if (host !== 'cursor') {
    console.error(`crossmodel: unknown --host "${host}". Currently: cursor (Claude Code installs via the plugin).`);
    process.exit(1);
  }

  const r = installCursor({ dryRun: has('dry-run'), noEnforce: has('no-enforce') });
  if (!r.ok) {
    console.error(`crossmodel: install failed — ${r.error}`);
    process.exit(1);
  }

  if (has('dry-run')) {
    console.error(`crossmodel: dry run — would write:`);
    console.error(`  shim  ${r.shim}  (${r.actions.shim})`);
    console.error(`  rule  ${r.rule}  (${r.actions.rule})`);
    console.error(`  skill ${r.skill} (${r.actions.skill})`);
    console.error(`  hookShim  ${r.hookShim}  (${r.actions.hookShim})`);
    console.error(`  hooksJson ${r.hooksJson} (${r.actions.hooksJson})`);
    console.error('crossmodel: Grep/Glob and Task explore|delegate|probe are denied; Read, Shell, and Grep of one file are not. --no-enforce skips/removes that gate.');
    process.exit(0);
  }

  const alreadyUpToDate = ['shim', 'rule', 'skill', 'hookShim', 'hooksJson'].every((key) => r.actions[key] === 'unchanged' || r.actions[key] === 'skipped');
  console.error(`crossmodel: Cursor host ${alreadyUpToDate ? 'already up to date' : 'installed'}`);
  console.error(`  shim  ${r.shim}  (${r.actions.shim})`);
  console.error(`  rule  ${r.rule}  (${r.actions.rule})  — always-on; Cursor agent will see it next session`);
  console.error(`  skill ${r.skill} (${r.actions.skill})`);
  console.error(`  hookShim  ${r.hookShim}  (${r.actions.hookShim})`);
  console.error(`  hooksJson ${r.hooksJson} (${r.actions.hooksJson})`);
  console.error('crossmodel: Grep/Glob and Task explore|delegate|probe are denied; Read, Shell, and Grep of one file are not. --no-enforce skips/removes that gate.');
  if (r.pathHint) {
    console.error(`crossmodel: ${path.dirname(r.shim)} is not on PATH. Add it, or the agent cannot find the binary.`);
  }
  console.error('crossmodel: enable Settings → Rules, Skills, Subagents → Include third-party Plugins so the Claude hooks (#route, saver, notice) load.');
  console.error('crossmodel: new Cursor chats pick up the rule; this one needs a restart.');
  process.exit(0);
}

if (argv[0] === 'usage') {
  const u = codexUsage();
  const n = (x) => (x ?? 0).toLocaleString();

  if (has('json')) {
    console.log(JSON.stringify(u, null, 2));
    process.exit(u.ok ? 0 : 2);
  }

  if (!u.ok) {
    console.error(`crossmodel: no usage data for codex — ${u.why}`);
    console.error('Run something through codex first; the numbers come from its session transcripts.');
    process.exit(2);
  }

  const l = u.limit;
  console.log(`codex${l?.plan ? ` — plan ${l.plan}` : ''}`);
  if (!l) {
    // Transcripts exist but none carried a snapshot: report the gap instead of printing
    // a comforting 0%, which would read as "plenty left".
    console.log('  quota    unknown — no rate-limit snapshot in the recent transcripts');
  } else {
    const pct = l.usedPercent;
    console.log(`  quota    ${bar(pct)}  ${pct == null ? '?' : `${pct}%`} used of the last ${describeWindow(l.windowMinutes)}`);
    if (l.secondaryPercent != null) console.log(`  second.  ${bar(l.secondaryPercent)}  ${l.secondaryPercent}% used`);
    console.log(`  resets   ${describeReset(l.resetsAt)}`);
    if (l.credits) {
      const c = l.credits.unlimited ? 'unlimited' : l.credits.has_credits ? `balance ${l.credits.balance}` : 'none';
      console.log(`  credits  ${c}`);
    }
    if (l.reached) console.log(`  ⚠ LIMIT REACHED (${l.reached}) — calls are being refused right now.`);
  }

  console.log('  tokens   last 24h   ' + `${n(u.tokens.day.input)} in / ${n(u.tokens.day.output)} out  (${u.tokens.day.sessions} sessions)`);
  console.log('           last 7d    ' + `${n(u.tokens.week.input)} in / ${n(u.tokens.week.output)} out  (${u.tokens.week.sessions} sessions)`);
  if (u.truncated) console.log('  note     older sessions beyond the scan cap were not counted.');
  console.log(`\nRead from ${u.sessionsDir} — no network call, works mid-run.`);
  process.exit(0);
}

if (has('help') || (!argv.length)) {
  console.log(`crossmodel — call any registered model

  crossmodel --model <alias> "<prompt>"
  crossmodel --model <alias> --file <path> "<instruction>"
  crossmodel --model <alias> --cwd <dir> "<sweep instruction>"
  crossmodel --list
  crossmodel usage [--json]
  crossmodel mode on|off|status
  crossmodel teach [--host cursor|claude] [--file CLAUDE.md] [--dry-run]
  crossmodel install --host cursor [--dry-run] [--no-enforce]

Teach — put a short primer in a project's CLAUDE.md (or AGENTS.md with --host cursor):
  crossmodel teach --dry-run              # print it, write nothing
  crossmodel teach                        # write it into ./CLAUDE.md
  crossmodel teach --host cursor          # write it into ./AGENTS.md

  Names the aliases that actually work on this machine, and covers what cannot be guessed
  from the code: exit-code semantics, which provider is genuinely sandboxed, and that
  delegated models never commit. Lives between BEGIN/END markers, so re-running updates
  it in place and deleting those lines removes it. Nothing outside the markers is touched.

Install — wire Cursor as an orchestrator (user-level, $HOME only, never a project repo):
  crossmodel install --host cursor        # shim on PATH, always-on rule, setup skill, enforcement hook
  crossmodel install --host cursor --dry-run
  crossmodel install --host cursor --no-enforce  # skip/remove the enforcement hook

Usage — how much of the provider's quota is left:
  crossmodel usage

  Reads codex's own session transcripts, so there is no network call and it works while
  a run is still in flight. Add --json for scripting. Exit 2 when there is no data,
  because "no reading" must never be mistaken for "nothing used".

Saver mode — for when this session's quota is nearly spent:
  crossmodel mode on --until sunday --prefer luna
  crossmodel mode status
  crossmodel mode off

  While it is on, every turn carries a short "delegate by default" reminder instead of
  waiting for the #route trigger. --until accepts 6h, 2d, a weekday, or an ISO date, and
  the mode expires on its own so it cannot be left on by accident.

Options:
  --model <alias>    which model (see --list)
  --cwd <dir>        directory the model may read and explore. These CLIs are agentic —
                     give them a repo and they grep and read it themselves, so you do
                     not have to paste code into the prompt.
  --write            let the model edit files inside --cwd (required with it). Off by
                     default only because a sweep should not edit by accident — not
                     because writing is a privilege. Writing is the job.

                     THE POLICY, everywhere, every provider: the agent works freely —
                     reads, edits, runs the build, runs the tests — and does not touch
                     git history. Committing is the orchestrator's, because a change in
                     the working tree is a diff you can throw away and a commit is a fact
                     other work builds on.

                     That rule is a CONTRACT, not a lock. codex is the only provider that
                     enforces it in the kernel (.git/ is read-only inside its sandbox);
                     everywhere else a determined agent could reach git through a shell.
                     The thing that actually protects you is reviewing the diff, so make
                     that cheap: point --write at --worktree and read what came back.
  --worktree <dir>   create (or reuse) an isolated git worktree and use it as --cwd.
                     Requires --write. node_modules is symlinked in automatically, because
                     a worktree that cannot run the project's tests cannot verify its own
                     work. The worktree is left behind for you to review and remove —
                     that review is the point.
  --link a,b         extra paths to symlink into the worktree, comma separated. For the
                     gitignored files a fresh checkout lacks and the tests need, such as
                     a local .env.
  --log <file>       also write the progress lines and the answer to a file. Use this
                     instead of redirecting stderr, which silences the live view.
  --effort <level>   reasoning effort, provider vocabulary (codex: minimal|low|medium|
                     high|xhigh). Omit for the provider default.
  --network          let the agent reach the network. OFF by default and requires --write.
                     Turn it on when the agent must run the project's real verification —
                     a test suite that talks to a local database cannot run without it, and
                     an agent that cannot run your tests hands back unverified code.
  --resume <id>      continue an existing session instead of starting cold; "last" picks
                     the most recent. Use after a run dies — the context it already paid
                     for survives, and re-reading the repo is the expensive part.
  --file <path>      append a file's contents to the prompt
  --timeout <ms>     a HARD ceiling. There is NO DEFAULT — omit it. A run takes as long as
                     it takes, and the deadline somebody guessed is what actually kills
                     runs and wastes everything already spent. Under --write, values below
                     600000 are refused: a kill mid-run leaves half-applied edits with no
                     rollback.
  --idle-timeout <ms>
                     kill a run that has produced NO output for this long. ALSO OFF BY
                     DEFAULT: silence only means something when there is a stream to be
                     silent on, and with --no-stream (or a provider without one) a healthy
                     run prints nothing until it finishes — an adversarial review runs ~40
                     minutes that way. For unattended batches where nobody is watching the
                     heartbeat. Nothing kills a run automatically otherwise; the heartbeat
                     reports the silence and Ctrl-C stops the whole process group.
  --schema <path>    JSON Schema for structured output (only providers whose CLI
                     supports it, e.g. codex. Elsewhere it is dropped with a
                     warning on stderr — never silently, or you would trust a shape
                     nothing enforced)
  --list             show which models are usable here, then exit
  --version          print the build you are actually running. Worth checking when a
                     subcommand you expected is missing: the plugin installs under a
                     versioned path, so an old build can linger.
  --quiet            print only the answer, no stderr diagnostics
  --no-stream        do not report progress; wait in silence and print only the answer.
                     Progress is ON by default for providers that expose an event stream
                     (codex today): each file written, command run and message is echoed
                     to STDERR as it happens, so a long run is watchable instead of
                     looking hung. stdout still carries only the answer, so pipes and
                     $(...) capture are unaffected.

Sweep example — costs the provider's quota, not yours:
  crossmodel --model luna --cwd ~/myrepo \
    "Which files handle authentication? Answer as a list of path:line."

Write example — point it at an isolated worktree, review the diff yourself, commit yourself:
  git worktree add /tmp/wt-feature -b feature
  crossmodel --model luna --cwd /tmp/wt-feature --write \
    "Implement the spec in SPEC.md. Run the tests. Do not commit."
  git -C /tmp/wt-feature diff        # you review
  git -C /tmp/wt-feature commit ...  # you commit

Aliases are defined in lib/providers.mjs and can be extended or overridden with a
crossmodel.config.json — see crossmodel.config.example.json.`);
  process.exit(argv.length ? 0 : 1);
}

if (has('list')) {
  const av = await availableModels();
  const width = Math.max(...Object.keys(av).map((k) => k.length));
  for (const [alias, v] of Object.entries(av)) {
    const caps = v.ok ? `[reads files${v.write ? ', can --write' : ''}]` : `(${v.why})`;
    console.log(`${v.ok ? '  ok  ' : '  --  '}${alias.padEnd(width)}  ${MODELS[alias].provider}/${MODELS[alias].model}  ${caps}`);
  }
  console.log('\nAll providers are agentic CLIs: pass --cwd <dir> and they explore the repo themselves.');
  console.log('Nothing here is configured? Run /crossmodel-setup.');
  process.exit(0);
}

// Every subcommand has already claimed its argv[0] and exited by now. Anything left that
// LOOKS like one is a typo, or a subcommand from a version this install does not have —
// and without this check it silently becomes the prompt. That is not a cosmetic problem:
// `crossmodel moed status` would have sent "moed status" to a model and billed a real
// call for a typo. Reported from the field: `crossmodel teach` on an older build answered
// "--model is required", which explains nothing.
const SUBCOMMANDS = ['mode', 'usage', 'teach', 'install'];
const first = argv[0];
if (first && !first.startsWith('--') && !flag('model') && /^[a-z][a-z-]*$/.test(first)) {
  console.error(`crossmodel: "${first}" is not a subcommand of this build (${VERSION}).`);
  console.error(`  Known subcommands: ${SUBCOMMANDS.join(', ')}. Newer versions may add more —`);
  console.error('  update the plugin if you expected one that is missing.');
  console.error('  To send this as a PROMPT instead, pass --model: crossmodel --model <alias> "..."');
  process.exit(1);
}

const alias = flag('model');
if (!alias) {
  console.error('crossmodel: --model is required. Run --list to see options.');
  process.exit(1);
}
if (!MODELS[alias]) {
  console.error(`crossmodel: unknown model "${alias}". Known: ${Object.keys(MODELS).join(', ')}`);
  process.exit(1);
}

// The prompt is the first bare argument (anything not a flag or a flag's value).
//
// 🔴 AN UNRECOGNISED FLAG IS AN ERROR, NOT SOMETHING TO SKIP.
// This loop used to skip every token starting with `--`, known or not, so `--wrte` (a typo
// for --write) vanished without a word: the run went ahead read-only, the agent reported it
// could not write, and nothing anywhere said why. That is the same defect the unknown-
// subcommand check below was written to fix, one level down — a typo silently changing what
// the command does.
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    if (VALUE_FLAGS.has(name)) { i++; continue; }
    if (BOOL_FLAGS.has(name)) continue;
    console.error(`crossmodel: unknown flag "${a}". Run --help for the list.`);
    console.error('  A flag this build does not know is refused rather than ignored, because an ignored');
    console.error('  typo changes what the run does without saying so.');
    process.exit(1);
  }
  positional.push(a);
}

let prompt = positional.join(' ').trim();
const file = flag('file');
if (file) {
  try {
    prompt = `${prompt}\n\n${readFileSync(file, 'utf8')}`.trim();
  } catch (e) {
    console.error(`crossmodel: cannot read --file ${file}: ${e.message}`);
    process.exit(1);
  }
}
if (!prompt) {
  console.error('crossmodel: empty prompt.');
  process.exit(1);
}

let cwd = flag('cwd');
const write = has('write');

// 🔴 --cwd IS RESOLVED TO AN ABSOLUTE PATH HERE, AND THAT IS LOAD-BEARING.
// Several providers take their working directory as a FLAG (`--workspace` for cursor,
// `--dir` for opencode, `--cwd` for grok) while crossmodel ALSO sets the spawned process's
// cwd to the same place. A relative value therefore gets resolved twice, against itself:
// measured on the first cursor call ever made, `--cwd lib` became
// "Workspace directory does not exist: .../crossmodel/lib/lib". An absolute path cannot be
// re-resolved, so it is unambiguous no matter what the child does with it.
// --worktree already did this; --cwd did not, and nothing made that asymmetry visible.
if (cwd) {
  cwd = path.resolve(cwd);
  // Cheaper to say so now than to have the provider say it in its own vocabulary, after
  // the call has been billed.
  if (!existsSync(cwd)) {
    console.error(`crossmodel: --cwd ${cwd} does not exist.`);
    process.exit(1);
  }
}

// ── how a run is allowed to end ──────────────────────────────────────────────────────
// Validated HERE, before anything with a side effect runs. Creating a worktree and only
// then refusing the run would leave the user cleaning up after an argument error — a
// check must never cost more than the thing it is checking.
//
// 🔴 THERE IS NO DEFAULT DEADLINE. A run takes as long as it takes.
// This used to default to 40 min (sweep) / 1 h (write), and the defaults were not the
// problem — the flag was. Measured over real use: the run that dies and wastes everything
// already spent is almost never a hung provider. It is a deadline somebody guessed, usually
// an orchestrator writing `--timeout 300000` because five minutes sounded generous, on a
// task that needed twenty-five. The tokens are gone and there is nothing to resume from.
//
// Nothing replaces it automatically, either. The obvious substitute — kill a run that has
// gone quiet — is wrong for the same reason once you look at when a run is quiet: with
// --no-stream, or on any provider without an event stream, a perfectly healthy run prints
// NOTHING until it finishes, and an adversarial review on luna takes ~40 minutes like that.
// A byte-based watchdog would kill it and call it wedged. See DEFAULT_IDLE_MS.
//
// What actually guards against a wedged run is visibility plus a working Ctrl-C: the
// heartbeat below names how long the silence has lasted, and interrupting now takes the
// child's whole process group with it.
//
// --timeout and --idle-timeout both remain, both opt-in, for callers who genuinely want a
// ceiling — an unattended batch, where nobody is reading the heartbeat.
const WRITE_TIMEOUT_FLOOR_MS = 600_000; // below 10 min, an explicit --write ceiling is a coin flip

const timeoutRaw = flag('timeout');
let timeoutMs = null;
if (timeoutRaw !== null && timeoutRaw !== undefined) {
  timeoutMs = Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(`crossmodel: --timeout must be a positive number of milliseconds (got "${timeoutRaw}").`);
    console.error('  Omitting it is the recommended choice: there is no default deadline, only an idle watchdog.');
    process.exit(1);
  }
  // 🔴 A timeout kill is DESTRUCTIVE under --write: the process dies by SIGKILL wherever it
  // happens to be, and half-applied edits stay on disk with no rollback.
  if (write && timeoutMs < WRITE_TIMEOUT_FLOOR_MS) {
    console.error(
      `crossmodel: --timeout ${timeoutMs}ms is too short for --write. A kill mid-run leaves half-applied\n` +
      `edits on disk with no rollback, so this is refused rather than risked. Use at least ${WRITE_TIMEOUT_FLOOR_MS}ms,\n` +
      '  or — better — drop --timeout entirely. There is no default deadline; a silent run is still caught\n' +
      '  by the idle watchdog, and a working one is never killed for taking long.',
    );
    process.exit(1);
  }
  if (!has('quiet')) {
    console.error(`crossmodel: --timeout ${timeoutMs}ms is a HARD ceiling — the run is killed at that mark even if it is`);
    console.error('  actively working. Omit it unless you specifically want that.');
  }
}

// The idle watchdog, off unless asked for. `0` or `off` is the default state.
const idleRaw = flag('idle-timeout');
let idleMs = DEFAULT_IDLE_MS;
if (idleRaw !== null && idleRaw !== undefined) {
  idleMs = idleRaw === 'off' ? 0 : Number(idleRaw);
  if (!Number.isFinite(idleMs) || idleMs < 0) {
    console.error(`crossmodel: --idle-timeout must be milliseconds, or "off" (got "${idleRaw}").`);
    process.exit(1);
  }
  // Silence is only evidence when there is a stream to be silent on. Without one, a healthy
  // run is silent from start to finish and this flag becomes a disguised deadline.
  if (idleMs > 0 && has('no-stream') && !has('quiet')) {
    console.error('crossmodel: --idle-timeout with --no-stream is a deadline in disguise — a run with no event');
    console.error('  stream prints nothing until it finishes, so ANY silence budget will eventually kill a healthy run.');
  }
}

// ── --worktree: make the recommended path the easy path ──────────────────────────────
// The README has always said "point --write at an isolated git worktree". Saying it is not
// the same as making it convenient, and the manual version (create, remember to remove,
// remember it shares the object store) is exactly the kind of chore people skip. This
// creates the worktree, hands it over as --cwd, and leaves it in place afterwards —
// removal stays manual on purpose, because the whole point is that you review the diff.
// ── preflight: refuse before anything has a side effect ──────────────────────────────
// Every reason this call cannot work, asked BEFORE the worktree block below creates a
// directory, a branch and a set of symlinks. These checks used to live only inside
// callModel, which runs after all of that, so `--worktree x --write --network` on a
// provider with no network toggle left an orphaned worktree behind and then refused.
{
  const refusal = capabilityError(alias, {
    write,
    // The worktree does not exist yet; what matters here is only whether a writable scope
    // was named at all, which either flag satisfies.
    cwd: cwd ?? flag('worktree') ?? undefined,
    effort: flag('effort') ?? undefined,
    network: has('network'),
    resume: flag('resume') ?? undefined,
  });
  if (refusal) {
    console.error(`crossmodel: ${refusal}`);
    process.exit(1);
  }
}

const worktree = flag('worktree');
if (worktree) {
  if (cwd) {
    console.error('crossmodel: --worktree and --cwd are two answers to the same question. Pass one.');
    process.exit(1);
  }
  if (!write) {
    console.error('crossmodel: --worktree only makes sense with --write (a read-only sweep can just use --cwd).');
    process.exit(1);
  }
  const dir = path.resolve(worktree);
  if (!existsSync(dir)) {
    const branch = `crossmodel/${path.basename(dir)}`;
    const r = spawnSync('git', ['worktree', 'add', '-b', branch, dir], { encoding: 'utf8' });
    if (r.status !== 0) {
      // Falling back to "just write in the current repo" would be the worst possible
      // recovery: the user asked for isolation precisely so a bad run stays contained.
      console.error(`crossmodel: could not create the worktree at ${dir} — refusing to fall back to an unisolated directory.`);
      console.error((r.stderr || r.stdout || '').trim());
      process.exit(1);
    }
    if (!has('quiet')) console.error(`crossmodel: worktree ${dir} on branch ${branch}`);
  } else {
    // 🔴 An existing directory was being trusted on its name alone. `--worktree ~/Documents`
    // would have been announced as "reusing existing worktree" and then handed to the agent
    // as a write target — a flag whose entire purpose is isolation, silently delivering an
    // arbitrary directory. Verify, or refuse.
    const gitDir = spawnSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
    const commonDir = spawnSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' });
    if (gitDir.status !== 0) {
      console.error(`crossmodel: ${dir} already exists and is not a git worktree. Refusing to write there —`);
      console.error('  --worktree promises isolation, and an ordinary directory does not provide it.');
      console.error('  Remove it, pick another path, or pass --cwd if you really mean that directory.');
      process.exit(1);
    }
    // A LINKED worktree has .git pointing elsewhere, so these two differ. When they match,
    // this is the main checkout — writing there is precisely what --worktree exists to avoid.
    const isLinked = path.resolve(dir, gitDir.stdout.trim()) !== path.resolve(dir, commonDir.stdout.trim());
    if (!isLinked) {
      console.error(`crossmodel: ${dir} is the main checkout, not a linked worktree. Refusing —`);
      console.error('  this is the tree you are working in, which is the one --worktree is meant to protect.');
      process.exit(1);
    }
    if (!has('quiet')) console.error(`crossmodel: reusing existing worktree ${dir}`);
  }
  cwd = dir;

  // ── what git does NOT bring, and without which the worktree is decoration ──
  // A fresh worktree has no node_modules and no gitignored env files, so the agent
  // cannot run the very test suite it was asked to prove its work with. Measured
  // here: the first --worktree run was useless for exactly this reason, and the
  // manual fix (symlink node_modules, symlink scripts/dev/.env) had to be done by
  // hand anyway. An isolation flag that blocks verification isn't isolation, it's
  // a trap — so linking is the default, not an option.
  const source = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const repoRoot = source.status === 0 ? source.stdout.trim() : process.cwd();
  const extra = (flag('link') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const rel of ['node_modules', ...extra]) {
    const from = path.resolve(repoRoot, rel);
    const to = path.join(dir, rel);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      // A symlink, not a copy: node_modules is gigabytes and a copy would make the
      // flag too slow to reach for. Shared state is acceptable here because these
      // are installed artefacts and config, not the code under edit.
      symlinkSync(from, to);
      if (!has('quiet')) console.error(`crossmodel: linked ${rel} into the worktree`);
    } catch (e) {
      // Say it, don't swallow it — a missing link shows up later as a confusing
      // "cannot find module" from inside the agent, far from the cause.
      console.error(`crossmodel: could not link ${rel} (${e.message}) — the agent may fail to run the project's tests.`);
    }
  }
}

if (write && !cwd) {
  console.error('crossmodel: --write requires --cwd (or --worktree). Refusing to make the caller\'s current directory writable by accident.');
  process.exit(1);
}

const network = has('network');
const effort = flag('effort');
const resume = flag('resume');

// There was a `--unsandboxed` flag here for about an hour. It is gone, along with the
// premise that produced it: crossmodel does not rank providers into confinement tiers and
// does not withhold writing from an agent that was asked to write. Writing is the job. The
// orchestrator reviewing the diff is the boundary, and a throwaway `--worktree` is how you
// make that review cheap. See lib/permissions.mjs for the policy in one paragraph.
// ── progress reporting ───────────────────────────────────────────────────────────────
// Everything here goes to STDERR on purpose. stdout is the answer and nothing else —
// that contract is what lets callers do `$(crossmodel ...)` and pipe into other tools.
// Break it and every existing consumer silently starts ingesting progress chatter as
// if it were content.
//
// Two separate switches, on purpose. `--quiet` silences the REPORTING, but the event
// stream stays on, because it is also what strips the provider's banner out of the
// answer. Tying them together would make --quiet hand back a dirtier stdout than the
// default — the opposite of what the flag promises. Only --no-stream turns the stream off.
const streaming = !has('no-stream');
const reportProgress = streaming && !has('quiet');
const t0 = Date.now();

// `--log` writes everything the terminal shows to a file as well. Exists because the
// obvious workaround — redirecting stderr into a file — silences the live view, and the
// obvious fix for THAT (`2>&1 | tee`) is easy to forget: doing it wrong once already cost
// a whole run's visibility here.
const logPath = flag('log');
if (logPath) {
  try {
    writeFileSync(logPath, '');
  } catch (e) {
    console.error(`crossmodel: cannot write --log ${logPath}: ${e.message}`);
    process.exit(1);
  }
}
const say = (line) => {
  if (reportProgress) console.error(line);
  if (logPath) { try { appendFileSync(logPath, `${line}\n`); } catch { /* log is best-effort */ } };
};
const since = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`;
const clip = (s, n = 140) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
// Marker per event kind, so a wall of lines is still skimmable at a glance.
const MARK = {
  start: '·', thinking: '~', run: '$', 'run-failed': '!',
  edit: '✎', search: '?', message: '>', error: '!', done: '=',
};

// Heartbeat. An agent alternates between bursts of tool calls and long silent stretches
// where it is reasoning and writing — and the silent stretch is indistinguishable from a
// hang. That exact confusion happened here ("o luna parou?") on a run that was working
// fine. So silence itself gets reported.
const HEARTBEAT_MS = 60_000;
let lastEventAt = Date.now();
/**
 * A cheap fingerprint of everything git can see change in `dir`, including untracked
 * files. Returns null when there is nothing to compare against — outside a git repo — and
 * null must be read as "unknown", never as "unchanged".
 */
function treeSignature(dir) {
  if (!dir) return null;
  const run = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 15_000 });
  if (run(['rev-parse', '--git-dir']).status !== 0) return null;
  // --porcelain covers modified, staged, deleted and untracked. HEAD catches the case of
  // an agent that committed despite being told not to: history moved even if the tree
  // looks identical afterwards.
  const status = run(['status', '--porcelain', '--untracked-files=all']);
  const head = run(['rev-parse', 'HEAD']);
  if (status.status !== 0) return null;
  return `${head.stdout ?? ''} ${status.stdout ?? ''}`;
}

let filesWritten = 0;
const heartbeat = setInterval(() => {
  const quietFor = Date.now() - lastEventAt;
  if (quietFor < HEARTBEAT_MS) return;
  say(`  ${since()} … working, ${Math.round(quietFor / 1000)}s since the last event`);
}, HEARTBEAT_MS);
heartbeat.unref?.(); // never keep the process alive just to tick

const onEvent = streaming
  ? (e) => {
      lastEventAt = Date.now();
      if (e.kind === 'edit') filesWritten++;
      if (e.kind === 'start') { say(`  ${since()} · session ${e.id ?? '?'}`); return; }
      const body = clip(e.text, e.kind === 'message' ? 200 : 140);
      if (!body) return;
      say(`  ${since()} ${MARK[e.kind] ?? '·'} ${body}`);
    }
  : undefined;

// One header line, before anything runs. With `--json` the provider's own banner
// disappears, and with it the only visible confirmation of WHICH settings are in force —
// proving that `--effort xhigh` had actually taken meant digging through codex's session
// transcript by hand. Settings you cannot see are settings you cannot trust.
if (reportProgress || logPath) {
  const bits = [alias, effort ?? 'default effort', write ? 'write' : 'read-only', `network: ${network ? 'on' : 'off'}`];
  if (resume) bits.push(`resume: ${resume}`);
  say(`crossmodel: ${bits.join(' · ')} in ${cwd ?? process.cwd()}`);
}

// Snapshot for the no-op check below. Only providers with an event stream can report
// edits as they happen; for the rest the tree itself has to be asked. Cheap, and it runs
// before the model does anything.
const treeBefore = write ? treeSignature(cwd) : null;

const r = await callModel(alias, prompt, {
  timeoutMs,
  idleMs,
  schemaPath: flag('schema') ?? undefined,
  cwd: cwd ?? undefined,
  write,
  effort: effort ?? undefined,
  network,
  resume: resume ?? undefined,
  onEvent,
});

clearInterval(heartbeat);

if (!r.ok) {
  console.error(`crossmodel: call to ${alias} (${r.provider}/${r.model}) failed after ${r.ms}ms: ${r.error}`);
  // A died-mid-run agent leaves two things behind: possibly-partial edits, and a session
  // that still holds everything it read. Say both, because the instinct is to relaunch —
  // and relaunching pays the expensive part (reading the repo) all over again.
  // Only after a run that actually STARTED. A pre-flight guard (unknown flag, provider
  // without write support) spawns nothing, so telling the caller to inspect the tree for
  // half-applied edits sends them hunting for damage that cannot exist.
  if (write && r.started !== false) {
    // Before scaring the caller, ask the tree. A child that died on startup — a sandbox
    // that would not initialise, a bad flag, a failed auth — spawned and exited without
    // touching anything, and `started` cannot see that because the process DID start.
    // Measured: a cursor run rejected by its own sandbox produced a "may hold PARTIAL
    // edits" warning and a --resume suggestion for a run that had done nothing at all.
    // A post-mortem about damage that cannot exist sends people hunting, and teaches them
    // to ignore the warning that matters.
    const treeAfter = treeSignature(cwd);
    const untouched = treeBefore !== null && treeAfter === treeBefore;
    if (untouched) {
      console.error(`crossmodel: ${cwd} is UNCHANGED — the run failed before writing anything.`);
    } else {
      console.error(`crossmodel: ${cwd} may hold PARTIAL edits — check \`git -C ${cwd} status\` before rerunning.`);
      console.error('crossmodel: to continue where it stopped instead of starting cold: --resume last');
    }
  }
  process.exit(2);
}

if (!has('quiet')) {
  const scope = cwd ? `, ${write ? 'WROTE IN' : 'swept'} ${cwd}` : '';
  console.error(`crossmodel: ${alias} → ${r.provider}/${r.model}, ${r.ms}ms${scope}`);
  // Say so when progress was asked for and could not be given, rather than leaving the
  // user to wonder whether the run was silent or the reporting was broken.
  if (streaming && !r.streamed) {
    console.error(`crossmodel: no progress stream — "${r.provider}" has no machine-readable event output wired up.`);
  }
  if (write) console.error('crossmodel: review the diff and commit yourself — the model did neither.');
}
if (logPath) { try { appendFileSync(logPath, `\n${r.text}\n`); } catch { /* best-effort */ } }
process.stdout.write(r.text);

// ── exit 3: it ran, it succeeded, it changed nothing ─────────────────────────────────
// A `--write` run that touches no file is a legitimate outcome — the agent may have found
// a blocker and correctly refused to fake progress. That happened here: a phase stopped
// because the schema it needed did not exist, and returned exit 0. Anything automating on
// top of this would have read that as "done". Success and no-op must not share a code.
//
// Two ways to know, because the first only works for some providers:
//   - the event stream counted the edits (codex);
//   - otherwise compare the tree before and after (opencode and anything else without a
//     stream). Gating this on r.streamed alone meant a no-op silently exited 0 for every
//     provider that has no event output — the exact hole this check exists to close.
if (write) {
  const treeAfter = r.streamed ? null : treeSignature(cwd);
  const wroteNothing = r.streamed
    ? filesWritten === 0
    // 🔴 treeAfter === null must NOT read as "unchanged" and must not read as "wrote
    // something" either. If git fails after the run — a lock, a .git the agent moved — the
    // comparison is unknowable, and defaulting either way is a guess presented as a fact.
    // The `!r.streamed && treeAfter === null` branch below is the one that says so.
    : treeBefore !== null && treeAfter !== null && treeAfter === treeBefore;

  if (wroteNothing) {
    console.error('crossmodel: the run succeeded but wrote NO files — read the answer before treating this as done.');
    // 🔴 `process.exit(3)` here TRUNCATED the answer. stdout to a pipe is async, and exit()
    // does not flush it: measured, 500,000 bytes written and 65,536 delivered. This is the
    // one exit path where the prose IS the whole deliverable — the agent hit a blocker and
    // explained why — so destroying it was the worst possible place for that bug.
    // Setting exitCode lets the script end normally, which flushes.
    process.exitCode = 3;
  } else

  // Not knowing is its own outcome and must not read as "it wrote something". Two ways to
  // land here: the target was never a git repo (nothing to diff against), or git worked
  // before the run and failed after it — a lock, or a .git the agent disturbed. The second
  // was previously indistinguishable from success.
  if (!r.streamed && (treeBefore === null || treeAfter === null)) {
    const why = treeBefore === null
      ? `${cwd} is not a git repo`
      : `git stopped answering in ${cwd} partway through — the tree may have been disturbed`;
    console.error(
      `crossmodel: could not verify whether any file changed — "${r.provider}" reports no events and ${why}.\n` +
      '  Check the tree yourself before treating this as done.',
    );
  }
}
