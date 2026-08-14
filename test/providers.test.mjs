import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  BUILTIN_MODELS,
  BUILTIN_PROVIDERS,
  CONFIG_NAMES,
  capabilityError,
  extractJSON,
  extractCode,
} from '../lib/providers.mjs';

const CTX = {
  model: 'test-model',
  prompt: 'do the thing',
  schemaPath: '/tmp/schema.json',
  cwd: '/tmp/work',
  write: false,
  stream: false,
  effort: undefined,
  network: false,
  resume: undefined,
};

function assertRefusal(msg, what) {
  assert.equal(typeof msg, 'string');
  assert.ok(msg.length > 0, 'refusal must be a non-empty string');
  assert.match(String(msg).toLowerCase(), what, `refusal should mention what to drop; got: ${msg}`);
}

describe('CONFIG_NAMES', () => {
  it('keeps the two legacy plugin-local locations after the move out of bench/', () => {
    // ROOT is now lib/. The old relatives ('crossmodel.config.json' = bench/,
    // '../crossmodel.config.json' = plugin root) would silently miss an existing
    // install's config — the class of bug this project exists to prevent.
    assert.ok(path.isAbsolute(CONFIG_NAMES[0]));
    assert.equal(CONFIG_NAMES[1], '../bench/crossmodel.config.json');
    assert.equal(CONFIG_NAMES[2], '../crossmodel.config.json');
  });
});

describe('capabilityError', () => {
  it('returns null for a valid read-only call', () => {
    assert.equal(capabilityError('luna'), null);
    assert.equal(capabilityError('luna', {}), null);
    assert.equal(capabilityError('luna', { write: false }), null);
  });

  it('refuses an unknown alias', () => {
    assertRefusal(capabilityError('no-such-alias'), /unknown/);
    assert.match(capabilityError('no-such-alias'), /no-such-alias/);
  });

  it('refuses --write without cwd', () => {
    assertRefusal(capabilityError('luna', { write: true }), /cwd/);
  });

  it('gemini and ollama still have no write mode wired up', () => {
    // They ship with no builtin alias (an alias that fails on first use is worse
    // than none), so capabilityError cannot name them. The flag is the contract.
    assert.equal(BUILTIN_PROVIDERS.gemini.supportsWrite, false);
    assert.equal(BUILTIN_PROVIDERS.ollama.supportsWrite, false);
  });

  it('allows --write on claude when cwd is set', () => {
    assert.equal(capabilityError('opus', { write: true, cwd: '/tmp/work' }), null);
  });

  it('refuses --effort on a provider without supportsEffort', () => {
    assertRefusal(capabilityError('cgrok', { effort: 'high' }), /--effort|effort/);
  });

  it('refuses --network on a provider without supportsNetwork', () => {
    assertRefusal(capabilityError('cgrok', { network: true, write: true, cwd: '/tmp/work' }), /--network|network/);
  });

  it('refuses --resume on a provider without supportsResume', () => {
    assertRefusal(capabilityError('opus', { resume: 'sess-1' }), /--resume|resume/);
  });

  it('refuses --network without --write', () => {
    assertRefusal(capabilityError('luna', { network: true }), /--network/);
  });
});

describe('BUILTIN_MODELS / BUILTIN_PROVIDERS', () => {
  // The merged MODELS/PROVIDERS tables absorb $HOME config; the builtins are the
  // HOME-independent contract this file can actually pin down.
  it('every model points at a provider that exists, and every provider has a bin and an args function', () => {
    for (const [alias, entry] of Object.entries(BUILTIN_MODELS)) {
      assert.ok(entry && entry.provider, `${alias} has no provider`);
      assert.ok(BUILTIN_PROVIDERS[entry.provider], `${alias} points at missing provider "${entry.provider}"`);
    }
    for (const [name, p] of Object.entries(BUILTIN_PROVIDERS)) {
      assert.equal(typeof p.bin, 'string', `${name}.bin`);
      assert.ok(p.bin.length > 0, `${name}.bin empty`);
      assert.equal(typeof p.args, 'function', `${name}.args`);
    }
  });

  it('each provider args() builder produces an array of strings with no undefined and no null', () => {
    for (const [name, p] of Object.entries(BUILTIN_PROVIDERS)) {
      const args = p.args(CTX);
      assert.ok(Array.isArray(args), `${name}.args() is not an array`);
      for (let i = 0; i < args.length; i++) {
        assert.equal(typeof args[i], 'string', `${name}.args()[${i}] = ${args[i]}`);
      }
    }
  });
});

