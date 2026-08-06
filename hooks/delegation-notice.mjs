#!/usr/bin/env node
// PreToolUse hook on Bash: announce when a command is about to spend an EXTERNAL
// provider's quota instead of your Anthropic quota.
//
// Why this exists: delegation is invisible. A `codex exec` and a `grep` look identical
// in the transcript, so you cannot tell which pool a turn is draining without reading
// every command. This makes the boundary visible at the moment it is crossed.
//
// It only announces. It never blocks — a notice that can break your workflow would be
// worse than no notice.

import { MODELS, PROVIDERS } from '../bench/providers.mjs';

// Provider binaries that mean "this call leaves the Anthropic quota pool".
// `claude` is deliberately absent: that IS the Anthropic pool, and announcing it would
// make the signal meaningless through sheer noise.
const EXTERNAL_BINS = Object.entries(PROVIDERS)
  .filter(([name, p]) => p.kind === 'cli' && p.bin && name !== 'claude')
  .map(([, p]) => p.bin);

const LABEL = {
  codex: 'OpenAI',
  gemini: 'Google',
  ollama: 'local hardware',
};

function inspect(command) {
  if (!command) return null;

  // Path A: our own CLI wrapper — the alias is right there in --model.
  const viaWrapper = command.match(/crossmodel(?:\.mjs)?\b[\s\S]*?--model[= ]+(\S+)/);
  if (viaWrapper) {
    const alias = viaWrapper[1].replace(/^["']|["']$/g, '');
    const entry = MODELS[alias];
    if (!entry) return { alias, provider: 'unknown', quota: 'an external provider' };
    if (entry.provider === 'claude') return null; // still Anthropic
    return {
      alias,
      provider: entry.provider,
      model: entry.model,
      quota: LABEL[entry.provider] ?? entry.provider,
      swept: (command.match(/--cwd[= ]+(\S+)/) || [])[1],
    };
  }

  // Path B: a provider CLI invoked directly, bypassing the wrapper.
  for (const bin of EXTERNAL_BINS) {
    // Word-boundary match so `mycodex` or a path fragment does not trigger it.
    if (!new RegExp(`(^|[\\s/;&|])${bin}\\b`).test(command)) continue;
    const provider = Object.entries(PROVIDERS).find(([, p]) => p.bin === bin)?.[0];
    const model = (command.match(/(?:-m|--model)[= ]+(\S+)/) || [])[1];
    return {
      alias: model ?? '(default)',
      provider,
      model,
      quota: LABEL[provider] ?? provider,
      direct: true,
    };
  }
  return null;
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  let command = '';
  try { command = JSON.parse(buf || '{}')?.tool_input?.command ?? ''; } catch { /* ignore */ }

  const hit = inspect(command);
  if (!hit) process.exit(0);

  const bits = [`🔶 delegating to ${hit.alias}`];
  if (hit.model && hit.model !== hit.alias) bits.push(`(${hit.model})`);
  bits.push(`— spending ${hit.quota} quota, not Anthropic`);
  if (hit.swept) bits.push(`· sweeping ${hit.swept}`);
  if (hit.direct) bits.push('· direct CLI call');

  process.stdout.write(JSON.stringify({ systemMessage: bits.join(' ') }));
  process.exit(0);
});
