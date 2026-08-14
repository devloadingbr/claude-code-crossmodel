import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { orchestratorHost, samePool } from '../lib/host.mjs';
import { inspect, formatNotice } from '../lib/notice.mjs';

describe('orchestratorHost', () => {
  it('prefers Cursor when both Cursor and Claude env vars are set', () => {
    assert.equal(orchestratorHost({
      CURSOR_TRACE_ID: 'abc',
      CLAUDE_PLUGIN_ROOT: '/tmp/plugin',
    }), 'cursor');
  });

  it('detects Claude Code from CLAUDE_PLUGIN_ROOT', () => {
    assert.equal(orchestratorHost({ CLAUDE_PLUGIN_ROOT: '/tmp/plugin' }), 'claude');
  });

  it('returns unknown when nothing matches', () => {
    assert.equal(orchestratorHost({}), 'unknown');
  });
});

describe('samePool', () => {
  it('Claude Code → claude is same-pool; Cursor → claude is not', () => {
    assert.equal(samePool('claude', 'claude'), true);
    assert.equal(samePool('claude', 'cursor'), false);
    assert.equal(samePool('codex', 'claude'), false);
  });

  it('Cursor → cursor is same-pool; Cursor → codex is not', () => {
    assert.equal(samePool('cursor', 'cursor'), true);
    assert.equal(samePool('codex', 'cursor'), false);
    assert.equal(samePool('cursor', 'unknown'), false);
  });
});

describe('inspect', () => {
  const claude = { CLAUDE_PLUGIN_ROOT: '/plugin' };
  const cursor = { CURSOR_TRACE_ID: 't' };

  it('announces crossmodel --model luna from either host', () => {
    const hit = inspect('crossmodel --model luna --cwd /repo "where is X"', claude);
    assert.equal(hit.alias, 'luna');
    assert.equal(hit.provider, 'codex');
    assert.equal(hit.quota, 'OpenAI');
    assert.equal(hit.swept, '/repo');
  });

  it('stays silent for Claude Code calling sonnet', () => {
    assert.equal(inspect('crossmodel --model sonnet "hi"', claude), null);
  });

  it('announces Cursor calling sonnet (Anthropic is external there)', () => {
    const hit = inspect('crossmodel --model sonnet --cwd /repo "list files"', cursor);
    assert.equal(hit.provider, 'claude');
    assert.equal(hit.quota, 'Anthropic');
  });

  it('stays silent for Cursor calling cgrok', () => {
    assert.equal(inspect('crossmodel --model cgrok "hi"', cursor), null);
  });

  it('does not fire on a grep that merely mentions the binary', () => {
    assert.equal(inspect('grep -r codex lib/', claude), null);
  });

  it('announces a direct codex exec in command position', () => {
    const hit = inspect('codex exec -m gpt-5.6-luna "hi"', claude);
    assert.equal(hit.direct, true);
    assert.equal(hit.provider, 'codex');
  });

  it('announces a direct claude call from Cursor, not from Claude Code', () => {
    assert.equal(inspect('claude -p "hi"', claude), null);
    const hit = inspect('claude -p "hi"', cursor);
    assert.equal(hit.direct, true);
    assert.equal(hit.provider, 'claude');
  });
});

describe('formatNotice', () => {
  it('says not this session, never a hardcoded Anthropic', () => {
    const msg = formatNotice({ alias: 'luna', model: 'gpt-5.6-luna', quota: 'OpenAI', swept: '/repo' });
    assert.match(msg, /spending OpenAI quota, not this session's/);
    assert.doesNotMatch(msg, /not Anthropic/);
    assert.match(msg, /sweeping \/repo/);
  });
});
