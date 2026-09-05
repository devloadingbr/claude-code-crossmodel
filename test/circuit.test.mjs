import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, parseQuotaResetMs, isGroupOpen, recordFailure, recordSuccess, nextRoundRobinIndex } from '../lib/circuit.mjs';

const NOW = new Date(2026, 8, 4, 12, 0, 0, 0);

describe('classifyFailure', () => {
  it('recognizes known quota/balance/rate-limit phrasing', () => {
    assert.equal(classifyFailure({ stderr: 'Error: Insufficient balance.' }), 'quota');
    assert.equal(classifyFailure({ stderr: 'exit 1: rate limit exceeded' }), 'quota');
    assert.equal(classifyFailure({ stderr: 'HTTP 429 Too Many Requests' }), 'quota');
    assert.equal(classifyFailure({ stdout: 'you are out of credits' }), 'quota');
  });

  it('recognizes auth/config phrasing and never confuses it with quota', () => {
    assert.equal(classifyFailure({ stderr: 'Error: Unauthorized' }), 'auth');
    assert.equal(classifyFailure({ stderr: 'invalid API key' }), 'auth');
    assert.equal(classifyFailure({ stderr: '401 authentication required' }), 'auth');
  });

  it('falls back to ambiguous for anything unrecognized', () => {
    assert.equal(classifyFailure({ stderr: 'exit 1: something exploded' }), 'ambiguous');
    assert.equal(classifyFailure({}), 'ambiguous');
  });

  it('auth wins even if quota-like words also appear, to avoid masking a login problem', () => {
    assert.equal(classifyFailure({ stderr: 'Unauthorized: check your quota plan settings' }), 'auth');
  });

  // Regression: measured live against a real agy (Antigravity) run, 2026-09-04. The
  // original pattern only matched "insufficient/exceeded/exhausted" wording and missed
  // this entirely, so a real quota hit was scored 'ambiguous' instead of 'quota'.
  it('recognizes agy\'s real "Individual quota reached" message', () => {
    const real = 'exit 1: Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h7m40s.\n';
    assert.equal(classifyFailure({ stderr: real }), 'quota');
  });
});

describe('parseQuotaResetMs', () => {
  it('parses the exact real agy reset message into milliseconds', () => {
    const real = 'exit 1: Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h7m40s.\n';
    const ms = parseQuotaResetMs({ stderr: real });
    assert.equal(ms, (1 * 3600 + 7 * 60 + 40) * 1000);
  });

  it('parses minutes-only and seconds-only forms', () => {
    assert.equal(parseQuotaResetMs({ stderr: 'resets in 45m' }), 45 * 60_000);
    assert.equal(parseQuotaResetMs({ stderr: 'reset in 30s' }), 30_000);
  });

  it('returns null when the message has no reset delay to parse', () => {
    assert.equal(parseQuotaResetMs({ stderr: 'Insufficient balance.' }), null);
  });
});

describe('recordFailure / isGroupOpen', () => {
  it('a single quota-classified failure opens the group immediately', () => {
    let state = { groups: {}, roleRotation: {} };
    state = recordFailure(state, 'opencode-go', 'quota', NOW);
    assert.equal(isGroupOpen(state, 'opencode-go', NOW), true);
    // still open one minute later
    assert.equal(isGroupOpen(state, 'opencode-go', new Date(NOW.getTime() + 60_000)), true);
  });

  it('an open group becomes eligible again once its cooldown passes', () => {
    let state = { groups: {}, roleRotation: {} };
    state = recordFailure(state, 'codex', 'quota', NOW, { quotaCooldownMs: 1000 });
    assert.equal(isGroupOpen(state, 'codex', NOW), true);
    assert.equal(isGroupOpen(state, 'codex', new Date(NOW.getTime() + 1001)), false);
  });

  it('auth failures never open the group, no matter how many', () => {
    let state = { groups: {}, roleRotation: {} };
    for (let i = 0; i < 10; i++) state = recordFailure(state, 'cursor', 'auth', NOW);
    assert.equal(isGroupOpen(state, 'cursor', NOW), false);
    assert.deepEqual(state.groups.cursor ?? {}, {});
  });

  it('ambiguous failures only open the group after reaching the threshold', () => {
    let state = { groups: {}, roleRotation: {} };
    state = recordFailure(state, 'agy', 'ambiguous', NOW, { ambiguousThreshold: 3 });
    assert.equal(isGroupOpen(state, 'agy', NOW), false);
    state = recordFailure(state, 'agy', 'ambiguous', new Date(NOW.getTime() + 1000), { ambiguousThreshold: 3 });
    assert.equal(isGroupOpen(state, 'agy', NOW), false);
    state = recordFailure(state, 'agy', 'ambiguous', new Date(NOW.getTime() + 2000), { ambiguousThreshold: 3 });
    assert.equal(isGroupOpen(state, 'agy', new Date(NOW.getTime() + 2000)), true);
  });

  it('ambiguous failures outside the window do not accumulate toward the threshold', () => {
    let state = { groups: {}, roleRotation: {} };
    const windowMs = 5000;
    state = recordFailure(state, 'agy', 'ambiguous', NOW, { ambiguousThreshold: 2, ambiguousWindowMs: windowMs });
    const later = new Date(NOW.getTime() + windowMs + 1);
    state = recordFailure(state, 'agy', 'ambiguous', later, { ambiguousThreshold: 2, ambiguousWindowMs: windowMs });
    // the first failure aged out of the window, so this is only the 1st within it
    assert.equal(isGroupOpen(state, 'agy', later), false);
  });

  it('recordSuccess clears an open group entirely', () => {
    let state = { groups: {}, roleRotation: {} };
    state = recordFailure(state, 'opencode-go', 'quota', NOW);
    assert.equal(isGroupOpen(state, 'opencode-go', NOW), true);
    state = recordSuccess(state, 'opencode-go');
    assert.equal(isGroupOpen(state, 'opencode-go', NOW), false);
    assert.deepEqual(state.groups['opencode-go'].failWindow, []);
  });
});

describe('nextRoundRobinIndex', () => {
  it('advances and wraps regardless of role name collisions', () => {
    let state = { groups: {}, roleRotation: {} };
    let r = nextRoundRobinIndex(state, 'review', 2);
    assert.equal(r.index, 0);
    state = r.state;
    r = nextRoundRobinIndex(state, 'review', 2);
    assert.equal(r.index, 1);
    state = r.state;
    r = nextRoundRobinIndex(state, 'review', 2);
    assert.equal(r.index, 0); // wrapped
  });

  it('tracks separate roles independently', () => {
    let state = { groups: {}, roleRotation: {} };
    let a = nextRoundRobinIndex(state, 'review', 3);
    let b = nextRoundRobinIndex(a.state, 'other-role', 3);
    assert.equal(a.index, 0);
    assert.equal(b.index, 0);
    assert.equal(b.state.roleRotation.review.lastIndex, 0);
    assert.equal(b.state.roleRotation['other-role'].lastIndex, 0);
  });
});
