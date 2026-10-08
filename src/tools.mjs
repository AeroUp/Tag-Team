// Tag-Team's MCP tools: definitions, dispatch and model-friendly formatting.
import { truncate, fmtTime, fmtIn, fmtDur } from './core/util.mjs';
import { LABEL } from './core/agents.mjs';
import { getJob, listJobs, cancelJob, waitJob, readJobLog, isTerminal } from './core/jobs.mjs';
import { ask, council, review, status, startBackground, detectCaller } from './ops.mjs';
import { imagine, critique, studio } from './images.mjs';

const AGENT_ENUM = ['claude', 'codex', 'gemini'];
const ACCESS = {
  type: 'string', enum: ['read', 'write', 'full'],
  description: 'read = look only (default). write = may edit files in cwd (Codex: workspace sandbox). full = no sandbox / no permission checks; only when the user wants it.',
};
const BG = { type: 'boolean', description: 'Run as a background job and return a job_id immediately (use for anything slow). Poll with the "job" tool.' };
const CWD = { type: 'string', description: 'Absolute working directory (the project). Always pass it.' };

export const TOOLS = [
  {
    name: 'agents',
    description: 'Who is available right now: which AI agents (claude, codex, gemini) are installed, which are usage-limited and until when, Codex usage %, image engines, and recent jobs. Call before delegating.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'ask',
    description: 'Send a prompt to another AI agent (Claude Code, Codex CLI or Gemini CLI) running headless in a directory, and get its answer. Use for second opinions, delegating a subtask, research, or having another model do work. The other agent cannot see this conversation, so include all the context it needs. Returns a session_id you can pass back to continue the same conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: [...AGENT_ENUM, 'auto'], description: 'Which agent. "auto" = first available agent that is not you.' },
        prompt: { type: 'string', description: 'Complete, self-contained instructions.' },
        cwd: CWD,
        access: ACCESS,
        session_id: { type: 'string', description: 'Continue an earlier conversation with that same agent.' },
        model: { type: 'string', description: 'Optional model override for that agent.' },
        images: { type: 'array', items: { type: 'string' }, description: 'Image file paths to attach.' },
        fallback: { type: 'boolean', description: 'If that agent is usage-limited, automatically try the next one.' },
        timeout_sec: { type: 'number', description: 'Default 1200.' },
        background: BG,
      },
      required: ['agent', 'prompt'],
    },
  },
  {
    name: 'council',
    description: 'Ask several AI agents the same question in parallel (read-only) and get all their answers side by side, e.g. to compare approaches, debug a hard problem, or sanity-check a plan. You then weigh and synthesize them.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        agents: { type: 'array', items: { type: 'string', enum: AGENT_ENUM }, description: 'Default: every installed agent except you.' },
        cwd: CWD,
        timeout_sec: { type: 'number' },
        background: BG,
      },
      required: ['prompt'],
    },
  },
  {
    name: 'review',
    description: 'Independent code review by other AIs (read-only), run in parallel. Findings are merged; issues flagged by more than one reviewer are listed first. Verify each finding yourself before acting on it.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD,
        scope: { type: 'string', enum: ['uncommitted', 'staged', 'branch', 'last_commit', 'files'], description: 'What to review. Default: uncommitted.' },
        base: { type: 'string', description: 'Base branch for scope "branch" (default main).' },
        files: { type: 'array', items: { type: 'string' }, description: 'For scope "files".' },
        focus: { type: 'string', description: 'What to scrutinise (e.g. "auth logic", "concurrency").' },
        context: { type: 'string', description: 'What the change is meant to do.' },
        agents: { type: 'array', items: { type: 'string', enum: AGENT_ENUM }, description: 'Default: every installed agent except you.' },
        background: BG,
      },
    },
  },
  {
    name: 'imagine',
    description: 'Generate image(s). engine "codex" uses Codex\'s built-in image_gen (ChatGPT plan, no API key); "gemini" uses Gemini\'s image model (needs a Gemini API key); "auto" tries Codex then Gemini. Returns saved file paths. View them with your own image/file reader, or call "critique".',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed brief: subject, style, composition, lighting, palette, exact text, things to avoid.' },
        engine: { type: 'string', enum: ['auto', 'codex', 'gemini'] },
        cwd: CWD,
        out_dir: { type: 'string', description: 'Output folder, relative to cwd. Default tagteam-images.' },
        name: { type: 'string', description: 'File name stem.' },
        count: { type: 'number', description: '1-4 variants.' },
        aspect_ratio: { type: 'string', description: 'e.g. 1:1, 16:9, 9:16, 4:3, 3:2.' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Reference or to-be-edited images.' },
        background: BG,
      },
      required: ['prompt'],
    },
  },
  {
    name: 'critique',
    description: 'Have other AIs (Claude, Gemini, Codex) critique image(s) against a brief. Each returns a 0-10 score, strengths, issues with fixes, and a revised prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        images: { type: 'array', items: { type: 'string' } },
        brief: { type: 'string', description: 'What the image is supposed to be / be used for.' },
        critics: { type: 'array', items: { type: 'string', enum: AGENT_ENUM } },
        cwd: CWD,
        background: BG,
      },
      required: ['images'],
    },
  },
  {
    name: 'studio',
    description: 'Image loop: generate → multi-AI critique → regenerate with the fixes, up to N rounds or until the average score reaches the target. Keeps the best image (copied to <name>-best). Slow: runs in the background by default.',
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string' },
        engine: { type: 'string', enum: ['auto', 'codex', 'gemini'] },
        critics: { type: 'array', items: { type: 'string', enum: AGENT_ENUM } },
        rounds: { type: 'number', description: '1-5, default 2.' },
        target_score: { type: 'number', description: 'Stop early at this average score. Default 8.' },
        cwd: CWD,
        out_dir: { type: 'string' },
        name: { type: 'string' },
        aspect_ratio: { type: 'string' },
        reference_images: { type: 'array', items: { type: 'string' } },
        background: { type: 'boolean', description: 'Default true.' },
      },
      required: ['brief'],
    },
  },
  {
    name: 'job',
    description: 'Check, wait for, or cancel a background job. With no id: list recent jobs. Pass wait_sec to block until it finishes (max 600).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'job-… id.' },
        wait_sec: { type: 'number' },
        action: { type: 'string', enum: ['status', 'cancel'] },
      },
    },
  },
];

