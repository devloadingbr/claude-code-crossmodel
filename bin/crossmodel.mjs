#!/usr/bin/env node
// crossmodel — call any registered model with one command.
//
//   crossmodel --model luna "Review this function and list only correctness defects"
//   crossmodel --model luna --file ./patch.diff "Review this diff"
//   crossmodel --list
//
// Transport (local CLI vs HTTP API) is resolved from the registry, so the caller
// never needs to know whether `luna` is a Codex subprocess or an OpenRouter request.
//
// Exit codes:
//   0  success — the model's answer is on stdout
//   1  usage error (unknown alias, missing prompt)
//   2  the call failed (provider unavailable, timeout, HTTP error, non-zero exit)
//
// Exit code 2 matters: an error must never be mistaken for an answer. Anything
// consuming this must check the exit code before trusting stdout.

import { readFileSync } from 'node:fs';
import { callModel, MODELS, availableModels, canReadFiles } from '../bench/providers.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

if (has('help') || (!argv.length)) {
  console.log(`crossmodel — call any registered model

  crossmodel --model <alias> "<prompt>"
  crossmodel --model <alias> --file <path> "<instruction>"
  crossmodel --model <alias> --cwd <dir> "<sweep instruction>"
  crossmodel --list

Options:
  --model <alias>    which model (see --list)
  --cwd <dir>        directory the model may read and explore. CLI-backed models are
                     agentic — give them a repo and they will grep and read it
                     themselves, so you do not have to paste code into the prompt.
                     Rejected for http-backed models, which have no filesystem.
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
    const files = canReadFiles(alias) ? 'reads files' : 'prompt only';
    console.log(`${v.ok ? '  ok  ' : '  --  '}${alias.padEnd(width)}  ${MODELS[alias].provider}/${MODELS[alias].model}  [${files}]  ${v.ok ? '' : `(${v.why})`}`);
  }
  console.log('\n"reads files" = agentic CLI: pass --cwd <dir> and it explores the repo itself.');
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
