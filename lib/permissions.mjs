// The permission policy crossmodel gives OpenCode. One rule, and it is the house rule.
//
// THE POLICY: THE AGENT WORKS FREELY. IT DOES NOT TOUCH GIT HISTORY.
//
// A delegated agent is not a lower life form than the orchestrator. It is the same class
// of tool doing the same class of work, and the work is writing code: reading the tree,
// editing files, running the build, running the tests, fixing what the tests say. An agent
// that has to negotiate for permission to run a build tool is an agent that hands back
// unverified code, which is worth less than no code at all.
//
// So there is exactly one denial, and it is not about safety — it is about ownership.
// What enters git history is the orchestrator's decision. In the working tree a change is
// a diff you can throw away; after a commit it is a fact other work builds on. Git's
// writing verbs are therefore denied, its reading verbs allowed, because an agent that
// cannot run `git diff` cannot check its own work.
//
// WHAT CHANGED, AND WHY THE OLD SHAPE WAS WRONG
// This used to be an allowlist with `"*": "ask"` as the floor — in a non-interactive run,
// a refusal. Two things were wrong with it.
//
// It did not work. MEASURED 2026-08-12, with that policy in force: `echo BACKUP >
// /outside/file` from the agent's shell exited 0 and overwrote a file outside the
// workspace, while `cat` of the same path was refused. OpenCode matches a command by its
// leading word, so every allowlisted command that can redirect or execute carried the hole
// with it — `echo`, `sed -i`, `awk`, `find -exec`, and under write `node -e`. A list that
// stops nothing determined and blocks plenty that is ordinary is the worst of both.
//
// And it was answering a question nobody asked. crossmodel drives coding CLIs — the same
// tools people run directly all day with no such list. Adding a permission layer here made
// delegated work weaker than the identical work done by hand, for a boundary that was
// never real. The boundary is, and always was, the orchestrator reading the diff before
// anything is committed.
//
// If a task genuinely must not touch a tree, the answer is a throwaway git worktree — see
// `--worktree` — not a config file pretending to be a kernel.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { USER_DIR } from './mode.mjs';

export const USER_PERMISSIONS_PATH = path.join(USER_DIR, 'permissions.json');

// Git's writing verbs. Denied so that history stays the orchestrator's, in both read-only
// and write runs — a read-only sweep has no business committing either.
//
// ⚠️ This is enforced by OpenCode, in process, and the same shell hole measured above
// applies: `git commit` reached through `sh -c` or `node -e` is not caught. It is a stated
// contract that a cooperating agent honours, not a lock. codex is the one provider that
// enforces it for real, by making `.git/` read-only inside its sandbox.
const GIT_WRITE_VERBS = [
  'git commit', 'git push', 'git reset', 'git rebase', 'git merge', 'git cherry-pick',
  'git checkout', 'git switch', 'git restore', 'git revert', 'git tag', 'git remote',
  'git clean', 'git stash', 'git filter-branch', 'git update-ref', 'git gc', 'git worktree',
  'git am', 'git apply', 'git branch -d', 'git branch -D', 'git branch -m',
];

// OpenCode matches a bare word and an invocation WITH arguments as different patterns:
// "grep *" permits `grep x f.txt` but not `grep`, and vice versa. Emitting both forms is
// the difference between a policy that works and one that blocks its own rules.
function bothForms(commands, verdict, into) {
  for (const c of commands) {
    into[c] = verdict;
    into[`${c} *`] = verdict;
  }
  return into;
}

/**
 * The policy crossmodel applies when it drives OpenCode.
 *
 * `write` decides whether the file-editing TOOLS are available. It does not gate the shell:
 * a read-only run is a run you asked a question of, not a run you distrust, and it still
 * needs to be able to look around.
 */
export function defaultPolicy({ write = false } = {}) {
  const bash = {};
  // Allow by default. The agent is here to work.
  bash['*'] = 'allow';
  // git's read side stays explicitly allowed so a broader user rule cannot sweep it away
  // along with the writes.
  bothForms(['git status', 'git diff', 'git log', 'git show', 'git branch', 'git ls-files',
    'git rev-parse', 'git blame', 'git describe', 'git config --get'], 'allow', bash);
  // The one denial. Last, so it wins over the `*` above.
  bothForms(GIT_WRITE_VERBS, 'deny', bash);

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
 *
 * ⚠️ The user's entries are merged AFTER the defaults, so `{"bash": {"git commit *":
 * "allow"}}` reopens committing. That is deliberate — it is your file — but it means the
 * git denial is a default, not a guarantee.
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
