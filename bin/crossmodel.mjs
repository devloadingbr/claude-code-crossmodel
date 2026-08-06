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

import { readFileSync } from 'node:fs';
import { callModel, MODELS, availableModels } from '../bench/providers.mjs';
import { readMode, writeMode, clearMode, parseUntil, describeUntil, MODE_PATH } from '../lib/mode.mjs';

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

if (has('help') || (!argv.length)) {
  console.log(`crossmodel — call any registered model

  crossmodel --model <alias> "<prompt>"
  crossmodel --model <alias> --file <path> "<instruction>"
  crossmodel --model <alias> --cwd <dir> "<sweep instruction>"
  crossmodel --list
  crossmodel mode on|off|status

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
                     Off by default. The model still cannot commit, and cannot reach
                     the network in either mode.
  --file <path>      append a file's contents to the prompt
  --timeout <ms>     default 240000
  --schema <path>    JSON Schema for structured output (only providers whose CLI
                     supports it, e.g. codex; silently ignored elsewhere)
  --list             show which models are usable here, then exit
  --quiet            print only the answer, no stderr diagnostics

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
const flagsTakingValue = new Set(['model', 'file', 'timeout', 'schema', 'cwd']);
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

const cwd = flag('cwd');
const write = has('write');
if (write && !cwd) {
  console.error('crossmodel: --write requires --cwd. Refusing to make the caller\'s current directory writable by accident.');
  process.exit(1);
}
const r = await callModel(alias, prompt, {
  timeoutMs: Number(flag('timeout', '240000')),
  schemaPath: flag('schema') ?? undefined,
  cwd: cwd ?? undefined,
  write,
});

if (!r.ok) {
  console.error(`crossmodel: call to ${alias} (${r.provider}/${r.model}) failed after ${r.ms}ms: ${r.error}`);
  process.exit(2);
}

if (!has('quiet')) {
  const scope = cwd ? `, ${write ? 'WROTE IN' : 'swept'} ${cwd}` : '';
  console.error(`crossmodel: ${alias} → ${r.provider}/${r.model}, ${r.ms}ms${scope}`);
  if (write) console.error('crossmodel: review the diff and commit yourself — the model did neither.');
}
process.stdout.write(r.text);
