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
import { callModel, MODELS, availableModels } from '../bench/providers.mjs';

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
  crossmodel --list

Options:
  --model <alias>    which model (see --list)
  --file <path>      append a file's contents to the prompt
  --timeout <ms>     default 240000
  --schema <path>    JSON Schema for structured output (only providers whose CLI
                     supports it, e.g. codex; silently ignored elsewhere)
  --list             show which models are usable here, then exit
  --quiet            print only the answer, no stderr diagnostics

Aliases are defined in bench/providers.mjs and can be extended or overridden with a
crossmodel.config.json — see crossmodel.config.example.json.`);
  process.exit(argv.length ? 0 : 1);
}

if (has('list')) {
  const av = await availableModels();
  const width = Math.max(...Object.keys(av).map((k) => k.length));
  for (const [alias, v] of Object.entries(av)) {
    console.log(`${v.ok ? '  ok  ' : '  --  '}${alias.padEnd(width)}  ${MODELS[alias].provider}/${MODELS[alias].model}  ${v.ok ? '' : `(${v.why})`}`);
  }
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
const flagsTakingValue = new Set(['model', 'file', 'timeout', 'schema']);
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

const r = await callModel(alias, prompt, {
  timeoutMs: Number(flag('timeout', '240000')),
  schemaPath: flag('schema') ?? undefined,
});

if (!r.ok) {
  console.error(`crossmodel: call to ${alias} (${r.provider}/${r.model}) failed after ${r.ms}ms: ${r.error}`);
  process.exit(2);
}

if (!has('quiet')) {
  console.error(`crossmodel: ${alias} → ${r.provider}/${r.model}, ${r.ms}ms`);
}
process.stdout.write(r.text);
