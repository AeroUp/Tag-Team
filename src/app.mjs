// What makes this package Tag-Team. Everything in src/core/ is shared with Relay
// (https://github.com/AeroUp/Relay) and reads its identity from this file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP = 'tagteam'; // MCP server name, data dir name
export const TITLE = 'Tag-Team';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'bin', 'tagteam.mjs');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const APP_HOME = process.env.TAGTEAM_HOME || path.join(os.homedir(), '.tagteam');

export const DEFAULTS = {
  images: {
    engine: 'auto', // auto (codex → antigravity → gemini) | codex | antigravity | gemini (API key)
    critics: ['claude', 'antigravity', 'codex'],
    out_dir: 'tagteam-images',
    gemini_image_model: null, // auto-discovered when null
    gemini_vision_model: null,
    gemini_api_key: null, // or GEMINI_API_KEY, or ~/.gemini/.env
  },
};
