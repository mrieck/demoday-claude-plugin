---
name: demo-video
description: >-
  Make a demo video of a piece of software: drive the app on screen while
  narrating what it does, generate an AI voiceover and optional on-camera
  presenter, and assemble everything into a finished MP4. Use when the user asks
  to "make a demo video", "record a demo", "create a product video", "show off
  this app", "make a walkthrough video", or runs /create-demo-video. Handles web
  apps, dashboards, websites, macOS desktop apps, and CLI/terminal programs
  (including demos of Claude Code plugins).
---

# Making a demo video

You are producing a finished video of someone's software. Not a screen recording —
a *demo*: narrated, paced, with an intro, transitions and a point.

`$CLAUDE_PLUGIN_ROOT` is the plugin root. Every command below runs from there
unless stated. Each video is its own project directory under `<repo>/demo/`,
named with a short kebab-case description of *that video*:
`demo/project-overview/` for a generic overview, `demo/onboarding-flow/`,
`demo/v2-launch/`. A repo accumulates one subfolder per video. Pick the folder
name when you pick the slug (they should match) and pass it as `--project
demo/<slug>` on **every** script call — never bare `--project demo`, and never
rely on the default project dir. The examples below write `demo/<slug>`; always
substitute the real folder.

## The one thing to understand first

**Two passes. Never record yourself exploring.**

1. **Rehearsal** — you drive the app through the `demo_*` MCP tools, taking a
   screenshot after each action, working out what is worth showing. Nothing is
   recorded. The result is an action script.
2. **Performance** — a runner replays that script deterministically, with eased
   cursor motion and human typing, *while recording*. No model in the loop, so
   the footage is smooth and has no dead air.

A recording of you thinking is unwatchable. This is why the split exists.

## Order of operations

Narration is generated **before** any capture. Once a line is spoken you know
exactly how long it takes, so the capture can be paced to land on it. Doing it the
other way round produces rushed voiceover or silence at the end of every scene.

```
recon → direction → script → narration → rehearse → perform → presenter/b-roll → render → QA
```

---

## 1. Recon

Read the codebase you were pointed at. You need to be able to say what the product
*is*, who it is for, and what its two or three best moments are. Look at the
README, the routes or entrypoints, the data model, and any tests that read like
user journeys.

Then find out how to run it. Ask the user for the dev-server URL, or the app name
if it is a desktop app. Do not guess a port.

## 2. Direction — ask, don't assume

Use AskUserQuestion. The answers change the whole shape of the video:

- **Style — "which of these is it most like?"** Show the catalog and let the
  user pick; each name is a complete look with sensible defaults
  (`plan.mjs --init --style <name>` applies them):

  | style | aspect | feels like |
  |---|---|---|
  | `launch` | 16:9 | Classic product demo: presenter intro/outro, narrated capture, b-roll |
  | `anchor` | 16:9 | Avatar-led: the presenter is always on screen — full-frame between demos, corner bubble over them |
  | `tutorial` | 16:9 | Step-by-step walkthrough: the full workflow on screen, the presenter riding along as a corner bubble |
  | `explainer` | 16:9 | No face: motion-graphic cards + voiceover over demos |
  | `listicle` | 9:16 | "5 plugins that fix X" — numbered rundown, a cut every ~1.5s |
  | `cohost` | 9:16 | Screenshare: demo on top, person talking below throughout |
  | `flashcard` | 9:16 | No face: big text cards alternate with UI clips on fast cuts |
  | `glide` | 9:16 | One immersive capture, the camera gliding to each click |

  The 16:9 styles run on this skill directly (they are presenter-mode +
  transition presets). The 9:16 styles are Shorts — hand off to the
  **demo-shorts** skill for their recipes.

- **Goal and audience** — a launch trailer, an onboarding walkthrough, and an
  investor demo are different videos.
