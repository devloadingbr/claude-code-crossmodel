import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splice, BEGIN, END } from '../lib/teach.mjs';

const BLOCK = `${BEGIN}\nhello\n${END}`;
const OTHER = `${BEGIN}\nworld\n${END}`;

describe('splice', () => {
  it('appends into empty text', () => {
    const r = splice('', BLOCK);
    assert.equal(r.action, 'appended');
    assert.equal(r.content, `${BLOCK}\n`);
    assert.equal(r.error, undefined);
  });

  it('appends into text ending with one newline', () => {
    // One trailing newline is not a blank line; splice inserts a second so the
    // block is separated from the preceding prose.
    const r = splice('intro\n', BLOCK);
    assert.equal(r.action, 'appended');
    assert.equal(r.content, `intro\n\n${BLOCK}\n`);
  });

  it('appends into text ending with two newlines', () => {
    const r = splice('intro\n\n', BLOCK);
    assert.equal(r.action, 'appended');
    assert.equal(r.content, `intro\n\n${BLOCK}\n`);
  });

  it('replaces an existing block and leaves surrounding text byte-identical', () => {
    const r = splice(`before\n${BLOCK}\nafter\n`, OTHER);
    assert.equal(r.action, 'updated');
    assert.equal(r.content, `before\n${OTHER}\nafter\n`);
  });

  it("returns action 'unchanged' when the block is byte-identical", () => {
    const text = `before\n${BLOCK}\nafter\n`;
    const r = splice(text, BLOCK);
    assert.equal(r.action, 'unchanged');
    assert.equal(r.content, text);
  });

  it('a BEGIN with no END returns an error and changes nothing', () => {
    const text = `keep me\n${BEGIN}\nhalf`;
    const r = splice(text, BLOCK);
    assert.ok(r.error);
    assert.match(r.error, /BEGIN/);
    assert.equal(r.content, undefined);
  });

  it('an END with no BEGIN returns an error and changes nothing', () => {
    const text = `keep me\n${END}\n`;
    const r = splice(text, BLOCK);
    assert.ok(r.error);
    assert.match(r.error, /END/);
    assert.equal(r.content, undefined);
  });

  it('two complete blocks return an error and change nothing', () => {
    // A second copy — pasted, merged, or duplicated by a bad rebase — would otherwise
    // be invisible: indexOf replaces the first pair and leaves the other to go stale.
    const text = `keep\n${BLOCK}\nmiddle\n${OTHER}\nkeep`;
    const r = splice(text, BLOCK);
    assert.ok(r.error);
    assert.match(r.error, /more than one/i);
    assert.equal(r.content, undefined);
  });

  it('text outside the markers is preserved exactly', () => {
    const prefix = '# Title\n\nprose  \n\tindented\n';
    const suffix = '\n\n## After\ntrailing spaces  ';
    const r = splice(`${prefix}${BLOCK}${suffix}`, OTHER);
    assert.equal(r.action, 'updated');
    assert.equal(r.content, `${prefix}${OTHER}${suffix}`);
  });
});
