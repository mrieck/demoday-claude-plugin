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
mcp/server.mjs        stateful rehearsal session (browser + screen)
scripts/
  doctor.mjs          environment preflight
  selftest.mjs        full render from ffmpeg test patterns — zero API spend
  lib/                manifest, cache, pacing, fal, ffmpeg, macOS helpers
  capture/            web + macOS backends, deterministic replay
  gen/                tts, presenter, b-roll
  render/             props builder, Remotion driver
remotion-template/    copied into your project on first render
skills/               orchestration, capture, script and assembly craft
```

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
~/.claude/plugins/cache/<marketplace>/demoday/0.1.0/
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
