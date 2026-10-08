// Config lives in <app home>/config.json and is deep-merged over these defaults.
import path from 'node:path';
import { APP_HOME, readJSON, writeJSON } from './util.mjs';
import { DEFAULTS as APP_DEFAULTS } from '../app.mjs';

export const CONFIG_PATH = path.join(APP_HOME, 'config.json');

const COMMON = {
  agents: {
    claude: { path: null, model: null },
    codex: { path: null, model: null },
    gemini: { path: null, model: null },
  },
  // How deep agents may call agents (Claude → Codex → Gemini = depth 2).
  max_depth: 2,
  // Max simultaneous agent processes across every tool using this core.
  max_concurrent: 6,
  default_timeout_sec: 1200,
  // Retry interval when a usage-limit message carries no reset time.
  unknown_reset_retry_min: 30,
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = typeof v === 'object' && v !== null && !Array.isArray(v) && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

export const DEFAULTS = merge(COMMON, APP_DEFAULTS);

let cached = null;
export function loadConfig({ fresh = false } = {}) {
  if (!cached || fresh) cached = merge(DEFAULTS, readJSON(CONFIG_PATH, {}));
  return cached;
}

export function setConfigValue(dotted, value) {
  const raw = readJSON(CONFIG_PATH, {});
  const keys = dotted.split('.');
  let o = raw;
  for (const k of keys.slice(0, -1)) o = o[k] = typeof o[k] === 'object' && o[k] ? o[k] : {};
  let v = value;
  try { v = JSON.parse(value); } catch {}
  o[keys.at(-1)] = v;
  writeJSON(CONFIG_PATH, raw);
  cached = null;
  return v;
}
