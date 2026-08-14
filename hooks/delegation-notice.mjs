#!/usr/bin/env node
// PreToolUse hook on Bash / beforeShellExecution: announce when a command is about to
// spend an EXTERNAL provider's quota instead of this session's.
//
// Why this exists: delegation is invisible. A `codex exec` and a `grep` look identical
// in the transcript, so you cannot tell which pool a turn is draining without reading
// every command. This makes the boundary visible at the moment it is crossed.
//
// It only announces. It never blocks — a notice that can break your workflow would be
// worse than no notice.
//
// Same-pool calls stay silent: Claude Code → `claude`, Cursor → `cursor`. Every other
// provider, including Claude when Cursor is the orchestrator, is announced.

import { inspect, formatNotice } from '../lib/notice.mjs';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  let command = '';
  try {
    const payload = JSON.parse(buf || '{}');
    // Claude PreToolUse: tool_input.command. Cursor beforeShellExecution: command.
    command = payload.tool_input?.command ?? payload.command ?? '';
  } catch { /* ignore */ }

  const hit = inspect(command);
  if (!hit) process.exit(0);

  process.stdout.write(JSON.stringify({ systemMessage: formatNotice(hit) }));
  process.exit(0);
});
