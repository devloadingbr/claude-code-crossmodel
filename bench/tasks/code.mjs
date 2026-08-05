// Coding tasks. Ground truth = real tests run with `node --test`.
// No model judges these: either the tests pass, or they don't.
//
// Each task: spec (what the model receives) + tests (what decides the score).
// The spec is DETAILED on purpose — we want to measure "follows the spec", not
// "guesses what I meant".

export default [
  {
    id: 'credit-card',
    difficulty: 'easy',
    spec: `Write a JavaScript module (ESM) exporting:

export function formatCreditCard(input)

Rules:
- Receives a string that may contain digits, spaces and dashes.
- Strip everything that isn't a digit.
- If exactly 16 digits remain, return them grouped in 4s separated by a single
  space: "1234 5678 9012 3456".
- In ANY other case (fewer than 16, more than 16, empty input, null, undefined,
  or a type other than string) return null. Do not throw.`,
    tests: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCreditCard } from './impl.mjs';

test('formats a 16-digit card', () => {
  assert.equal(formatCreditCard('1234567890123456'), '1234 5678 9012 3456');
});
test('normalizes an already-spaced card', () => {
  assert.equal(formatCreditCard('1234 5678 9012 3456'), '1234 5678 9012 3456');
});
test('strips dashes and spaces', () => {
  assert.equal(formatCreditCard('1234-5678-9012-3456'), '1234 5678 9012 3456');
});
test('fewer than 16 digits becomes null', () => {
  assert.equal(formatCreditCard('123456789012345'), null);
});
test('more than 16 digits becomes null', () => {
  assert.equal(formatCreditCard('12345678901234567'), null);
});
test('invalid inputs become null without throwing', () => {
  assert.equal(formatCreditCard(''), null);
  assert.equal(formatCreditCard(null), null);
  assert.equal(formatCreditCard(undefined), null);
  assert.equal(formatCreditCard(1234567890123456), null);
});`,
  },

  {
    id: 'slug',
    difficulty: 'easy',
    spec: `Write a JavaScript module (ESM) exporting:

export function slugify(text)

Rules:
- Lowercase.
- Strip accents/diacritics: "Café" -> "cafe", "Crème" -> "creme", "façade" -> "facade".
- Replace any run of non-alphanumeric characters with a SINGLE hyphen.
- Trim leading and trailing hyphens.
- If the input isn't a string or is empty, return the empty string "".`,
    tests: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './impl.mjs';

test('strips accents and spaces', () => {
  assert.equal(slugify('Café Crème & Croissants!'), 'cafe-creme-croissants');
});
test('collapses repeated separators', () => {
  assert.equal(slugify('Bed   &   Breakfast!!!'), 'bed-breakfast');
});
test('trims hyphens from the edges', () => {
  assert.equal(slugify('  --Grand Opening--  '), 'grand-opening');
});
test('handles diacritics from multiple languages', () => {
  assert.equal(slugify('Zürich Straße Über'), 'zurich-strasse-uber');
  assert.equal(slugify('Ñoño García'), 'nono-garcia');
});
test('invalid input becomes empty string', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(42), '');
});`,
  },

  {
    id: 'billing',
    difficulty: 'medium',
    spec: `Write a JavaScript module (ESM) exporting:

export function nextBillingDate(subscription, now)

- subscription: { lastBilledAt: Date, periodMonths: number }
- now: Date (the clock comes in as a parameter; do NOT use new Date() inside the function)

Rules:
- The next billing date is lastBilledAt + periodMonths months.
- WATCH OUT for end-of-month: if the day doesn't exist in the target month, use the
  LAST day of the target month. Example: Jan 31 + 1 month = Feb 28 (or Feb 29 in a
  leap year), NEVER Mar 2 or Mar 3.
