import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decide, DENIED_SUBAGENTS } from '../lib/enforce.mjs';

const deny = (payload, opts) => {
  const result = decide(payload, opts);
  assert.equal(result.permission, 'deny');
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(result.hookSpecificOutput.permissionDecisionReason, result.agent_message);
  assert.match(result.agent_message, /crossmodel --model luna --cwd/);
  assert.match(result.agent_message, /Do not retry Grep\/Glob\/Task explore\|delegate\|probe/);
  assert.match(result.agent_message, /Read and Shell stay available/);
  return result;
};

describe('decide', () => {
  it('exports the denied subagent set', () => {
    assert.deepEqual([...DENIED_SUBAGENTS].sort(), ['delegate', 'explore', 'probe']);
  });

  it('denies native globbing and broad grep paths', () => {
    for (const tool_name of ['Glob', 'glob']) deny({ tool_name });
    for (const path of [undefined, '.', '..', 'lib/', 'lib', '/workspace']) {
      deny({ tool_name: 'Grep', tool_input: { path } }, { isFile: () => false });
    }
  });

  it('allows grep of one file and uses the injected file check', () => {
    const checked = [];
    const result = decide(
      { tool_name: 'grep', tool_input: { path: 'src/index.mjs' } },
      { isFile: (filePath) => { checked.push(filePath); return filePath === 'src/index.mjs'; } },
    );
    assert.deepEqual(result, { permission: 'allow' });
    assert.deepEqual(checked, ['src/index.mjs']);
  });

  it('denies the three native task subagents, including type on the payload root', () => {
    for (const subagent_type of ['delegate', 'explore', 'probe']) {
      const result = deny({ tool_name: 'Task', tool_input: { subagent_type } });
      assert.match(result.user_message, /Task/);
      deny({ tool_name: 'Task', subagent_type });
    }
  });

  it('points --cwd at the workspace, never the hook process cwd', () => {
    const result = deny({
      tool_name: 'Glob',
      cwd: '/tmp/the-project',
      workspace_roots: ['/tmp/ignored'],
    });
    assert.match(result.agent_message, /--cwd "\/tmp\/the-project"/);
    assert.doesNotMatch(result.agent_message, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const fallback = deny({ tool_name: 'Glob', workspace_roots: ['/tmp/from-roots'] });
    assert.match(fallback.agent_message, /--cwd "\/tmp\/from-roots"/);
    const placeholder = deny({ tool_name: 'Glob' });
    assert.match(placeholder.agent_message, /--cwd <dir>/);
  });

  it('denies matching subagent start payloads, including no tool name', () => {
    for (const subagent_type of ['delegate', 'explore', 'probe']) {
      deny({ hook_event_name: 'subagentStart', subagent_type });
      deny({ subagent_type });
    }
  });

  it('allows the remaining native tools and task types', () => {
    for (const payload of [
      { tool_name: 'Read' },
      { tool_name: 'Shell' },
      ...['shell', 'bugbot', 'security-review', 'ci-investigator', 'cursor-guide', 'generalPurpose']
        .map((subagent_type) => ({ tool_name: 'Task', tool_input: { subagent_type } })),
      { hook_event_name: 'subagentStart', subagent_type: 'slice' },
    ]) {
      assert.deepEqual(decide(payload), { permission: 'allow' });
    }
  });

  it('fails open for empty and malformed payloads', () => {
    for (const payload of [undefined, null, [], 'not an object', 42, {}]) {
      assert.deepEqual(decide(payload), { permission: 'allow' });
    }
  });

  it('allows all tools when enforcement is disabled', () => {
    for (const CROSSMODEL_ENFORCE of ['0', 'off']) {
      assert.deepEqual(
        decide({ tool_name: 'Glob' }, { env: { CROSSMODEL_ENFORCE } }),
        { permission: 'allow' },
      );
    }
  });
});
