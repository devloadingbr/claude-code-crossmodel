import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installCursor, CLI_BIN, HOOK_SRC, RULE_SRC, SKILL_SRC } from '../lib/install.mjs';

describe('installCursor', () => {
  it('dry-run writes nothing', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-install-'));
    const r = installCursor({ home, dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(existsSync(r.shim), false);
    assert.equal(existsSync(r.rule), false);
    assert.equal(existsSync(r.skill), false);
    assert.equal(existsSync(r.hookShim), false);
    assert.equal(existsSync(r.hooksJson), false);
    assert.equal(r.actions.shim, 'would-create');
    assert.equal(r.actions.hookShim, 'would-create');
    assert.equal(r.actions.hooksJson, 'would-create');
  });

  it('writes shim, rule and skill under $HOME, and is idempotent', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-install-'));
    const first = installCursor({ home });
    assert.equal(first.ok, true);
    assert.equal(first.actions.shim, 'created');
    assert.equal(first.actions.rule, 'created');
    assert.equal(first.actions.skill, 'created');
    assert.equal(first.actions.hookShim, 'created');
    assert.equal(first.actions.hooksJson, 'created');

    const shim = readFileSync(first.shim, 'utf8');
    assert.match(shim, /^#!\/bin\/sh\n/);
    assert.match(shim, /exec node /);
    assert.ok(shim.includes(JSON.stringify(CLI_BIN)));

    const hookShim = readFileSync(first.hookShim, 'utf8');
    assert.match(hookShim, /^#!\/bin\/sh\n/);
    assert.ok(hookShim.includes(JSON.stringify(HOOK_SRC)));
    assert.equal(statSync(first.hookShim).mode & 0o777, 0o755);

    const hooks = JSON.parse(readFileSync(first.hooksJson, 'utf8'));
    assert.equal(hooks.version, 1);
    assert.deepEqual(hooks.hooks.preToolUse, [{ command: './hooks/crossmodel-enforce', matcher: 'Grep|Glob|Task' }]);
    assert.deepEqual(hooks.hooks.subagentStart, [{ command: './hooks/crossmodel-enforce', matcher: 'delegate|explore|probe' }]);

    assert.equal(readFileSync(first.rule, 'utf8'), readFileSync(RULE_SRC, 'utf8'));
    assert.equal(readFileSync(first.skill, 'utf8'), readFileSync(SKILL_SRC, 'utf8'));
    assert.match(readFileSync(first.rule, 'utf8'), /alwaysApply: true/);

    const second = installCursor({ home });
    assert.equal(second.ok, true);
    assert.equal(second.actions.shim, 'unchanged');
    assert.equal(second.actions.rule, 'unchanged');
    assert.equal(second.actions.skill, 'unchanged');
    assert.equal(second.actions.hookShim, 'unchanged');
    assert.equal(second.actions.hooksJson, 'unchanged');
  });

  it('rewrites the shim when the checkout path changes', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-install-'));
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(path.join(home, '.local', 'bin', 'crossmodel'), '#!/bin/sh\nexec node "/old/path" "$@"\n');
    const r = installCursor({ home });
    assert.equal(r.actions.shim, 'updated');
    assert.ok(readFileSync(r.shim, 'utf8').includes(JSON.stringify(CLI_BIN)));
  });

  it('preserves unrelated hooks and noEnforce removes only its own entries', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-install-'));
    const hooksJson = path.join(home, '.cursor', 'hooks.json');
    mkdirSync(path.dirname(hooksJson), { recursive: true });
    writeFileSync(hooksJson, JSON.stringify({
      version: 1,
      hooks: {
        afterFileEdit: [{ command: 'other-hook', matcher: '*' }],
      },
    }, null, 2));

    const first = installCursor({ home });
    const beforeShim = readFileSync(first.hookShim, 'utf8');
    const installed = JSON.parse(readFileSync(hooksJson, 'utf8'));
    assert.deepEqual(installed.hooks.afterFileEdit, [{ command: 'other-hook', matcher: '*' }]);

    const removed = installCursor({ home, noEnforce: true });
    assert.equal(removed.actions.hookShim, 'skipped');
    assert.equal(removed.actions.hooksJson, 'removed');
    assert.equal(readFileSync(removed.hookShim, 'utf8'), beforeShim);
    const stripped = JSON.parse(readFileSync(hooksJson, 'utf8'));
    assert.deepEqual(stripped, {
      version: 1,
      hooks: { afterFileEdit: [{ command: 'other-hook', matcher: '*' }] },
    });
  });
});
