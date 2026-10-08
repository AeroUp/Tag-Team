// Offline checks: no agent calls, no usage spent. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResetTime, classifyFailure } from '../src/core/limits.mjs';
import { extractJSON } from '../src/core/util.mjs';
import { _test as agy, normAgent } from '../src/core/agents.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tagteam.mjs');
const results = [];
async function t(name, fn) {
  try { await fn(); results.push(`✔ ${name}`); } catch (e) { results.push(`✖ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// Start an MCP server and return a tiny JSON-RPC client.
export function mcpClient(cli, env = {}) {
  const tmp = path.join(os.tmpdir(), `agent-selftest-${process.pid}`);
  const child = spawn(process.execPath, [cli, 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AI_AGENT_SELF: 'selftest', TAGTEAM_HOME: tmp, RELAY_HOME: tmp, AGENT_STATE_DIR: tmp, ...env },
  });
  const replies = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.id !== undefined) replies.set(m.id, m);
    }
  });
  let next = 1;
  return {
    async request(method, params) {
      const id = next++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      for (let k = 0; k < 300 && !replies.has(id); k++) await new Promise((r) => setTimeout(r, 50));
      return replies.get(id);
    },
    notify(method, params) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); },
    close() { child.stdin.end(); child.kill(); },
  };
}

export async function selftest() {
  const now = Date.UTC(2026, 9, 8, 18, 0); // 2pm in New York

  await t('Claude: "resets 3pm (America/New_York)"', () => {
    assert.equal(parseResetTime("You've hit your session limit · resets 3pm (America/New_York)", now), Date.UTC(2026, 9, 8, 19, 0));
  });
  await t('Claude: a time already passed today rolls to tomorrow', () => {
    assert.equal(parseResetTime('resets 1pm (America/New_York)', now), Date.UTC(2026, 9, 9, 17, 0));
  });
  await t('Claude: "resets Oct 10, 9:30am (Europe/London)"', () => {
    assert.equal(parseResetTime("You've hit your weekly limit · resets Oct 10, 9:30am (Europe/London)", now), Date.UTC(2026, 9, 10, 8, 30));
  });
  await t('Claude legacy: "usage limit reached|<epoch>"', () => {
    assert.equal(parseResetTime('Claude AI usage limit reached|1791504000', now), 1791504000 * 1000);
  });
  await t('Codex: "try again in 2 hours 13 minutes"', () => {
    assert.equal(parseResetTime("You've hit your usage limit. Try again in 2 hours 13 minutes.", now), now + (2 * 60 + 13) * 60e3);
  });
  await t('Antigravity/Gemini: "Please retry in 34.5s"', () => {
    assert.equal(parseResetTime('Quota exceeded. Please retry in 34.5s.', now), now + 34500);
  });
  await t('ISO reset time', () => {
    assert.equal(parseResetTime('spend limit reached (daily; resets 2026-10-09 00:00 UTC)', now), Date.UTC(2026, 9, 9, 0, 0));
  });
  await t('classify: limit vs transient vs unrelated', () => {
    assert.equal(classifyFailure("You've hit your usage limit"), 'limit');
    assert.equal(classifyFailure('RESOURCE_EXHAUSTED: You have exhausted your daily quota'), 'limit');
    assert.equal(classifyFailure('API Error: 529 overloaded'), 'transient');
    assert.equal(classifyFailure('TypeError: x is undefined'), null);
  });
  await t('extractJSON from fenced / prose output', () => {
    assert.deepEqual(extractJSON('Sure!\n```json\n{"score": 7.5, "issues": [{"p": "a}b"}]}\n```'), { score: 7.5, issues: [{ p: 'a}b' }] });
    assert.deepEqual(extractJSON('noise {"a":1} tail'), { a: 1 });
  });
  await t('Antigravity CLI: flags per access level', () => {
    const args = (o) => agy.antigravitySpec({ prompt: 'hi', cwd: os.tmpdir(), timeoutSec: 600, ...o }).args;
    assert.deepEqual(args({ access: 'read' }).slice(-3), ['--mode', 'plan', '--sandbox']);
    assert.ok(args({ access: 'write' }).includes('accept-edits'));
    assert.ok(args({ access: 'full' }).includes('--dangerously-skip-permissions'));
    assert.ok(args({ session: 'c1' }).join(' ').includes('--conversation c1'));
    assert.ok(args({}).join(' ').includes('--output-format stream-json --print-timeout 600s'));
    assert.equal(normAgent('gemini'), 'antigravity');
  });
  await t('Antigravity CLI: stream-json success and quota error', () => {
    const ok = agy.antigravityParser({});
    for (const e of [
      { event: 'init', init: { cwd: '/p', permission_mode: 'request-review' } },
      { event: 'step_update', step_update: { conversation_id: 'conv-1', step_type: 'tool', state: 'ACTIVE', tool_name: 'view_file' } },
      { event: 'step_update', step_update: { conversation_id: 'conv-1', step_type: 'agent_response', text_delta: 'Hel' } },
      { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'Hello', num_turns: 1 } },
    ]) ok.line(JSON.stringify(e));
    const r1 = ok.finish({ code: 0, stderr: '' });
    assert.equal(r1.ok, true); assert.equal(r1.answer, 'Hello'); assert.equal(r1.session_id, 'conv-1');
    const bad = agy.antigravityParser({});
    bad.line(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'You have exhausted your quota. Your quota resets in 2 hours.' } }));
    const r2 = bad.finish({ code: 1, stderr: '' });
    assert.equal(r2.ok, false); assert.equal(classifyFailure(r2.errorText), 'limit');
  });
  await t('MCP: handshake, tools/list, agents tool, unknown method', async () => {
    const c = mcpClient(CLI);
    try {
      const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } });
      assert.equal(init.result.serverInfo.name, 'tagteam');
      c.notify('notifications/initialized');
      const names = (await c.request('tools/list')).result.tools.map((x) => x.name);
      for (const n of ['agents', 'ask', 'council', 'review', 'imagine', 'critique', 'studio', 'job']) assert.ok(names.includes(n), `missing tool ${n}`);
      const ag = await c.request('tools/call', { name: 'agents', arguments: {} });
      assert.ok(ag?.result?.content?.[0]?.text?.includes('Agents:'), 'agents tool output');
      assert.equal((await c.request('bogus/method')).error.code, -32601);
    } finally {
      c.close();
    }
  });

  console.log(results.join('\n'));
}
