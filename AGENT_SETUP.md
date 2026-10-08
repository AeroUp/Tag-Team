# Tag-Team setup guide for AI agents

> **For the human:** paste this into Claude Code, Codex or Antigravity:
>
> ```
> Set up Tag-Team for me by following https://raw.githubusercontent.com/AeroUp/Tag-Team/main/AGENT_SETUP.md
> ```

**For the AI agent reading this:** the user wants Tag-Team installed on this machine. Tag-Team is an MCP server plus skills that let Claude Code, Codex and Antigravity call each other, review each other's code, and generate or critique images. Follow the steps below in order, run the commands yourself, and keep the user informed in plain language. Each step says what to check before moving on.

## Ground rules

- Install for the current user only. Never use `sudo` or admin rights, and never change system settings.
- Don't edit agent config files by hand. `install` does it, makes a backup first (`*.bak-tagteam`), and only touches the `tagteam` entries.
- Never ask the user to paste API keys or passwords into the chat. The optional Gemini API key (step 6) is something the user sets themselves.
- If a step fails, show the user the exact error, try the fix listed for it, and stop if it still fails. Don't improvise risky workarounds.

## 1. Check prerequisites

```bash
node --version
git --version
```

- **Node:** must be v20 or newer. If it's missing or older, tell the user to install the LTS from https://nodejs.org, then stop.
- **git:** optional. Without it, use the zip download in step 2.

Tag-Team needs at least **two** of these agents installed and signed in. Don't worry if they aren't on PATH; Tag-Team also finds them in their default install locations.

| Agent | How to check | If it's missing |
|---|---|---|
| Claude Code | `claude --version` | https://claude.com/claude-code |
| Codex | `codex --version`, or the Codex desktop app is installed | `npm i -g @openai/codex`, or the desktop app |
| Antigravity CLI | `agy --version` | Windows: `irm https://antigravity.google/cli/install.ps1 \| iex`. macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |

Each agent must have been opened once and signed in. Signing in is the user's job; you can't do it for them.

## 2. Get the code into a permanent folder

The installed config points at this folder, so **don't use a temp folder**. Use the location the user asks for. Otherwise, use `<home>/tools/Tag-Team`.

```bash
git clone https://github.com/AeroUp/Tag-Team.git ~/tools/Tag-Team
```

- **Already cloned?** Run `git -C ~/tools/Tag-Team pull` instead.
- **No git?** Download https://github.com/AeroUp/Tag-Team/archive/refs/heads/main.zip, unzip it, and rename the folder to `Tag-Team`.

## 3. Run the offline self-test

This step makes no AI calls and uses no quota.

```bash
node ~/tools/Tag-Team/bin/tagteam.mjs selftest
```

Every line should start with ✔. If any line starts with ✖, stop and show the user the output.

## 4. Install

```bash
node ~/tools/Tag-Team/bin/tagteam.mjs install
```

This does three things for each agent it finds:
- registers the `tagteam` MCP server;
- copies the skills `tagteam`, `tagteam-review` and `tagteam-studio`;
- in Codex and Antigravity, pre-approves the Tag-Team tools so headless runs aren't blocked.

To limit it to specific agents, add `--only claude,codex,antigravity`.

## 5. Verify

```bash
node ~/tools/Tag-Team/bin/tagteam.mjs doctor --json
```

Check two things in the output:
- `wired_into` lists the agents the user has.
- In `agents`, at least two entries have `"installed": true`.

If Claude Code is one of them, `claude mcp list` should show `tagteam … ✔ Connected`.

**Optional live test** (spends a tiny amount of quota): `node ~/tools/Tag-Team/bin/tagteam.mjs ask codex "Reply with just: pong" --cwd ~/tools/Tag-Team`. Run it with any installed agent other than yourself.

## 6. Optional: Gemini API image engine

Codex and Antigravity can already generate images without a key. If the user also wants the direct Gemini API engine:
1. They create a free key at https://aistudio.google.com/apikey.
2. They set it themselves in one of these ways:
   - set the `GEMINI_API_KEY` environment variable;
   - add `GEMINI_API_KEY=…` to `~/.gemini/.env`;
   - run `node ~/tools/Tag-Team/bin/tagteam.mjs config set images.gemini_api_key "<key>"`.

Don't handle the key yourself.

## 7. Tell the user

Summarize in a few lines:
- which agents Tag-Team is wired into;
- that they must **restart** those agents (or start a new session) to load it;
- how to use it, e.g. "have codex review my changes", "ask antigravity whether this approach is right", "make a logo and have claude critique it", or the `/tagteam` skills;
- where it lives, and that moving the folder means re-running `install`;
- how to remove it: `node ~/tools/Tag-Team/bin/tagteam.mjs uninstall`.

If the user wants their agents to keep working when they hit a usage limit, offer to set up the companion project **Relay** too. Its guide is at https://raw.githubusercontent.com/AeroUp/Relay/main/AGENT_SETUP.md.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `doctor` shows an agent as "not installed" but it is | `node bin/tagteam.mjs config set agents.<claude\|codex\|antigravity>.path "<full path to the exe>"`, then run `install` again |
| Claude Code: `claude mcp add-json` failed | Make sure `claude` runs in a terminal, then run `install --only claude` again |
| Codex on Windows: "setup refresh had errors" | Nothing to do. Tag-Team switches Codex to its unelevated sandbox automatically on first use |
| Antigravity skills don't appear | Different versions read skills from different folders. Copy `skills/*` into the folder the user's version uses, e.g. `~/.gemini/config/skills/` |
| Tools don't show up after installing | The agent wasn't restarted. Start a new session |
