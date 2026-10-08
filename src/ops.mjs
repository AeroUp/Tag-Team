// Tag-Team operations shared by the MCP server, the CLI and background jobs.
import path from 'node:path';
import { ENV, fmtTime, fmtIn, gitInfo, extractJSON } from './core/util.mjs';
import { loadConfig } from './core/config.mjs';
import { AGENTS, LABEL, resolveAgent, runAgent, depth, normAgent, installHint } from './core/agents.mjs';
import { limitedUntil, codexUsage, getLimits } from './core/limits.mjs';
import { acquireSlot, startJob, listJobs } from './core/jobs.mjs';
import { imagine, critique, studio, geminiKey } from './images.mjs';

const label = (a) => LABEL[a] || a;

/** Which agent is calling us? The installer sets AI_AGENT_SELF per client. */
export function detectCaller() {
  const e = process.env;
  if (e[ENV.SELF]) return e[ENV.SELF];
  if (e.CLAUDECODE || e.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  return null;
}

export function guard() {
  const max = loadConfig().max_depth;
  if (depth() >= max) {
    throw new Error(`Depth limit reached (${depth()}/${max}): you were started by another agent, `
      + 'so you cannot start more agents. Do this part yourself.');
  }
}

/** Ask one agent (optionally falling back to others if it is usage-limited). */
export async function ask(p, ctx = {}) {
  guard();
  if (!p.prompt?.trim()) return { ok: false, error: 'prompt is required' };
  const caller = p.from || detectCaller();
  const pool = ['codex', 'claude', 'antigravity'];
  let order = p.agent && p.agent !== 'auto' ? [normAgent(p.agent)] : pool.filter((a) => a !== caller);
  if (p.fallback) order = [...order, ...pool.filter((a) => !order.includes(a) && a !== caller)];
  const skipped = [];
  for (const agent of order) {
    if (!AGENTS.includes(agent)) { skipped.push(`${agent}: unknown agent`); continue; }
    if (!resolveAgent(agent)) { skipped.push(`${agent}: not installed${order.length === 1 ? `. ${installHint(agent)}` : ''}`); continue; }
    const lu = limitedUntil(agent);
    if (lu) { skipped.push(`${agent}: usage-limited until ${fmtTime(lu)}`); continue; }
    const release = acquireSlot();
    let r;
    try {
      r = await runAgent(agent, {
        prompt: p.prompt, cwd: p.cwd, access: p.access || 'read', session: p.session_id, model: p.model,
        images: p.images, addDirs: p.add_dirs, timeoutSec: p.timeout_sec, caller: caller ? label(caller) : null,
        log: ctx.log, signal: ctx.signal, onSpawn: ctx.onSpawn,
      });
    } finally {
      release();
    }
    if (r.ok || !p.fallback || !(r.limited_until || r.transient)) return { ...r, skipped };
    skipped.push(`${agent}: ${r.limited_until ? `hit its usage limit (back ${fmtIn(r.limited_until)})` : 'transient API error'}`);
  }
  return { ok: false, error: `No agent could take this. ${skipped.join('; ')}`, skipped };
}

/** The same question to several agents in parallel. */
export async function council(p, ctx = {}) {
  guard();
  const caller = p.from || detectCaller();
  const agents = [...new Set((p.agents?.length ? p.agents.map(normAgent) : AGENTS.filter((a) => a !== caller)))].filter((a) => resolveAgent(a));
  if (!agents.length) return { ok: false, error: 'No other agents are installed.' };
  const results = await Promise.all(agents.map((agent) => ask({ ...p, agent, fallback: false }, ctx).catch((e) => ({ agent, ok: false, error: e.message }))));
  return { ok: results.some((r) => r.ok), results };
}

const REVIEW_PROMPT = (what, focus, context) => `You are one of several independent AI code reviewers. Review ${what}.
${focus ? `\nFocus especially on: ${focus}` : ''}${context ? `\nContext from the author: ${context}` : ''}

Rules:
- Read the real code around each change and verify before you claim anything. Do not modify any files.
- Report only real problems: bugs, logic errors, security holes, data loss, race conditions, broken edge cases,
  error handling that matters, API misuse, performance traps. No style nits, no praise.
- For each finding: severity (critical/high/medium/low), file and line, what is wrong, a concrete failure scenario, and the fix.
- If you find nothing significant, say so plainly. Never invent issues to look useful.

Finish with a fenced JSON block:
\`\`\`json
{"verdict": "approve" | "changes_requested",
 "findings": [{"severity": "high", "file": "src/x.ts", "line": 42, "title": "...", "scenario": "...", "fix": "..."}]}
\`\`\``;

/** Multi-AI code review with merged findings. */
export async function review(p, ctx = {}) {
  const cwd = path.resolve(p.cwd || process.cwd());
  const g = gitInfo(cwd, { diffStat: false });
  const scope = p.scope || (g ? 'uncommitted' : 'files');
  const base = p.base || 'main';
  const what = {
    uncommitted: 'the uncommitted changes in this repository (run `git status` and `git diff HEAD`, and read new untracked files)',
    staged: 'the staged changes (`git diff --cached`)',
    branch: `everything on the current branch compared with ${base} (\`git diff ${base}...HEAD\` and \`git log ${base}..HEAD\`)`,
    last_commit: 'the most recent commit (`git show HEAD`)',
    files: p.files?.length ? `these files: ${p.files.join(', ')}` : 'the code in this directory',
  }[scope] || scope;
  if (!g && scope !== 'files') return { ok: false, error: `${cwd} is not a git repository; use scope "files" with a files list.` };
  const res = await council({ ...p, cwd, access: 'read', prompt: REVIEW_PROMPT(what, p.focus, p.context) }, ctx);
  const merged = [];
  for (const r of res.results || []) {
    const tail = r.ok ? r.answer.slice(Math.max(0, r.answer.lastIndexOf('```json'))) : '';
    const j = r.ok ? extractJSON(tail) || extractJSON(r.answer) : null;
    r.verdict = j?.verdict || null;
    for (const f of j?.findings || []) {
      const twin = merged.find((m) => m.file && m.file === f.file && Math.abs((m.line || 0) - (f.line || 0)) <= 3);
      if (twin) twin.flagged_by.push(r.agent);
      else merged.push({ ...f, flagged_by: [r.agent] });
    }
  }
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  merged.sort((a, b) => (b.flagged_by.length - a.flagged_by.length) || ((order[a.severity] ?? 4) - (order[b.severity] ?? 4)));
  return { ...res, scope, findings: merged };
}

/** Everything an agent needs to decide whom to call. */
export async function status() {
  const limits = getLimits();
  const cu = codexUsage();
  const agents = AGENTS.map((a) => {
    const r = resolveAgent(a);
    const lu = limitedUntil(a);
    const info = { agent: a, installed: !!r, path: r?.path || null, available: !!r && !lu, limited_until: lu || null };
    if (lu) info.limit_reason = limits[a]?.reason?.slice(0, 160);
    if (a === 'codex' && cu) {
      info.usage = {
        five_hour_used_pct: cu.primary?.used_percent ?? null, five_hour_resets: cu.primary?.resets_at ? fmtTime(cu.primary.resets_at) : null,
        weekly_used_pct: cu.secondary?.used_percent ?? null, weekly_resets: cu.secondary?.resets_at ? fmtTime(cu.secondary.resets_at) : null,
        plan: cu.plan_type, as_of: cu.observed ? fmtTime(cu.observed) : null,
      };
    }
    return info;
  });
  return {
    caller: detectCaller(),
    depth: depth(),
    agents,
    image_engines: { codex: !!resolveAgent('codex'), antigravity: !!resolveAgent('antigravity'), gemini_api: !!geminiKey() },
    jobs: listJobs(8).map((j) => ({ id: j.id, title: j.title, status: j.status, created: fmtTime(j.created_at) })),
  };
}

// Ops runnable as background jobs.
export const OPS = { ask, council, review, imagine, critique, studio };

export function startBackground(op, params, title) {
  guard();
  const j = startJob(op, { ...params, from: params.from || detectCaller() }, { title, caller: detectCaller() });
  return { ok: true, job_id: j.id, message: `Started in the background as ${j.id}. Check it with the "job" tool (wait_sec up to 600).` };
}
