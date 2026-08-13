import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseUntil, describeUntil } from '../lib/mode.mjs';

// Thursday 13 Aug 2026 12:00 local. Injected so a weekday test cannot drift with the
// wall clock — parseUntil('sunday') on a Sunday is a different answer than on a Monday.
const THU = new Date(2026, 7, 13, 12, 0, 0, 0);

describe('parseUntil', () => {
  it('offsets 6h, 90m, 2d from the injected now', () => {
    assert.equal(parseUntil('6h', THU).getTime(), THU.getTime() + 6 * 3_600_000);
    assert.equal(parseUntil('90m', THU).getTime(), THU.getTime() + 90 * 60_000);
    assert.equal(parseUntil('2d', THU).getTime(), THU.getTime() + 2 * 86_400_000);
  });

  it('a weekday name lands on the next future midnight, never today', () => {
    assert.equal(THU.getDay(), 4); // Thursday
    const fri = parseUntil('friday', THU);
    assert.equal(fri.getDay(), 5);
    assert.equal(fri.getHours(), 0);
    assert.equal(fri.getMinutes(), 0);
    assert.equal(fri.getSeconds(), 0);
    assert.equal(fri.getMilliseconds(), 0);
    assert.equal(fri.getDate(), 14);
    assert.ok(fri.getTime() > THU.getTime());
  });

  it("'sunday' when today is Sunday lands 7 days out, not 0", () => {
    // 9 Aug 2026 is a Sunday. Landing on "this morning at 00:00" would already be in
    // the past by noon, so the boundary that matters is the one coming up.
    const sundayNoon = new Date(2026, 7, 9, 12, 0, 0, 0);
    assert.equal(sundayNoon.getDay(), 0);
    const next = parseUntil('sunday', sundayNoon);
    assert.equal(next.getDay(), 0);
    assert.equal(next.getHours(), 0);
    assert.equal(next.getTime(), new Date(2026, 7, 16).getTime());
    assert.equal((next.getTime() - new Date(2026, 7, 9).getTime()) / 86_400_000, 7);
  });

  it("a date-only string resolves to local midnight, not UTC", () => {
    // Date-only ISO is UTC per spec, so "2026-08-09" would be the 8th at 21:00 in UTC-3.
    const d = parseUntil('2026-08-09', THU);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 7);
    assert.equal(d.getDate(), 9);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
    assert.equal(d.getMilliseconds(), 0);
    assert.equal(d.getTime(), new Date(2026, 7, 9).getTime());
  });

  it('garbage returns null', () => {
    assert.equal(parseUntil('banana', THU), null);
    assert.equal(parseUntil('6 hours', THU), null);
    assert.equal(parseUntil('tomorrow', THU), null);
  });

  it('empty returns null', () => {
    assert.equal(parseUntil('', THU), null);
    assert.equal(parseUntil(null, THU), null);
    assert.equal(parseUntil(undefined, THU), null);
  });
});

describe('readMode', () => {
  // readMode always opens ~/.claude/crossmodel/mode.json. There is no path injection,
  // so a test that called it would read (and, to cover the write/expiry paths, mutate)
  // the user's real state file. That is exactly the $HOME coupling this suite must not
  // have. The parseable surface — parseUntil, describeUntil — is tested above and below.
});

describe('describeUntil', () => {
  it('names the deadline from an injected now', () => {
    assert.equal(describeUntil(null, THU), 'until you turn it off');
    assert.equal(describeUntil('', THU), 'until you turn it off');
    assert.equal(describeUntil(new Date(THU.getTime() - 1), THU), 'expired');

    const in2h = new Date(THU.getTime() + 2 * 3_600_000);
    const twoHours = describeUntil(in2h, THU);
    assert.match(twoHours, /^until /);
    assert.match(twoHours, /2h 0m from now/);

    const in26h = new Date(THU.getTime() + 26 * 3_600_000);
    const dayAndBit = describeUntil(in26h, THU);
    assert.match(dayAndBit, /1d 2h from now/);
  });
});
