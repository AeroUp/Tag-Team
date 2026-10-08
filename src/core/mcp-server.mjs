// Minimal, dependency-free MCP server over stdio (newline-delimited JSON-RPC 2.0).
import readline from 'node:readline';
import path from 'node:path';
import { APP, TITLE, VERSION, truncate } from './util.mjs';

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * serve({ instructions, tools, call })
 *   tools: MCP tool definitions
 *   call(name, args, ctx) → Promise<string>; ctx = { signal, log }
 */
export function serve({ instructions, tools, call }) {
  const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const inflight = new Map();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.stdout.on('error', () => process.exit(0));

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const { id, method, params = {} } = msg;
    const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      switch (method) {
        case 'initialize':
          return reply({
            protocolVersion: SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: APP, title: TITLE, version: VERSION },
            instructions,
          });
        case 'notifications/initialized':
        case 'notifications/roots/list_changed':
          return;
        case 'notifications/cancelled':
          inflight.get(params.requestId)?.abort();
          return;
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools });
        case 'resources/list':
          return reply({ resources: [] });
        case 'resources/templates/list':
          return reply({ resourceTemplates: [] });
        case 'prompts/list':
          return reply({ prompts: [] });
        case 'tools/call': {
          const ac = new AbortController();
          inflight.set(id, ac);
          const token = params._meta?.progressToken;
          let n = 0;
          let lastLine = '';
          const ctx = {
            signal: ac.signal,
            log: (l) => { lastLine = l; process.stderr.write(`[${APP}] ${l}\n`); },
          };
          // Progress heartbeats keep clients informed during long agent runs.
          const beat = token !== undefined ? setInterval(() => send({
            jsonrpc: '2.0', method: 'notifications/progress',
            params: { progressToken: token, progress: ++n, message: truncate(lastLine || 'working…', 200) },
          }), 10000) : null;
          try {
            const args = { ...(params.arguments || {}) };
            if (args.cwd) args.cwd = path.resolve(args.cwd);
            const text = await call(params.name, args, ctx);
            reply({ content: [{ type: 'text', text: String(text) }], isError: false });
          } catch (e) {
            reply({ content: [{ type: 'text', text: `Error: ${e.message || e}` }], isError: true });
          } finally {
            if (beat) clearInterval(beat);
            inflight.delete(id);
          }
          return;
        }
        default:
          if (id !== undefined) fail(-32601, `Method not found: ${method}`);
      }
    } catch (e) {
      fail(-32603, String(e.message || e));
    }
  });
  rl.on('close', () => {
    for (const ac of inflight.values()) ac.abort();
    setTimeout(() => process.exit(0), 200);
  });
}
