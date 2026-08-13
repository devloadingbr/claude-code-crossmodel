// Permission policy for providers whose boundary is a CONFIG rather than a kernel.
//
// Why this file exists. codex confines a run with an OS sandbox: writes outside the
// working directory fail at the syscall, and `.git/` is read-only, so an agent can edit
// but cannot commit — measured, not assumed. OpenCode has no such sandbox; what it has is
// a permission layer, and that layer only checks the arguments it can see. A path handed
// to the Write tool is checked. The same path inside `printf 'x' > /outside/file` is not,
// because to the permission layer that is just "run a command".
//
// An allowlist NARROWS that hole. It does not close it, and an earlier version of this
// comment claimed it did. With `"*": "ask"` as the floor an unrecognised command is
// refused, which removes the easy paths — but the policy matches a command by its leading
// word, so anything allowlisted that can redirect or execute carries the hole with it:
//
//   echo x > /outside/file      allowed via `echo *`   — MEASURED 2026-08-12: exit 0, the
//                                                        file outside the workspace was
//                                                        overwritten. Read of the same
//                                                        path WAS refused; the write was
//                                                        not, because the path lived
//                                                        inside a command string.
//   sed -i, awk, find -exec     allowed unconditionally, and all three write
//   node -e / python3 -c        allowed under --write, which is arbitrary execution and
//                               therefore reaches every verb in DENIED_COMMANDS below
//
// Keeping the list is still worth it: it stops the casual `rm -rf`, the `curl | sh`, and
// the accidental `git commit`. What it must never be called is a boundary. The boundary
// for opencode is the orchestrator reading the diff. If the work genuinely must not escape
// a directory, route it to codex or grok, whose sandboxes fail the write at the syscall.
//
// The shape of the policy is the house rule, not a security opinion: let the agent do the
// work — read, edit in scope, run the tests that prove it — and keep what belongs to the
// orchestrator. What enters git history is the orchestrator's, so git's writing verbs are
// denied while its reading verbs are allowed; an agent that cannot run `git diff` cannot
// orient itself.
//
// ⚠️ This is enforced by OpenCode, in process. It is much stronger than nothing and
// weaker than codex. Do not describe it as a sandbox.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { USER_DIR } from './mode.mjs';

export const USER_PERMISSIONS_PATH = path.join(USER_DIR, 'permissions.json');

// Reading and orienting. Safe in the sense that matters here: no persistence beyond the
// working tree, nothing that reaches the network, nothing that rewrites history.
const READ_COMMANDS = [
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
  'find', 'grep', 'rg', 'ag', 'sed', 'awk', 'cut', 'sort', 'uniq', 'diff', 'tree',
  'which', 'basename', 'dirname', 'realpath', 'date',
  // `env` is deliberately NOT here. Two reasons, both concrete: the child inherits the
  // full parent environment, so `env` prints every API key in your shell straight into the
  // answer — which lands on stdout and, with --log, on disk in plain text. And `env CMD`
  // runs CMD with `env` as the leading word, which is the only word the matcher sees, so
  // it launders any denied command through an allowed one.
  // git's read side. An agent that cannot see the diff cannot check its own work.
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git ls-files',
  'git rev-parse', 'git blame', 'git describe', 'git config --get',
];

// Proving the work. This is the half that makes delegation worth anything: an agent that
// cannot run the suite hands back code nobody has run.
const BUILD_COMMANDS = [
  'node', 'npm run', 'npm test', 'npm exec', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
  'make', 'cargo', 'go', 'python', 'python3', 'pytest', 'ruff', 'mypy',
  'jest', 'vitest', 'mocha', 'tsc', 'eslint', 'prettier', 'biome', 'tsx',
];

