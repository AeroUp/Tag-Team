#!/usr/bin/env node
// Tag-Team: Claude, Codex and Gemini working together.
import fs from 'node:fs';
import path from 'node:path';
import { VERSION, APP_HOME } from '../src/core/util.mjs';
import { loadConfig, setConfigValue, CONFIG_PATH } from '../src/core/config.mjs';
import { LABEL, agentVersion } from '../src/core/agents.mjs';
import { fmtTime, fmtIn } from '../src/core/util.mjs';
import { runJobProcess, getJob, listJobs, cancelJob, waitJob, readJobLog, jobLog, isTerminal } from '../src/core/jobs.mjs';
import { OPS, status, ask, council, review, startBackground } from '../src/ops.mjs';
import { imagine, critique, studio } from '../src/images.mjs';

const BOOL = new Set(['bg', 'json', 'fallback', 'follow', 'f']);

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f') { flags.f = true; continue; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) flags[k] = v;
      else if (BOOL.has(k) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const progress = { log: (l) => process.stderr.write(`  ${l}\n`) };

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

const HELP = `tagteam ${VERSION}: Claude, Codex and Gemini working together.

Setup
  tagteam install [--only claude,codex,gemini,antigravity]
  tagteam uninstall
  tagteam doctor                       who is installed / usage-limited, recent jobs
  tagteam config [get <key> | set <key> <value> | path]

Talk to other agents
  tagteam ask <claude|codex|gemini|auto> "prompt" [--cwd .] [--access read|write|full] [--session id] [--model m] [--fallback] [--bg]
  tagteam council "prompt" [--agents codex,gemini]
  tagteam review [--scope uncommitted|staged|branch|last_commit|files] [--base main] [--focus "..."] [--files a,b] [--agents ...]

Images
  tagteam imagine "brief" [--engine auto|codex|gemini] [--count 2] [--aspect 16:9] [--out dir] [--name stem] [--ref img.png]
  tagteam critique img.png [more.png] --brief "what it should be" [--critics claude,gemini]
  tagteam studio "brief" [--rounds 3] [--target 8] [--engine codex] [--critics claude,gemini] [--bg]

Jobs
  tagteam jobs | tagteam job <id> [--wait 300] | tagteam logs <id> [-f] | tagteam cancel <id>

Internal: mcp, _job <id>, selftest`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const cwd = path.resolve(flags.cwd || process.cwd());

  switch (cmd) {
    case 'mcp': {
      const { serve } = await import('../src/core/mcp-server.mjs');
      const { TOOLS, call, instructions } = await import('../src/tools.mjs');
      return serve({ tools: TOOLS, call, instructions: instructions() });
    }
    case '_job':
      return runJobProcess(pos[0], OPS);

    case 'install': {
      const { install } = await import('../src/install.mjs');
      console.log('Installing Tag-Team…');
      await install({ only: list(flags.only) });
      console.log('\nDone. Restart your agents (Claude Code, Codex, Gemini CLI, Antigravity) so they load the "tagteam" MCP server and skills.\nCheck with: tagteam doctor');
      return;
    }
    case 'uninstall': {
      const { uninstall } = await import('../src/install.mjs');
      return uninstall();
    }
    case 'doctor':
    case 'status': {
      const s = await status();
      const { installedTargets } = await import('../src/install.mjs');
      console.log(`Tag-Team ${VERSION} · data ${APP_HOME}\n`);
      for (const a of s.agents) {
        const v = a.installed ? await agentVersion(a.agent) : null;
        const state = !a.installed ? 'not installed' : a.available ? 'available' : `LIMITED until ${fmtTime(a.limited_until)} (${fmtIn(a.limited_until)})`;
        console.log(`${LABEL[a.agent].padEnd(7)} ${state}${v ? ` · ${v}` : ''}${a.path ? `\n        ${a.path}` : ''}`);
        if (a.usage) console.log(`        usage: 5h ${a.usage.five_hour_used_pct ?? '?'}% (resets ${a.usage.five_hour_resets}) · week ${a.usage.weekly_used_pct ?? '?'}% (resets ${a.usage.weekly_resets}) · as of ${a.usage.as_of}`);
      }
      console.log(`\nImages: codex ${s.image_engines.codex ? 'ready' : 'missing'} · gemini API ${s.image_engines.gemini_api ? 'ready' : 'no key (see README)'}`);
      console.log(`Wired into: ${installedTargets().join(', ') || 'nothing yet (run: tagteam install)'}`);
      console.log(`Jobs:\n${s.jobs.map((j) => `  ${j.id} ${j.title} [${j.status}] ${j.created}`).join('\n') || '  none'}`);
      return;
    }
    case 'config': {
      if (pos[0] === 'set') return out({ [pos[1]]: setConfigValue(pos[1], pos.slice(2).join(' ')) });
      if (pos[0] === 'path') return out(CONFIG_PATH);
      const c = loadConfig();
      return out(pos[1] ? pos[1].split('.').reduce((o, k) => o?.[k], c) : c);
    }

    case 'ask': {
      const p = {
        agent: pos[0], prompt: pos.slice(1).join(' ') || (await readStdin()), cwd, access: flags.access, session_id: flags.session,
        model: flags.model, fallback: !!flags.fallback, timeout_sec: flags.timeout && +flags.timeout,
      };
      if (flags.bg) return out(startBackground('ask', p, 'ask (cli)'));
      const r = await ask(p, progress);
      if (flags.json) return out(r);
      console.log(r.ok ? r.answer : `✖ ${r.error}`);
      if (r.session_id) process.stderr.write(`\n(session ${r.session_id})\n`);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case 'council': {
      const r = await council({ prompt: pos.join(' ') || (await readStdin()), cwd, agents: list(flags.agents) }, progress);
      if (!r.results) return console.log(`✖ ${r.error}`);
      for (const x of r.results) console.log(`\n===== ${LABEL[x.agent]} =====\n${x.ok ? x.answer : `✖ ${x.error}`}`);
      return;
    }
    case 'review': {
      const r = await review({ cwd, scope: flags.scope, base: flags.base, focus: flags.focus, agents: list(flags.agents), files: list(flags.files) }, progress);
      if (flags.json) return out(r);
      if (!r.results) return console.log(`✖ ${r.error}`);
      console.log(`\nMerged findings (${r.findings.length}):`);
      for (const f of r.findings) console.log(`  [${f.severity}] ${f.file}:${f.line ?? '?'} ${f.title} (${f.flagged_by.join('+')})`);
      for (const x of r.results) console.log(`\n===== ${LABEL[x.agent]} (${x.verdict || (x.ok ? 'done' : 'failed')}) =====\n${x.ok ? x.answer : `✖ ${x.error}`}`);
      return;
    }

    case 'imagine': {
      const p = { prompt: pos.join(' '), engine: flags.engine, count: flags.count, aspect_ratio: flags.aspect, out_dir: flags.out, name: flags.name, cwd, reference_images: list(flags.ref) };
      if (flags.bg) return out(startBackground('imagine', p, 'imagine (cli)'));
      const r = await imagine(p, progress);
      console.log(r.ok ? `${r.engine}${r.model ? ` (${r.model})` : ''}:\n${r.files.join('\n')}` : `✖ ${r.error}`);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case 'critique':
      return out(await critique({ images: pos, brief: flags.brief, critics: list(flags.critics), cwd }, progress));
    case 'studio': {
      const p = { brief: pos.join(' '), engine: flags.engine, critics: list(flags.critics), rounds: flags.rounds, target_score: flags.target, out_dir: flags.out, name: flags.name, aspect_ratio: flags.aspect, cwd };
      if (flags.bg) return out(startBackground('studio', p, 'studio (cli)'));
      const r = await studio(p, progress);
      if (!r.ok) return console.log(`✖ ${r.error}`);
      console.log(`Best: ${r.best.copy} (round ${r.best.round}, ${r.best.avg}/10)`);
      for (const h of r.history) console.log(`  round ${h.round}: ${h.error ? `✖ ${h.error}` : `${h.avg}/10 ${h.image}`}`);
      return;
    }

    case 'jobs':
      return console.log(listJobs(20).map((j) => `${j.id}  ${j.status.padEnd(9)} ${new Date(j.created_at).toLocaleString()}  ${j.title}`).join('\n') || 'No jobs.');
    case 'job': {
      const j = flags.wait ? await waitJob(pos[0], +flags.wait) : getJob(pos[0]);
      if (!j) return console.log('No such job.');
      return out(isTerminal(j) ? j : { ...j, progress: readJobLog(j.id, 3000) });
    }
    case 'logs': {
      const id = pos[0];
      process.stdout.write(readJobLog(id, 1e9));
      if (!(flags.f || flags.follow)) return;
      let size = fs.existsSync(jobLog(id)) ? fs.statSync(jobLog(id)).size : 0;
      while (!isTerminal(getJob(id))) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = fs.existsSync(jobLog(id)) ? fs.statSync(jobLog(id)).size : 0;
        if (s > size) {
          const fd = fs.openSync(jobLog(id), 'r');
          const buf = Buffer.alloc(s - size);
          fs.readSync(fd, buf, 0, buf.length, size);
          fs.closeSync(fd);
          process.stdout.write(buf.toString('utf8'));
          size = s;
        }
      }
      return;
    }
    case 'cancel':
      return out(cancelJob(pos[0])?.status || 'No such job.');

    case 'selftest': {
      const { selftest } = await import('../test/selftest.mjs');
      return selftest();
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return console.log(HELP);
    case '--version':
    case '-v':
      return console.log(VERSION);
    default:
      console.log(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`tagteam: ${e.message || e}`);
  process.exitCode = 1;
});
