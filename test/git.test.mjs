import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { touchedSince } from '../lib/git.mjs';

// casa-mods#1 (19/10): a luna6 --write run delivered its report into `.work/` (git-ignored, written through the
// shell, so no edit event) and still exited 3 "wrote NO files". touchedSince is the filesystem's answer.
test('touchedSince sees a file written into an ignored folder and skips node_modules and .git', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-touched-'));
  mkdirSync(path.join(dir, '.work'));
  mkdirSync(path.join(dir, 'node_modules'));
  mkdirSync(path.join(dir, '.git'));
  const old = path.join(dir, 'old.txt');
  writeFileSync(old, 'x');
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(old, past, past);
  const since = Date.now() - 1000;

  assert.equal(touchedSince(dir, since), null, 'nothing new yet');
  writeFileSync(path.join(dir, 'node_modules', 'dep.js'), '1');
  writeFileSync(path.join(dir, '.git', 'index'), '1');
  assert.equal(touchedSince(dir, since), null, 'pruned folders do not count');
  writeFileSync(path.join(dir, '.work', 'report.md'), 'done');
  assert.equal(touchedSince(dir, since), path.join(dir, '.work', 'report.md'));
});

test('touchedSince without a directory is unknown, not "unchanged"', () => {
  assert.equal(touchedSince('', Date.now()), undefined);
});