// The orchestrator's, and the plainly destructive. Denied outright so that a more general
// "allow" pattern can never widen into them.
const DENIED_COMMANDS = [
  // What enters history is the orchestrator's decision. This is the whole design principle
  // expressed as configuration.
  'git commit', 'git push', 'git reset', 'git rebase', 'git merge', 'git cherry-pick',
  'git checkout', 'git switch', 'git restore', 'git revert', 'git tag', 'git remote',
  'git clean', 'git stash', 'git filter-branch', 'git update-ref', 'git gc', 'git worktree',
  // Not the orchestrator's — simply not recoverable by reviewing a diff.
  'rm', 'rmdir', 'mv', 'dd', 'mkfs', 'chown', 'chmod', 'sudo', 'su', 'doas',
  'shutdown', 'reboot', 'systemctl', 'kill', 'killall', 'pkill', 'crontab',
  // Exfiltration and remote execution. Network is off by default anyway; denying these
  // means the policy still holds the day someone turns it on.
  'curl', 'wget', 'nc', 'ncat', 'telnet', 'ssh', 'scp', 'rsync', 'sftp',
  // Installers run arbitrary lifecycle scripts, which is a way around every rule above.
  'npm install', 'npm i', 'npm ci', 'pnpm add', 'yarn add', 'pip install', 'cargo install',
  'brew', 'apt', 'apt-get', 'dnf', 'pacman', 'snap',
];

// OpenCode matches a bare word and an invocation WITH arguments as different patterns:
// "grep *" permits `grep x f.txt` but not `grep`, and vice versa. Emitting both forms is
// the difference between a policy that works and one that blocks its own allowlist.
function bothForms(commands, verdict, into) {
  for (const c of commands) {
    into[c] = verdict;
    into[`${c} *`] = verdict;
  }
  return into;
}

/**
 * The policy crossmodel applies when it drives OpenCode.
 * `write` decides whether editing files is permitted at all; everything else is identical,
 * because a read-only run has no business running the build either way.
 */
export function defaultPolicy({ write = false } = {}) {
  const bash = {};
  // Floor first. Anything not named below lands here, and "ask" with nobody to ask is a
  // refusal — which is precisely what makes this an allowlist rather than a suggestion.
  bash['*'] = 'ask';
  bothForms(READ_COMMANDS, 'allow', bash);
  if (write) bothForms(BUILD_COMMANDS, 'allow', bash);
  // Denials last so they win over any broader allow ABOVE them in this function.
  // ⚠️ They do NOT win over the user's own file: loadPolicy merges `permissions.json`
  // after this, so `{"bash": {"git commit *": "allow"}}` reopens committing. That is the
  // intended precedence — it is your file — but an earlier version of this comment claimed
  // the opposite, which is a bad thing to be wrong about.
  bothForms(DENIED_COMMANDS, 'deny', bash);

  return {
    permission: {
      bash,
      edit: write ? 'allow' : 'deny',
      // Reaching the network is a separate decision made by --network, not by the policy.
      webfetch: 'deny',
    },
  };
}

/**
 * User override, merged over the default. Shallow per key so that replacing `bash` is a
 * deliberate act rather than something that happens by editing one line.
 * A malformed file is an error, never a silent fallback: believing a policy is in force
 * while it is not is worse than having none.
 */
export function loadPolicy({ write = false } = {}) {
  const base = defaultPolicy({ write });
  if (!existsSync(USER_PERMISSIONS_PATH)) return { policy: base, source: 'built-in' };

  let raw;
  try {
    raw = JSON.parse(readFileSync(USER_PERMISSIONS_PATH, 'utf8'));
  } catch (e) {
    return { policy: base, source: 'built-in', error: `permissions.json: ${e.message}` };
  }

  // Valid JSON, invalid shape. `null` parses and then throws on `.permission`, and the
  // throw happens inside provider.env() with no catch around it, so the whole run dies
  // with a stack trace instead of a sentence.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { policy: base, source: 'built-in', error: 'permissions.json: expected a JSON object' };
  }
  const userPerm = raw.permission ?? raw;
  if (!userPerm || typeof userPerm !== 'object' || Array.isArray(userPerm)) {
    return { policy: base, source: 'built-in', error: 'permissions.json: "permission" must be an object' };
  }
  return {
    policy: {
      permission: {
        ...base.permission,
        ...userPerm,
        bash: userPerm.bash ? { ...base.permission.bash, ...userPerm.bash } : base.permission.bash,
      },
    },
    source: USER_PERMISSIONS_PATH,
  };
}
