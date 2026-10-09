// Shared helpers: paths, JSON files, process spawning, notifications.
// (src/core is identical in Tag-Team and Relay; app identity comes from ../app.mjs.)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { APP, TITLE, APP_HOME, ROOT, CLI, VERSION } from '../app.mjs';

export { APP, TITLE, APP_HOME, ROOT, CLI, VERSION };
export const HOME = os.homedir();
export const IS_WIN = process.platform === 'win32';
// State shared by every tool built on this core (usage limits, concurrency slots, Codex sandbox mode).
export const SHARED_HOME = process.env.AGENT_STATE_DIR || path.join(HOME, '.agent-state');
// Environment variables that travel from parent agent to child agent.
export const ENV = { DEPTH: 'AI_AGENT_DEPTH', SELF: 'AI_AGENT_SELF', PARENT: 'AI_AGENT_PARENT' };

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readJSON(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

// Temp file + rename, falling back to a direct write when Windows refuses the
// rename because another process has the file open.
export function writeJSON(p, obj) {
  ensureDir(path.dirname(p));
  const data = JSON.stringify(obj, null, 2);
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, p);
  } catch {
    fs.writeFileSync(p, data);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s;
}

export function fmtTime(ms) {
  if (!ms) return 'unknown';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}

export function fmtDur(ms) {
  if (ms == null) return '?';
  let s = Math.round(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const out = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
  return ms < 0 ? `-${out}` : out;
}

export const fmtIn = (ms) => (ms > Date.now() ? `in ${fmtDur(ms - Date.now())}` : 'now');

// Find an executable on PATH (honours PATHEXT on Windows).
export function which(name) {
  const exts = IS_WIN ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').toLowerCase().split(';')] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

// Newest file called `fileName` exactly `depth` directory levels below `base`.
export function newestMatch(base, depth, fileName) {
  let best = null;
  const walk = (dir, d) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (d === 0) {
        if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) {
          const m = fs.statSync(p).mtimeMs;
          if (!best || m > best.m) best = { p, m };
        }
      } else if (e.isDirectory()) walk(p, d - 1);
    }
  };
  walk(base, depth);
  return best?.p || null;
}

// Kill a process and its children.
export function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else {
      try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); }
    }
  } catch {}
}

/**
 * Run a command, streaming stdout lines to onLine. Never rejects; resolves to
 * { code, stdout, stderr, timedOut, aborted, durationMs }.
 */
export function run(cmd, args, { cwd, env, input, timeoutMs, onLine, signal, onSpawn } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let buf = '';
    let timedOut = false;
    let aborted = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e.message || e), timedOut, aborted, durationMs: 0 });
    }
    onSpawn?.(child.pid);
    const cap = 30 * 1024 * 1024;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (stdout.length < cap) stdout += d;
      if (!onLine) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.trim()) try { onLine(line); } catch {}
      }
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < cap) stderr += d;
    });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs) : null;
    const onAbort = () => { aborted = true; killTree(child.pid); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { stderr += `\n${e.message}`; });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (onLine && buf.trim()) try { onLine(buf.trim()); } catch {}
      resolve({ code, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started });
    });
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Start `node <this CLI> ...args` fully detached so it outlives the caller.
export function spawnDetached(args, { cwd, env, logFile } = {}) {
  const out = logFile ? fs.openSync(logFile, 'a') : 'ignore';
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: cwd || ensureDir(APP_HOME),
    env: env || process.env,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  if (typeof out === 'number') fs.closeSync(out);
  return child.pid;
}

