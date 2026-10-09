// Agent adapters: find each CLI, run it headless, normalise its output.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HOME, IS_WIN, APP_HOME, SHARED_HOME, TITLE, ENV, run, which, newestMatch, ensureDir, truncate, readJSON, writeJSON } from './util.mjs';
import { loadConfig } from './config.mjs';
import { classifyFailure, parseResetTime, markLimited, clearLimit, codexUsage } from './limits.mjs';

export const AGENTS = ['claude', 'codex', 'antigravity'];
export const LABEL = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

// Antigravity CLI replaced Gemini CLI in 2026; accept the old names too.
export const normAgent = (a) => (a === 'gemini' || a === 'agy' ? 'antigravity' : a);

// npm .cmd shims can't be spawned without a shell on modern Node; run their JS directly.
function unwrapShim(p) {
  if (!p || !IS_WIN || !/\.(cmd|bat|ps1)$/i.test(p)) return { cmd: p, pre: [] };
  try {
    const body = fs.readFileSync(p.replace(/\.ps1$/i, '.cmd'), 'utf8');
    const m = body.match(/"%~?dp0%?\\([^"]+?\.(?:c|m)?js)"/i);
    if (m) return { cmd: process.execPath, pre: [path.join(path.dirname(p), m[1])] };
  } catch {}
  return { cmd: p, pre: [], shell: true };
}

const candidates = {
  claude: () => [
    which('claude'),
    path.join(HOME, '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude'),
    path.join(HOME, '.claude', 'local', IS_WIN ? 'claude.exe' : 'claude'),
    IS_WIN && newestMatch(path.join(process.env.APPDATA || '', 'Claude', 'claude-code'), 2, 'claude.exe'),
  ],
  codex: () => {
    const fromConfig = (() => {
      try {
        const m = fs.readFileSync(path.join(HOME, '.codex', 'config.toml'), 'utf8').match(/CODEX_CLI_PATH\s*=\s*['"]([^'"]+)['"]/);
        return m?.[1];
      } catch { return null; }
    })();
    return [
      which('codex'),
      IS_WIN && newestMatch(path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'), 1, 'codex.exe'),
      fromConfig,
      path.join(HOME, '.codex', '.sandbox-bin', IS_WIN ? 'codex.exe' : 'codex'),
    ];
  },
  antigravity: () => [
    which('agy'),
    IS_WIN && path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'),
    path.join(HOME, '.local', 'bin', IS_WIN ? 'agy.exe' : 'agy'),
  ],
};

const resolved = {};
export function resolveAgent(name) {
  name = normAgent(name);
  if (resolved[name] !== undefined) return resolved[name];
  const cfg = loadConfig().agents[name] || {};
  const list = [cfg.path, ...(candidates[name]?.() || [])].filter(Boolean);
  const hit = list.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  resolved[name] = hit ? { name, path: hit, ...unwrapShim(hit) } : null;
  return resolved[name];
}

// Environment for child agents: drop the parent Claude session's host wiring so a
// child `claude` behaves like a fresh CLI, and carry the recursion depth forward.
const HOST_ENV = new Set(`CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_HOST_SESSION_ID
CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_SESSION_ATTENDED
CLAUDE_CODE_DESKTOP_APP_VERSION CLAUDE_CODE_SIMPLE CLAUDE_CODE_EXECPATH CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH
CLAUDE_CODE_OAUTH_SCOPES CLAUDE_CODE_ACCOUNT_UUID CLAUDE_CODE_ORGANIZATION_UUID CLAUDE_CODE_USER_EMAIL
CLAUDE_CODE_EAGER_FLUSH CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL
CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING CLAUDE_CODE_DISABLE_CRON CLAUDE_CODE_DISABLE_TERMINAL_TITLE
CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST CLAUDE_CODE_REPORT_FINDINGS CLAUDE_CODE_TERMINAL_MCP_TOOLS
CLAUDE_PID CLAUDE_EFFORT CLAUDE_PREVIEW_CLASSIFIER_FLOOR MCP_CONNECTION_NONBLOCKING MCP_SERVER_CONNECTION_BATCH_SIZE`.split(/\s+/));

export function childEnv(extra = {}) {
  const env = { ...process.env };
  const fromDesktop = !!env.CLAUDE_CODE_ENTRYPOINT || !!env.CLAUDE_CODE_DESKTOP_APP_VERSION;
  for (const k of Object.keys(env)) {
    if (HOST_ENV.has(k) || k.startsWith('CLAUDE_AGENT_SDK_')) delete env[k];
  }
  if (fromDesktop && env.ANTHROPIC_BASE_URL === 'https://api.anthropic.com') delete env.ANTHROPIC_BASE_URL;
  delete env[ENV.SELF];
  env[ENV.DEPTH] = String(depth() + 1);
  return { ...env, ...extra };
}

export const depth = () => parseInt(process.env[ENV.DEPTH] || '0', 10) || 0;

const HEADLESS_NOTE = (caller) =>
  `You were started headlessly by ${TITLE}${caller && caller !== TITLE ? ` on behalf of ${caller}` : ''}. ` +
  'No human is watching this run and nobody can answer questions: make reasonable assumptions, ' +
  'work autonomously, and finish with a concise final report of what you did and found.';

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git blame:*)', 'Bash(ls:*)'];

