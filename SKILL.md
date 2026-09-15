---
name: demoday
description: >-
  Make a finished demo video of a piece of software: drive the app on screen
  (web, macOS desktop or terminal) while narrating what it does, generate an AI
  voiceover and optional on-camera presenter, and render a polished MP4 with
  Remotion — or cut a vertical 9:16 Short (YouTube Shorts, Reels, TikTok) from
  one. Use when the user asks to "make a demo video", "record a demo", "create a
  product video", "make a walkthrough", "show off this app", or asks for a
  "short", "reel", "TikTok" or "vertical video" of their software. macOS only.
license: MIT
compatibility: macOS, Node 20+, ffmpeg. Works with any agent that can run shell commands; MCP client optional.
metadata:
  author: Mark Rieck
  homepage: https://github.com/mrieck/demoday-claude-plugin
---

# DemoDay

You are about to produce a **finished demo video** of someone's software — narrated,
paced, with an intro, transitions and a point — not a screen recording. This
folder is the whole toolkit: scripts, a rehearsal server, a Remotion template and
the five craft guides below. Nothing lives outside it.

## Where things are

`$CLAUDE_PLUGIN_ROOT` in the guides means **this folder** — the directory that
holds this `SKILL.md`. In Claude Code the plugin sets that variable; installed
through `npx skills` it is `~/.agents/skills/demoday` (or the project's
`.agents/skills/demoday`); as a Codex plugin it is the plugin's install
directory. Every `node scripts/...` command in the guides runs from here, e.g.

```bash
cd ~/.agents/skills/demoday && node scripts/doctor.mjs
```

The video **project** is separate: it lives under the demoed repo at
`<repo>/demo/<slug>/` and is passed as `--project demo/<slug>` to every script.

## First run — do this before anything else

```bash
node scripts/doctor.mjs --install        # installs node packages + Chromium, then checks the machine
```

`doctor` prints one line per requirement with the exact fix command. The two
things it cannot do for the user: a **FAL_API_KEY** (fal.ai — narration,
presenter, b-roll; store it in the macOS Keychain as printed), and, for desktop
or terminal demos, the **Screen Recording** and **Accessibility** permissions,
which the user grants to the terminal app and then restarts it. Stop and tell
the user exactly what to do when either is missing; never fake a capture.

## The rehearsal tools

Capture is two passes: **rehearse** (you drive the app, screenshot after every
action, nothing recorded) and **perform** (a runner replays the rehearsed steps
smoothly while recording). The rehearsal tools are `demo_open`, `demo_open_app`,
`demo_open_cli`, `demo_inspect`, `demo_click`, `demo_type`, `demo_key`,
`demo_scroll`, `demo_highlight`, `demo_wait_stable`, `demo_screenshot`,
`demo_undo_step`, `demo_review_script`, `demo_save_actions`,
`demo_load_actions`, `demo_close`.

Three ways to reach them, pick the first that applies:

1. **They are already in your tool list** (Claude Code plugin, Codex plugin) —
   call them directly.
2. **Your agent supports MCP servers** — register `mcp/server.mjs` as a stdio
   server once and the tools appear. Any client config takes the same shape:
   ```json
   { "mcpServers": { "demo-stage": { "command": "node", "args": ["<this folder>/mcp/server.mjs"] } } }
   ```
   (Codex: `codex mcp add demo-stage -- node <this folder>/mcp/server.mjs`;
   Cursor: `.cursor/mcp.json`; Gemini CLI: `~/.gemini/settings.json`; VS Code /
   Copilot: `.vscode/mcp.json`.) Raise the client's tool timeout if it has one —
   `demo_wait_stable` can legitimately take a couple of minutes.
3. **Shell only** — `scripts/stage.mjs` is the same server driven from the
   command line. The first call starts it in the background; each later call is
   one tool invocation against the live session, so the browser and the action
   script persist between commands:
   ```bash
   node scripts/stage.mjs tools                                     # every tool and its flags
   node scripts/stage.mjs open --url http://localhost:3000 --id feature-1
   node scripts/stage.mjs inspect --filter save
   node scripts/stage.mjs click --selectors '[data-testid=save]' --label "Save"
   node scripts/stage.mjs save_actions --file demo/<slug>/actions/feature-1.json
   node scripts/stage.mjs stop                                      # close + end the daemon
   ```
   Tool names drop the `demo_` prefix. Screenshots are written as PNG files and
   the path is printed as `screenshot: …` — **open that image** after each step;
   deciding from the text alone is guessing. Desktop clicks take `--x --y` read
   off the most recent screenshot, exactly as with the MCP tool.

Everywhere the guides say `demo_<name>`, read `node scripts/stage.mjs <name>` if
you are on path 3.

## The workflow — read this next

Open and follow **`skills/demo-video/SKILL.md`** in this folder. It is the
end-to-end recipe (recon → direction → script → narration → rehearse → perform →
presenter/b-roll → render → QA) and it tells you when to read the others:

| guide | read it when |
|---|---|
| `skills/demo-video/SKILL.md` | always — the orchestration and the rules |
| `skills/demo-script/SKILL.md` | writing narration and the `demo.json` manifest |
| `skills/demo-capture/SKILL.md` | staging a window, selectors, desktop coordinates, terminal demos, the action-script format |
| `skills/demo-assembly/SKILL.md` | rendering, transitions, captions, zoom, audio, the dynamic style's moving presenter frame, or a render that came out wrong |
| `skills/demo-shorts/SKILL.md` | a 9:16 Short — listicle, cohost, flashcard or glide |

Where a guide says to use `AskUserQuestion`, ask the user in whatever way your
agent asks questions; the answers (style, goal, length, presenter mode) change
the whole video, so do not skip them.

## Rules that never bend

- **Show the cost estimate (`node scripts/plan.mjs --project demo/<slug>`) and get
  an explicit yes before generating anything.** Narration, presenter and b-roll
  bill per second.
- **Narration before capture.** Durations drive the pacing of every scene.
- **Rehearse, then perform. Never record yourself exploring.**
- **Everything goes in `demo.json`.** State that only exists in your context is
  lost on the next run.
- **Look at the frames** during QA (`node scripts/qa.mjs`). There is no automatic
  grader.
- **Report what actually happened.** A failed scene is reported, not hidden.