export const instructions = () => `Tag-Team connects you (${detectCaller() || 'this agent'}) with the other AI coding agents on this machine: Claude Code, Codex and Gemini. `
  + 'ask/council: answers or delegated work from them. review: independent multi-AI code review. imagine/critique/studio: image generation with AI critique loops. '
  + 'Always pass cwd. The other agents cannot see this conversation, so give them full context. Slow work: background:true, then the "job" tool.';

// ---- Formatting -------------------------------------------------------------

function fmtAsk(r) {
  if (!r) return 'No result.';
  const head = `${LABEL[r.agent] || r.agent || 'agent'} ${r.ok ? 'answered' : 'failed'}${r.duration_ms ? ` in ${fmtDur(r.duration_ms)}` : ''}${r.session_id ? ` · session_id ${r.session_id}` : ''}`;
  const lim = r.limited_until ? `\n⛔ Usage-limited until ${fmtTime(r.limited_until)} (${fmtIn(r.limited_until)}).` : '';
  const skipped = r.skipped?.length ? `\n(skipped: ${r.skipped.join('; ')})` : '';
  return `${head}${lim}${skipped}\n\n${r.ok ? r.answer : `Error: ${r.error}`}`;
}

function fmtReview(r) {
  if (!r.ok && !r.results) return `Review failed: ${r.error}`;
  const lines = [`Review (${r.scope}) by ${r.results.map((x) => `${LABEL[x.agent]}${x.ok ? `: ${x.verdict || 'done'}` : ': failed'}`).join(', ')}`];
  if (r.findings?.length) {
    lines.push('\nMerged findings (verify before fixing):');
    for (const f of r.findings) lines.push(`- [${f.severity || '?'}] ${f.file || '?'}${f.line ? `:${f.line}` : ''} ${f.title || ''} (flagged by ${f.flagged_by.map((a) => LABEL[a]).join(' + ')})\n  scenario: ${f.scenario || '-'}\n  fix: ${f.fix || '-'}`);
  } else lines.push('\nNo structured findings were reported.');
  lines.push('\n--- Full reviews ---');
  for (const x of r.results) lines.push(`\n### ${LABEL[x.agent]}\n${x.ok ? truncate(x.answer, 6000) : `Error: ${x.error}`}`);
  return lines.join('\n');
}

