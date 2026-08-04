# DemoDay Claude Plugin

Turns a codebase into a finished demo video. Claude reads your repo to learn what the
software does, agrees a plan with you, **drives the app on screen** while telling you
what it's exercising, generates the voiceover and an optional on-camera presenter via
fal.ai, and renders the whole timeline — intro, transitions, captions, callouts — into
one MP4 with Remotion.

```
/demoday:create-demo-video
```

macOS only. Capture works against web apps (Playwright), native desktop apps
(real screen recording plus synthetic input), and CLI/terminal programs — a
staged Terminal.app window running the real program (including a live `claude`
session for demoing Claude Code plugins), recorded at natural speed and retimed
to the narration. The iOS simulator target is declared in the manifest schema
but not implemented yet.

---

## Setup

### 1. Your fal.ai API key

Everything generated — voice, presenter, b-roll — goes through [fal.ai](https://fal.ai/dashboard/keys),
so a key is required. **Recommended: put it in the macOS Keychain.**

Run this **in your own terminal**, not through Claude:

```bash
security add-generic-password -s demoday -a FAL_API_KEY -w
```

`-w` with no value makes `security` prompt for the key without echoing it. Nothing
is written in plaintext, nothing lands in your shell history, and — because you ran
it yourself rather than asking Claude to — the key never enters a session transcript
or gets sent to a model.

Optionally, the same way, for b-roll reference image search:

```bash
security add-generic-password -s demoday -a BRAVE_API_KEY -w
```

And optionally, for **custom character voices** — describe a voice in prose
("weathered New England lobster-boat captain, thick coastal accent") and the
whole demo is narrated in it. Uses [ElevenLabs Voice Design](https://elevenlabs.io/app/settings/api-keys)
directly, so it needs its own key:

```bash
security add-generic-password -s demoday -a ELEVENLABS_API_KEY -w
```

**This needs a paid ElevenLabs plan** (Starter and up) — the free tier cannot
create or use voices through the API, only in the web app. A paid plan also
carries the commercial license you need anyway to publish a demo video.

Designed voices are saved to your ElevenLabs account, where custom-voice slots
are limited by subscription tier. The plugin reuses a voice when you give the
same description twice, and `node scripts/gen/voice-design.mjs --list` /
`--delete <voice_id>` shows and frees slots.

Confirm it took:

```bash
node scripts/doctor.mjs
#   OK    FAL_API_KEY   set (from keychain)
```

macOS may ask for permission the first time a script reads the item. Choose
**Always Allow** and you won't see it again.

#### Other places the key can live

Resolved in this order; the first hit wins.

| # | Source | Survives a plugin update? |
| :-: | --- | --- |
| 1 | `FAL_API_KEY` in the environment | yes |
| 2 | macOS Keychain (above) | yes |
| 3 | `~/.config/demoday/config.json` | yes |
| 4 | `.env` beside this README | **no** |

Source 1 also covers an `env` block in `~/.claude/settings.json`, which is the
portable option if you're not on macOS or don't want to use the Keychain:

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

**Source 4 is for developing this plugin, not for using it.** An installed plugin
lives in a version-pinned directory:

```
~/.claude/plugins/cache/<marketplace>/demoday/0.1.0/
```

Publishing `0.2.0` creates a *new* directory beside it, so a `.env` you wrote into
the old tree is orphaned and your key appears to vanish. `doctor.mjs` prints which
source a key came from and flags this case specifically, rather than showing a green
row that will break on the next update.

Nothing in this plugin ever *writes* a secret — scripts only read. Writing would mean
the key travelling through a tool call and into the transcript, which is exactly what
the Keychain command above avoids.

### 2. Everything else

```bash
npm install
npx playwright install chromium
brew install ffmpeg cliclick
node scripts/doctor.mjs          # every required row should say OK
```

`doctor.mjs` is the single source of truth for whether the machine is ready. Run it
with `--target web` or `--target mac` to check only what one capture backend needs.

### 3. macOS permissions (desktop capture only)

Recording a native app needs two permissions granted to **the terminal app you run
Claude Code from** (iTerm, Terminal, VS Code — whichever it is):

- **Screen Recording** — System Settings → Privacy & Security → Screen Recording
- **Accessibility** — System Settings → Privacy & Security → Accessibility

Quit and reopen the terminal afterwards; macOS only re-reads these at launch.
`node scripts/doctor.mjs --target mac` probes both and prints the exact path if
either is missing. Web capture needs neither.

---

## How it works

The central idea is **two passes**, because recording a model while it explores an app
produces jerky footage full of dead air.

1. **Rehearsal** — Claude drives the app through the MCP server (screenshot → decide →
   act → screenshot), working out what actually works. Nothing is recorded. The output
   is an action script with verified selectors and coordinates.
2. **Performance** — a deterministic runner replays that script with eased cursor
   motion and human typing cadence, *while* recording. No model in the loop, so the
   footage is smooth and repeatable.

Narration is generated **first**, from one voice, so every scene's duration is known
before anything is captured. The performance runner is then paced to land on the
voiceover, and the on-camera presenter is animated to that same audio — so the
narrator and the person on screen are audibly the same. `scripts/lib/pacing.mjs` owns
the timing invariant that keeps one line from starting underneath the last one.

## Layout

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

A project's state lives in `demo.json` — the timeline, artifact paths and durations.
Every script reads and writes it, so a run can be resumed or partially regenerated.
Generated artifacts are content-addressed in `.cache.json`, so changing one line of
narration re-synthesises that line and nothing else.

## Cost

Roughly **$1–2 in fal credits** for a 30-second demo, dominated by presenter video
generation. `node scripts/plan.mjs` prices a timeline before anything is spent, and
`scripts/selftest.mjs` exercises the entire render path for free.

## Licence note

Remotion is free for individuals and small companies but requires a paid company
licence above a headcount threshold. See [remotion.dev/license](https://remotion.dev/license).
