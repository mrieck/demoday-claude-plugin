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

`$CLAUDE_PLUGIN_ROOT` is the plugin root (outside Claude Code: the folder DemoDay
is installed in — two directories above this file, the one holding `scripts/`,
`mcp/` and the top-level `SKILL.md`). Every command below runs from there unless
stated. Each video is its
own project directory under `<repo>/demo/`, named with a short kebab-case
description of *that video*:
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

## 0. Preflight

```bash
node scripts/doctor.mjs --install
```

Installs missing Node packages and Chromium, then checks keys, ffmpeg and macOS
permissions, printing the exact fix for anything it cannot do itself. Do this
before the first video on a machine and again whenever something fails
mysteriously. If the `demo_*` tools are missing from your tool list even though
the server is configured, the MCP server was started before its packages
existed — reload MCP servers or restart the agent after `--install`, or use
`node scripts/stage.mjs` (see §5).

## 1. Recon

Read the codebase you were pointed at. You need to be able to say what the product
*is*, who it is for, and what its two or three best moments are. Look at the
README, the routes or entrypoints, the data model, and any tests that read like
user journeys.

Then find out how to run it. Ask the user for the dev-server URL, or the app name
if it is a desktop app. Do not guess a port.

## 2. Direction — ask, don't assume

Use AskUserQuestion (or however your agent asks the user a question). The
answers change the whole shape of the video:

- **Style — "which of these is it most like?"** Show the catalog and let the
  user pick; each name is a complete look with sensible defaults
  (`plan.mjs --init --style <name>` applies them):

  | style | aspect | feels like |
  |---|---|---|
  | `launch` | 16:9 | Classic product demo: presenter intro/outro, narrated capture, b-roll |
  | `anchor` | 16:9 | Avatar-led: the presenter is always on screen — full-frame between demos, corner bubble over them |
  | `tutorial` | 16:9 | Step-by-step walkthrough: the full workflow on screen, the presenter riding along as a corner bubble |
  | `dynamic` | 16:9 | Dynamic tutorial: one continuous presenter take re-framed every 4–6s (full-face / side panel / corner card) over zoomed-in screen beats, captions always on |
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
- **Length** — 30s, 60s, 2min. Default to 60s; tutorials default to ~60–90s,
  dynamic tutorials to ~120s.
  Length is the cost driver: narration, avatar and b-roll all bill per second,
  and a continuous-take style bills avatar-seconds for the *whole* runtime. Say
  so, default short, and let the user override — a 5-minute walkthrough is
  fine if that is what they want. (Shorts: 15–45s.)
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

What the style seeds (all overridable in `demo.json`):

- `presenter.pip = { shape: "circle", position: "bottom-right", sizePct: 18 }` —
  bottom-right because most apps keep navigation and primary content top-left.
- `presenter.continuousPip = true` — the bubble is **one continuous lip-synced
  take** for the whole video (`gen/presenter.mjs --all` does this automatically
  for the style; it is the same as `--take`). Every scene's narration is padded
  to its scene length and concatenated, then animated once, and the renderer
  plays that clip straight through underneath the cuts. No pop-in/pop-out at
  every step, no frozen bubble at scene tails, same avatar-seconds as per-scene
  clips. kling-avatar handled a 73s take in one clip; `--take-max-sec` (default
  120) chunks longer takes at scene boundaries, and a refused long take
  automatically retries as 60s chunks. `--take false` gives the old
  per-scene clips.
- `zoomToClick = false` manifest-wide — the 1.18× push-in crops the sidebar,
  and in a walkthrough the whole UI is the point. Set it per scene to re-enable.
- Short by default: **~60–90s**. Avatar-seconds bill for the entire runtime in
  this style, so tell the user what a longer cut costs and let them choose.

Then follow these rules:

