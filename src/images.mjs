// Image studio: generate with Codex (built-in image_gen) or Gemini (Nano Banana via API),
// critique with Claude / Gemini / Codex, and iterate generate → critique → refine.
import fs from 'node:fs';
import path from 'node:path';
import { APP, HOME, APP_HOME, ensureDir, readJSON, writeJSON, extractJSON, truncate, fmtTime } from './core/util.mjs';
import { loadConfig } from './core/config.mjs';
import { runAgent, resolveAgent } from './core/agents.mjs';
import { limitedUntil } from './core/limits.mjs';

const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const API = 'https://generativelanguage.googleapis.com/v1beta';
const NO_KEY = 'No Gemini API key. Get one at https://aistudio.google.com/apikey and either set GEMINI_API_KEY, '
  + `add GEMINI_API_KEY=... to ~/.gemini/.env, or run: ${APP} config set images.gemini_api_key "<key>"`;

export function geminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  const k = loadConfig().images.gemini_api_key;
  if (k) return k;
  for (const f of [path.join(HOME, '.gemini', '.env'), path.join(APP_HOME, '.env')]) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/^\s*(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*["']?([^"'\r\n]+)/m);
      if (m) return m[1].trim();
    } catch {}
  }
  return null;
}

async function gfetch(url, key, body, timeoutMs = 240000) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  if (!res.ok) {
    const e = new Error(`Gemini API ${res.status}: ${j?.error?.message || text.slice(0, 400)}`);
    e.status = res.status;
    throw e;
  }
  return j;
}

