import { statSync } from 'node:fs';

export const DENIED_SUBAGENTS = new Set(['delegate', 'explore', 'probe']);

function defaultIsFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
    const segment = String(filePath).split(/[\\/]/).at(-1) ?? '';
    return /\.[^./\\]+$/.test(segment);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function workspaceDir(payload) {
  if (typeof payload.cwd === 'string' && payload.cwd.length > 0) return payload.cwd;
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0].length > 0) return roots[0];
  return '<dir>';
}

function deniedResult(payload, blockedTool) {
  // User hooks run with cwd ~/.cursor — never process.cwd(), or the agent
  // would be told to sweep the Cursor config directory.
  const dir = workspaceDir(payload);
  const cwdArg = dir === '<dir>' ? '<dir>' : JSON.stringify(dir);
  const reason = `Native ${blockedTool} is blocked for crossmodel enforcement. Run: crossmodel --model luna --cwd ${cwdArg} "<self-contained brief>". Do not retry Grep/Glob/Task explore|delegate|probe. Read and Shell stay available.`;
  return {
    permission: 'deny',
    agent_message: reason,
    user_message: `${blockedTool} blocked; use Shell crossmodel instead.`,
    hookSpecificOutput: {
      hookEventName: payload.hook_event_name || 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function isSingleFile(filePath, isFile) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  if (filePath === '.' || filePath === '..' || /[\\/]$/.test(filePath)) return false;
  try {
    return isFile(filePath) === true;
  } catch {
    return false;
  }
}

/**
 * Decide whether a native Cursor/Claude tool should be allowed to run.
 * @param {unknown} payload
 * @param {{ env?: NodeJS.ProcessEnv, isFile?: (path: string) => boolean }} [opts]
 */
export function decide(payload, opts = {}) {
  const env = opts.env ?? process.env;
  if (String(env?.CROSSMODEL_ENFORCE ?? '').toLowerCase() === '0' || String(env?.CROSSMODEL_ENFORCE ?? '').toLowerCase() === 'off') {
    return { permission: 'allow' };
  }
  if (!isObject(payload)) return { permission: 'allow' };

  const toolName = payload.tool_name;
  const input = isObject(payload.tool_input) ? payload.tool_input : {};
  const normalizedTool = typeof toolName === 'string' ? toolName.toLowerCase() : null;
  const isFile = typeof opts.isFile === 'function' ? opts.isFile : defaultIsFile;

  if (normalizedTool === 'glob') return deniedResult(payload, 'Glob');

  if (normalizedTool === 'grep' && !isSingleFile(input.path, isFile)) {
    return deniedResult(payload, 'Grep');
  }

  const subagentType = (
    (typeof input.subagent_type === 'string' && input.subagent_type)
    || (typeof payload.subagent_type === 'string' && payload.subagent_type)
    || ''
  ).toLowerCase();

  if (normalizedTool === 'task' && DENIED_SUBAGENTS.has(subagentType)) {
    return deniedResult(payload, 'Task');
  }

  if ((payload.hook_event_name === 'subagentStart' || toolName == null) && DENIED_SUBAGENTS.has(subagentType)) {
    return deniedResult(payload, payload.hook_event_name === 'subagentStart' ? 'subagentStart' : 'Task');
  }

  return { permission: 'allow' };
}

