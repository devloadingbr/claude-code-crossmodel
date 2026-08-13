// The policy has exactly one rule, so these tests have exactly one thing to protect:
// the agent works freely, and git history stays the orchestrator's.
//
// An earlier version of this file asserted the opposite shape — an allowlist with an
// `"*": "ask"` floor and a long DENIED list covering rm, curl, sudo and the package
// managers. That shape was removed on 2026-08-13, and these tests were rewritten with it,
// because it did two bad things at once: it blocked ordinary work (an agent that cannot
// run an unlisted build tool hands back unverified code) while not actually stopping
// anything (MEASURED: `echo BACKUP > /outside/file` through the shell exited 0 and wrote
// outside the workspace, because OpenCode matches a command by its leading word).
//
// If someone reintroduces a general denial here, one of these tests should fail and this
// comment should be the argument they have to answer.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPolicy } from '../lib/permissions.mjs';

const GIT_WRITE = [
  'git commit', 'git push', 'git reset', 'git rebase', 'git merge', 'git cherry-pick',
  'git checkout', 'git switch', 'git restore', 'git revert', 'git tag', 'git remote',
  'git clean', 'git stash', 'git filter-branch', 'git update-ref', 'git gc', 'git worktree',
  'git am', 'git apply',
];

const GIT_READ = [
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git ls-files',
  'git rev-parse', 'git blame', 'git describe', 'git config --get',
];

// Ordinary work an agent must be able to do without asking. None of these is named in the
// policy; they all fall through to the `*` floor, which is the point of the assertion.
const ORDINARY_WORK = [
  'npm test', 'npm run build', 'npm install', 'pnpm add zod', 'cargo build', 'go test ./...',
  'node -e "1+1"', 'python3 -m pytest', 'make', 'tsc --noEmit', 'eslint .',
  'rm -rf node_modules/.cache', 'mv old.txt new.txt', 'mkdir -p dist',
  'curl -s localhost:3000/health', 'docker compose up -d', 'sed -i s/a/b/ f.txt',
  'env', 'chmod +x script.sh',
];

/** The verdict the policy actually yields for a command line, floor included. */
function verdict(bash, command) {
  if (Object.hasOwn(bash, command)) return bash[command];
  const word = Object.keys(bash)
    .filter((k) => k.endsWith(' *'))
    .map((k) => k.slice(0, -2))
    .filter((k) => command === k || command.startsWith(`${k} `))
    // longest prefix wins, the way a specific rule should beat a general one
    .sort((a, b) => b.length - a.length)[0];
  return word ? bash[`${word} *`] : bash['*'];
}

function bothForms(commands, bash, expected) {
  for (const c of commands) {
    assert.ok(Object.hasOwn(bash, c), `missing bare form: ${c}`);
    assert.ok(Object.hasOwn(bash, `${c} *`), `missing starred form: ${c} *`);
    assert.equal(bash[c], expected, `${c} should be ${expected}`);
    assert.equal(bash[`${c} *`], expected, `${c} * should be ${expected}`);
  }
}

describe('defaultPolicy — the agent works freely', () => {
  it("the bash floor is 'allow' in both modes", () => {
    // The whole policy in one assertion. A run is not a negotiation.
    assert.equal(defaultPolicy({ write: false }).permission.bash['*'], 'allow');
    assert.equal(defaultPolicy({ write: true }).permission.bash['*'], 'allow');
  });

  it('ordinary work is permitted without being named', () => {
    for (const mode of [{ write: false }, { write: true }]) {
      const bash = defaultPolicy(mode).permission.bash;
      for (const c of ORDINARY_WORK) {
        assert.equal(verdict(bash, c), 'allow', `${c} must be allowed (write=${mode.write})`);
      }
    }
  });

  it('nothing is denied except git writes', () => {
    for (const mode of [{ write: false }, { write: true }]) {
      const bash = defaultPolicy(mode).permission.bash;
      const denied = Object.entries(bash).filter(([, v]) => v === 'deny').map(([k]) => k);
      assert.ok(denied.length > 0, 'the git denial must exist');
      for (const k of denied) {
        assert.ok(k.startsWith('git '), `only git writes may be denied, found: ${k}`);
      }
    }
  });

  it("nothing is left on 'ask' — there is nobody to ask in a headless run", () => {
    for (const mode of [{ write: false }, { write: true }]) {
      const bash = defaultPolicy(mode).permission.bash;
      const asked = Object.entries(bash).filter(([, v]) => v === 'ask').map(([k]) => k);
      assert.deepEqual(asked, [], `'ask' is a hang, not a policy: ${asked.join(', ')}`);
    }
  });
});

describe('defaultPolicy — git history stays the orchestrator\'s', () => {
  it("git's writing verbs are denied in both modes, in both forms", () => {
    // Both modes on purpose: a read-only sweep has no business committing either.
    bothForms(GIT_WRITE, defaultPolicy({ write: false }).permission.bash, 'deny');
    bothForms(GIT_WRITE, defaultPolicy({ write: true }).permission.bash, 'deny');
  });

  it("git's reading verbs are allowed — an agent that cannot see the diff cannot check itself", () => {
    bothForms(GIT_READ, defaultPolicy({ write: false }).permission.bash, 'allow');
    bothForms(GIT_READ, defaultPolicy({ write: true }).permission.bash, 'allow');
  });

  it('the denial survives the general floor', () => {
    // Regression: denials are emitted last precisely so a broader rule above cannot
    // swallow them. If the ordering is ever flipped, this is what catches it.
    const bash = defaultPolicy({ write: true }).permission.bash;
    assert.equal(verdict(bash, 'git commit -m "x"'), 'deny');
    assert.equal(verdict(bash, 'git push origin main'), 'deny');
    assert.equal(verdict(bash, 'git diff --stat'), 'allow');
  });

  it('every named command carries both its bare and starred form', () => {
    // OpenCode treats `grep` and `grep *` as different patterns, so emitting one without
    // the other produces a rule that half applies.
    for (const mode of [{ write: false }, { write: true }]) {
      const bash = defaultPolicy(mode).permission.bash;
      for (const k of Object.keys(bash)) {
        if (k === '*') continue;
        const bare = k.endsWith(' *') ? k.slice(0, -2) : k;
        assert.ok(Object.hasOwn(bash, bare), `${k} has no bare form`);
        assert.ok(Object.hasOwn(bash, `${bare} *`), `${bare} has no starred form`);
        assert.equal(bash[bare], bash[`${bare} *`], `verdicts differ for ${bare}`);
      }
    }
  });
});

describe('defaultPolicy — editing is what --write gates', () => {
  it("edit is 'deny' for a sweep and 'allow' for a write run", () => {
    // The only thing --write actually decides. It does not gate the shell: a read-only run
    // is a question, not a suspect.
    assert.equal(defaultPolicy({ write: false }).permission.edit, 'deny');
    assert.equal(defaultPolicy({ write: true }).permission.edit, 'allow');
  });

  it('webfetch stays denied in both — the network is --network\'s decision, not the policy\'s', () => {
    assert.equal(defaultPolicy({ write: false }).permission.webfetch, 'deny');
    assert.equal(defaultPolicy({ write: true }).permission.webfetch, 'deny');
  });
});
