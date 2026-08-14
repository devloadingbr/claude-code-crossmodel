// Pure inspection of a shell command: is this about to spend an EXTERNAL provider's
// quota? Used by the PreToolUse / beforeShellExecution hook.
//
// Extracted from the hook so a test can pin the rules without spawning a process:
//   • same-pool calls stay silent (Claude→claude, Cursor→cursor)
//   • the binary must be in command position, not merely present in the string
//   • an unknown --model alias still announces (better noise than a drained pool)

import { MODELS, PROVIDERS } from './providers.mjs';
import { orchestratorHost, samePool, QUOTA_LABEL } from './host.mjs';

/**
 * @param {string} command
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ alias: string, provider?: string, model?: string, quota: string, swept?: string, direct?: boolean } | null}
 */
export function inspect(command, env = process.env) {
  if (!command) return null;
  const host = orchestratorHost(env);

  // Path A: our own CLI wrapper — the alias is right there in --model.
  const viaWrapper = command.match(/crossmodel(?:\.mjs)?\b[\s\S]*?--model[= ]+(\S+)/);
  if (viaWrapper) {
    const alias = viaWrapper[1].replace(/^["']|["']$/g, '');
    const entry = MODELS[alias];
    if (!entry) return { alias, provider: 'unknown', quota: 'an external provider' };
    if (samePool(entry.provider, host)) return null;
    return {
      alias,
      provider: entry.provider,
      model: entry.model,
      quota: QUOTA_LABEL[entry.provider] ?? entry.provider,
      swept: (command.match(/--cwd[= ]+(\S+)/) || [])[1],
    };
  }

  // Path B: a provider CLI invoked directly, bypassing the wrapper.
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (p.kind !== 'cli' || !p.bin) continue;
    if (samePool(name, host)) continue;
    // 🔴 THE BINARY MUST BE IN COMMAND POSITION, not merely present in the string.
    // A plain word-boundary match fired on `grep -r codex lib/` and announced
    // "delegating to (default) — spending OpenAI quota" for a local grep. A notice that
    // lies is worse than no notice, and this hook exists precisely to be trusted.
    // Command position = start of the string, or right after a separator (; && || | & or
    // a newline), optionally preceded by a leading path.
    const bin = p.bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(^|[;&|\\n]|&&|\\|\\|)\\s*(\\S*/)?${bin}(\\s|$)`).test(command)) continue;
    const model = (command.match(/(?:-m|--model)[= ]+(\S+)/) || [])[1];
    return {
      alias: model ?? '(default)',
      provider: name,
      model,
      quota: QUOTA_LABEL[name] ?? name,
      direct: true,
    };
  }
  return null;
}

export function formatNotice(hit) {
  const bits = [`🔶 delegating to ${hit.alias}`];
  if (hit.model && hit.model !== hit.alias) bits.push(`(${hit.model})`);
  bits.push(`— spending ${hit.quota} quota, not this session's`);
  if (hit.swept) bits.push(`· sweeping ${hit.swept}`);
  if (hit.direct) bits.push('· direct CLI call');
  return bits.join(' ');
}
