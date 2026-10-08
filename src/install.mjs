// Wire Tag-Team into every agent on this machine: MCP server + skills.
import path from 'node:path';
import { APP_HOME, ensureDir, readJSON, writeJSON } from './core/util.mjs';
import {
  detect, claudeAddMcp, claudeRemoveMcp, codexAddMcp, codexRemoveMcp, jsonAddMcp, jsonRemoveMcp,
  GEMINI_SETTINGS, ANTIGRAVITY_MCP, SKILL_DIRS, installSkills, removeSkills,
} from './core/install-kit.mjs';

const SKILLS = ['tagteam', 'tagteam-review', 'tagteam-studio'];
const RECORD = path.join(APP_HOME, 'install.json');

export async function install({ only } = {}) {
  const log = (l) => l && console.log(`  ${l}`);
  const want = (k) => (!only || only.includes(k)) && detect[k]();
  const rec = { at: new Date().toISOString(), targets: [] };
  ensureDir(APP_HOME);
  if (want('claude')) { log(await claudeAddMcp()); rec.targets.push('claude'); }
  if (want('codex')) { log(codexAddMcp()); rec.targets.push('codex'); }
  if (want('gemini')) {
    jsonAddMcp(GEMINI_SETTINGS, 'gemini', { timeout: 3600000, trust: false });
    log(`Gemini CLI: MCP server added to ${GEMINI_SETTINGS}`);
    rec.targets.push('gemini');
  }
  if (want('antigravity')) {
    jsonAddMcp(ANTIGRAVITY_MCP, 'antigravity');
    log(`Antigravity: MCP server added to ${ANTIGRAVITY_MCP}`);
    rec.targets.push('antigravity');
  }
  for (const k of ['claude', 'codex', 'gemini', 'antigravity']) {
    if (!rec.targets.includes(k) && (!only || only.includes(k))) log(`${k}: not found, skipped (install it, run it once, then run install again)`);
  }
  for (const t of rec.targets) installSkills(SKILL_DIRS[t], SKILLS);
  log(`Skills ${SKILLS.join(', ')} → ${rec.targets.map((t) => SKILL_DIRS[t]).join(', ')}`);
  writeJSON(RECORD, rec);
}

export async function uninstall() {
  const log = (l) => l && console.log(`  ${l}`);
  if (detect.claude()) log(await claudeRemoveMcp());
  log(codexRemoveMcp());
  if (jsonRemoveMcp(GEMINI_SETTINGS)) log('Gemini CLI: MCP server removed');
  if (jsonRemoveMcp(ANTIGRAVITY_MCP)) log('Antigravity: MCP server removed');
  for (const base of Object.values(SKILL_DIRS)) for (const p of removeSkills(base, SKILLS)) log(`removed skill ${p}`);
  log(`Done. Data in ${APP_HOME} was kept; delete it by hand if you want.`);
}

export const installedTargets = () => readJSON(RECORD, {}).targets || [];
