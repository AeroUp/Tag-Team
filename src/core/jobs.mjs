// Background jobs: each runs in its own detached process and is stored on disk,
// so the server inside any agent (Claude, Codex, Gemini) can check on any job.
import fs from 'node:fs';
import path from 'node:path';
import { APP, APP_HOME, SHARED_HOME, ensureDir, readJSON, writeJSON, newId, pidAlive, killTree, spawnDetached, appendLog, sleep } from './util.mjs';
import { loadConfig } from './config.mjs';

const JOBS = path.join(APP_HOME, 'jobs');
const ACTIVE = path.join(SHARED_HOME, 'active');
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

const jobFile = (id) => path.join(JOBS, id, 'job.json');
export const jobLog = (id) => path.join(JOBS, id, 'log.txt');

export function getJob(id) {
  const j = readJSON(jobFile(id));
  if (!j) return null;
  // A runner that died without recording a result.
  if (j.status === 'running' && j.pid && !pidAlive(j.pid) && Date.now() - (j.started_at || 0) > 5000) {
    j.status = 'failed';
    j.error = j.error || 'job runner exited unexpectedly';
    j.ended_at = Date.now();
    writeJSON(jobFile(id), j);
  }
  return j;
}

export function updateJob(id, patch) {
  const j = readJSON(jobFile(id)) || { id };
  Object.assign(j, patch, { updated_at: Date.now() });
  writeJSON(jobFile(id), j);
  return j;
}

export function startJob(op, params, { title, caller } = {}) {
  const id = newId('job');
  ensureDir(path.join(JOBS, id));
  const job = { id, op, params, title: title || op, caller: caller || null, status: 'queued', created_at: Date.now() };
  writeJSON(jobFile(id), job);
  const pid = spawnDetached(['_job', id], { cwd: params.cwd && fs.existsSync(params.cwd) ? params.cwd : APP_HOME, logFile: path.join(JOBS, id, 'runner.txt') });
  return updateJob(id, { pid });
}

export function listJobs(limit = 15) {
  let ids = [];
  try { ids = fs.readdirSync(JOBS); } catch {}
  return ids
    .map((id) => getJob(id))
    .filter(Boolean)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
}

export function cancelJob(id) {
  const j = getJob(id);
  if (!j) return null;
  if (TERMINAL.has(j.status)) return j;
  killTree(j.pid);
  for (const p of j.child_pids || []) killTree(p);
  return updateJob(id, { status: 'cancelled', ended_at: Date.now(), error: 'cancelled' });
}

export async function waitJob(id, seconds) {
  const until = Date.now() + Math.min(Math.max(seconds || 0, 0), 900) * 1000;
  let j = getJob(id);
  while (j && !TERMINAL.has(j.status) && Date.now() < until) {
    await sleep(1500);
    j = getJob(id);
  }
  return j;
}

export function readJobLog(id, maxChars = 4000) {
  try {
    const s = fs.readFileSync(jobLog(id), 'utf8');
    return s.length > maxChars ? `…\n${s.slice(-maxChars)}` : s;
  } catch {
    return '';
  }
}

export const isTerminal = (j) => TERMINAL.has(j?.status);

// Body of the detached `_job <id>` process.
export async function runJobProcess(id, ops) {
  const j = getJob(id);
  if (!j) return;
  const log = (line) => appendLog(jobLog(id), line);
  updateJob(id, { status: 'running', started_at: Date.now(), pid: process.pid });
  try {
    const fn = ops[j.op];
    if (!fn) throw new Error(`unknown op ${j.op}`);
    const result = await fn(j.params, {
      log,
      onSpawn: (pid) => {
        const cur = readJSON(jobFile(id)) || {};
        updateJob(id, { child_pids: [...(cur.child_pids || []), pid] });
      },
    });
    const cur = getJob(id);
    if (cur?.status === 'cancelled') return;
    const failed = result && result.ok === false;
    updateJob(id, { status: failed ? 'failed' : 'done', result, error: failed ? result.error : null, ended_at: Date.now() });
    log(failed ? `✖ failed: ${result.error}` : '✔ done');
  } catch (e) {
    updateJob(id, { status: 'failed', error: String(e?.stack || e), ended_at: Date.now() });
    log(`✖ crashed: ${e?.message || e}`);
  }
}

// ---- Concurrency guard (sync calls + jobs, across all processes) ----------

export function activeCount() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(ACTIVE)) {
      const pid = parseInt(f, 10);
      if (pidAlive(pid)) n++;
      else try { fs.unlinkSync(path.join(ACTIVE, f)); } catch {}
    }
  } catch {}
  return n;
}

export function acquireSlot() {
  const cfg = loadConfig();
  if (activeCount() >= cfg.max_concurrent) {
    throw new Error(`Already running ${cfg.max_concurrent} agent processes (max_concurrent). Wait for some to finish or raise it with: ${APP} config set max_concurrent 10`);
  }
  ensureDir(ACTIVE);
  const f = path.join(ACTIVE, `${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(f, String(Date.now()));
  return () => { try { fs.unlinkSync(f); } catch {} };
}