- **Length** — 30s, 60s, 2min. Default to 60s. (Shorts: 15–45s.)
- **Presenter mode** — see below; the style already picked a default.
- **Voice** — *only if doctor showed `ELEVENLABS_API_KEY` set*: offer a custom
  character voice designed from a prose description ("weathered New England
  lobster-boat captain, gravelly, thick coastal accent") — great for themed or
  parody demos. Otherwise use the fal.ai stock voice and do not mention this.
- **What to show** — offer your two or three candidate flows from recon.

### Presenter modes

| Mode | What it means | When |
|---|---|---|
| `hybrid` *(default)* | On-camera presenter for intro/outro/cutscenes; voiceover only over the screen | Almost always. A face over the UI is what amateur demos do. |
| `none` | No human at all; motion-graphics cards instead | Dev tools, infra, anything where a stock-looking person undercuts credibility |
| `always` | Presenter also appears as a corner bubble over the demo | Tutorials and walkthroughs, personality-led brands, founder-led launches |

In `always` mode every plain demo scene gets a lip-synced corner bubble from its
own `presenterVideo` clip (generated by the normal `gen/presenter.mjs --all` —
no extra command). The bubble's look is configured once in the manifest:

```json
"presenter": { "mode": "always", "pip": { "shape": "circle", "position": "bottom-left", "sizePct": 22 } }
```

`shape` is `"circle"` (default) or `"square"` (rounded corners); `position` is any
of the four corners; `sizePct` is the bubble's width as % of frame width (10–40).
A scene can override with its own `pip: { ... }`, or opt out entirely with
`pip: false` when the bubble would cover the UI the narration is pointing at.

**One voice throughout.** The narration and the presenter use the same voice,
because the presenter is animated *to the narration audio*. Never generate a
separate voice for the on-camera segments.

## 3. Script

```bash
node scripts/plan.mjs --project demo/<slug> --init --slug <slug> --name "<Product>"
```

Then write `demo/<slug>/demo.json`. See the **demo-script** skill for the schema and how
to write narration that fits a demo. Sketch of a 60s hybrid video:

| id | kind | ~sec | purpose |
|---|---|---|---|
| `hook` | presenter | 7 | The problem, in one sentence |
| `feature-1` | demo | 14 | The core action |
| `broll-1` | broll | 4 | Human context beat |
| `feature-2` | demo | 16 | The payoff |
| `outro` | presenter | 8 | What to do next |

### The tutorial recipe (`--style tutorial`)

A tutorial is the how-to alternative to the promotional styles: the screen is the
hero the whole way through, with the presenter riding along as a corner bubble.
Init with `plan.mjs --init --style tutorial` and follow these rules:

- **One scene per step**, numbered in the narration ("Step two: paste your API
  key"). No presenter scenes, no b-roll — demo scenes back to back, hard cuts
  (the style seeds an empty `transitions` list; keep it that way), then a card
  with the CTA. Cards and `pip: false` scenes never get a bubble.
- **Keep each step's narration under ~9.5s.** The avatar engine quantises clips
  to 5s or 10s, so a scene ≈ narration + breath is always covered; a longer
  scene freezes the bubble at the tail. If build-props warns "the speaker will
  freeze", split the step into two scenes or shorten the line — that is an
  editing note, not a render bug.
- **Capture per step** with the normal rehearse/perform flow (default), **or**
  record one continuous take of the whole workflow and chop it: give every scene
  the same `video` and a scene-level `videoStartSec` marking where its step
  begins in the take.
- Pip clips are per-scene and lip-synced, so `always` mode bills avatar-seconds
  for every demo scene — the plan gate shows this as its own "corner pip" count.
  Approve the estimate before generating.

Existing projects keep their scaffolded Remotion app: an older `anchor`/`always`
project only gains the corner bubble after `render.mjs --sync-template` (which
overwrites any local Remotion edits — say so first) plus `gen/presenter.mjs --all`.

Show the user the plan and the cost before spending anything:

```bash
node scripts/plan.mjs --project demo/<slug>
```

**Get explicit approval of the estimate before step 4.** That is the point at
which real money starts being spent.

### 3.5 Character voice (optional — needs ELEVENLABS_API_KEY)

If the user chose a custom character voice in Direction, design it **after the
script is written** (previews audition with the real first line) and **before any
narration is generated** (every scene uses it):

```bash
node scripts/gen/voice-design.mjs --project demo/<slug> \
  --describe "Weathered 60-year-old New England lobster-boat captain, gravelly, thick coastal Maine accent" \
  --name "Captain"
```

That designs ~3 previews, **auto-accepts the first**, writes
`voice.provider/voiceId` into `demo.json`, and keeps all previews in
`demo/<slug>/audio/voice-previews/`. Tell the user to listen (`afplay
demo/<slug>/audio/voice-previews/preview-1.mp3`) and, if a different candidate is
better, run `--pick 2` / `--pick 3` **promptly** — un-accepted previews expire.
To hear candidates before anything is saved, add `--audition` and then `--pick N`.

Know these three behaviours:

- **Same description = same voice, free.** Designs are cached globally, so a
  re-run or a v2 of the video reuses the account voice with zero design spend.
- **Voice slots are quota-limited** on the ElevenLabs account. `--list` shows
  what exists; `--delete <voice_id>` frees a slot when a character is retired.
- **`--use <voice_id>`** adopts an existing account voice with no design spend.

## 4. Narration first

```bash
node scripts/gen/tts.mjs --project demo/<slug> --all
```

Writes an mp3 and a `.words.json` per scene, and records the measured duration
back into `demo.json`. Every later step reads those durations.

## 5. Rehearse

Start a session with the MCP tools — `demo_open` for web, `demo_open_app` for a
macOS app, `demo_open_cli` for a terminal program:

- `demo_inspect` before clicking. It returns real selectors ranked by durability;
  reading a selector off a screenshot is guessing, and guesses break on replay.
- Every successful action is recorded automatically. Failed ones are not.
- `demo_undo_step` drops an action that worked but does not belong in the video.
- `demo_save_actions --file demo/<slug>/actions/<scene>.json` when the flow is right.

While rehearsing, **tell the user what part of the app you are exercising** and
what you found. That running commentary is half the value of this whole process.

See the **demo-capture** skill for staging, desktop coordinates and permissions.

## 6. Perform

Pass the narration duration so the footage lands on the voiceover:

```bash
node scripts/capture/web-perform.mjs \
  --actions demo/<slug>/actions/feature-1.json \
  --out demo/<slug>/clips/feature-1.mp4 \
  --timestamps demo/<slug>/audio/feature-1.words.json \
  --target-duration 14.0
```

Desktop scenes use `mac-perform.mjs --app "<App Name>"` instead. Then record the
clip and its event log in `demo.json` (`video`, `events`).

If it warns that the steps overrun the narration, fix it in the script — either
cut steps or lengthen that line. Do not ignore it; the scene will overrun.

CLI scenes are different: the real program (e.g. a live `claude` session) sets
the pace, so `cli-perform.mjs` records at natural speed and **retimes the take
in post** to the narration duration (kept within 0.5x–2x; the raw take is saved
beside the clip):

```bash
node scripts/capture/cli-perform.mjs \
  --actions demo/<slug>/actions/feature-1.json \
  --cwd /path/to/demo-project \
  --out demo/<slug>/clips/feature-1.mp4 \
  --target-duration 14.0
```

If it warns that the retime factor was clamped, the take and the narration are
too far apart — shorten the prompt or rewrite the line, then re-retime with
`scripts/edit/retime.mjs` (no new live take needed). See the **demo-capture**
skill's CLI section for staging, `waitStable` and pre-approved permissions.

## 7. Presenter and b-roll

```bash
node scripts/gen/presenter.mjs --project demo/<slug> --all   # face generated once, reused
node scripts/gen/broll.mjs --project demo/<slug> --all       # still → video, with model fallback
```

These two are safe to run in parallel — manifest saves merge instead of
clobbering each other.

### Iterating on a hard shot

A composite shot (a specific character, in a specific place, doing a specific
thing) rarely lands in one prompt. Iterate on the **still** before animating —
a still costs cents, a video costs dollars:

```bash
node scripts/gen/still.mjs --project demo/<slug> --out assets/shot.png \
  --prompt "wide shot on the deck of a trawler at golden hour…"

node scripts/gen/still.mjs --project demo/<slug> --out assets/shot-v2.png \
  --edit "give each creature a soft contact shadow on the wet deck" \
  --from assets/shot.png --ref assets/presenter.png
```

**Read the image file after every step** and edit what is actually wrong.
`--ref` passes identity references — pass the presenter portrait so the same
character appears in b-roll shots. `--scene <id>` attaches the result as that
scene's `still` (broll.mjs animates a supplied still instead of generating
one); `--character` records it as `presenter.characterImage`, which is how a
themed character (a ship captain on a headland) gets a portrait that
presenter.mjs's corporate-headshot prompt would fight. Version the filenames
(`-v2`, `-v3`) so you can compare takes and keep the best; identical re-runs
are cache hits and cost nothing.

For edits, pass `--aspect` whenever the output shape matters: without it the
model infers the aspect from the source images, and a portrait-format `--ref`
photo can drag a 9:16 `--from` down to 3:4.

A reusable character kit may ship a `wardrobe/` of premade looks (same face,
different outfit/background — often edited from the canonical portrait with a
photo of a real garment as `--ref`). When one exists, pick a look the previous
video didn't use and copy it in under the canonical `assets/presenter*` names
— outfit variation without touching the manifest.

## 8. Render

```bash
node scripts/render/render.mjs --project demo/<slug>
```

First run scaffolds a Remotion app into `demo/<slug>/remotion/` and installs it. The user
can open `--studio` to tweak anything and their edits survive re-renders.

## 9. QA — actually look at it

```bash
node scripts/qa.mjs --project demo/<slug>
```

Then **read a sample of the extracted frames**. There is no automatic grader. You
are checking: is text legible, does the cursor go where the narration says, is
anything sensitive on screen, does it look like something a company would publish.

The secret scanner only sees *text* — narration and typed values. Anything merely
visible on screen (a real email in a sidebar, a live API key in a settings page)
is only caught by looking at the frames.

Re-running regenerates only what changed, so fixing one scene is cheap.

## 10. Optional: a vertical Short

Once the demo is done, a 15–45s vertical cut for YouTube Shorts / Reels / TikTok
can be made from the same project — reusing the captures, voice and best
narration lines for pennies. See the **demo-shorts** skill; it starts with:

```bash
node scripts/plan.mjs --project demo/<slug> --init --manifest shorts.json --from demo.json --format 9:16
```

Every Short carries a `cover` — a hook card baked into frame 0, since that
frame is the thumbnail on every vertical platform (the skill's §2b).

Offer this when the demo wraps; do not build it unasked.

---

## Rules

- **Never spend before showing the estimate and getting a yes.**
- **Narration before capture.** Always.
- **One voice.** Set it once in `demo.json`.
- **Demo scenes get voiceover, not a face** — unless the mode is `always`.
- **Everything goes in `demo.json`.** If it only exists in your context, it is lost
  on the next run and nothing can be resumed or partially regenerated.
- **Report what you actually did.** If a scene failed, say so and say which. A
  video with a broken scene is worse than one with a missing scene.
