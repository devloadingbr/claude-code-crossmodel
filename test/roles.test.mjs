import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { quotaGroupOf, resolveRole, unknownAliases, DEFAULT_ROLES } from '../lib/roles.mjs';

const MODELS = {
  luna:  { provider: 'codex', model: 'gpt-5.6-luna' },
  sol:   { provider: 'codex', model: 'gpt-5.6-sol' },
  qwen:  { provider: 'opencode', model: 'opencode-go/qwen3.8-flash' },
  glm:   { provider: 'opencode', model: 'opencode-go/glm-5.3-flash' },
  flash: { provider: 'opencode', model: 'opencode/ling-3.0-flash-fin-free' },
  gem:   { provider: 'agy', model: 'gemini-3.8-flash-high' },
  opus:  { provider: 'claude', model: 'claude-opus-5' },
};

const NOW = new Date(2026, 8, 4, 12, 0, 0, 0);
const EMPTY_CIRCUIT = { groups: {}, roleRotation: {} };

describe('quotaGroupOf', () => {
  it('groups codex aliases under one pool', () => {
    assert.equal(quotaGroupOf('luna', MODELS), 'codex');
    assert.equal(quotaGroupOf('sol', MODELS), 'codex');
  });

  it('distinguishes OpenCode Go from the free opencode tier, same provider field', () => {
    assert.equal(quotaGroupOf('qwen', MODELS), 'opencode-go');
    assert.equal(quotaGroupOf('glm', MODELS), 'opencode-go');
    assert.equal(quotaGroupOf('flash', MODELS), 'opencode-free');
  });

  it('falls back to the provider name for everything else', () => {
    assert.equal(quotaGroupOf('gem', MODELS), 'agy');
    assert.equal(quotaGroupOf('opus', MODELS), 'claude');
  });

  it('unknown alias resolves to null rather than throwing', () => {
    assert.equal(quotaGroupOf('nonexistent', MODELS), null);
  });
});

describe('DEFAULT_ROLES', () => {
  it('never routes the orchestrator\'s own model (claude) into an automatic role', () => {
    for (const def of Object.values(DEFAULT_ROLES)) {
      assert.ok(!def.order.includes('opus') && !def.order.includes('sonnet') && !def.order.includes('haiku'));
    }
  });

  it('every default alias resolves against the real MODELS shape', () => {
    for (const def of Object.values(DEFAULT_ROLES)) {
      assert.deepEqual(unknownAliases(def.order, MODELS), []);
    }
  });
});

describe('resolveRole — priority policy', () => {
  const def = { policy: 'priority', order: ['luna', 'qwen'] };

  it('picks the first candidate when nothing is open', () => {
    const r = resolveRole('write', def, MODELS, EMPTY_CIRCUIT, NOW);
    assert.equal(r.alias, 'luna');
    assert.equal(r.group, 'codex');
  });

  it('falls through to the next candidate when the first\'s group is open', () => {
    const circuit = { groups: { codex: { state: 'open', openUntil: null, failWindow: [] } }, roleRotation: {} };
    const r = resolveRole('write', def, MODELS, circuit, NOW);
    assert.equal(r.alias, 'qwen');
    assert.equal(r.group, 'opencode-go');
  });

  it('errors when every candidate\'s group is open', () => {
    const circuit = {
      groups: {
        codex: { state: 'open', openUntil: null, failWindow: [] },
        'opencode-go': { state: 'open', openUntil: null, failWindow: [] },
      },
      roleRotation: {},
    };
    const r = resolveRole('write', def, MODELS, circuit, NOW);
    assert.ok(r.error);
    assert.match(r.error, /write/);
  });
});

describe('resolveRole — round-robin policy', () => {
  const def = { policy: 'round-robin', order: ['glm', 'gem'] };

  it('alternates the starting candidate across successive calls', () => {
    let circuit = EMPTY_CIRCUIT;
    const first = resolveRole('review', def, MODELS, circuit, NOW);
    assert.equal(first.alias, 'glm');
    circuit = first.circuitState;
    const second = resolveRole('review', def, MODELS, circuit, NOW);
    assert.equal(second.alias, 'gem');
    circuit = second.circuitState;
    const third = resolveRole('review', def, MODELS, circuit, NOW);
    assert.equal(third.alias, 'glm'); // wrapped back around
  });

  it('still falls through to the other candidate if its rotated pick is open', () => {
    const circuit = {
      groups: { agy: { state: 'open', openUntil: null, failWindow: [] } }, // gem's group
      roleRotation: { review: { lastIndex: 0 } }, // next pick would be index 1 = gem
    };
    const r = resolveRole('review', def, MODELS, circuit, NOW);
    assert.equal(r.alias, 'glm'); // gem skipped, glm used instead
  });

  it('persists the rotation advance in circuitState even when the candidate is open', () => {
    const circuit = { groups: {}, roleRotation: { review: { lastIndex: 0 } } };
    const r = resolveRole('review', def, MODELS, circuit, NOW);
    assert.equal(r.circuitState.roleRotation.review.lastIndex, 1);
  });
});
