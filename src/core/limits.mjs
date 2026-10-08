// Usage-limit detection, reset-time parsing and the shared "who is limited" store.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, SHARED_HOME, readJSON, writeJSON } from './util.mjs';

// Shared by every tool on this core, so Tag-Team and Relay agree on who is out of quota.
const STORE = path.join(SHARED_HOME, 'limits.json');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Text that means "you're out of quota until later" (as opposed to a transient 429).
const LIMIT_RE = /(usage limit|hit your (?:\w+ )?limit|reached your (?:\w+ )?limit|limit reached|out of (?:usage )?credits|quota (?:exceeded|exhausted)|exhausted your|resource_exhausted|rate limit(?:ed)? .*reset|spend limit|try again (?:at|in)|resets? (?:at|in|on)?\s*\d|usage_limit_reached)/i;
const TRANSIENT_RE = /(rate limited|too many requests|\b429\b|overloaded|\b529\b|temporarily unavailable)/i;

export function classifyFailure(text) {
  if (!text) return null;
  if (LIMIT_RE.test(text)) return 'limit';
  if (TRANSIENT_RE.test(text)) return 'transient';
  return null;
}

// Wall-clock time in an IANA zone → epoch ms.
function zonedToEpoch(y, mo, d, h, mi, tz) {
  const target = Date.UTC(y, mo, d, h, mi);
  let guess = target;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    for (let i = 0; i < 3; i++) {
      const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
      const seen = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
      guess += target - seen;
    }
    return guess;
  } catch {
    return new Date(y, mo, d, h, mi).getTime();
  }
}

function zonedParts(ms, tz) {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
        .formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
    );
    return { y: +parts.year, mo: +parts.month - 1, d: +parts.day };
  } catch {
    const t = new Date(ms);
    return { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate() };
  }
}

const UNIT_MS = { d: 86400e3, h: 3600e3, m: 60e3, s: 1e3 };

/**
 * Parse when a usage limit resets from a provider's error text. Handles:
 *   "You've hit your session limit · resets 3pm (America/New_York)"
 *   "… resets Oct 9, 3:30pm (Europe/London)"   "Claude AI usage limit reached|1759996800"
 *   "try again in 2 hours 13 minutes"  "Please retry in 34.5s"  "try again at 3:45 PM"
 *   "resets 2026-10-09 00:00 UTC"  "resets_at": 1791260919
 * Returns epoch ms or null.
 */
export function parseResetTime(text, now = Date.now()) {
  if (!text) return null;
  const s = String(text);

  // Epoch seconds/ms next to a reset keyword, or Claude's legacy "…reached|<epoch>".
  let m = s.match(/(?:resets?_?at|resetsAt|reset_at|limit reached)["'\s:|=]+(\d{10,13})\b/i);
  if (m) {
    const n = +m[1];
    return n < 1e12 ? n * 1000 : n;
  }

  // ISO / "YYYY-MM-DD HH:MM UTC".
  m = s.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(Z|UTC|[+-]\d{2}:?\d{2})?/i);
  if (m && /(reset|again|until|available)/i.test(s)) {
    const zone = !m[3] || /^utc$/i.test(m[3]) ? 'Z' : m[3];
    const t = Date.parse(`${m[1]}T${m[2]}${zone}`);
    if (!Number.isNaN(t)) return t;
  }

  // Relative durations: "in 2 hours 13 minutes", "retry in 34.5s", "after 3h2m".
  m = s.match(/(?:in|after|retry in|retry after|wait)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i);
  if (m) {
    let total = 0;
    for (const [, num, unit] of m[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
      total += parseFloat(num) * (UNIT_MS[unit[0].toLowerCase()] || 0);
    }
    if (total > 0) return now + total;
  }

  // Clock time, optionally with a date and an IANA zone in parentheses.
  const clock = /(?:resets?|again at|available at|until|reset at)\s*(?:at\s+|on\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?(?:\s*\(([^)]+)\))?/i;
  m = s.match(clock);
  if (m) {
    const [, mon, day, year, hh, mm, ap, tzRaw] = m;
    let hour = +hh % 12;
    if (ap.toLowerCase() === 'p') hour += 12;
    const minute = mm ? +mm : 0;
    const tz = tzRaw && /^[A-Za-z_]+\/[A-Za-z_\/+-]+$|^UTC$/i.test(tzRaw.trim()) ? tzRaw.trim() : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = zonedParts(now, tz);
    let y = year ? +year : today.y;
    let mo = mon ? MONTHS.indexOf(mon.toLowerCase().slice(0, 3)) : today.mo;
    let d = day ? +day : today.d;
    let t = zonedToEpoch(y, mo, d, hour, minute, tz);
    if (!mon && t < now - 60e3) t += 86400e3; // "3pm" already passed today → tomorrow
    if (mon && !year && t < now - 86400e3) t = zonedToEpoch(y + 1, mo, d, hour, minute, tz);
    return t;
  }
  return null;
}

// ---- Shared limit store (all agents, all processes) -----------------------

export function getLimits() {
  const all = readJSON(STORE, {});
  const now = Date.now();
  for (const [k, v] of Object.entries(all)) if (!v?.until || v.until < now) delete all[k];
  return all;
}

export function markLimited(agent, until, reason) {
  const all = readJSON(STORE, {});
  all[agent] = { until, reason: String(reason || '').slice(0, 300), observed: Date.now() };
  writeJSON(STORE, all);
}

export function clearLimit(agent) {
  const all = readJSON(STORE, {});
  if (all[agent]) {
    delete all[agent];
    writeJSON(STORE, all);
  }
}

// ---- Codex: read the exact rate-limit snapshot it records in its rollouts --

function newestRollouts(n = 3) {
  const base = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'sessions');
  const out = [];
  const desc = (dir) => {
    try { return fs.readdirSync(dir).filter((x) => !x.startsWith('.')).sort().reverse(); } catch { return []; }
  };
  for (const y of desc(base)) for (const mo of desc(path.join(base, y))) for (const d of desc(path.join(base, y, mo))) {
    const dir = path.join(base, y, mo, d);
    const files = desc(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }));
    out.push(...files);
    if (out.length >= n * 3) return out.sort((a, b) => b.m - a.m).slice(0, n);
  }
  return out.sort((a, b) => b.m - a.m).slice(0, n);
}

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Latest Codex usage snapshot: { primary:{used_percent,window_minutes,resets_at(ms)}, secondary, plan_type, observed } */
export function codexUsage() {
  for (const { p } of newestRollouts()) {
    let text;
    try { text = readTail(p, 4 * 1024 * 1024); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let j;
      try { j = JSON.parse(lines[i]); } catch { continue; }
      const rl = j?.payload?.rate_limits || j?.rate_limits;
      if (!rl || (!rl.primary && !rl.secondary)) continue;
      const fix = (w) => (w ? { ...w, resets_at: w.resets_at ? w.resets_at * (w.resets_at < 1e12 ? 1000 : 1) : null } : null);
      return { primary: fix(rl.primary), secondary: fix(rl.secondary), plan_type: rl.plan_type, observed: Date.parse(j.timestamp) || null };
    }
  }
  return null;
}

/** When is `agent` usable again? Returns epoch ms (0 = available now). */
export function limitedUntil(agent) {
  const now = Date.now();
  let until = getLimits()[agent]?.until || 0;
  if (agent === 'codex') {
    const u = codexUsage();
    for (const w of [u?.primary, u?.secondary]) {
      if (w && w.used_percent >= 100 && w.resets_at > now) until = Math.max(until, w.resets_at);
    }
  }
  return until > now ? until : 0;
}
