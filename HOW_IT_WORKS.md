# How DemoDay works

The technical companion to the [README](README.md). Nothing here is needed to
*use* the plugin — `/demoday:create-demo-video` walks you through everything —
but this is the place if you want to know what's actually happening, tune a
setup, or hack on DemoDay itself.

## The two-pass design

The central idea is **two passes**, because recording a model while it explores
an app produces jerky footage full of dead air.

1. **Rehearsal** — Claude drives the app through the MCP server (screenshot →
   decide → act → screenshot), working out what actually works. Nothing is
   recorded. The output is an action script with verified selectors and
   coordinates.
2. **Performance** — a deterministic runner replays that script with eased
   cursor motion and human typing cadence, *while* recording. No model in the
   loop, so the footage is smooth and repeatable.

Narration is generated **first**, from one voice, so every scene's duration is
known before anything is captured. The performance runner is then paced to land
on the voiceover, and the on-camera presenter is animated to that same audio —
so the narrator and the person on screen are audibly the same.
`scripts/lib/pacing.mjs` owns the timing invariant that keeps one line from
starting underneath the last one.

## Capture targets

- **Web** — Playwright-driven Chromium with a synthetic cursor overlay.
- **macOS desktop** — real screen recording plus synthetic input (`cliclick`).
  Needs the Screen Recording and Accessibility permissions described below.
- **CLI / terminal** — a staged Terminal.app window running the real program
  (including a live `claude` session for demoing Claude Code plugins), recorded
  at natural speed and retimed to the narration.
- **iOS simulator** — declared in the manifest schema but not implemented yet.

## Project state: `demo.json` and the cache

A project's state lives in `demo.json` — the timeline, artifact paths and
durations. Every script reads and writes it, so a run can be resumed or
partially regenerated. Generated artifacts are content-addressed in
`.cache.json`, so changing one line of narration re-synthesises that line and
nothing else.

`node scripts/plan.mjs` prices a timeline before anything is spent, and
`scripts/selftest.mjs` exercises the entire render path from ffmpeg test
patterns — zero API spend.

## Repository layout

```
mcp/server.mjs        stateful rehearsal session (browser + screen); --socket = daemon mode
mcp/socket-transport.mjs   Unix-socket transport behind scripts/stage.mjs
scripts/
  doctor.mjs          environment preflight (--install fixes packages + Chromium)
  stage.mjs           the demo_* tools from the shell, for agents without MCP
  selftest.mjs        full render from ffmpeg test patterns — zero API spend
  lib/                manifest, cache, pacing, fal, ffmpeg, macOS helpers
  capture/            web + macOS backends, deterministic replay
  gen/                tts, presenter, b-roll
  render/             props builder, Remotion driver
remotion-template/    copied into your project on first render
skills/               orchestration, capture, script and assembly craft
SKILL.md              umbrella skill for `npx skills` installs (points at skills/)
.claude-plugin/       Claude Code manifest + marketplace; .mcp.json beside it
.codex-plugin/        Codex manifest + its own mcp.json; .agents/plugins/ = Codex marketplace
```

## One repo, three front doors

The same checkout is a Claude Code plugin, a Codex plugin and an agent skill.
Nothing is duplicated; each host just reads a different manifest.

| host | reads | how it reaches the rehearsal tools |
| --- | --- | --- |
| Claude Code | `.claude-plugin/plugin.json`, `.mcp.json`, `commands/`, `skills/` | `.mcp.json` starts `mcp/server.mjs` with `${CLAUDE_PLUGIN_ROOT}` |
| Codex | `.codex-plugin/plugin.json` → `skills/` + `.codex-plugin/mcp.json` | Codex has no `${CLAUDE_PLUGIN_ROOT}`; its MCP config uses `"cwd": "."`, which Codex resolves to the installed plugin root, and a plugin-relative `args` path |
| `npx skills` (Cursor, Copilot, Gemini CLI, OpenCode, …) | the root `SKILL.md` | a root `SKILL.md` makes the *whole folder* the skill, so the installer copies scripts, server and template together and offers exactly one skill. The skill says: register `mcp/server.mjs` if the agent speaks MCP, otherwise use `scripts/stage.mjs` |

`scripts/stage.mjs` is the piece that makes the last row possible. Rehearsal
is stateful — one browser or staged window across many turns — which is why it
is an MCP server and not a pile of CLI scripts. `stage.mjs` keeps that property
without an MCP client: its first call starts `mcp/server.mjs --socket <path>`
as a detached daemon, and every call after that opens the Unix socket, sends
the same newline-delimited JSON-RPC a stdio client would (`initialize`,
`tools/call`), prints the text result and writes any screenshot to a PNG whose
path it prints. The daemon exits by itself after 30 idle minutes, and
`stage.mjs stop` closes the session (restoring the desktop) and ends it. Tool
arguments are coerced against the tool's own JSON schema, so `--dwellMs 300`
is a number and repeated `--selectors` become a ladder.

