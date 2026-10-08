---
name: tagteam-studio
description: AI image studio across agents. Generate images with Codex (built-in image_gen, no API key) or Gemini (Nano Banana), have Claude/Gemini/Codex critique them, and auto-iterate generate → critique → refine until they score well. Use when the user wants an image, icon, illustration, mockup, hero/banner, sprite, texture or concept art, wants images critiqued or improved, or says "make an image", "generate art", "have gemini/codex draw", "critique this image".
---

# Tag-Team studio: generate, critique, refine

## Tools

- **`imagine`** generates image(s) and returns the file paths.
  - `engine: "codex"` uses Codex's built-in `image_gen` on the user's ChatGPT plan. No API key needed.
  - `engine: "gemini"` uses Gemini's newest image model, auto-detected. It needs a Gemini API key.
  - `engine: "auto"` (default) tries Codex first, then Gemini.
  - Other options: `count` (1–4 variants), `aspect_ratio` (e.g. `16:9`), `reference_images` (style refs or an image to edit), `out_dir` (default `tagteam-images/`), `name`.
- **`critique`** has the critics (Claude, Gemini, Codex) score each image 0–10 against your `brief`. Each critic returns strengths, issues with fixes, and a rewritten prompt.
- **`studio`** runs the full loop: generate, have every critic score it, then regenerate using the fixes, with the last image as a reference. It stops at `target_score` (default 8) or after `rounds` (default 2, max 5), keeps every round, and copies the winner to `<name>-best.<ext>`. It runs in the background, so collect the result with `job` and `wait_sec: 600`.

## Write a strong brief

Write a strong brief, because it is what both the generator and the critics work from:

```
Use: website hero, 16:9, dark UI around it
Subject: <what, doing what>
Style/medium: <photo / flat vector / 3D render / watercolor …>
Composition: <framing, focal point, negative space for text>
Lighting & palette: <…>
Exact text (if any): "…"
Avoid: <watermarks, extra fingers, clutter …>
```

## Workflow

1. Turn the user's request into a brief, using the template above.
2. Pick a path:
   - **Quick ask**: call `imagine`, then look at the result. In Claude Code, open the file with Read. Show the user the path.
   - **Quality matters** (logos, heroes, anything shipped): call `studio` with 2–3 rounds and the critics you trust. Different families catch different flaws: Gemini is sharp on visual detail and text rendering, Claude on brief fidelity and composition.
   - **The user already has an image**: call `critique` on it, then `imagine` with `reference_images: [it]` and the fixes.
3. Look at the final image yourself before calling it done. Critics can miss things, and garbled text is the most common one.
4. Report: the final path, the score history, and what changed between rounds. Copy the chosen file into the project's asset folder if it's for the project. Never overwrite an existing asset; save a `-v2` copy instead.

## Setup notes

- Gemini images need a key from https://aistudio.google.com/apikey. Set it in any of these ways:
  - set `GEMINI_API_KEY`
  - put `GEMINI_API_KEY=…` in `~/.gemini/.env`
  - run `{{CLI}} config set images.gemini_api_key "<key>"`
- Antigravity has its own image generator. From Antigravity, generate there, then call `critique` with the saved file.
- CLI: `{{CLI}} studio "brief…" --rounds 3 --critics claude,gemini --cwd <dir>`.
