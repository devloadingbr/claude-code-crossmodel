// Tiny git helpers shared between the main dispatch path and role-based fallback.
import { spawnSync } from 'node:child_process';

/**
 * A cheap fingerprint of everything git can see change in `dir`, including untracked
 * files. Returns null when there is nothing to compare against — outside a git repo — and
 * null must be read as "unknown", never as "unchanged".
 */
export function treeSignature(dir) {
  if (!dir) return null;
  const run = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 15_000 });
  if (run(['rev-parse', '--git-dir']).status !== 0) return null;
  // --porcelain covers modified, staged, deleted and untracked. HEAD catches the case of
  // an agent that committed despite being told not to: history moved even if the tree
  // looks identical afterwards.
  const status = run(['status', '--porcelain', '--untracked-files=all']);
  const head = run(['rev-parse', 'HEAD']);
  if (status.status !== 0) return null;
  return `${head.stdout ?? ''} ${status.stdout ?? ''}`;
}