- If the computed date is before "now", return "now".
- Always return a Date object. Do the math in UTC.`,
    tests: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextBillingDate } from './impl.mjs';

const d = (s) => new Date(s);

test('advances one normal month', () => {
  const r = nextBillingDate(
    { lastBilledAt: d('2026-03-15T00:00:00Z'), periodMonths: 1 },
    d('2026-03-20T00:00:00Z'));
  assert.equal(r.toISOString().slice(0, 10), '2026-04-15');
});
test('end of month: Jan 31 + 1 month = Feb 28 in a common year', () => {
  const r = nextBillingDate(
    { lastBilledAt: d('2026-01-31T00:00:00Z'), periodMonths: 1 },
    d('2026-01-31T00:00:00Z'));
  assert.equal(r.toISOString().slice(0, 10), '2026-02-28');
});
test('end of month in a leap year: Jan 31 + 1 month = Feb 29', () => {
  const r = nextBillingDate(
    { lastBilledAt: d('2024-01-31T00:00:00Z'), periodMonths: 1 },
    d('2024-01-31T00:00:00Z'));
  assert.equal(r.toISOString().slice(0, 10), '2024-02-29');
});
test('period of 3 months', () => {
  const r = nextBillingDate(
    { lastBilledAt: d('2026-01-31T00:00:00Z'), periodMonths: 3 },
    d('2026-01-31T00:00:00Z'));
  assert.equal(r.toISOString().slice(0, 10), '2026-04-30');
});
test('overdue date returns now', () => {
  const now = d('2026-08-05T12:00:00Z');
  const r = nextBillingDate(
    { lastBilledAt: d('2026-01-15T00:00:00Z'), periodMonths: 1 }, now);
  assert.equal(r.getTime(), now.getTime());
});
test('does not use the real clock', () => {
  const r = nextBillingDate(
    { lastBilledAt: d('2030-06-10T00:00:00Z'), periodMonths: 1 },
    d('2030-06-01T00:00:00Z'));
  assert.equal(r.toISOString().slice(0, 10), '2030-07-10');
});`,
  },

  {
    id: 'paginate',
    difficulty: 'medium',
    spec: `Write a JavaScript module (ESM) exporting:

export function paginate(total, page, size)

- total: total number of items (integer >= 0)
- page: page number, starting at 1
- size: items per page (integer >= 1)

Returns { offset, limit, totalPages, hasNext }:
- offset: index of the first item on the page (0-based)
- limit: how many items to fetch for THIS page (may be smaller than size on the last page)
- totalPages: total number of pages; if total is 0, totalPages is 0
- hasNext: boolean

Edge-case rules:
- If page is less than 1, treat it as 1.
- If page is greater than totalPages, return limit 0 and hasNext false
  (offset can be any value >= total).
- If total is 0: { offset: 0, limit: 0, totalPages: 0, hasNext: false }.`,
    tests: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from './impl.mjs';

test('first full page', () => {
  assert.deepEqual(paginate(100, 1, 20), { offset: 0, limit: 20, totalPages: 5, hasNext: true });
});
test('middle page', () => {
  assert.deepEqual(paginate(100, 3, 20), { offset: 40, limit: 20, totalPages: 5, hasNext: true });
});
test('partial last page', () => {
  const r = paginate(95, 5, 20);
  assert.equal(r.offset, 80);
  assert.equal(r.limit, 15);
  assert.equal(r.totalPages, 5);
  assert.equal(r.hasNext, false);
});
test('zero total', () => {
  assert.deepEqual(paginate(0, 1, 20), { offset: 0, limit: 0, totalPages: 0, hasNext: false });
});
test('page past the end', () => {
  const r = paginate(50, 99, 20);
  assert.equal(r.limit, 0);
  assert.equal(r.hasNext, false);
});
test('page below 1 becomes 1', () => {
  const r = paginate(50, 0, 20);
  assert.equal(r.offset, 0);
  assert.equal(r.limit, 20);
});
test('exact division does not invent an extra page', () => {
  const r = paginate(40, 2, 20);
  assert.equal(r.totalPages, 2);
  assert.equal(r.hasNext, false);
});`,
  },

  {
    id: 'intervals',
    difficulty: 'hard',
    spec: `Write a JavaScript module (ESM) exporting:

export function mergeIntervals(intervals)

- intervals: array of { start: number, end: number } (minutes since midnight),
  with start < end. May arrive out of order.

Returns a NEW array of merged intervals, sorted by ascending start:
- Overlapping intervals become one.
- ADJACENT intervals (the end of one equals the start of the other) also merge.
- Intervals contained within another disappear into the larger one.
- Do not modify the input array.
- Empty or non-array input returns [].`,
    tests: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeIntervals } from './impl.mjs';

test('merges overlapping intervals', () => {
  assert.deepEqual(mergeIntervals([{ start: 60, end: 120 }, { start: 90, end: 150 }]),
    [{ start: 60, end: 150 }]);
});
test('fuses adjacent intervals', () => {
  assert.deepEqual(mergeIntervals([{ start: 60, end: 120 }, { start: 120, end: 180 }]),
    [{ start: 60, end: 180 }]);
});
test('keeps non-touching intervals separate', () => {
  assert.deepEqual(mergeIntervals([{ start: 60, end: 120 }, { start: 121, end: 180 }]),
    [{ start: 60, end: 120 }, { start: 121, end: 180 }]);
});
test('sorts scrambled input', () => {
  assert.deepEqual(mergeIntervals([{ start: 300, end: 360 }, { start: 60, end: 90 }]),
    [{ start: 60, end: 90 }, { start: 300, end: 360 }]);
});
test('absorbs a contained interval', () => {
  assert.deepEqual(mergeIntervals([{ start: 60, end: 300 }, { start: 100, end: 150 }]),
    [{ start: 60, end: 300 }]);
});
test('does not mutate the input', () => {
  const input = [{ start: 60, end: 120 }, { start: 90, end: 150 }];
  const copy = JSON.parse(JSON.stringify(input));
  mergeIntervals(input);
  assert.deepEqual(input, copy);
});
test('edge cases', () => {
  assert.deepEqual(mergeIntervals([]), []);
  assert.deepEqual(mergeIntervals(null), []);
});`,
  },

  {
    id: 'conflicts',
    difficulty: 'hard',
    spec: `Write a JavaScript module (ESM) exporting:

export function findConflicts(bookings, candidate)

- bookings: array of { id: string, start: number, end: number, resource: string }
- candidate: { start: number, end: number, resource: string }
  (start/end in minutes, start < end)

Returns an array with the IDs of the bookings that conflict with "candidate", in the
order they appear in the input.

Rules:
- Only conflicts if it's the SAME resource.
- Partial or total overlap conflicts.
- Touching does NOT conflict: a booking that ends at 120 does not conflict with
  another that starts at 120.
- If there's no conflict, return [].
- Invalid input (bookings isn't an array, or candidate is null) returns [].`,
    tests: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findConflicts } from './impl.mjs';

