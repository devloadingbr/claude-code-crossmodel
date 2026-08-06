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

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { callModel, MODELS, availableModels } from '../bench/providers.mjs';
import { readMode, writeMode, clearMode, parseUntil, describeUntil, MODE_PATH } from '../lib/mode.mjs';
import { codexUsage, describeWindow, describeReset, bar } from '../lib/usage.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

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

Usage — how much of the provider's quota is left:
  crossmodel usage

  Reads codex's own session transcripts, so there is no network call and it works while
  a run is still in flight. Add --json for scripting. Exit 2 when there is no data,
  because "no reading" must never be mistaken for "nothing used".

Saver mode — for when your Anthropic quota is nearly spent:
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
  --write            let the model edit files inside --cwd (required with it). Writes
                     are confined to that directory; anything outside is rejected.
                     Off by default. The model still cannot commit, and has no network
                     unless you also pass --network.
  --worktree <dir>   create (or reuse) an isolated git worktree and use it as --cwd.
                     Requires --write. The worktree is left behind for you to review and
                     remove — that review is the point.
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
  --timeout <ms>     default 240000, or 3600000 with --write. Under --write a timeout kill
                     leaves half-applied edits with no rollback, so values under 600000
                     are refused rather than risked.
  --schema <path>    JSON Schema for structured output (only providers whose CLI
                     supports it, e.g. codex; silently ignored elsewhere)
  --list             show which models are usable here, then exit
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

Aliases are defined in bench/providers.mjs and can be extended or overridden with a
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
const flagsTakingValue = new Set(['model', 'file', 'timeout', 'schema', 'cwd', 'effort', 'resume', 'worktree']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (flagsTakingValue.has(a.slice(2))) i++;
    continue;
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

// ── timeout ──────────────────────────────────────────────────────────────────────────
// Validated HERE, before anything with a side effect runs. Creating a worktree and only
// then refusing the run would leave the user cleaning up after an argument error — a
// check must never cost more than the thing it is checking.
//
// 🔴 A timeout kill is DESTRUCTIVE under --write: the process dies by SIGKILL wherever it
// happens to be, and half-applied edits stay on disk with no rollback. A default sized for
// a question (4 min) is therefore actively dangerous for an implementation run — measured
// at ~25 min for a single phase. So --write gets a default an order of magnitude larger,
// and an explicitly short one is refused rather than silently honoured.
const SWEEP_TIMEOUT_MS = 240_000;       // 4 min — plenty for "which files do X"
const WRITE_TIMEOUT_MS = 3_600_000;     // 1 h  — an implementation run reads before it writes
const WRITE_TIMEOUT_FLOOR_MS = 600_000; // below 10 min, --write is a coin flip

const timeoutRaw = flag('timeout');
const timeoutMs = timeoutRaw ? Number(timeoutRaw) : write ? WRITE_TIMEOUT_MS : SWEEP_TIMEOUT_MS;
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error(`crossmodel: --timeout must be a positive number of milliseconds (got "${timeoutRaw}").`);
  process.exit(1);
}
if (write && timeoutMs < WRITE_TIMEOUT_FLOOR_MS) {
  console.error(
    `crossmodel: --timeout ${timeoutMs}ms is too short for --write. A kill mid-run leaves half-applied\n` +
    `edits on disk with no rollback, so this is refused rather than risked. Use at least ${WRITE_TIMEOUT_FLOOR_MS}ms,\n` +
    `or drop --write to run read-only.`,
  );
  process.exit(1);
}

// ── --worktree: make the recommended path the easy path ──────────────────────────────
// The README has always said "point --write at an isolated git worktree". Saying it is not
// the same as making it convenient, and the manual version (create, remember to remove,
// remember it shares the object store) is exactly the kind of chore people skip. This
// creates the worktree, hands it over as --cwd, and leaves it in place afterwards —
// removal stays manual on purpose, because the whole point is that you review the diff.
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
  } else if (!has('quiet')) {
    console.error(`crossmodel: reusing existing worktree ${dir}`);
  }
  cwd = dir;
}

if (write && !cwd) {
  console.error('crossmodel: --write requires --cwd (or --worktree). Refusing to make the caller\'s current directory writable by accident.');
  process.exit(1);
}

const network = has('network');
const effort = flag('effort');
const resume = flag('resume');
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

const onEvent = streaming
  ? (e) => {
      if (!reportProgress) return; // stream still consumed — just not narrated
      if (e.kind === 'start') { console.error(`  ${since()} · session ${e.id ?? '?'}`); return; }
      const body = clip(e.text, e.kind === 'message' ? 200 : 140);
      if (!body) return;
      console.error(`  ${since()} ${MARK[e.kind] ?? '·'} ${body}`);
    }
  : undefined;

const r = await callModel(alias, prompt, {
  timeoutMs,
  schemaPath: flag('schema') ?? undefined,
  cwd: cwd ?? undefined,
  write,
  effort: effort ?? undefined,
  network,
  resume: resume ?? undefined,
  onEvent,
});

if (!r.ok) {
  console.error(`crossmodel: call to ${alias} (${r.provider}/${r.model}) failed after ${r.ms}ms: ${r.error}`);
  // A died-mid-run agent leaves two things behind: possibly-partial edits, and a session
  // that still holds everything it read. Say both, because the instinct is to relaunch —
  // and relaunching pays the expensive part (reading the repo) all over again.
  if (write) {
    console.error(`crossmodel: ${cwd} may hold PARTIAL edits — check \`git -C ${cwd} status\` before rerunning.`);
    console.error('crossmodel: to continue where it stopped instead of starting cold: --resume last');
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
process.stdout.write(r.text);