- **One scene per step**, numbered in the narration ("Step two: paste your API
  key"), ~5–9s each — short steps, quick cuts. No presenter scenes, no b-roll —
  demo scenes back to back, hard cuts (the style seeds an empty `transitions`
  list; keep it that way), then a card with the CTA. The bubble stays up through
  the card; `pip: false` on a scene hides it there.
- **Capture per step** with the normal rehearse/perform flow (default), **or**
  record one continuous screen take of the whole workflow and chop it: give
  every scene the same `video` and a scene-level `videoStartSec` marking where
  its step begins in the take.
- Terminal steps (a Claude Code session, a CLI) can be self-playing HTML
  replay pages captured as `target: web` when a real terminal cannot be driven
  — feed them the real output, never invented results.
- The plan gate shows the bubble as its own "corner pip" line. Approve the
  estimate before generating.

Existing projects keep their scaffolded Remotion app: an older `anchor`/`always`
project only gains the corner bubble after `render.mjs --sync-template` (which
overwrites any local Remotion edits — say so first) plus `gen/presenter.mjs --all`.

### The dynamic tutorial recipe (`--style dynamic`)

The engaging cousin of `tutorial`, measured from the best creator tutorials
(48 shots in 4:28, 2026-09-13): the presenter is still **one continuous
lip-synced take**, but instead of sitting in a corner it is **re-framed every
4–6 seconds** — full-frame face, a tall side panel next to the screen, a small
corner card over it — and every change is a ~0.2s ease-out **move** of the
frame with the screen content fading in or out beneath it. The screen is never
the whole window: each beat zooms 2–3× into the element being talked about.
Captions are always on: a bottom phrase box whose words appear as spoken, one
word per phrase in an accent box.

What the style seeds (`plan.mjs --init --style dynamic`):

- `presenter.mode = "always"`, `continuousPip = true`, **`takeAspect = "16:9"`**
  — the take is shot wide because face beats fill the frame; panel and card
  are crops of the same clip. `gen/presenter.mjs --all` uses
  `assets/presenter-16x9.png` (or the manifest's `characterImage` when that is
  the 16:9 file). For a kit character make it once with
  `still.mjs --edit --from <9x16 portrait> --aspect 16:9` ("same person, head
  and shoulders centred, eyes on the upper third, background continuing on
  both sides") so the face stays the same; a description-only project gets one
  generated. The take comes back at the engine's resolution (~1280×720 for
  kling): a full-frame face on 1080p is a 1.5× upscale, which is the reference
  look too.
- `presenter.frame = { morphMs: 200, pace: "lively", faceFit: "auto" }` —
  `morphMs` is the move duration (`0` = hard cuts). **`pace` is a direction
  question — ask it:** `"lively"` is the creator grammar below (a move every
  4–6s, the rules measure it); `"calm"` (`plan.mjs --init --style dynamic
  --pace calm`) is a plain step-by-step for people who find the jumping
  TikTok-coded: `face` for the intro and outro, ONE panel or card layout per
  step, moves only at step boundaries, focus zooms still welcome. validate()
  then only caps a hold at 30s. `faceFit` `"auto"` letterboxes a square or
  9:16 take (centred, full height, background either side) for the full-frame
  layouts instead of cropping it into a giant face; `"cover"` crops anyway.
  The side panel is a plain cover-fit of the take (`panelZoom` 1–1.6 pushes
  in, but that magnifies the presenter's own movement and the face drifts
  off-centre — leave it alone).
- `captions.style = "buildup"`, `zoomToClick = false`, `transitions = []`
  (a transition is an **error** in this style: overlaps drift the take's
  lip-sync), `targetLengthSec 120`.

Then write the manifest like this:

- **~120s ≈ 300 words** at 2.5 wps. One scene per tutorial step, 10–15s each,
  demo scenes back to back (no presenter scenes, no b-roll). A closing card is
  optional; if you keep one give it `"layout": "none"` (scene-level) — the
  take keeps running underneath, never `pip: false`.
- **2–3 beats per scene**, each `{ "atSec", "layout"?, "videoStartSec"?,
  "focus"?, "cut"? }`. `layout` is one of `face | face-band | panel-left |
  panel-right | card-tl | card-tr | card-bl | card-br | none`; a beat without one inherits
  the previous layout, so a beat can be a content-only change. `shot` is
  optional (`screen` by default; `insert` still works; `face`/`split`/`card`
  are rejected — the presenter is framed by `layout`). Time `atSec` from the
  `.words.json` timestamps so moves land on clause boundaries.
- **The first beat of the first scene declares a layout** (usually `face`,
  ≤3s, the hook/proof) and the first move happens inside 3s.
- **Frame 0 is a hook band, not a blank frame.** The style scaffolds
  `cover: { kind: "overlay", hook, kicker, accent?, portrait? }` — the band
  over the real first frame (the face), held 0.5s then slid away. Write the
  hook (≤ 60 chars, the claim), a short kicker, and point `portrait` at a
  square still of the presenter (`assets/cover-mark.png`). This is the poster
  of every README / embedded player, which otherwise shows whatever frame 0
  happens to be. Delete the block to opt out.
- **Mix ≈ 40% face / 40% panel / 20% card**, 20–28 layout shots at 120s,
  never one layout for more than 12s. validate() warns on all of these; the
  plan gate and `qa.mjs` print the layout stats.
- **`focus`** is `{ x, y, w, h }` as fractions of the capture frame — the box
  around the field/button the narration names, `w` 0.3–0.5 (tighter than 0.3
  is mush). A focus change on the same running clip glides there over 0.4s;
  a `videoStartSec` jump (or `"cut": "dissolve"`) is a 0.2s zoom-dissolve to
  the new moment. Whole-window beats (no focus) are for when the layout is
  the point; `"framing": "pan" | "cover"` on a beat opts into DemoClip's
  click-following pan instead of the focus box.
- **Pick the card corner away from the UI element** being shown; `panel-right`
  when the interesting UI is on the left. validate() warns when a card sits in
  the watermark's corner.
- **Close with ONE spoken CTA** (one ask per video): keep a `card` scene with
  `logo`, `title`, `cta` (the URL) and give it `"layout": "face-band"` — the
  presenter fills the top 68% of the frame while the card draws as a band
  along the bottom (logo left of the title, the URL button under them). The
  band's crop also hides the stray hand gestures avatar engines put at the
  bottom of a take. A plain `face` card hides the URL; `none` drops the face.
- Captions: keep the narration text clean (it goes to TTS); the emphasis word
  is auto-picked per phrase. Add `captionEmphasis: [{ match, tone }]` on a
  scene only to override; `captions.autoEmphasis: false` turns the auto pick
  off.
- Generate in this order: TTS → captures → `gen/presenter.mjs --all` (once;
  the take is chunked at scene boundaries above `--take-max-sec` 120 and the
  avatar re-poses at a chunk seam — build-props warns unless a layout change
  sits on that second, so start a scene with a new layout there) → render.
  The plan gate shows the take as one "continuous take" line (~$0.056/s).

Renderer pieces, for the assembly guide: `PresenterFrame.jsx` (the moving
frame), `DynamicScene.jsx` (the content pane + focus/dissolve), `lib/layouts.js`
(the geometry), `build-props` (`presenter.layoutTrack`, per-beat resolved
`layout`, `prevLayout`).

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

### 3.6 Sound effects (opt-in only — never add them unless the user asks)

Sound effects are **off by default**. Do not scaffold, generate, or propose an
`sfx` pack unless the user explicitly asks for sound effects. When they do,
`plan.mjs --init --style <name> --sfx` (or `gen/sfx.mjs --init` on an existing
manifest) adds the pack, the estimate shows a `sound effects` line (~$0.02 per
take, 3 takes per cue), and after the script is final:

```bash
node scripts/gen/sfx.mjs --project demo/<slug> --all          # generate, accept take #1 of each
node scripts/gen/sfx.mjs --project demo/<slug> --cue whoosh --pick 2   # prefer another take
```

The renderer then places cues on the events the style wires (`sfx.auto`), and
any scene/transition/beat can say `"sfx": false` or name a different cue.
Details in the demo-assembly skill § Audio.

## 4. Narration first

```bash
node scripts/gen/tts.mjs --project demo/<slug> --all
```

Writes an mp3 and a `.words.json` per scene, and records the measured duration
back into `demo.json`. Every later step reads those durations.

## 5. Rehearse

Start a session with the MCP tools — `demo_open` for web, `demo_open_app` for a
macOS app, `demo_open_cli` for a terminal program. (No `demo_*` tools in your
tool list? `node scripts/stage.mjs <name>` drives the same server from the
shell — `node scripts/stage.mjs tools` lists them; see the top-level `SKILL.md`.)

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