const base = [
  { id: 'a', start: 60, end: 120, resource: 'room1' },
  { id: 'b', start: 120, end: 180, resource: 'room1' },
  { id: 'c', start: 60, end: 180, resource: 'room2' },
];

test('partial overlap conflicts', () => {
  assert.deepEqual(findConflicts(base, { start: 100, end: 140, resource: 'room1' }), ['a', 'b']);
});
test('touching at the end does not conflict', () => {
  assert.deepEqual(findConflicts(base, { start: 180, end: 240, resource: 'room1' }), []);
});
test('touching at the start does not conflict', () => {
  assert.deepEqual(findConflicts(base, { start: 0, end: 60, resource: 'room1' }), []);
});
test('different resource does not conflict', () => {
  assert.deepEqual(findConflicts(base, { start: 100, end: 140, resource: 'room3' }), []);
});
test('candidate contained in an existing booking', () => {
  assert.deepEqual(findConflicts(base, { start: 70, end: 80, resource: 'room1' }), ['a']);
});
test('candidate engulfs an existing booking', () => {
  assert.deepEqual(findConflicts(base, { start: 0, end: 600, resource: 'room2' }), ['c']);
});
test('edge cases', () => {
  assert.deepEqual(findConflicts([], { start: 1, end: 2, resource: 'x' }), []);
  assert.deepEqual(findConflicts(null, { start: 1, end: 2, resource: 'x' }), []);
  assert.deepEqual(findConflicts(base, null), []);
});`,
  },

  // ---- BRUTAL tier: added after everyone scored 100% on the set above ----

  {
    id: 'csv',
    difficulty: 'brutal',
    spec: `Write a JavaScript module (ESM) exporting:

export function parseCSV(text)

Returns an array of arrays of strings (rows x fields). CSV rules (RFC 4180):
- Field separator: comma.
- A field may be quoted with double quotes. Inside quotes, comma and newline are
  PART of the field, they don't separate it.
