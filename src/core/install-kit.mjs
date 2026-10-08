// Building blocks for wiring an MCP server + skills into Claude Code, Codex and
// Antigravity (IDE + agy CLI). Every config file is backed up before it changes.
import fs from 'node:fs';
import path from 'node:path';
import { APP, HOME, CLI, ROOT, ENV, ensureDir, readJSON, writeJSON, run } from './util.mjs';
import { resolveAgent, childEnv } from './agents.mjs';

export const fwd = (p) => p.replace(/\\/g, '/');
export const NODE = fwd(process.execPath);
export const CLI_CMD = `"${NODE}" "${fwd(CLI)}"`;
const CLI_BASE = path.basename(CLI).replace(/\./g, '\\.');

export const serverDef = (self) => ({ command: NODE, args: [fwd(CLI), 'mcp'], env: { [ENV.SELF]: self } });

export function backup(file) {
  if (fs.existsSync(file) && !fs.existsSync(`${file}.bak-${APP}`)) fs.copyFileSync(file, `${file}.bak-${APP}`);
}

export const TARGETS = ['claude', 'codex', 'antigravity'];

export const detect = {
  claude: () => !!resolveAgent('claude'),
  codex: () => !!resolveAgent('codex') || fs.existsSync(path.join(HOME, '.codex')),
  // The Antigravity IDE and the Antigravity CLI (`agy`) both keep their config under ~/.gemini.
  antigravity: () => !!resolveAgent('antigravity') || fs.existsSync(path.join(HOME, '.gemini')),
};

// ---- Claude Code ------------------------------------------------------------

async function claudeCli(args) {
  const a = resolveAgent('claude');
  return run(a.cmd, [...a.pre, ...args], { env: childEnv(), timeoutMs: 60000 });
}

export async function claudeAddMcp() {
  await claudeCli(['mcp', 'remove', '-s', 'user', APP]);
  const def = { type: 'stdio', ...serverDef('claude'), timeout: 3600000 };
  let r = await claudeCli(['mcp', 'add-json', '-s', 'user', APP, JSON.stringify(def)]);
  if (r.code !== 0) { // older Claude Code without per-server timeout
    delete def.timeout;
    r = await claudeCli(['mcp', 'add-json', '-s', 'user', APP, JSON.stringify(def)]);
  }
  return r.code === 0 ? `Claude Code: MCP server "${APP}" added (user scope)` : `Claude Code: MCP add failed: ${(r.stderr || r.stdout).trim()}`;
}

export async function claudeRemoveMcp() {
  const r = await claudeCli(['mcp', 'remove', '-s', 'user', APP]);
  return `Claude Code: MCP server ${r.code === 0 ? 'removed' : 'was not registered'}`;
}

const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const isOurHook = (h) => new RegExp(`${CLI_BASE}"?\\s+hook\\b`).test(h?.command || '');

/** hooks: { EventName: { arg, timeout } }; pass null to remove ours. */
export function claudeSetHooks(hooks) {
  const s = readJSON(CLAUDE_SETTINGS, {});
  backup(CLAUDE_SETTINGS);
  s.hooks = s.hooks || {};
  for (const ev of Object.keys(s.hooks)) {
    s.hooks[ev] = s.hooks[ev].map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurHook(h)) })).filter((g) => g.hooks.length);
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  for (const [ev, { arg, timeout }] of Object.entries(hooks || {})) {
    (s.hooks[ev] = s.hooks[ev] || []).push({ hooks: [{ type: 'command', command: `${CLI_CMD} hook ${arg}`, timeout }] });
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  ensureDir(path.dirname(CLAUDE_SETTINGS));
  writeJSON(CLAUDE_SETTINGS, s);
  return hooks ? `Claude Code: hooks ${Object.keys(hooks).join(', ')} added` : 'Claude Code: hooks removed';
}

// ---- Codex (config.toml block between markers) --------------------------------

const CODEX_TOML = path.join(HOME, '.codex', 'config.toml');
const START = `# >>> ${APP} >>>`;
const END = `# <<< ${APP} <<<`;
const stripBlock = (t) => t.replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`, 'g'), '\n');

export function codexAddMcp() {
  ensureDir(path.dirname(CODEX_TOML));
  backup(CODEX_TOML);
  const block = [
    START,
    `[mcp_servers.${APP}]`,
    `command = '${NODE}'`,
    `args = ['${fwd(CLI)}', "mcp"]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 3600',
    // Headless `codex exec` can't show approval prompts; without this, calls get blocked.
    'default_tools_approval_mode = "approve"',
    `env_vars = ["${ENV.DEPTH}", "${ENV.PARENT}", "AGENT_STATE_DIR", "GEMINI_API_KEY", "GOOGLE_API_KEY", "TAGTEAM_HOME", "RELAY_HOME"]`,
    '',
    `[mcp_servers.${APP}.env]`,
    `${ENV.SELF} = "codex"`,
    END,
  ].join('\n');
  const text = fs.existsSync(CODEX_TOML) ? stripBlock(fs.readFileSync(CODEX_TOML, 'utf8')).replace(/\s*$/, '') : '';
  fs.writeFileSync(CODEX_TOML, `${text}\n\n${block}\n`);
  return `Codex: MCP server "${APP}" added to ${CODEX_TOML}`;
}