async function geminiModels(key) {
  const cacheFile = path.join(APP_HOME, 'cache', 'gemini-models.json');
  const c = readJSON(cacheFile);
  if (c && Date.now() - c.at < 86400e3 && c.models?.length) return c.models;
  const models = [];
  let page = '';
  do {
    const j = await gfetch(`${API}/models?pageSize=1000${page ? `&pageToken=${page}` : ''}`, key, null, 30000);
    models.push(...(j.models || []).map((m) => ({ name: m.name.replace(/^models\//, ''), methods: m.supportedGenerationMethods || [] })));
    page = j.nextPageToken || '';
  } while (page);
  writeJSON(cacheFile, { at: Date.now(), models });
  return models;
}

// Pick the newest suitable model so this keeps working as Google ships new ones.
export async function pickGeminiModel(kind, key) {
  const cfg = loadConfig().images;
  if (kind === 'image' && cfg.gemini_image_model) return cfg.gemini_image_model;
  if (kind === 'vision' && cfg.gemini_vision_model) return cfg.gemini_vision_model;
  const all = (await geminiModels(key)).filter((m) => m.methods.includes('generateContent'));
  const pool = kind === 'image'
    ? all.filter((m) => /^gemini-.*image/.test(m.name) && !/tts|audio|live|embed/.test(m.name))
    : all.filter((m) => /^gemini-\d+(\.\d+)?-(pro|flash)(-preview)?(-\d{2}-\d{4})?$/.test(m.name));
  const ver = (n) => parseFloat(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || '0');
  const score = (n) => ver(n) * 10 + (/pro/.test(n) ? 3 : 0) - (/preview|exp/.test(n) ? 1 : 0);
  pool.sort((a, b) => score(b.name) - score(a.name));
  if (!pool.length) throw new Error(`No Gemini ${kind} model is available for this API key.`);
  return pool[0].name;
}

function inlinePart(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return { inlineData: { mimeType: MIME[ext] || 'image/png', data: fs.readFileSync(file).toString('base64') } };
}

function uniquePath(dir, file) {
  let p = path.join(dir, file);
  const { name, ext } = path.parse(file);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${name}-v${i}${ext}`);
  return p;
}

const slug = (s) => String(s || 'image').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';

function listImages(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listImages(p, out);
    else if (IMG_RE.test(e.name)) out.push({ p, m: fs.statSync(p).mtimeMs });
  }
  return out;
}

async function geminiImagine({ prompt, refs, aspect, outDir, name, count, log }) {
  const key = geminiKey();
  if (!key) throw new Error(NO_KEY);
  const model = await pickGeminiModel('image', key);
  const files = [];
  for (let i = 0; i < count; i++) {
    const body = {
      contents: [{ role: 'user', parts: [...refs.map(inlinePart), { text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(aspect ? { imageConfig: { aspectRatio: aspect } } : {}) },
    };
    log?.(`▶ Gemini ${model}: image ${i + 1}/${count}`);
    let j;
    try {
      j = await gfetch(`${API}/models/${model}:generateContent`, key, body);
    } catch (e) {
      if (!(aspect && e.status === 400)) throw e;
      delete body.generationConfig.imageConfig; // older models reject imageConfig
      j = await gfetch(`${API}/models/${model}:generateContent`, key, body);
    }
    const parts = j.candidates?.[0]?.content?.parts || [];
    const img = parts.map((p) => p.inlineData || p.inline_data).find((d) => d?.data);
    if (!img) {
      const why = parts.map((p) => p.text).filter(Boolean).join(' ') || j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || 'unknown';
      throw new Error(`Gemini returned no image (${truncate(why, 300)})`);
    }
    const ext = (img.mimeType || img.mime_type || 'image/png').split('/')[1].replace('jpeg', 'jpg');
    const f = uniquePath(outDir, `${name}-${i + 1}.${ext}`);
    fs.writeFileSync(f, Buffer.from(img.data, 'base64'));
    files.push(f);
  }
  return { ok: true, engine: 'gemini', model, files };
}

async function codexImagine({ prompt, refs, aspect, outDir, name, count, ctx }) {
  const started = Date.now();
  const genDir = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'generated_images');
  const instr = [
    `Use your built-in image generation tool (image_gen) to create ${count} image(s).`,
    '',
    'BRIEF:',
    prompt,
    aspect ? `\nAspect ratio: ${aspect}` : '',
    refs.length ? '\nThe attached image(s) are references: follow their style/composition, or treat them as the image to revise if the brief says so.' : '',
    '',
    'Rules:',
    '- Use the built-in image tool only. Do not write code, SVG, HTML or call any API or script.',
    `- Copy each final image into: ${outDir}`,
    `  named ${name}-1.png, ${name}-2.png, … (keep the real file extension).`,
    '- Your final reply must be ONLY this JSON: {"files": ["<absolute path>", ...], "prompt_used": "<exact prompt you gave the image tool>"}',
  ].join('\n');
  const r = await runAgent('codex', {
    prompt: instr, cwd: outDir, access: 'write', images: refs, timeoutSec: 900,
    caller: 'Tag-Team image studio', log: ctx.log, signal: ctx.signal, onSpawn: ctx.onSpawn,
  });
  if (!r.ok) return { ok: false, error: r.error, limited_until: r.limited_until };
  const parsed = extractJSON(r.answer) || {};
  let files = (parsed.files || []).map((f) => path.resolve(outDir, f)).filter((f) => IMG_RE.test(f) && fs.existsSync(f));
  if (!files.length) {
    // Fall back to whatever Codex just wrote into its generated_images folder.
    const fresh = listImages(genDir).filter((f) => f.m >= started - 5000).sort((a, b) => a.m - b.m).slice(-count);
    files = fresh.map((f, i) => {
      const dest = uniquePath(outDir, `${name}-${i + 1}${path.extname(f.p)}`);
      fs.copyFileSync(f.p, dest);
      return dest;
    });
  }
  if (!files.length) return { ok: false, error: `Codex finished without producing an image. Its reply: ${truncate(r.answer, 500)}` };
  return { ok: true, engine: 'codex', files, prompt_used: parsed.prompt_used || null };
}

/** Generate image(s). engine: auto | codex | gemini */
export async function imagine(p, ctx = {}) {
  const cfg = loadConfig().images;
  const engine = p.engine || cfg.engine;
  const cwd = path.resolve(p.cwd || process.cwd());
  const outDir = ensureDir(path.resolve(cwd, p.out_dir || cfg.out_dir));
  const name = slug(p.name || p.prompt);
  const count = Math.min(Math.max(parseInt(p.count || 1, 10), 1), 4);
  const refs = (p.reference_images || []).map((f) => path.resolve(cwd, f));
  const missing = refs.filter((f) => !fs.existsSync(f));
  if (missing.length) return { ok: false, error: `Reference image(s) not found: ${missing.join(', ')}` };
  const order = engine === 'auto' ? ['codex', 'gemini'] : [engine];
  const errors = [];
  for (const e of order) {
    if (e === 'codex') {
      if (!resolveAgent('codex')) { errors.push('codex: not installed'); continue; }
      const lu = limitedUntil('codex');
      if (lu && order.length > 1) { errors.push(`codex: rate-limited until ${fmtTime(lu)}`); continue; }
      const r = await codexImagine({ prompt: p.prompt, refs, aspect: p.aspect_ratio, outDir, name, count, ctx });
      if (r.ok) return r;
      errors.push(`codex: ${r.error}`);
    } else if (e === 'gemini') {
      if (!geminiKey()) { errors.push(`gemini: ${NO_KEY}`); continue; }
      try {
        return await geminiImagine({ prompt: p.prompt, refs, aspect: p.aspect_ratio, outDir, name, count, log: ctx.log });
      } catch (err) {
        errors.push(`gemini: ${err.message}`);
      }
    } else errors.push(`${e}: unknown engine (use codex or gemini)`);
  }
  return { ok: false, error: `Image generation failed.\n${errors.join('\n')}` };
}

// ---- Critique -------------------------------------------------------------

const RUBRIC = (brief) => `You are an exacting art director reviewing an AI-generated image.

BRIEF (what the image is supposed to be):
${brief || '(no brief given: judge general quality and coherence)'}

Look closely at the actual pixels. Judge: fidelity to the brief, composition and focal point, anatomy/geometry/perspective errors,
text rendering and spelling, artifacts or smudges, lighting and colour, style consistency, and fitness for the stated use.
Be specific and honest; do not inflate the score.

Reply with ONLY this JSON (no prose before or after):
{"score": <0-10, decimals ok>, "verdict": "ship" | "revise",
 "strengths": ["..."],
 "issues": [{"severity": "high" | "medium" | "low", "problem": "...", "fix": "..."}],
 "revised_prompt": "<a complete improved prompt for the image generator that fixes the issues>"}`;

function normalizeCritique(critic, text) {
  const j = extractJSON(text);
  if (!j) return { critic, ok: true, score: null, raw: truncate(text, 1500) };
  const score = typeof j.score === 'number' ? j.score : parseFloat(j.score);
  return {
    critic, ok: true, score: Number.isFinite(score) ? score : null, verdict: j.verdict || null,
    strengths: j.strengths || [], issues: j.issues || [], revised_prompt: j.revised_prompt || null,
  };
}

export function availableCritics(list) {
  const want = list?.length ? list : loadConfig().images.critics;
  return want.filter((c) => (c === 'gemini' ? resolveAgent('gemini') || geminiKey() : resolveAgent(c)) && !limitedUntil(c));
}

async function critiqueOne(critic, image, brief, ctx) {
  const prompt = RUBRIC(brief);
  if (critic === 'gemini' && !resolveAgent('gemini')) {
    const key = geminiKey();
    if (!key) return { critic, ok: false, error: NO_KEY };
    try {
      const model = await pickGeminiModel('vision', key);
      ctx.log?.(`▶ Gemini ${model}: critiquing ${path.basename(image)}`);
      const j = await gfetch(`${API}/models/${model}:generateContent`, key, {
        contents: [{ role: 'user', parts: [inlinePart(image), { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      });
      const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join('\n');
      return { ...normalizeCritique(critic, text), model };
    } catch (e) {
      return { critic, ok: false, error: e.message };
    }
  }
  const r = await runAgent(critic, {
    prompt, images: [image], cwd: path.dirname(image), access: 'read', timeoutSec: 600,
    caller: 'Tag-Team image studio', log: ctx.log, signal: ctx.signal, onSpawn: ctx.onSpawn,
  });
  if (!r.ok) return { critic, ok: false, error: r.error, limited_until: r.limited_until };
  return normalizeCritique(critic, r.answer);
}

/** Critique image(s) with several AIs in parallel. */
export async function critique(p, ctx = {}) {
  const cwd = path.resolve(p.cwd || process.cwd());
  const images = (p.images || []).map((f) => path.resolve(cwd, f));
  const missing = images.filter((f) => !fs.existsSync(f));
  if (!images.length || missing.length) return { ok: false, error: missing.length ? `Image(s) not found: ${missing.join(', ')}` : 'No images given.' };
  const critics = availableCritics(p.critics);
  if (!critics.length) return { ok: false, error: 'No critic available (install Claude/Codex/Gemini CLI or set a Gemini API key).' };
  const results = [];
  for (const image of images) {
    const critiques = await Promise.all(critics.map((c) => critiqueOne(c, image, p.brief, ctx)));
    const scores = critiques.map((c) => c.score).filter((s) => typeof s === 'number');
    const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
    results.push({ image, avg, critiques });
  }
  return { ok: results.some((r) => r.critiques.some((c) => c.ok)), critics, results };
}

const SEV = { high: 0, medium: 1, low: 2 };

function revisionPrompt(brief, entry) {
  const ok = entry.critiques.filter((c) => c.ok);
  const issues = ok.flatMap((c) => (c.issues || []).map((i) => ({ ...i, by: c.critic })))
    .sort((a, b) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3)).slice(0, 10);
  const strengths = [...new Set(ok.flatMap((c) => c.strengths || []))].slice(0, 5);
  // Start from the harshest critic's rewrite: it usually addresses the most.
  const base = ok.filter((c) => c.revised_prompt).sort((a, b) => (a.score ?? 10) - (b.score ?? 10))[0]?.revised_prompt;
  return [
    base || brief,
    '',
    `REVISION NOTES: the attached reference image is the previous attempt (avg critic score ${entry.avg ?? '?'}/10).`,
    strengths.length ? `Keep: ${strengths.join('; ')}.` : '',
    issues.length ? `Fix:\n${issues.map((i) => `- [${i.severity}] ${i.problem}${i.fix ? ` → ${i.fix}` : ''}`).join('\n')}` : '',
    '',
    `The original brief still governs: ${brief}`,
  ].filter(Boolean).join('\n');
}

/** Generate → critique → refine loop. Keeps the best-scoring image. */
export async function studio(p, ctx = {}) {
  const rounds = Math.min(Math.max(parseInt(p.rounds || 2, 10), 1), 5);
  const target = parseFloat(p.target_score ?? 8);
  const name = slug(p.name || p.brief);
  const history = [];
  let best = null;
  let prompt = p.brief;
  let refs = p.reference_images || [];
  for (let round = 1; round <= rounds; round++) {
    ctx.log?.(`── round ${round}/${rounds}`);
    const gen = await imagine({ ...p, prompt, name: `${name}-r${round}`, count: 1, reference_images: refs }, ctx);
    if (!gen.ok) { history.push({ round, error: gen.error }); break; }
    const image = gen.files[0];
    const crit = await critique({ images: [image], brief: p.brief, critics: p.critics, cwd: p.cwd }, ctx);
    const entry = crit.results?.[0] || { avg: null, critiques: [] };
    history.push({ round, engine: gen.engine, image, avg: entry.avg, critiques: entry.critiques, prompt });
    if (!best || (entry.avg ?? -1) > (best.avg ?? -1)) best = { image, avg: entry.avg, round };
    if (entry.avg != null && entry.avg >= target) break;
    if (round < rounds) {
      prompt = revisionPrompt(p.brief, entry);
      refs = [image];
    }
  }
  if (best) {
    const dest = path.join(path.dirname(best.image), `${name}-best${path.extname(best.image)}`);
    fs.copyFileSync(best.image, dest);
    best.copy = dest;
  }
  return { ok: !!best, best, target_score: target, history, error: best ? undefined : history.at(-1)?.error };
}