// ---- Claude Code ----------------------------------------------------------

function claudeSpec(o) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (o.session) args.push('--resume', o.session);
  if (o.model) args.push('--model', o.model);
  if (o.access === 'full') args.push('--dangerously-skip-permissions');
  else if (o.access === 'write') args.push('--permission-mode', 'acceptEdits');
  else args.push('--allowedTools', ...READ_TOOLS, '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit');
  for (const d of o.addDirs || []) args.push('--add-dir', d);
  args.push('--append-system-prompt', HEADLESS_NOTE(o.caller));
  let prompt = o.prompt;
  if (o.images?.length) prompt = `Image file(s) to look at with the Read tool:\n${o.images.map((p) => `- ${p}`).join('\n')}\n\n${prompt}`;
  return { args, stdin: prompt };
}

function claudeParser() {
  const st = { session: null, text: [], result: null, isError: false, resetAt: null, cost: null, turns: null };
  return {
    st,
    line(l, log) {
      let j;
      try { j = JSON.parse(l); } catch { return; }
      if (j.session_id) st.session = j.session_id;
      if (j.type === 'assistant') {
        for (const c of j.message?.content || []) {
          if (c.type === 'text' && c.text) st.text.push(c.text);
          if (c.type === 'tool_use') log?.(`→ ${c.name} ${truncate(JSON.stringify(c.input?.file_path || c.input?.command || c.input?.pattern || c.input?.url || ''), 120)}`);
        }
      } else if (j.type === 'rate_limit_event') {
        const info = j.rate_limit_info || {};
        if (info.status === 'rejected' && info.resetsAt) st.resetAt = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
      } else if (j.type === 'result') {
        st.result = typeof j.result === 'string' ? j.result : null;
        st.isError = !!j.is_error || (j.subtype && j.subtype !== 'success');
        st.cost = j.total_cost_usd ?? null;
        st.turns = j.num_turns ?? null;
      }
    },
    finish(r) {
      const answer = st.result ?? st.text.at(-1) ?? '';
      const errText = st.isError ? `${answer}\n${r.stderr}` : r.code !== 0 && !answer ? r.stderr : '';
      return { answer, session_id: st.session, errorText: errText, ok: !st.isError && (r.code === 0 || !!answer), resetAt: st.resetAt, meta: { cost_usd: st.cost, turns: st.turns } };
    },
  };
}

// ---- Codex CLI ------------------------------------------------------------

// Codex's elevated Windows sandbox can fail to set up when Codex is launched
// outside its desktop app. We then switch to the unelevated restricted-token
// sandbox (still a sandbox) and remember that for every tool on this core.
const STATE = path.join(SHARED_HOME, 'codex.json');
const SANDBOX_BROKEN_RE = /setup refresh had errors|helper_unknown_error|Failed to create unified exec process/i;
const codexWinSandbox = () => (IS_WIN ? readJSON(STATE, {}).codex_windows_sandbox : null);

