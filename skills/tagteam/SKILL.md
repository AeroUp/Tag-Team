---
name: tagteam
description: Work with the other AI coding agents on this machine (Claude Code, Codex, Antigravity) through the Tag-Team MCP server. Use when the user wants a second opinion from another AI, wants to delegate a subtask to Codex/Claude/Antigravity, compare answers from several models, check which agent is available or rate-limited, or says things like "ask codex", "have antigravity do this", "get claude's take", "use another AI".
---

# Tag-Team: work with the other agents

Tag-Team is an MCP server (`tagteam`) installed in Claude Code, Codex and Antigravity (the IDE and the `agy` CLI). Through it, any agent can run any other agent headless and read its answer. In Claude Code the tools appear as `mcp__tagteam__<tool>`.

| Tool | Use it for |
|---|---|
| `agents` | Who is installed, who is usage-limited and until when, Codex usage %, and recent jobs. **Call this first** when choosing a partner. |
| `ask` | One agent, one prompt. Returns the answer and a `session_id` to continue that conversation. |
| `council` | Same prompt to several agents in parallel (read-only). Compare and synthesize. |
| `review` | Multi-AI code review. See the `tagteam-review` skill. |
| `imagine` / `critique` / `studio` | Images. See the `tagteam-studio` skill. |
| `job` | Poll, wait for, or cancel background jobs. |

To hand a whole task to another agent when you hit a usage limit, and get woken up when it resets, use the companion project **Relay** (`relay` skill, https://github.com/AeroUp/Relay).

## Picking a partner

- **Codex**: strong at hands-on implementation, refactors, running and fixing tests, terminal work. It also has built-in image generation.
- **Claude**: strong at careful reasoning, architecture, code review, long-context reading, writing.
- **Antigravity** (Gemini models, via the `agy` CLI): huge context window (whole-repo questions, long logs), web-grounded answers, and multimodal input.
- Don't ask yourself. "auto" picks the first available agent that isn't you.

## Writing the prompt

The other agent **cannot see this conversation**. Every prompt must stand on its own:
1. The goal and why it matters.
2. Exact file paths, function names, error messages, and any constraints.
3. What you want back (format and length). For example: "Reply with a numbered list of concrete issues with file:line."
4. Always pass `cwd` (the project's absolute path).

## Access levels

- `read` (default): the agent can look but not change anything. Use it for questions, reviews, and research.
- `write`: the agent can edit files in `cwd` (Codex runs it in its workspace sandbox). Use it for delegated implementation.
- `full`: no sandbox and no permission checks. Only use it when the user explicitly wants that.

Never give two agents `write` access to the same files at the same time.

## Long tasks

Anything that may take more than a couple of minutes: pass `background: true`. You get a `job_id` back right away. Then keep working, and later call `job` with `wait_sec` (max 600) to collect the result.

## Continuing a conversation

`ask` returns `session_id`. To follow up with the same agent and keep its context, pass that `session_id` with the next `ask` to the same agent.

## Using its answer

Treat other agents' output as a strong colleague's opinion, not ground truth. Verify claims against the code before acting, and tell the user which agent said what when it matters.

## Limits and safety

- If an agent is usage-limited, `ask` says until when. Pass `fallback: true` to automatically try the next agent.
- Agents started by Tag-Team can start at most one more level of agents (depth limit), so recursion stays bounded.
- If the MCP tools aren't loaded, use the CLI instead: `{{CLI}} ask codex "…" --cwd <dir>`, `{{CLI}} doctor`.
