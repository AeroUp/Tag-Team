<p align="center">
  <img src="assets/logo.png" alt="Tag-Team logo" width="160">
</p>

<h1 align="center">Tag-Team</h1>

<p align="center">
  <b>Let Claude Code, Codex and Antigravity work together.</b><br>
  Ask each other questions, delegate work, review each other's code, and make images with a built-in art critic.
</p>

<p align="center">
  <a href="https://github.com/AeroUp/Tag-Team/actions"><img src="https://github.com/AeroUp/Tag-Team/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero dependencies">
  <img src="https://img.shields.io/badge/node-%3E%3D20-blue" alt="node >= 20">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

---

You probably pay for more than one AI coding agent. Tag-Team connects them. It's a small MCP server, plus skills, that you install into **Claude Code, Codex and Antigravity** (the IDE and the `agy` CLI). Once installed, any of them can call the others:

> **You (in Claude Code):** have codex review my uncommitted changes, and ask antigravity whether this migration is safe
>
> **You (in Codex):** get claude's opinion on this architecture before we build it
>
> **You (anywhere):** make a logo for my app and have claude critique it until it's good

Tag-Team runs the other agents' own CLIs headless, on **your existing logins and subscriptions**. You don't need API keys. The only exception is the optional Gemini API image engine.

## Features

| | |
|---|---|
| 🤝 **Ask & delegate** | One agent asks another for an answer, a second opinion, or a delegated task. It can keep the same conversation going across calls. |
| 🏛️ **Council** | Several agents get the same question in parallel, and you compare their answers side by side. |
| 🔍 **Cross-AI code review** | Codex, Claude and Antigravity review the same diff independently. Findings are merged, and issues flagged by more than one reviewer come first. |
| 🎨 **Image studio** | Codex (built-in `image_gen`) or Antigravity draws, with no API key needed. The Gemini API (Nano Banana) is an optional third engine. Claude, Antigravity or Codex critiques and scores the result. Then it redraws with the fixes, until the image hits your target score. |
| 📊 **Who's available?** | Shows which agents are installed and which are rate-limited, with reset times and Codex's exact usage %. |
| ⏳ **Background jobs** | Long work runs detached. Any agent can check on any job. |

> **Out of usage mid-task?** That's the companion project **[Relay](https://github.com/AeroUp/Relay)**. When your agent hits its limit, another one takes over, and the first wakes up to finish when its limit resets. Tag-Team and Relay share the same core and know about each other's rate limits.

## Install

### Easiest: let your AI agent do it

Paste this into Claude Code, Codex or Antigravity:

```
Set up Tag-Team for me by following https://raw.githubusercontent.com/AeroUp/Tag-Team/main/AGENT_SETUP.md
```

The agent checks the prerequisites, installs Tag-Team, verifies it, and tells you what changed. It follows [AGENT_SETUP.md](AGENT_SETUP.md).

### Manual