function codexSpec(o) {
  const lastFile = path.join(ensureDir(path.join(APP_HOME, 'tmp')), `codex-last-${process.pid}-${Date.now()}.txt`);
  const args = ['exec'];
  const imgs = (o.images || []).flatMap((p) => ['-i', p]);
  const sandboxOverride = o.access !== 'full' && codexWinSandbox() ? ['-c', `windows.sandbox="${codexWinSandbox()}"`] : [];
  if (o.session) {
    args.push('resume', o.session, ...imgs);
    if (o.access === 'full') args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-c', `sandbox_mode="${o.access === 'write' ? 'workspace-write' : 'read-only'}"`);
  } else {
    args.push(...imgs, '-C', o.cwd);
    if (o.access === 'full') args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-s', o.access === 'write' ? 'workspace-write' : 'read-only');
    for (const d of o.addDirs || []) args.push('--add-dir', d);
  }
  args.push(...sandboxOverride);
  if (o.model) args.push('-m', o.model);
  args.push('--json', '--skip-git-repo-check', '-o', lastFile, '-');
  // The first line becomes the thread's title in the Codex app, so lead with o.title when given.
  return { args, stdin: `${o.title ? `${o.title}\n\n` : ''}${HEADLESS_NOTE(o.caller)}\n\n${o.prompt}`, lastFile };
}

function codexParser(spec) {
  const st = { session: null, messages: [], errors: [] };
  return {
    st,
    line(l, log) {
      let j;
      try { j = JSON.parse(l); } catch { return; }
      if (j.type === 'thread.started' && j.thread_id) st.session = j.thread_id;
      const item = j.item;
      if (j.type === 'item.completed' && item?.type === 'agent_message' && item.text) st.messages.push(item.text);
      if (j.type === 'item.started' && item?.type === 'command_execution') log?.(`$ ${truncate(item.command, 160)}`);
      if (j.type === 'item.completed' && item?.type === 'command_execution' && SANDBOX_BROKEN_RE.test(item.aggregated_output || '')) st.sandboxBroken = true;
      if (j.type === 'item.completed' && item?.type === 'file_change') log?.(`✎ ${(item.changes || []).map((c) => c.path).join(', ')}`);
      if (j.type === 'item.completed' && /image/i.test(item?.type || '')) log?.(`🖼 ${item.type}`);
      if (j.type === 'turn.failed') st.errors.push(j.error?.message || JSON.stringify(j.error));
      if (j.type === 'error') st.errors.push(j.message || JSON.stringify(j));
    },
    finish(r) {
      let last = '';
      try { last = fs.readFileSync(spec.lastFile, 'utf8').trim(); fs.unlinkSync(spec.lastFile); } catch {}
      const answer = last || st.messages.at(-1) || '';
      const errText = st.errors.join('\n') || (r.code !== 0 ? r.stderr.slice(-4000) : '');
      return { answer, session_id: st.session, errorText: errText, ok: r.code === 0 && !st.errors.length, resetAt: null, meta: {}, sandboxBroken: st.sandboxBroken || SANDBOX_BROKEN_RE.test(r.stderr) };
    },
  };
}

// ---- Antigravity CLI (`agy`) ---------------------------------------------------
// Headless docs: https://antigravity.google/docs/cli/headless/

// Windows command lines top out near 32K chars, so very long prompts go through
// a temporary file in the workspace (reads inside the workspace are auto-allowed).
const AGY_ARG_LIMIT = 24000;