The MCP server does **not** install its own dependencies on startup: hosts give
a server a few seconds to come up (Codex's default is 10 s), and an `npm
install` inside that window would be killed half way. `doctor.mjs --install`
does it instead, and the skills run that first.

## Environment preflight: `doctor.mjs`

`node scripts/doctor.mjs` is the single source of truth for whether the machine
is ready — it checks keys, Node dependencies, Chromium, ffmpeg, `cliclick` and
macOS permissions, and prints exactly what to install or grant for anything
missing. Run it with `--target web` or `--target mac` to check only what one
capture backend needs. The `/demoday:create-demo-video` command runs it
automatically before doing anything else, which is why users never install
dependencies by hand.

## Where API keys can live

Resolved in this order; the first hit wins.

| # | Source | Survives a plugin update? |
| :-: | --- | --- |
| 1 | `FAL_API_KEY` in the environment | yes |
| 2 | macOS Keychain (`security add-generic-password -s demoday -a FAL_API_KEY -w`) | yes |
| 3 | `~/.config/demoday/config.json` | yes |
| 4 | `.env` beside this file | **no** |

The Keychain is the recommended home: the `-w` prompt means the key is never
echoed, never lands in shell history, and — because you run the command yourself
rather than asking Claude to — never enters a session transcript. macOS may ask
for permission the first time a script reads the item; choose **Always Allow**
and you won't see it again.

Source 1 also covers an `env` block in `~/.claude/settings.json`, the portable
option if you're not on macOS or don't want to use the Keychain:

```json
{
  "env": {
    "FAL_API_KEY": "your-key-here"
  }
}
```

Source 3 is the same idea as a dotfile, just outside the plugin:

```json
{ "FAL_API_KEY": "your-key-here", "BRAVE_API_KEY": "", "ELEVENLABS_API_KEY": "" }
```

**Source 4 is for developing this plugin, not for using it.** An installed
plugin lives in a version-pinned directory:

```
~/.claude/plugins/cache/<marketplace>/demoday/0.2.1/
```

Publishing `0.2.0` creates a *new* directory beside it, so a `.env` you wrote
into the old tree is orphaned and your key appears to vanish. `doctor.mjs`
prints which source a key came from and flags this case specifically, rather
than showing a green row that will break on the next update.

Nothing in this plugin ever *writes* a secret — scripts only read. Writing would
mean the key travelling through a tool call and into the transcript, which is
exactly what the Keychain flow avoids.

## What leaves the machine

The short version is in the README's
[What leaves your machine](README.md#-what-leaves-your-machine) section. In
pipeline terms: capture and rendering are entirely local (the `demo-stage` MCP
server makes no network calls), and only generation steps upload anything.
`scripts/lib/fal.mjs` uploads referenced local files (presenter image,
narration audio, b-roll and still-iteration frames) to fal storage —
content-addressed and cached by sha256 so the same file is never uploaded
twice — and narration text goes to the configured TTS provider (fal, or
api.elevenlabs.io directly). `scripts/qa.mjs` scans narration, typed text and
visible URLs for anything credential-shaped before you publish.

## ElevenLabs sound effects

With the same key, `scripts/gen/sfx.mjs` calls `POST /v1/sound-generation`
(`eleven_text_to_sound_v2`) to design a project's cue pack — ~200 credits
(≈$0.02) per take, three takes per cue, the first accepted and the rest kept
under `audio/sfx/previews/` for `--pick`. Each take is trimmed of leading
silence, faded and loudness-normalised (−16 LUFS) with ffmpeg so cues sit at
a predictable level under the voice. Takes are content-cached per project
(`.cache.json`, kind `sfx`) and accepted cues are copied to
`~/.config/demoday/sfx/` keyed by prompt + duration, so the default pack is
generated once per machine. Placement (`scripts/lib/sfx.mjs`) runs in
`build-props`, on the same absolute frame timeline as narration, so the
template only ever plays a flat `sfxTrack`.

## ElevenLabs voice management

Custom character voices use ElevenLabs Voice Design, which requires a paid plan
(Starter and up) — the free tier returns 403/402 for voice creation and library
voices over the API.

Designed voices are saved to your ElevenLabs account, where custom-voice slots
are limited by subscription tier. The plugin reuses a voice when you give the
same description twice, and

```bash
node scripts/gen/voice-design.mjs --list
node scripts/gen/voice-design.mjs --delete <voice_id>
```

shows and frees slots.

## macOS permissions in detail

Recording a native app needs two permissions granted to **the terminal app you
run Claude Code from** (iTerm, Terminal, VS Code — whichever it is):

- **Screen Recording** — System Settings → Privacy & Security → Screen Recording
- **Accessibility** — System Settings → Privacy & Security → Accessibility

Quit and reopen the terminal afterwards; macOS only re-reads these at launch.
`node scripts/doctor.mjs --target mac` probes both and prints the exact path if
either is missing. Web capture needs neither.

## Developing the plugin

Working from a clone rather than an installed copy:

```bash
npm install
npx playwright install chromium
brew install ffmpeg cliclick
node scripts/doctor.mjs          # every required row should say OK
node scripts/selftest.mjs        # full render pipeline, zero API spend
```

A `.env` beside this file works for keys during development (source 4 above).
