// Circuit breaker for role-based fallback, keyed by QUOTA GROUP (see roles.mjs), not by
// alias. State persists in ~/.claude/crossmodel/circuit.json so it survives across
// separate `crossmodel` invocations — a single CLI call cannot see the failure history
// of the call before it otherwise.
//
// Design follows external review (gpt-6-astra, 2026-09-04) on the first draft, which
// used a flat "N failures -> demote" counter for everything. That conflates three
// different situations:
//   - an unambiguous quota/rate-limit signal: ONE occurrence is enough evidence. Waiting
//     for N more just wastes N more calls on a pool that is already empty.
//   - an auth/config error (bad API key, not logged in): this is NOT a quota signal at
//     all. Tripping the breaker on it would silently paper over a setup bug — the
//     command would just start failing over to a different provider forever instead of
//     surfacing "you are not logged in".
//   - everything else (timeout, unclear non-zero exit, provider hiccup): genuinely
//     ambiguous. This is the only case where counting occurrences within a window is the
//     right tool, because a single flaky call should not take a whole quota group offline.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { USER_DIR } from './mode.mjs';

export const CIRCUIT_PATH = path.join(USER_DIR, 'circuit.json');

const AMBIGUOUS_WINDOW_MS = 10 * 60_000;   // count ambiguous failures within this window
const AMBIGUOUS_COOLDOWN_MS = 10 * 60_000; // how long an ambiguous-triggered trip stays open
const QUOTA_COOLDOWN_MS = 60 * 60_000;     // default cooldown for a confirmed quota signal —
                                            // used only when the provider gave no reset time
                                            // of its own to parse.

// Broadened 2026-09-04 after a REAL run: agy's own message ("Individual quota reached.
// Please upgrade your subscription... Resets in 1h7m40s.") did not match the original
// pattern (it had no "insufficient", "exceeded" or "exhausted") and fell through to
// 'ambiguous'. Do not narrow this back down without testing against that exact string —
// it is now a regression test in test/circuit.test.mjs.
const QUOTA_PATTERN = /insufficient balance|out of (credits|quota)|quota (exceeded|reached)|quota limit|rate.?limit|too many requests|\b429\b/i;
const AUTH_PATTERN = /unauthori[sz]ed|invalid api.?key|not logged in|authentication (failed|required)|\b401\b|no credentials/i;

// "Resets in 1h7m40s" / "resets in 45m" / "reset in 30s" — captures whatever units are
// present; a message with none of h/m/s present does not match at all, and the caller
// falls back to the generic QUOTA_COOLDOWN_MS.
const RESET_IN_PATTERN = /resets?\s+in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i;

/**
 * Classify a failed run from its exit signal. Returns 'quota', 'auth', or 'ambiguous'.
 * Auth NEVER trips the breaker — it means "fix your login", not "try someone else".
 */
export function classifyFailure({ stderr = '', stdout = '' } = {}) {
  const text = `${stderr}\n${stdout}`;
  if (AUTH_PATTERN.test(text)) return 'auth';
  if (QUOTA_PATTERN.test(text)) return 'quota';
  return 'ambiguous';
}

/**
 * When a quota-classified message names its own reset delay, use THAT instead of the
 * generic cooldown — a provider telling you exactly when it reopens is better evidence
 * than any default. Returns milliseconds, or null when nothing parseable is present.
 */
export function parseQuotaResetMs({ stderr = '', stdout = '' } = {}) {
  const text = `${stderr}\n${stdout}`;
  const m = RESET_IN_PATTERN.exec(text);
  if (!m) return null;
  const [, h, min, s] = m;
  if (!h && !min && !s) return null;
  return (Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000;
}

function emptyGroup() {
  return { state: 'closed', openUntil: null, failWindow: [] };
}

function shapeError(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `circuit.json: expected a JSON object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`;
  }
  return null;
}

export function readCircuit() {
  if (!existsSync(CIRCUIT_PATH)) return { groups: {}, roleRotation: {} };
  let raw;
  try {
    raw = JSON.parse(readFileSync(CIRCUIT_PATH, 'utf8'));
  } catch (e) {
    return { error: `circuit.json: ${e.message}` };
  }
  const err = shapeError(raw);
  if (err) return { error: err };
  return { groups: raw.groups ?? {}, roleRotation: raw.roleRotation ?? {} };
}

export function writeCircuit(state) {
  mkdirSync(USER_DIR, { recursive: true });
  writeFileSync(CIRCUIT_PATH, `${JSON.stringify(state, null, 2)}\n`);
  return CIRCUIT_PATH;
}

/**
 * True when `group` is currently suspended. Passing the open deadline resets nothing by
 * itself — the caller still has to attempt a real dispatch and report success/failure —
 * this only tells you whether to skip straight to the next candidate.
 */
export function isGroupOpen(state, group, now = new Date()) {
  const g = state.groups?.[group];
  if (!g || g.state !== 'open') return false;
  if (!g.openUntil) return true; // open with no deadline: stays open until a success clears it
  return now.getTime() < new Date(g.openUntil).getTime();
}

/** Pure state transition — callers persist the result with writeCircuit. */
export function recordFailure(state, group, kind, now = new Date(), opts = {}) {
  if (kind === 'auth') return state; // never trips the breaker
  const groups = { ...state.groups };
  const g = { ...(groups[group] ?? emptyGroup()) };

  if (kind === 'quota') {
    g.state = 'open';
    g.openUntil = new Date(now.getTime() + (opts.quotaCooldownMs ?? QUOTA_COOLDOWN_MS)).toISOString();
    g.failWindow = [];
  } else {
    // ambiguous: prune the window, then count. One flaky call must not read as an outage.
    const windowMs = opts.ambiguousWindowMs ?? AMBIGUOUS_WINDOW_MS;
    const threshold = opts.ambiguousThreshold ?? 3;
    const kept = (g.failWindow ?? []).filter((t) => now.getTime() - new Date(t).getTime() < windowMs);
    kept.push(now.toISOString());
    g.failWindow = kept;
    if (kept.length >= threshold) {
      g.state = 'open';
      g.openUntil = new Date(now.getTime() + (opts.ambiguousCooldownMs ?? AMBIGUOUS_COOLDOWN_MS)).toISOString();
      g.failWindow = [];
    }
  }

  groups[group] = g;
  return { ...state, groups };
}

/** A successful call is the only thing that fully clears a group's failure history. */
export function recordSuccess(state, group) {
  const groups = { ...state.groups };
  groups[group] = emptyGroup();
  return { ...state, groups };
}

/**
 * Next index for a round-robin role. Advances and wraps regardless of outcome — the
 * point is distributing load across reviewers, which is orthogonal to whether any one
 * call happened to fail.
 */
export function nextRoundRobinIndex(state, roleName, orderLength) {
  const cur = state.roleRotation?.[roleName]?.lastIndex ?? -1;
  const next = (cur + 1) % orderLength;
  const roleRotation = { ...state.roleRotation, [roleName]: { lastIndex: next } };
  return { index: next, state: { ...state, roleRotation } };
}