function fmtCritique(r) {
  if (!r.ok && !r.results) return `Critique failed: ${r.error}`;
  return r.results.map((res) => [
    `## ${res.image}\nAverage score: ${res.avg ?? 'n/a'}/10`,
    ...res.critiques.map((c) => (c.ok
      ? `### ${LABEL[c.critic] || c.critic}: ${c.score ?? '?'}/10 (${c.verdict || '-'})\n`
        + (c.strengths?.length ? `Strengths: ${c.strengths.join('; ')}\n` : '')
        + (c.issues || []).map((i) => `- [${i.severity}] ${i.problem}${i.fix ? ` → ${i.fix}` : ''}`).join('\n')
        + (c.revised_prompt ? `\nRevised prompt: ${c.revised_prompt}` : '') + (c.raw ? `\n${c.raw}` : '')
      : `### ${LABEL[c.critic] || c.critic}: failed: ${c.error}`)),
  ].join('\n')).join('\n\n');
}

function fmtStudio(r) {
  if (!r.ok) return `Studio failed: ${r.error}`;
  const rounds = r.history.map((h) => (h.error ? `Round ${h.round}: error ${h.error}`
    : `Round ${h.round} (${h.engine}): ${h.avg ?? '?'}/10 → ${h.image}\n${h.critiques.filter((c) => c.ok).map((c) => `  ${LABEL[c.critic] || c.critic} ${c.score ?? '?'}: ${(c.issues || []).slice(0, 3).map((i) => i.problem).join('; ')}`).join('\n')}`));
  return `Best: ${r.best.copy || r.best.image} (round ${r.best.round}, ${r.best.avg ?? '?'}/10, target ${r.target_score})\n\n${rounds.join('\n')}`;
}

function fmtImagine(r) {
  return r.ok ? `Generated with ${r.engine}${r.model ? ` (${r.model})` : ''}:\n${r.files.map((f) => `- ${f}`).join('\n')}${r.prompt_used ? `\nPrompt used: ${r.prompt_used}` : ''}` : `Image generation failed: ${r.error}`;
}

export const FORMAT = {
  ask: fmtAsk,
  council: (r) => (r.results ? r.results.map(fmtAsk).join('\n\n========\n\n') : `Failed: ${r.error}`),
  review: fmtReview, imagine: fmtImagine, critique: fmtCritique, studio: fmtStudio,
};

function fmtJob(j) {
  if (!j) return 'No such job.';
  const head = `${j.id} · ${j.title} · ${j.status}${j.started_at ? ` · ran ${fmtDur((j.ended_at || Date.now()) - j.started_at)}` : ''}`;
  if (isTerminal(j) && j.result) return `${head}\n\n${(FORMAT[j.op] || ((x) => JSON.stringify(x, null, 2)))(j.result)}`;
  if (isTerminal(j)) return `${head}\n${j.error || ''}`;
  return `${head}\n\nProgress so far:\n${readJobLog(j.id, 2500) || '(no output yet)'}`;
}

export async function call(name, a, ctx) {
  const op = { ask, council, review, imagine, critique, studio }[name];
  if (op) {
    const bg = name === 'studio' ? a.background !== false : !!a.background;
    if (bg) return startBackground(name, a, `${name}${a.agent ? ` → ${a.agent}` : ''}`).message;
    return FORMAT[name](await op(a, ctx));
  }
  if (name === 'agents') {
    const s = await status();
    const ag = s.agents.map((x) => `- ${LABEL[x.agent]}: ${!x.installed ? 'not installed' : x.available ? 'available' : `usage-limited until ${fmtTime(x.limited_until)} (${fmtIn(x.limited_until)})`}`
      + (x.usage ? ` · Codex usage 5h ${x.usage.five_hour_used_pct ?? '?'}% (resets ${x.usage.five_hour_resets}), week ${x.usage.weekly_used_pct ?? '?'}% (resets ${x.usage.weekly_resets}), as of ${x.usage.as_of}` : '')).join('\n');
    return `You are: ${s.caller || 'unknown'} (depth ${s.depth})\nAgents:\n${ag}\n`
      + `Image engines: codex ${s.image_engines.codex ? 'yes' : 'no'}, gemini API ${s.image_engines.gemini_api ? 'yes' : 'no (no key)'}\n`
      + `Recent jobs:\n${s.jobs.map((j) => `- ${j.id} ${j.title} [${j.status}] ${j.created}`).join('\n') || '- none'}`;
  }
  if (name === 'job') {
    if (!a.id) return `Jobs:\n${listJobs(12).map((j) => `- ${j.id} · ${j.title} · ${j.status}`).join('\n') || '- none'}`;
    if (a.action === 'cancel') return fmtJob(cancelJob(a.id));
    return fmtJob(a.wait_sec ? await waitJob(a.id, Math.min(a.wait_sec, 600)) : getJob(a.id));
  }
  throw new Error(`Unknown tool: ${name}`);
}