function antigravitySpec(o) {
  const args = ['--output-format', 'stream-json', '--print-timeout', `${o.timeoutSec || loadConfig().default_timeout_sec}s`];
  if (o.session) args.push('--conversation', o.session);
  if (o.model) args.push('--model', o.model);
  // Shell commands are soft-denied headlessly unless pre-granted, in every mode.
  if (o.access === 'full') args.push('--dangerously-skip-permissions');
  else args.push('--mode', o.access === 'write' ? 'accept-edits' : 'plan', '--sandbox');
  let prompt = `${HEADLESS_NOTE(o.caller)}\n\n${o.prompt}`;
  if (o.images?.length) prompt = `Image file(s) to look at:\n${o.images.map((p) => `- ${p}`).join('\n')}\n\n${prompt}`;
  if (o.title) prompt = `${o.title}\n\n${prompt}`;
  let promptFile = null;
  if (prompt.length > AGY_ARG_LIMIT) {
    promptFile = path.join(o.cwd, `.agy-prompt-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(promptFile, prompt);
    prompt = `Read the file ${path.basename(promptFile)} in the current directory and follow the instructions in it exactly.`;
  }
  return { args: ['-p', prompt, ...args], stdin: null, promptFile };
}

function antigravityParser(spec) {
  const st = { session: null, text: '', result: null, plain: '' };
  return {
    st,
    line(l, log) {
      let j;
      try { j = JSON.parse(l); } catch { st.plain += `${l}\n`; return; }
      const ev = j.event;
      const p = (ev && j[ev]) || j.payload || j;
      if (p?.conversation_id) st.session = p.conversation_id;
      if (ev === 'step_update') {
        if (p.step_type === 'tool' && p.state === 'ACTIVE' && p.tool_name) log?.(`→ ${p.tool_name}`);
        if (p.step_type === 'agent_response' && p.text_delta) st.text += p.text_delta;
      } else if (ev === 'result' || (!ev && p.status && 'response' in p)) {
        st.result = p;
      }
    },
    finish(r) {
      if (spec.promptFile) try { fs.unlinkSync(spec.promptFile); } catch {}
      const res = st.result;
      if (!res && st.plain.trim()) { // builds that print plain text
        return { answer: st.plain.trim(), session_id: st.session, errorText: r.code !== 0 ? r.stderr.slice(-4000) : '', ok: r.code === 0, resetAt: null, meta: {} };
      }
      const ok = r.code === 0 && (!res?.status || res.status === 'SUCCESS');
      const errText = ok ? '' : `${res?.status && res.status !== 'SUCCESS' ? `${res.status}: ` : ''}${res?.error || ''}\n${r.stderr}`.trim().slice(-4000);
      return { answer: res?.response ?? st.text, session_id: res?.conversation_id || st.session, errorText: errText, ok, resetAt: null, meta: { turns: res?.num_turns } };
    },
  };
}

const SPECS = { claude: [claudeSpec, claudeParser], codex: [codexSpec, codexParser], antigravity: [antigravitySpec, antigravityParser] };

/**
 * Run an agent headless.
 * opts: { prompt, cwd, access: read|write|full, session, model, images, addDirs, timeoutSec, caller, signal, log, onSpawn,
 *         title (thread title for apps that list runs), events (file that receives the raw event stream),
 *         onSession (called once the agent reports its session/thread id) }
 * → { agent, ok, answer, session_id, limited_until, transient, error, duration_ms, meta }
 */
const EVENTS_CAP = 50 * 1024 * 1024;
export async function runAgent(agent, opts) {
  agent = normAgent(agent);
  const a = resolveAgent(agent);
  if (!a) return { agent, ok: false, error: `${LABEL[agent] || agent} CLI not found. ${installHint(agent)}` };
  const cfg = loadConfig();
  const o = { access: 'read', ...opts, cwd: path.resolve(opts.cwd || process.cwd()), model: opts.model || cfg.agents[agent]?.model };
  if (!fs.existsSync(o.cwd)) return { agent, ok: false, error: `cwd does not exist: ${o.cwd}` };
  const [specFn, parserFn] = SPECS[agent];
  const spec = specFn(o);
  const parser = parserFn(spec);
  o.log?.(`▶ ${LABEL[agent]} (${o.access}${o.session ? `, resume ${o.session.slice(0, 8)}` : ''}) in ${o.cwd}`);
  let eventBytes = 0;
  let seenSession = null;
  const r = await run(a.cmd, [...a.pre, ...spec.args], {
    cwd: o.cwd,
    env: childEnv({ [ENV.PARENT]: o.caller || '' }),
    input: spec.stdin,
    timeoutMs: (o.timeoutSec || cfg.default_timeout_sec) * 1000,
    signal: o.signal,
    onSpawn: o.onSpawn,
    onLine: (l) => {
      if (o.events && eventBytes < EVENTS_CAP) {
        try { fs.appendFileSync(o.events, `${l}\n`); eventBytes += l.length + 1; } catch {}
      }
      parser.line(l, o.log);
      if (o.onSession && parser.st.session && parser.st.session !== seenSession) {
        seenSession = parser.st.session;
        try { o.onSession(seenSession); } catch {}
      }
    },
  });
  const out = parser.finish(r);
  if (agent === 'codex' && IS_WIN && out.sandboxBroken && o.access !== 'full' && !codexWinSandbox() && !r.aborted) {
    writeJSON(STATE, { ...readJSON(STATE, {}), codex_windows_sandbox: 'unelevated', codex_sandbox_switched_at: new Date().toISOString() });
    o.log?.('⚠ Codex\'s elevated Windows sandbox failed to set up; retrying with the unelevated sandbox (remembered for next time)');
    return runAgent(agent, opts);
  }
  const res = { agent, ok: out.ok && !r.timedOut && !r.aborted, answer: out.answer, session_id: out.session_id, duration_ms: r.durationMs, meta: out.meta };
  if (r.timedOut) res.error = `timed out after ${Math.round(r.durationMs / 1000)}s`;
  if (r.aborted) res.error = 'cancelled';
  if (!res.ok && !res.error) res.error = truncate(out.errorText || out.answer || `exit code ${r.code}`, 3000);

  // Limit detection only looks at failure text, so normal answers that merely
  // discuss rate limits never trip it.
  const failureText = res.ok ? '' : `${out.errorText}\n${res.ok ? '' : out.answer}`;
  const kind = out.resetAt ? 'limit' : classifyFailure(failureText);
  if (kind === 'limit') {
    let until = out.resetAt || parseResetTime(failureText);
    if (!until && agent === 'codex') {
      const u = codexUsage();
      until = [u?.primary, u?.secondary].filter((w) => w?.used_percent >= 100).map((w) => w.resets_at).sort((x, y) => y - x)[0];
    }
    res.limited_until = until || Date.now() + cfg.unknown_reset_retry_min * 60e3;
    res.ok = false;
    markLimited(agent, res.limited_until, failureText);
    o.log?.(`⛔ ${LABEL[agent]} hit its usage limit (until ${new Date(res.limited_until).toLocaleString()})`);
  } else if (kind === 'transient') {
    res.transient = true;
  } else if (res.ok) {
    clearLimit(agent);
  }
  return res;
}

export function installHint(agent) {
  return {
    claude: 'Install Claude Code: https://claude.com/claude-code (then run `claude` once to log in).',
    codex: 'Install Codex: `npm i -g @openai/codex` or the Codex desktop app, then log in once.',
    antigravity: 'Install the Antigravity CLI: `irm https://antigravity.google/cli/install.ps1 | iex` (Windows) or '
      + '`curl -fsSL https://antigravity.google/cli/install.sh | bash`, run `agy` once to sign in, then re-run the install command.',
  }[normAgent(agent)] || '';
}

export async function agentVersion(agent) {
  const a = resolveAgent(agent);
  if (!a) return null;
  const r = await run(a.cmd, [...a.pre, '--version'], { timeoutMs: 20000, env: childEnv() });
  return (r.stdout || r.stderr).trim().split('\n')[0] || null;
}

export function osInfo() {
  return `${os.platform()} ${os.release()}`;
}

// Exposed for the offline self-test only.
export const _test = { antigravitySpec, antigravityParser };
