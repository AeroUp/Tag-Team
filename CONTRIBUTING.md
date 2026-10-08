# Contributing to Tag-Team

Thanks for helping! Tag-Team is plain Node.js (20+) with **zero dependencies**, and we want to keep it that way.

## Setup

```bash
git clone https://github.com/AeroUp/Tag-Team.git
cd Tag-Team
npm test                      # offline self-test, spends no AI usage
node bin/tagteam.mjs doctor   # what it can see on your machine
```

To try your changes in your agents, run `node bin/tagteam.mjs install` from your clone. The MCP config points at whatever folder you install from.

## Layout

```
bin/tagteam.mjs      CLI entry point (also `mcp` and the `_job` background runner)
src/app.mjs          Tag-Team's identity and default config
src/ops.mjs          ask / council / review / status
src/images.mjs       imagine / critique / studio
src/tools.mjs        MCP tool definitions and output formatting
src/install.mjs      wiring into Claude Code, Codex, Gemini CLI, Antigravity
src/core/            shared with Relay (see below)
skills/              Agent Skills (SKILL.md) installed into each agent
test/selftest.mjs    offline tests
```

## The shared core

`src/core/` is **byte-identical** in Tag-Team and [Relay](https://github.com/AeroUp/Relay). It holds the agent adapters, usage-limit parsing, the job system, the MCP protocol layer and the installer kit. If you change it here, open the same change on Relay too, or mention it in your PR and we'll port it. Anything app-specific belongs outside `src/core/`.

## Guidelines

- No runtime dependencies, no build step.
- Keep it working on Windows, macOS and Linux. CI runs all three.
- Agent CLIs change often. When you touch an adapter in `src/core/agents.mjs`, say which CLI version you tested against.
- New usage-limit message formats are very welcome. Add a test case to `test/selftest.mjs`.
- Never send anything to a network service other than the agent CLIs themselves, or Google's Gemini API when the user has set a key.