- Double quotes inside a quoted field are escaped by doubling: "" becomes ".
- Line breaks may be \\n or \\r\\n. A trailing one at end of file (if present)
  does not produce an extra empty row.
- An empty field becomes an empty string.
- Spaces OUTSIDE quotes are part of the field (do not trim).
- Empty or non-string input returns [].`,
    tests: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV } from './impl.mjs';

test('basic', () => {
  assert.deepEqual(parseCSV('a,b,c'), [['a', 'b', 'c']]);
});
test('multiple rows with CRLF', () => {
  assert.deepEqual(parseCSV('a,b\\r\\nc,d'), [['a', 'b'], ['c', 'd']]);
});
test('does not create an extra trailing row', () => {
  assert.deepEqual(parseCSV('a,b\\n'), [['a', 'b']]);
});
test('comma inside quotes', () => {
  assert.deepEqual(parseCSV('"Smith, John",30'), [['Smith, John', '30']]);
});
test('escaped quotes', () => {
  assert.deepEqual(parseCSV('"he said ""hi""",x'), [['he said "hi"', 'x']]);
});
test('newline inside quotes', () => {
  assert.deepEqual(parseCSV('"line1\\nline2",b'), [['line1\\nline2', 'b']]);
});
test('empty fields', () => {
  assert.deepEqual(parseCSV('a,,c'), [['a', '', 'c']]);
  assert.deepEqual(parseCSV(',,'), [['', '', '']]);
});
test('does not trim outside quotes', () => {
  assert.deepEqual(parseCSV('a , b'), [['a ', ' b']]);
});
test('field that is just empty quotes', () => {
  assert.deepEqual(parseCSV('"",x'), [['', 'x']]);
});
test('edge cases', () => {
  assert.deepEqual(parseCSV(''), []);
  assert.deepEqual(parseCSV(null), []);
});`,
  },

  {
    id: 'money',
    difficulty: 'brutal',
    spec: `Write a JavaScript module (ESM) exporting:

export function allocateCents(totalCents, weights)

Allocates an integer amount in cents among N participants, proportionally to
"weights" (array of numbers >= 0).

Rules:
- Returns an array of integers (cents), same length as "weights".
- The SUM of the result must be EXACTLY totalCents. No cent lost or left over —
  that's the whole point of the exercise.
- Use largest-remainder distribution: compute each participant's proportional
  share, take the integer part of each, then hand out the remaining cents one by
  one to whoever has the LARGEST fractional remainder. Tie on remainder: whoever
  comes first in the array wins.
- If the sum of weights is 0 (or the array is empty), return an array of zeros of
  the same length.
- totalCents may be negative; the allocation follows the same logic (the sum must
  still match).
- Do not use floating point in the final result — return integers.`,
    tests: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateCents } from './impl.mjs';

const sum = (a) => a.reduce((x, y) => x + y, 0);

test('exact division', () => {
  assert.deepEqual(allocateCents(300, [1, 1, 1]), [100, 100, 100]);
});
test('classic 100/3 — no cent goes missing', () => {
  const r = allocateCents(100, [1, 1, 1]);
  assert.equal(sum(r), 100);
  assert.deepEqual(r, [34, 33, 33]);
});
test('different weights', () => {
  const r = allocateCents(1000, [1, 2, 3]);
  assert.equal(sum(r), 1000);
  assert.deepEqual(r, [167, 333, 500]);
});
test('remainder tie goes to the first', () => {
  const r = allocateCents(10, [1, 1, 1]);
  assert.equal(sum(r), 10);
  assert.deepEqual(r, [4, 3, 3]);
});
test('zero weight receives nothing', () => {
  const r = allocateCents(100, [1, 0, 1]);
  assert.equal(sum(r), 100);
  assert.equal(r[1], 0);
});
test('negative total keeps the sum', () => {
  const r = allocateCents(-100, [1, 1, 1]);
  assert.equal(sum(r), -100);
});
test('large value without loss', () => {
  const r = allocateCents(999999, [7, 11, 13, 17]);
  assert.equal(sum(r), 999999);
});
test('edge cases', () => {
  assert.deepEqual(allocateCents(100, [0, 0]), [0, 0]);
  assert.deepEqual(allocateCents(100, []), []);
});`,
  },
];