export function codexRemoveMcp() {
  if (!fs.existsSync(CODEX_TOML)) return null;
  const text = fs.readFileSync(CODEX_TOML, 'utf8');
  if (!text.includes(START)) return null;
  fs.writeFileSync(CODEX_TOML, `${stripBlock(text).replace(/\s*$/, '')}\n`);
  return 'Codex: MCP server removed';
}

// ---- Antigravity IDE + Antigravity CLI ----------------------------------------------
// Both read MCP servers from ~/.gemini/config/mcp_config.json (https://antigravity.google/docs/mcp).
// Older IDE builds used ~/.gemini/antigravity/mcp_config.json, which we also update when it exists.

const AG_MCP = path.join(HOME, '.gemini', 'config', 'mcp_config.json');
const AG_MCP_LEGACY = path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json');
const AGY_SETTINGS = path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json');
const AG_PERMISSION = `mcp(${APP}/*)`;

function jsonAddMcp(file, self) {
  ensureDir(path.dirname(file));
  backup(file);
  const j = readJSON(file, {});
  j.mcpServers = { ...(j.mcpServers || {}), [APP]: serverDef(self) };
  writeJSON(file, j);
}

function jsonRemoveMcp(file) {
  const j = readJSON(file);
  if (!j?.mcpServers?.[APP]) return false;
  delete j.mcpServers[APP];
  writeJSON(file, j);
  return true;
}

export function antigravityAddMcp() {
  jsonAddMcp(AG_MCP, 'antigravity');
  const files = [AG_MCP];
  if (fs.existsSync(path.dirname(AG_MCP_LEGACY))) { jsonAddMcp(AG_MCP_LEGACY, 'antigravity'); files.push(AG_MCP_LEGACY); }
  // Unconfigured MCP tools run in "Ask" mode, which headless `agy -p` runs can't answer.
  if (resolveAgent('antigravity') || fs.existsSync(path.dirname(AGY_SETTINGS))) {
    ensureDir(path.dirname(AGY_SETTINGS));
    backup(AGY_SETTINGS);
    const s = readJSON(AGY_SETTINGS, {});
    s.permissions = s.permissions || {};
    s.permissions.allow = [...new Set([...(s.permissions.allow || []), AG_PERMISSION])];
    writeJSON(AGY_SETTINGS, s);
  }
  return `Antigravity: MCP server "${APP}" added to ${files.join(' and ')}`;
}

export function antigravityRemoveMcp() {
  const removed = [AG_MCP, AG_MCP_LEGACY].filter((f) => jsonRemoveMcp(f));
  const s = readJSON(AGY_SETTINGS);
  if (s?.permissions?.allow?.includes(AG_PERMISSION)) {
    s.permissions.allow = s.permissions.allow.filter((p) => p !== AG_PERMISSION);
    writeJSON(AGY_SETTINGS, s);
  }
  return removed.length ? 'Antigravity: MCP server removed' : null;
}

// ---- Skills (Agent Skills format: <dir>/<name>/SKILL.md) ------------------------

export function skillDirs(target) {
  if (target === 'claude') return [path.join(HOME, '.claude', 'skills')];
  if (target === 'codex') return [path.join(HOME, '.agents', 'skills')];
  if (target === 'antigravity') {
    const legacy = path.join(HOME, '.gemini', 'antigravity');
    return [path.join(HOME, '.gemini', 'config', 'skills'), ...(fs.existsSync(legacy) ? [path.join(legacy, 'skills')] : [])];
  }
  return [];
}

export const ALL_SKILL_DIRS = [
  path.join(HOME, '.claude', 'skills'), path.join(HOME, '.agents', 'skills'),
  path.join(HOME, '.gemini', 'config', 'skills'), path.join(HOME, '.gemini', 'antigravity', 'skills'),
];

function copyDir(src, dest, transform) {
  ensureDir(dest);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d, transform);
    else if (/\.(md|txt)$/i.test(e.name)) fs.writeFileSync(d, transform(fs.readFileSync(s, 'utf8')));
    else fs.copyFileSync(s, d);
  }
}

/** Copy skills/<name> into `base`, replacing {{CLI}} with this machine's CLI command. */
export function installSkills(base, names) {
  return names.map((name) => {
    const dest = path.join(base, name);
    fs.rmSync(dest, { recursive: true, force: true });
    copyDir(path.join(ROOT, 'skills', name), dest, (t) => t.replaceAll('{{CLI}}', CLI_CMD));
    return dest;
  });
}

export function removeSkills(base, names) {
  return names.filter((n) => fs.existsSync(path.join(base, n))).map((n) => {
    fs.rmSync(path.join(base, n), { recursive: true, force: true });
    return path.join(base, n);
  });
}