You need **Node.js 20+** and at least two of: [Claude Code](https://claude.com/claude-code), [Codex](https://github.com/openai/codex), [Antigravity](https://antigravity.google) (the `agy` CLI, which replaced Gemini CLI, or the IDE). Log in to each one once before installing.

```bash
git clone https://github.com/AeroUp/Tag-Team.git
cd Tag-Team
node bin/tagteam.mjs install
```

Then **restart your agents**. To check the setup:

```bash
node bin/tagteam.mjs doctor
```

<details>
<summary>What <code>install</code> changes</summary>

It backs up every file it touches to `*.bak-tagteam` first.

| Agent | MCP server | Skills |
|---|---|---|
| Claude Code | `claude mcp add-json -s user tagteam …` | `~/.claude/skills/` |
| Codex | a marked block in `~/.codex/config.toml` | `~/.agents/skills/` |
| Antigravity (IDE + `agy` CLI) | `mcpServers.tagteam` in `~/.gemini/config/mcp_config.json`, plus `mcp(tagteam/*)` allowed in `~/.gemini/antigravity-cli/settings.json` | `~/.gemini/config/skills/` |

The config points at the folder you installed from, so keep the clone where it is. If you move it, run `install` again. To install only some agents, use `--only claude,codex`.
</details>

## Use it

Just ask your agent in plain words, or use the skills:

| Skill | For |
|---|---|
| `/tagteam` | Ask, delegate to, or compare other agents |
| `/tagteam-review` | Multi-AI code review, with findings verified before fixing |
| `/tagteam-studio` | Generate → critique → refine images |

### MCP tools

| Tool | What it does |
|---|---|
| `agents` | Who is installed or limited, Codex usage %, recent jobs |
| `ask` | Prompt one agent (`claude` / `codex` / `antigravity` / `auto`). Supports `access` read/write/full, `session_id`, `images`, `fallback` |
| `council` | Send the same prompt to several agents in parallel |
| `review` | Review `uncommitted` / `staged` / `branch` / `last_commit` / `files`, with merged findings |
| `imagine` | Generate images with `codex`, `antigravity` or `gemini` (API) |
| `critique` | Get scores and fixes from several AI critics |
| `studio` | Run the generate → critique → regenerate loop |
| `job` | Check, wait for, or cancel background jobs |

Slow tools accept `background: true` and return a job id right away.

### CLI

```bash
tagteam ask codex "why is test_auth flaky? look at tests/auth" --cwd .
tagteam council "Postgres or SQLite for this app? see docs/requirements.md"
tagteam review --scope branch --base main --focus "error handling"
tagteam imagine "isometric pixel-art coffee shop, warm light" --engine codex --count 2
tagteam critique tagteam-images/coffee-1.png --brief "isometric pixel-art coffee shop"
tagteam studio "app icon: paper plane made of circuit traces, flat" --rounds 3 --target 8.5
tagteam jobs | tagteam job <id> --wait 300 | tagteam logs <id> -f
```

`tagteam` means `node bin/tagteam.mjs`. To get a real `tagteam` command, either run `npm link` inside the clone, or install with `npm i -g github:AeroUp/Tag-Team` and then run `tagteam install`.

### Image engines

- **`codex`** uses Codex's built-in `image_gen` on your ChatGPT plan.
- **`antigravity`** asks the `agy` agent to draw with its built-in image tool.
- **`gemini`** calls the Gemini API directly. It needs a free key from [Google AI Studio](https://aistudio.google.com/apikey). The key also lets the Antigravity critic work when `agy` isn't installed. Provide it in any of these ways:
- set `GEMINI_API_KEY`
- put `GEMINI_API_KEY=…` in `~/.gemini/.env`
- run `tagteam config set images.gemini_api_key "<key>"`

With a key, Tag-Team picks the newest Gemini image and vision models automatically.

## Configuration

`tagteam config set <key> <value>` writes to `~/.tagteam/config.json`.

| Key | Default | |
|---|---|---|
| `agents.<name>.path` | auto | Path to an agent CLI, if auto-detection misses it |
| `agents.<name>.model` | CLI default | Model to use for that agent |
| `images.engine` | `auto` | `codex`, `antigravity`, `gemini` or `auto` (tries them in that order) |
| `images.critics` | `["claude","antigravity","codex"]` | Default critics |
| `max_depth` | `2` | How deep agents may call agents (A → B → C) |
| `max_concurrent` | `6` | Max agent processes at once (shared with Relay) |
| `default_timeout_sec` | `1200` | Per agent call |

## How it works

- Each agent runs through its own CLI in headless mode:
  - **Claude:** `claude -p --output-format stream-json`
  - **Codex:** `codex exec --json`
  - **Antigravity:** `agy -p --output-format stream-json`
- Prompts go in through stdin (Antigravity: through `-p`), and Tag-Team parses the output stream. Your agents use their own logins, models and settings.
- **Access levels.**
  - `read` (the default): Claude only gets read tools, Codex runs `-s read-only`, Antigravity runs `--mode plan --sandbox`.
  - `write`: lets the agent edit files in `cwd`.
  - `full`: removes sandboxes and permission checks. Use it only when you mean it.
- **Recursion guard.** Every child agent inherits `AI_AGENT_DEPTH`. Once it passes `max_depth`, no more agents can be started, so agents can't ping-pong forever.
- **Shared state** lives in `~/.agent-state/`: rate limits, concurrency slots and the Codex sandbox mode. Tag-Team and Relay both use it.
- **Codex rate limits** come from Codex's own session logs: the exact used % and reset time.
- The MCP server is ~100 lines of dependency-free JSON-RPC (`src/core/mcp-server.mjs`).

## Troubleshooting

- **The tools don't show up.** Restart the agent after installing. In Claude Code, run `claude mcp list` and look for `tagteam ✔ Connected`.
- **Codex says "MCP tool call requires approval".** Run `install` again. It sets `default_tools_approval_mode = "approve"` for this server only.
- **Codex on Windows: "setup refresh had errors".** Codex's elevated sandbox sometimes can't initialise outside its desktop app. Tag-Team detects this and switches Codex to its unelevated sandbox, which is still sandboxed. The choice is stored in `~/.agent-state/codex.json`.
- **Antigravity's MCP tools ask for approval.** `install` allows `mcp(tagteam/*)` in `~/.gemini/antigravity-cli/settings.json`, so headless `agy` runs can use them.
- **Skills don't show up in Antigravity.** Different Antigravity versions look in different folders. Copy `skills/*` into the skills folder your version uses, and please open an issue.
- **An agent isn't found.** Run `tagteam config set agents.codex.path "C:/path/to/codex.exe"`. The same works for `agents.antigravity.path`.

## Uninstall

```bash
node bin/tagteam.mjs uninstall
```

This removes the MCP entries and skills. Your data in `~/.tagteam` is kept.

## Status

`0.1.0` is an early release.
- Tested with **Claude Code** and **Codex** on Windows.
- **Antigravity** support (the `agy` CLI and the IDE) follows the official docs but hasn't been battle-tested yet. Bug reports welcome. `gemini` is still accepted as an alias for `antigravity`.

Not affiliated with Anthropic, OpenAI or Google. Product names are trademarks of their owners.

## License

[MIT](LICENSE). Contributions welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
