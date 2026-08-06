// Persistent "saver mode" state, shared by the CLI and the routing hook.
//
// WHY THE STATE LIVES IN $HOME AND NOT IN THE PLUGIN DIRECTORY
// An installed plugin lives at .../cache/<mkt>/<plugin>/<version>/ — the version is in
// the path, so a plugin update creates a NEW directory and anything the user wrote into
// the old one is gone. Config that the user owns must live outside. Same reasoning
// applies to routing.json, which is why the hook looks here first.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const USER_DIR = path.join(os.homedir(), '.claude', 'crossmodel');
export const MODE_PATH = path.join(USER_DIR, 'mode.json');
export const USER_ROUTING_PATH = path.join(USER_DIR, 'routing.json');

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Parse a human deadline into an absolute Date.
 * Accepts: "6h", "90m", "2d", a weekday name (next occurrence at 00:00 local),
 * or anything Date.parse understands (ISO 8601).
 * Returns null when the input cannot be parsed — callers must treat that as an error,
 * never as "no deadline", or a typo would silently pin saver mode on forever.
 */
export function parseUntil(input, now = new Date()) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();

  const rel = s.match(/^(\d+)\s*(m|h|d)$/);
  if (rel) {
    const n = Number(rel[1]);
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2]];
    return new Date(now.getTime() + n * ms);
  }

  const wd = WEEKDAYS.indexOf(s);
  if (wd !== -1) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    // Always land on a FUTURE midnight: if today is already that weekday, the boundary
    // that matters is the one coming up, not the one that started this morning.
    let delta = (wd - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    d.setDate(d.getDate() + delta);
    return d;
  }

  // A date-only ISO string is UTC per spec, so "2026-08-09" would resolve to the 8th at
  // 21:00 in UTC-3 — a deadline a day early. The user meant local midnight.
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));

  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Current mode. Expiry is evaluated on read, so the mode turns itself off without
 * anything having to run on a schedule.
 * Returns { active, until, model, expired, error }.
 */
export function readMode(now = new Date()) {
  if (!existsSync(MODE_PATH)) return { active: false };

  let raw;
  try {
    raw = JSON.parse(readFileSync(MODE_PATH, 'utf8'));
  } catch (e) {
    // Malformed state must announce itself. Silently reading it as "off" would mean the
    // user believes they are saving quota while nothing is happening.
    return { active: false, error: `mode.json: ${e.message}` };
  }

  if (!raw.active) return { active: false };

  if (raw.until) {
    const t = Date.parse(raw.until);
    if (Number.isNaN(t)) return { active: false, error: `mode.json: unparseable "until": ${raw.until}` };
    if (now.getTime() >= t) return { active: false, expired: true, until: raw.until };
  }

  return {
    active: true,
    until: raw.until ?? null,
    model: raw.model ?? null,
    startedAt: raw.startedAt ?? null,
  };
}

export function writeMode(state) {
  mkdirSync(USER_DIR, { recursive: true });
  writeFileSync(MODE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  return MODE_PATH;
}

export function clearMode() {
  if (existsSync(MODE_PATH)) rmSync(MODE_PATH);
}

/** "until Sunday 00:00 (2d 4h from now)" — for humans, in one line. */
export function describeUntil(until, now = new Date()) {
  if (!until) return 'until you turn it off';
  const d = new Date(until);
  const ms = d.getTime() - now.getTime();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  const rest = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return `until ${d.toLocaleString()} (${rest} from now)`;
}
