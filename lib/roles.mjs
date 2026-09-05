// Role-based routing: "who does what" instead of "which alias by name".
//
// A role is a named job (write, review, explore, ...) mapped to an ORDERED list of
// aliases plus a dispatch POLICY. Two policies exist because they solve different
// problems — conflating them was the first thing external review (gpt-6-astra,
// 2026-09-04) flagged in this design:
//   priority    — try aliases in order, fall through on failure. For "which model do
//                 I actually prefer", like write: luna then qwen.
//   round-robin — alternate every call, regardless of failure. For "never let the same
//                 model review twice in a row", like review: glm/gem.
//
// QUOTA GROUPS matter more than aliases here. sol/terra/luna/astra all bill the same
// ChatGPT subscription through codex; qwen/glm bill the same OpenCode Go subscription.
// A quota failure on one alias means the WHOLE group is out, not just that alias — so
// the circuit breaker (circuit.mjs) keys its state by group, not by alias. Getting this
// wrong was the other point astra flagged: falling back from "luna" to "sol" on a codex
// quota error accomplishes nothing, because both draw from the same empty pool.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { USER_DIR } from './mode.mjs';
import { isGroupOpen, nextRoundRobinIndex } from './circuit.mjs';

export const ROLES_PATH = path.join(USER_DIR, 'roles.json');

// Deliberately excludes 'claude' — routing the orchestrator's own model back into its
// own fallback chain would spend the quota this whole plugin exists to protect. It can
// still be called by name (`--model opus`) for a one-off, explicit reason; it never
// appears in an automatic role fallback.
export const DEFAULT_ROLES = {
  write:   { policy: 'priority',    order: ['luna', 'qwen'] },
  review:  { policy: 'round-robin', order: ['glm', 'gem'] },
  explore: { policy: 'priority',    order: ['qwen', 'flash'] },
};

/**
 * Which quota pool an alias actually draws from. Falls back to the provider name, which
 * is correct for every provider except opencode, which hosts three separate pools
 * (the paid Go subscription, the free promotional tier, and pay-as-you-go Zen) behind
 * one binary — distinguished by the model id's own prefix, not by anything crossmodel
 * assigns.
 */
export function quotaGroupOf(alias, MODELS) {
  const entry = MODELS[alias];
  if (!entry) return null;
  if (entry.provider === 'opencode') {
    if (entry.model.startsWith('opencode-go/')) return 'opencode-go';
    if (/-free$/.test(entry.model)) return 'opencode-free';
    return 'opencode-zen';
  }
  return entry.provider;
}

function shapeError(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `roles.json: expected a JSON object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`;
  }
  if (!raw.roles || typeof raw.roles !== 'object' || Array.isArray(raw.roles)) {
    return 'roles.json: expected a "roles" object';
  }
  for (const [name, def] of Object.entries(raw.roles)) {
    if (!def || typeof def !== 'object') return `roles.json: role "${name}" is not an object`;
    if (!['priority', 'round-robin'].includes(def.policy)) {
      return `roles.json: role "${name}" has policy "${def.policy}", expected "priority" or "round-robin"`;
    }
    if (!Array.isArray(def.order) || def.order.length === 0 || !def.order.every((a) => typeof a === 'string')) {
      return `roles.json: role "${name}" needs a non-empty array of alias strings in "order"`;
    }
  }
  return null;
}

/**
 * Reads ~/.claude/crossmodel/roles.json, falling back to DEFAULT_ROLES when the file
 * does not exist. A malformed file is an ERROR, not a silent fallback to defaults —
 * otherwise a typo in hand-edited JSON quietly reverts to a policy the user thought
 * they had changed.
 */
export function readRoles() {
  if (!existsSync(ROLES_PATH)) return { roles: DEFAULT_ROLES };
  let raw;
  try {
    raw = JSON.parse(readFileSync(ROLES_PATH, 'utf8'));
  } catch (e) {
    return { error: `roles.json: ${e.message}` };
  }
  const err = shapeError(raw);
  if (err) return { error: err };
  return { roles: raw.roles };
}

export function writeRoles(roles) {
  mkdirSync(USER_DIR, { recursive: true });
  writeFileSync(ROLES_PATH, `${JSON.stringify({ roles }, null, 2)}\n`);
  return ROLES_PATH;
}

/**
 * Pick ONE alias to dispatch for a role, given the current circuit-breaker state.
 *
 * round-robin starts from the next rotation slot (advancing the pointer regardless of
 * what happens next — distributing load is the point, independent of success) and then
 * falls through the rest of the order if that slot's quota group is open. priority just
 * walks the order as given. Either way, a candidate whose quota GROUP is open is skipped
 * — this is the proactive half of quota-awareness: known-exhausted pools are never
 * dispatched to, no call wasted finding that out again.
 *
 * Returns { alias, group, reason, circuitState } on success (circuitState carries the
 * round-robin pointer advance, to be persisted by the caller regardless of outcome), or
 * { error, circuitState } when every candidate's group is currently open.
 */
export function resolveRole(roleName, roleDef, MODELS, circuitState, now = new Date()) {
  const { policy, order } = roleDef;
  let candidates = order;
  let circuitAfterRotation = circuitState;
  let reasonPrefix = 'priority';

  if (policy === 'round-robin') {
    const { index, state } = nextRoundRobinIndex(circuitState, roleName, order.length);
    circuitAfterRotation = state;
    candidates = [...order.slice(index), ...order.slice(0, index)];
    reasonPrefix = `round-robin turn ${index + 1}/${order.length}`;
  }

  for (const alias of candidates) {
    const group = quotaGroupOf(alias, MODELS);
    // Openness is checked against the ORIGINAL state — rotation bookkeeping never
    // changes which quota groups are actually exhausted.
    if (group && isGroupOpen(circuitState, group, now)) continue;
    return { alias, group, reason: reasonPrefix, circuitState: circuitAfterRotation };
  }

  return {
    error: `every candidate for role "${roleName}" (${order.join(', ')}) has its quota group marked open right now — check \`crossmodel role status\``,
    circuitState: circuitAfterRotation,
  };
}

/**
 * Every alias a role's order list can legally resolve to, validated against MODELS.
 * Callers should check this before writing the file, not after — an alias that stops
 * existing (a provider removed, a typo) should fail at `/crossmodel-select` time, not
 * silently at 2am during a real dispatch.
 */
export function unknownAliases(order, MODELS) {
  return order.filter((a) => !MODELS[a]);
}