export function appendLog(file, line) {
  try {
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

export function event(msg) {
  appendLog(path.join(APP_HOME, 'events.log'), msg);
}

// Optional Discord webhook for notifications (reaches your phone even while you're gaming).
// Shared by every tool on this core: { "discord_webhook": "https://discord.com/api/webhooks/…" }
export const NOTIFY_CONFIG = path.join(SHARED_HOME, 'notify.json');

const xmlEsc = (s, max = 300) => String(s).slice(0, max).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const isLoopback = (u) => { try { return /^(localhost|127\.|\[::1\]$)/.test(new URL(u).hostname); } catch { return true; } };

// Toast XML. A click on the toast opens opts.url; opts.actions adds buttons: [{ label, url }].
// Protocol activation needs no registered app, so http:// and codex:// links both work.
export function toastXml(title, body, { url, actions = [] } = {}) {
  const launch = url ? ` activationType="protocol" launch="${xmlEsc(url, 2000)}"` : '';
  const buttons = actions.filter((a) => a?.url).slice(0, 5)
    .map((a) => `<action content="${xmlEsc(a.label, 40)}" activationType="protocol" arguments="${xmlEsc(a.url, 2000)}"/>`).join('');
  return `<toast${launch}><visual><binding template="ToastGeneric"><text>${xmlEsc(title)}</text><text>${xmlEsc(body)}</text></binding></visual>${buttons ? `<actions>${buttons}</actions>` : ''}</toast>`;
}

// Windows toast that stays in the Notification Center. The old NotifyIcon balloon deleted
// itself after a few seconds, so it vanished unseen whenever Windows muted notifications
// (e.g. "do not disturb while gaming"). Attributed to Windows PowerShell's registered app id.
function windowsToast(title, body, opts) {
  const ps = `$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('${toastXml(title, body, opts).replace(/'/g, "''")}')
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;
  const out = fs.openSync(path.join(ensureDir(APP_HOME), 'notify.log'), 'a');
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], {
    detached: true, stdio: ['ignore', out, out], windowsHide: true,
  }).unref();
  fs.closeSync(out);
}

function discordWebhook(title, body, { url: link } = {}) {
  const url = readJSON(NOTIFY_CONFIG, {})?.discord_webhook;
  if (!url || !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url)) return;
  // Discord only links somewhere the phone can reach (not 127.0.0.1).
  const embedLink = link && /^https?:/.test(link) && !isLoopback(link) ? { url: link } : {};
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: TITLE, embeds: [{ title: String(title).slice(0, 250), description: String(body).slice(0, 2000), color: 0xa855f7, timestamp: new Date().toISOString(), ...embedLink }] }),
    signal: AbortSignal.timeout(10000),
  }).catch((e) => appendLog(path.join(APP_HOME, 'notify.log'), `discord webhook failed: ${e.message}`));
}

// Desktop notification (+ Discord if configured). Never throws, never blocks.
// opts: { url: opened when the toast is clicked, actions: [{ label, url }] buttons (Windows) }
export function notify(title, body, opts = {}) {
  event(`${title}: ${body}`);
  if (process.env.AGENT_NO_NOTIFY) return;
  try { discordWebhook(title, body, opts); } catch {}
  try {
    if (IS_WIN) {
      windowsToast(title, body, opts);
    } else if (process.platform === 'darwin') {
      const q = (s) => JSON.stringify(String(s));
      spawn('osascript', ['-e', `display notification ${q(body)} with title ${q(title)}`], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('notify-send', [title, body], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
  } catch {}
}

// Open a URL (http(s):// or an app link such as codex://) with the system handler.
export function openUrl(url) {
  if (!/^(https?|codex|claude):\/\/[^\s"<>]+$/i.test(String(url))) return false;
  try {
    const [cmd, args] = IS_WIN ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
    return true;
  } catch {
    return false;
  }
}

// First balanced JSON object in model output (handles ```json fences and prose around it).
export function extractJSON(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const src of fenced ? [fenced[1], text] : [text]) {
    for (let start = src.indexOf('{'); start >= 0; start = src.indexOf('{', start + 1)) {
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          try { return JSON.parse(src.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

export function gitInfo(cwd, { diffStat = true, maxLines = 60 } = {}) {
  const git = (args) => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    } catch {
      return null;
    }
  };
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const clip = (s) => (s || '').split('\n').slice(0, maxLines).join('\n');
  return {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    head: git(['log', '-1', '--format=%h %s']),
    status: clip(git(['status', '--short'])),
    diffStat: diffStat ? clip(git(['diff', '--stat', 'HEAD'])) : null,
  };
}
