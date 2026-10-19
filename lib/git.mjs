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

/**
 * The first file under `dir` modified at or after `sinceMs`, or null when none was found.
 * It sees what git cannot: a report written into an ignored folder (`.work/`) is invisible
 * to `git status`, and an agent that writes through the shell emits no edit event — both
 * read as "wrote nothing" and turned a delivered report into exit 3 (casa-mods#1, 19/10).
 * Heavy generated folders are pruned. Returns undefined when `find` itself failed: unknown.
 */
export function touchedSince(dir, sinceMs) {
  if (!dir) return undefined;
  const r = spawnSync('find', [
    dir, '-xdev',
    '(', '-name', 'node_modules', '-o', '-name', '.git', '-o', '-name', '.next', '-o', '-name', '.turbo', ')', '-prune',
    '-o', '-type', 'f', '-newermt', `@${Math.floor(sinceMs / 1000)}`, '-print', '-quit',
  ], { encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0 && !(r.stdout ?? '').trim()) return undefined;
  const first = (r.stdout ?? '').trim().split('\n')[0];
  return first ? first : null;
}