describe('codex args', () => {
  const codex = BUILTIN_PROVIDERS.codex;

  it('puts the prompt last', () => {
    const args = codex.args({ ...CTX, model: 'gpt-5.6-luna', prompt: 'PROMPT' });
    assert.equal(args.at(-1), 'PROMPT');
  });

  it("when resume is set, emits 'resume' with the session id after the options", () => {
    // Grammar is `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` — the id is a
    // positional, so options must precede it. Emitting `--sandbox` on `resume` was
    // a measured trap (codex-cli 0.146.1: "unexpected argument '--sandbox'").
    const args = codex.args({
      ...CTX,
      model: 'gpt-5.6-luna',
      prompt: 'PROMPT',
      resume: 'sess-abc',
    });
    assert.equal(args.at(-1), 'PROMPT');
    const ri = args.indexOf('resume');
    assert.ok(ri !== -1, "missing 'resume' subcommand");
    const sid = args.indexOf('sess-abc');
    assert.ok(sid !== -1, 'missing session id');
    assert.ok(sid > ri, 'session id must follow resume');
    assert.ok(sid < args.length - 1, 'session id must precede the prompt');
    // `-c sandbox_mode=...` is the option pair; the value does not start with `-`.
    // `--sandbox` is the measured trap: resume rejects it (codex-cli 0.146.1).
    const dash = args.findIndex((t, i) => i > ri && i < sid && t.startsWith('-'));
    assert.ok(dash !== -1, 'options must sit between resume and the session id');
    assert.ok(dash < sid);
    assert.ok(!args.includes('--sandbox'));
  });
});

describe('claude args', () => {
  const claude = BUILTIN_PROVIDERS.claude;

  it('bench path (no cwd, no write) disables tools so the battery scores the model', () => {
    const args = claude.args({ ...CTX, cwd: undefined, write: false, prompt: 'PROMPT' });
    const i = args.indexOf('--tools');
    assert.ok(i !== -1, 'missing --tools');
    assert.equal(args[i + 1], '');
    assert.ok(args.indexOf('PROMPT') < i, 'prompt must precede --tools (it is variadic)');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  });

  it('a sweep (cwd, no write) skips permissions so headless can actually read the tree', () => {
    // Measured 2026-08-13: without this, sonnet --cwd exited 0 asking the user to
    // approve `ls`. A blocked sweep reported as success.
    const args = claude.args({ ...CTX, cwd: '/tmp/work', write: false, prompt: 'PROMPT' });
    assert.ok(!args.includes('--tools'), 'a sweep that cannot use tools cannot read the tree');
    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.ok(args.includes('PROMPT'));
  });

  it('a write run skips permissions so headless does not hang on a TTY prompt', () => {
    const args = claude.args({ ...CTX, write: true, prompt: 'PROMPT' });
    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.ok(!args.includes('--tools'));
  });
});

describe('cursor args', () => {
  const cursor = BUILTIN_PROVIDERS.cursor;

  it("emits '--mode ask' when write is false", () => {
    const args = cursor.args({ ...CTX, write: false, prompt: 'PROMPT' });
    const i = args.indexOf('--mode');
    assert.ok(i !== -1, 'missing --mode');
    assert.equal(args[i + 1], 'ask');
    assert.ok(!args.includes('--sandbox'), '--sandbox is only asked for under --write');
  });

  it("emits '--sandbox disabled' on a write run, and never 'enabled'", () => {
    // crossmodel used to send `--sandbox enabled` here and let the run die when the
    // sandbox would not start. It refused on a machine where the plain `agent` CLI writes
    // perfectly well, over what turned out to be a gap in Cursor's own AppArmor profile
    // (profile cursor_sandbox_agent_cli denies dac_override to newuidmap, diagnosed
    // 2026-08-13). A wrapper that forbids what the tool permits is a wrapper people route
    // around, so this now matches Cursor's own default.
    const on = cursor.args({ ...CTX, write: true });
    const i = on.indexOf('--sandbox');
    assert.ok(i !== -1, 'a write run must state the sandbox mode rather than inherit config');
    assert.equal(on[i + 1], 'disabled');
    assert.ok(!on.includes('enabled'), 'never re-enable the sandbox: it cannot start on a stock Ubuntu');
  });

  it('a write run auto-approves rather than waiting for an approver that does not exist', () => {
    const on = cursor.args({ ...CTX, write: true });
    assert.ok(on.includes('--force'), 'headless has nobody to approve; without this the run hangs or refuses');
    assert.ok(!on.includes('--mode'), '--mode ask would make a write run read-only');
  });
});

describe('extractJSON', () => {
  it('finds the last valid object', () => {
    assert.deepEqual(extractJSON('pre { "a": 1 } mid { "b": 2 }'), { b: 2 });
  });

  it('returns null on garbage', () => {
    assert.equal(extractJSON('not json at all'), null);
    assert.equal(extractJSON('{'), null);
    assert.equal(extractJSON(''), null);
  });

  it('respects the isValid predicate', () => {
    const text = '{ "a": 1 } { "b": 2 }';
    assert.deepEqual(extractJSON(text, (o) => o.a === 1), { a: 1 });
    assert.equal(extractJSON(text, (o) => o.z === 1), null);
  });
});

describe('extractCode', () => {
  it('pulls a fenced block', () => {
    assert.equal(extractCode('prose\n```js\nconst x = 1;\n```\n'), 'const x = 1;');
  });

  it('returns raw text that already looks like code', () => {
    const src = 'export function foo() { return 1; }';
    assert.equal(extractCode(src), src);
  });

  it('returns null otherwise', () => {
    assert.equal(extractCode('just a sentence about nothing in particular.'), null);
  });
});
