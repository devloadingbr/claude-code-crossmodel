// crossmodel usage — how much of the external provider's quota is actually left.
//
// The whole premise of this tool is "spend their quota instead of yours". That premise is
// unverifiable without a number, and until now there was none: you delegated and hoped.
// Worse, the failure mode is silent — you only discover the pool was empty when a run
// comes back refused, halfway through a batch.
//
// None of these CLIs ship a `usage` command. What codex *does* ship is a rollout
// transcript per session, and the rate-limit snapshot the server returns rides along in
// it. So this reads the transcripts rather than calling an API — no network, no auth, and
// it works while a run is still in flight.
//
// ⚠️ This reads a file format nobody promised to keep stable. Every field is therefore
// optional here, and a shape we don't recognise reports "unknown" instead of throwing or,
// far worse, inventing a reassuring zero.

import { readFileSync, openSync, readSync, fstatSync, closeSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Where codex keeps its per-session transcripts. `CODEX_HOME` wins when set. */
export function codexSessionsDir() {
  const home = process.env.CODEX_HOME || path.join(homedir(), '.codex');
  return path.join(home, 'sessions');
}

/**
 * Read the last `bytes` of a file as text, dropping the leading partial line.
 *
 * Transcripts grow into the tens of MB and the numbers we want are cumulative — the last
 * occurrence is the whole answer. Reading the file entire would turn a status command into
 * a disk-thrashing one for no extra information.
 */
function tail(file, bytes = 256 * 1024) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    // A partial first line is not a line. Keep it and JSON.parse would fail on every call.
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
  }
}

/** Every rollout-*.jsonl under sessions/YYYY/MM/DD, newest first, with its date. */
function rolloutFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try { out.push({ file: p, mtime: statSync(p).mtimeMs }); } catch { /* raced with a delete */ }
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Depth-first search for the first object under `node` carrying `key`. */
function findKey(node, key, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Object.prototype.hasOwnProperty.call(node, key) && node[key] && typeof node[key] === 'object') return node[key];
  for (const v of Object.values(node)) {
    const hit = findKey(v, key, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Last JSON line in `text` that contains `key`, parsed and unwrapped to that key's value. */
function lastValue(text, key) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes(`"${key}"`)) continue;
    try {
      const hit = findKey(JSON.parse(l), key);
      if (hit) return hit;
    } catch { /* truncated or not JSON — keep walking back */ }
  }
  return null;
}

/**
 * Current quota picture for codex.
 *
 * @param {{now?: number, maxFiles?: number}} [opts] `now` is injectable so the windowing is
 *        testable without waiting for a calendar day to turn over.
 * @returns {{provider, ok, why?, limit?, tokens?, sessionsDir}}
 */
export function codexUsage(opts = {}) {
  const now = opts.now ?? Date.now();
  const dir = codexSessionsDir();
  const files = rolloutFiles(dir);
  if (!files.length) {
    return { provider: 'codex', ok: false, why: `no session transcripts under ${dir}`, sessionsDir: dir };
  }

  // The freshest snapshot wins, but the newest file may not have one yet (a session that
  // died before its first server response). Walk back until one turns up.
  let limit = null;
  for (const { file } of files.slice(0, 40)) {
    const rl = lastValue(tail(file), 'rate_limits');
    if (rl) { limit = rl; break; }
  }

  // Token totals per window. Cumulative per session, so only the last entry of each file
  // counts — summing every entry would multiply one session by its number of turns.
  const DAY = 86_400_000;
  const acc = { day: { input: 0, output: 0, sessions: 0 }, week: { input: 0, output: 0, sessions: 0 } };
  const cap = opts.maxFiles ?? 400;
  for (const { file, mtime } of files.slice(0, cap)) {
    const age = now - mtime;
    if (age > 7 * DAY) break; // sorted newest-first, so everything after is older too
    const t = lastValue(tail(file), 'total_token_usage');
    if (!t) continue;
    const input = t.input_tokens ?? 0;
    const output = t.output_tokens ?? 0;
    acc.week.input += input; acc.week.output += output; acc.week.sessions++;
    if (age <= DAY) { acc.day.input += input; acc.day.output += output; acc.day.sessions++; }
  }

  const primary = limit?.primary ?? null;
  return {
    provider: 'codex',
    ok: true,
    sessionsDir: dir,
    limit: limit
      ? {
          plan: limit.plan_type ?? null,
          usedPercent: primary?.used_percent ?? null,
          windowMinutes: primary?.window_minutes ?? null,
          resetsAt: primary?.resets_at ? primary.resets_at * 1000 : null,
          secondaryPercent: limit.secondary?.used_percent ?? null,
          credits: limit.credits ?? null,
          // Non-null means the account actually hit a wall — the one field worth shouting.
          reached: limit.rate_limit_reached_type ?? null,
        }
      : null,
    tokens: acc,
    truncated: files.length > cap,
  };
}

/** Human-readable window, e.g. 10080 -> "7d". */
export function describeWindow(minutes) {
  if (!minutes) return '?';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}min`;
}

export function describeReset(ms, now = Date.now()) {
  if (!ms) return 'unknown';
  const left = ms - now;
  if (left <= 0) return 'now';
  const h = Math.floor(left / 3_600_000);
  const d = Math.floor(h / 24);
  const rel = d >= 1 ? `${d}d ${h % 24}h` : `${h}h ${Math.floor((left % 3_600_000) / 60_000)}min`;
  return `${new Date(ms).toLocaleString()} (in ${rel})`;
}

/** A 20-cell bar. Text, because this prints into terminals and transcripts alike. */
export function bar(percent, width = 20) {
  if (percent == null) return '?'.repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export { readFileSync as _readFileSync };
