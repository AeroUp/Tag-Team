// Wire Tag-Team into every agent on this machine: MCP server + skills.
import path from 'node:path';
import { APP_HOME, ensureDir, readJSON, writeJSON } from './core/util.mjs';
import {
  TARGETS, detect, claudeAddMcp, claudeRemoveMcp, codexAddMcp, codexRemoveMcp, antigravityAddMcp, antigravityRemoveMcp,
  skillDirs, ALL_SKILL_DIRS, installSkills, removeSkills,
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
  if (want('antigravity')) { log(antigravityAddMcp()); rec.targets.push('antigravity'); }
  for (const k of TARGETS) {
    if (!rec.targets.includes(k) && (!only || only.includes(k))) log(`${k}: not found, skipped (install it, run it once, then run install again)`);
  }
  const dirs = rec.targets.flatMap(skillDirs);
  for (const d of dirs) installSkills(d, SKILLS);
  log(`Skills ${SKILLS.join(', ')} → ${dirs.join(', ')}`);
  writeJSON(RECORD, rec);
}

export async function uninstall() {
  const log = (l) => l && console.log(`  ${l}`);
  if (detect.claude()) log(await claudeRemoveMcp());
  log(codexRemoveMcp());
  log(antigravityRemoveMcp());
  for (const base of ALL_SKILL_DIRS) for (const p of removeSkills(base, SKILLS)) log(`removed skill ${p}`);
  log(`Done. Data in ${APP_HOME} was kept; delete it by hand if you want.`);
}

export const installedTargets = () => readJSON(RECORD, {}).targets || [];
