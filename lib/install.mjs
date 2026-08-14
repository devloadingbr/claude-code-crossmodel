// Install crossmodel into a Cursor host: shim on PATH, always-on user rule, setup skill.
//
// Why a command and not something npm install does: the files live in $HOME
// (`~/.cursor/rules`, `~/.local/bin`) and are the user's, not the package's. Writing
// them unprompted would surprise anyone who `npm i -g` for the CLI alone.
//
// Why a shim and not `npm link`: global npm often needs root, and a link into a
// versioned plugin directory dies on the next plugin update. The shim points at
// THIS checkout's `bin/crossmodel.mjs` by absolute path; re-running install
// rewrites it if the checkout moved.
//
// Never touches a project repo. Project primers are `crossmodel teach`.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_BIN = path.join(ROOT, 'bin', 'crossmodel.mjs');
export const HOOK_SRC = path.join(ROOT, 'hooks', 'enforce.mjs');
export const SKILL_SRC = path.join(ROOT, 'skills', 'crossmodel-setup', 'SKILL.md');
export const RULE_SRC = path.join(ROOT, 'cursor', 'rules', 'crossmodel.mdc');

function writeIfChanged(file, contents, mode = 0o644) {
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (prev === contents) {
    try { chmodSync(file, mode); } catch { /* non-unix */ }
    return 'unchanged';
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, { mode });
  try { chmodSync(file, mode); } catch { /* non-unix */ }
  return prev == null ? 'created' : 'updated';
}

function shimBody(cliBin) {
  // JSON.stringify quotes the path so a space in the checkout does not split the exec.
  return `#!/bin/sh\nexec node ${JSON.stringify(cliBin)} "$@"\n`;
}

const ENFORCE_COMMAND = 'crossmodel-enforce';
const ENFORCE_HOOKS = {
  preToolUse: {
    command: './hooks/crossmodel-enforce',
    matcher: 'Grep|Glob|Task',
  },
  subagentStart: {
    command: './hooks/crossmodel-enforce',
    matcher: 'delegate|explore|probe',
  },
};

function isOurHook(entry) {
  return entry && typeof entry.command === 'string' && entry.command.includes(ENFORCE_COMMAND);
}

function readHooksJson(file) {
  if (!existsSync(file)) return { version: 1, hooks: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  if (parsed.hooks != null && (typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks))) {
    throw new Error(`${file}.hooks must contain an object`);
  }
  return { ...parsed, version: parsed.version ?? 1, hooks: { ...(parsed.hooks ?? {}) } };
}

function withoutOurHooks(document) {
  const hooks = { ...document.hooks };
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !isOurHook(entry));
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  return { ...document, hooks };
}

function mergedHooksJson(file, noEnforce) {
  const current = readHooksJson(file);
  const stripped = withoutOurHooks(current);
  if (noEnforce) return stripped;
  return {
    ...stripped,
    hooks: {
      ...stripped.hooks,
      preToolUse: [...(Array.isArray(stripped.hooks.preToolUse) ? stripped.hooks.preToolUse : []), ENFORCE_HOOKS.preToolUse],
      subagentStart: [...(Array.isArray(stripped.hooks.subagentStart) ? stripped.hooks.subagentStart : []), ENFORCE_HOOKS.subagentStart],
    },
  };
}

function hooksJsonBody(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function hooksJsonHasOurHooks(file) {
  if (!existsSync(file)) return false;
  const document = readHooksJson(file);
  return Object.values(document.hooks).some((entries) => Array.isArray(entries) && entries.some(isOurHook));
}

/**
 * @param {{ home?: string, cliBin?: string, dryRun?: boolean, noEnforce?: boolean }} [opts]
 */
export function installCursor(opts = {}) {
  const home = opts.home ?? os.homedir();
  const cliBin = opts.cliBin ?? CLI_BIN;
  if (!existsSync(cliBin)) return { ok: false, error: `CLI not found at ${cliBin}` };
  if (!existsSync(HOOK_SRC)) return { ok: false, error: `enforcement hook missing at ${HOOK_SRC}` };
  if (!existsSync(SKILL_SRC)) return { ok: false, error: `setup skill missing at ${SKILL_SRC}` };
  if (!existsSync(RULE_SRC)) return { ok: false, error: `Cursor rule missing at ${RULE_SRC}` };

  const shim = path.join(home, '.local', 'bin', 'crossmodel');
  const rule = path.join(home, '.cursor', 'rules', 'crossmodel.mdc');
  const skill = path.join(home, '.cursor', 'skills', 'crossmodel-setup', 'SKILL.md');
  const hookShim = path.join(home, '.cursor', 'hooks', 'crossmodel-enforce');
  const hooksJson = path.join(home, '.cursor', 'hooks.json');
  const noEnforce = opts.noEnforce === true;

  let hooksJsonAction = 'unchanged';
  try {
    if (noEnforce) {
      if (hooksJsonHasOurHooks(hooksJson)) hooksJsonAction = opts.dryRun ? 'would-update' : 'removed';
    } else {
      hooksJsonAction = opts.dryRun
        ? (existsSync(hooksJson) ? 'would-update' : 'would-create')
        : null;
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }

  if (opts.dryRun) {
    return {
      ok: true,
      actions: {
        shim: existsSync(shim) ? 'would-update' : 'would-create',
        rule: existsSync(rule) ? 'would-update' : 'would-create',
        skill: existsSync(skill) ? 'would-update' : 'would-create',
        hookShim: noEnforce ? 'skipped' : (existsSync(hookShim) ? 'would-update' : 'would-create'),
        hooksJson: hooksJsonAction,
      },
      shim, rule, skill, hookShim, hooksJson,
      pathHint: !(process.env.PATH || '').split(path.delimiter).includes(path.dirname(shim)),
    };
  }

  if (hooksJsonAction === null) {
    try {
      hooksJsonAction = writeIfChanged(hooksJson, hooksJsonBody(mergedHooksJson(hooksJson, false)));
    } catch (error) {
      return { ok: false, error: error.message };
    }
  } else if (noEnforce && hooksJsonAction === 'removed') {
    try {
      writeIfChanged(hooksJson, hooksJsonBody(mergedHooksJson(hooksJson, true)));
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  const actions = {
    shim: writeIfChanged(shim, shimBody(cliBin), 0o755),
    rule: writeIfChanged(rule, readFileSync(RULE_SRC, 'utf8')),
    skill: writeIfChanged(skill, readFileSync(SKILL_SRC, 'utf8')),
    hookShim: noEnforce ? 'skipped' : writeIfChanged(hookShim, shimBody(HOOK_SRC), 0o755),
    hooksJson: hooksJsonAction,
  };
  const pathHint = !(process.env.PATH || '').split(path.delimiter).includes(path.dirname(shim));
  return { ok: true, actions, shim, rule, skill, hookShim, hooksJson, pathHint };
}
