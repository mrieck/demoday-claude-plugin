---
name: demo-shorts
description: >-
  Cut a vertical 9:16 Short (YouTube Shorts, Instagram Reels, TikTok) from a demo
  video project in one of four named styles — listicle (rapid numbered beats),
  cohost (split screen with presenter), flashcard (typographic interstitials), or
  glide (immersive pan). Use when the user asks for a "short", "shorts",
  "vertical video", "TikTok", "Reel", "9:16", or a social cut of a demo.
---

# Cutting a vertical Short

A Short is **not a re-render of the demo at a different size**. It is its own
15–45 second video cut from the demo project's assets. Work inside the same
project directory as the main demo: the Short lives in a **sibling manifest**
(`shorts.json`) that shares the project's clips, audio, cache and Remotion app.

## 1. Pick a style first

Everything else follows from this. Show the user the four looks and ask which
their video is most like:

| style | feels like | mechanics |
|---|---|---|
| `listicle` | "5 plugins that fix your CSS" — numbered rundown, a cut every ~1.5s | beat engine: face/screen/split/insert windows, `#N` stamps, boxed captions |
| `cohost` | screenshare with a person talking below the demo throughout | split framing, steady scene-length pacing, karaoke captions |
| `flashcard` | text asks, UI answers — big typographic cards alternating with full-bleed clips, no face | beat engine: insert(title)/screen windows, boxed captions |
| `glide` | one immersive screen recording, the camera gliding to each click | pan framing, karaoke captions |

```bash
node scripts/plan.mjs --project demo/<slug> --init \
  --manifest shorts.json --from demo.json --style listicle
```

`--style` sets the format (1080×1920), presenter mode, caption style and
transition policy, and records `style` in the manifest. `--from demo.json`
copies product, brand, voice and presenter identity. The timeline starts empty.

**Prefix every scene id with `s-`** — both manifests share `clips/` and
`assets/`, and generated artifacts are named after scene ids.

## What is reused vs regenerated

| Asset | Verdict | Why |
|---|---|---|
| Screen captures + event logs | **reused, free** | Reframed (pan/split/beats) inside the 9:16 frame |
| Voice (designed voiceId) | **reused, free** | Copied by `--init --from` |
| Narration lines kept verbatim | **reused, free** | Same text + voice = cache hit |
| New narration lines | cents | Normal TTS pricing |
| B-roll | **regenerated** | Stills generate at 9:16; i2v inherits the aspect |
| Presenter clips (full scenes, split bottoms, face beats) | **generated per scene** | Animated to that scene's narration; billed avatar-seconds, shown in the estimate |
| Cards / captions / bullets / title inserts | free | Rendered, not generated |
| Insert stills from a `prompt` | ~$0.05 each | Beats with an existing `image` are free |

Always show `plan.mjs --project demo/<slug> --manifest shorts.json` and get a yes
before generating.

## 2. Style recipes

### listicle — the numbered rundown

The workhorse for "N plugins/tools that fix X". The grammar (modeled on the
strongest TikTok listicles) has a **home base and two kinds of departure**:

- **Home base — the anchored split.** `beatLayout: "anchored"` + `bottom:
  {kind: "presenter"}`: the speaker talks *continuously* in the bottom pane
  while the demo hard-cuts in the top pane (`shot: "screen"` beats with
  `videoStartSec` jumps). Boxed captions automatically ride the **seam**
  between the panes. Use `splitPct` ~0.42 and `presenterFocusY "50% 22%"`
  (the 9:16 portrait sits high in the squat zone).
- **The punch-in.** A full-bleed `face` beat, 0.6–2s, reserved for the
  revelation line ("it's your setup") — never for narration filler. Captions
  drop to the lower third automatically.
- **The full-screen moment.** `insert` beats (animated title + `stamp: "#N"`,
  or `images: [2–5 stills]` for the spread effect) and full-bleed `screen`
  beats with a mid-screen caption — for each numbered item's reveal.

**Cost rule (hybrid):** anchor only 2–3 scenes — hook, one middle beat, the
closer. Anchored scenes and face beats need that scene's presenter clip
(billed avatar-seconds); everything else is free. Structure (15–45s):

1. **Hook (≤2s in)** — anchored: pain on the top pane, speaker below,
   caption tagged `neg`.
2. **Revelation** — full-bleed face punch-in: the claim.
3. **Promise** — an animated insert(title) beat: "3 plugins".
4. **One scene per tool** — insert with title + `stamp "#N"` → screen cuts
   (`videoStartSec` to the best moments; pan framing is the default).
5. **Closer** — anchored or face-beat payoff line.
6. **CTA card** — ~4s, where to get them.

Rules of the style: a cut every **1.2–1.5s** (`atSec` steps); hard cuts only
(no scene transitions — `--style` already emptied them); boxed captions with
`captionEmphasis` — tag pain words `neg`, payoff words `pos`:

```jsonc
{ "id": "s-p1", "kind": "demo", "target": "web",
  "narration": "First: DemoDay. It records your app and cuts the video for you.",
  "video": "clips/p1.mp4", "events": "clips/p1.events.json",
  "beatLayout": "anchored", "splitPct": 0.42,
  "bottom": { "kind": "presenter" }, "presenterFocusY": "50% 22%",
  "captionEmphasis": [ { "match": "records", "tone": "pos" }, { "match": "for you", "tone": "pos" } ],
  "beats": [
    { "atSec": 0,   "shot": "insert", "title": "DemoDay", "stamp": "#1" },
    { "atSec": 1.4, "shot": "screen" },
    { "atSec": 2.8, "shot": "screen", "videoStartSec": 12 },
    { "atSec": 4.4, "shot": "face" },
    { "atSec": 5.8, "shot": "screen", "videoStartSec": 20 }
  ] }
```

In an anchored scene, `screen`/`split` beats cut inside the top pane (the
speaker keeps talking below); `face`/`insert`/`card` beats punch in full-bleed
over everything. Per-beat `captionPlacement` (`seam` | `mid` | `low`)
overrides the automatic choice when needed.

Timing beats to the narration: read the scene's `.words.json` and place `atSec`
cuts on phrase boundaries — punch-ins land ON the key word, not near it. Face
beats and anchored bottoms need `gen/presenter.mjs --manifest shorts.json
--all` (uses the 9:16 portrait; billed per scene).

### cohost — the screenshare

Steady scenes, no beats. Every demo scene is `framing: "split"`; choose the
bottom per beat: `presenter` for hook/outro, `bullets` for feature lists,
`image` for product shots, `captions` (default) elsewhere. Karaoke captions
ride the seam. See the split schema in the demo-script skill.

### flashcard — text asks, UI answers

Beats, but no face and nothing billed: alternate `insert` beats carrying a
short `title` (≤5 words — the question or claim) with `screen` beats showing
the answer in the UI. Cut every 1.5–2.5s. Boxed captions carry the narration;
use `captionEmphasis` sparingly. Great when there's no presenter identity or
budget.

### glide — the immersive single take

One capture per scene, `framing: "pan"` (the default pan follows the click
log), karaoke captions, gentle crossfades allowed. Pick this when the UI
detail *is* the story and cuts would cheapen it.

## 2b. The cover — frame 0 is the thumbnail

TikTok uses frame 0 as the cover, Instagram's default `thumb_offset` is 0,
Shorts grabs an early frame, and the posting API (Postiz) cannot override any
of them. Whatever the first frame shows is what the channel grid shows. A run
of Shorts that all open on the presenter's face reads as the same video posted
eight times — so every Short declares a `cover`, a typographic hook card that
**is** frame 0, holds 0.5s, then wipes away over the first scene while the
narration is already running underneath (`--init` scaffolds it; `validate()`
refuses to render until `hook` is written).

```jsonc
"cover": {
  "hook": "You use AI for all your coding.",   // required, ≤60 chars, the strongest line
  "kicker": "AI TECH STACK",                    // optional eyebrow label
  "layout": "band",                             // stack | band | corner | stripe
  "accent": "#8B5CF6",                          // defaults to brand.colors.primary
  "portrait": "assets/cover-mark.png",          // optional circular presenter portrait
  "holdSec": 0.5, "outSec": 0.5,                // fully visible, then the exit
  "exit": "wipe-up"                             // wipe-up | dissolve | slide-left
}
```

Writing it:

1. **`hook`** is the video's single strongest line — usually the first
   narration line, shortened to what fits three lines of huge type. A claim
   or a question, never the product name (that is a logo card).
2. **Vary the look against what is already posted.** Scan
   `demo/*/{demo,shorts*}.json` for `cover.layout` and `cover.accent` and pick
   a layout the last three Shorts did not use (each style scaffolds a
   different default: listicle `band`, cohost `corner`, flashcard `stack`,
   glide `stripe`) and, when the brand colour repeats, a different `accent`.
   Same rotation idea as the presenter wardrobe.
3. **`portrait`** keeps the card recognisably the presenter's without making
   the face the whole cover — a `characters/<name>/` portrait, copied into
   the project's `assets/`. Skip it on flashcard/glide (no-face styles).
4. **Preview before rendering:**

   ```bash
   node scripts/render/render.mjs --project demo/<slug> --manifest shorts.json --cover-only
   ```

   Writes `out/<slug>-cover.png` in seconds. **Read the PNG and show it** to
   the user; adjust hook/layout/accent until it works at phone-grid size
   (would you tap it?), then do the full render, which writes the PNG again
   beside the MP4.
5. After rendering, `node scripts/render/cover-sheet.mjs` tiles every cover
   under `demo/` into `demo/cover-sheet.png` — the grid as the channel will
   show it. Two near-identical tiles means change one before posting.

### The frozen-frame alternative (`cover.kind: "frame"`)

No card at all: frame 0 is a frame of the video itself, frozen from a later
timestamp — the poster a creator picks by scrubbing to a good moment — held
~0.45s, then a hard cut to the real open while the narration already runs.
It looks like a native "pick a cover from the video" thumbnail, without the
typographic-card intro. Use it when the card feels like a title-card open, or
to break up a grid of hook cards.

```jsonc
"cover": {
  "kind": "frame",
  "scene": "s-r2", "atSec": 2.6,     // scene-relative; omit `scene` for an absolute second
  "holdSec": 0.45,                    // ≤0.6 — longer reads as a stalled video
  "captions": false                   // drop the caption box: a mid-phrase box on the poster reads as a glitch
}
```

Pick a frame that reads as a thumbnail on its own: an anchored split with the
presenter below and a legible demo/post above, or a face punch-in. Preview it
exactly like the card (`--cover-only`), and still vary the moment per video.
No `hook`/`layout`/`portrait` apply. Existing projects need one render with
`--sync-template` to pick the mode up.

## 3. Generate, render, QA

```bash
node scripts/gen/tts.mjs       --project demo/<slug> --manifest shorts.json --all
node scripts/gen/presenter.mjs --project demo/<slug> --manifest shorts.json --all   # face beats / split bottoms
node scripts/gen/broll.mjs     --project demo/<slug> --manifest shorts.json --all   # stills auto-generate at 9:16
node scripts/render/render.mjs --project demo/<slug> --manifest shorts.json --cover-only   # preview frame 0
node scripts/render/render.mjs --project demo/<slug> --manifest shorts.json
node scripts/qa.mjs            --project demo/<slug> --manifest shorts.json
```

Output: `out/<slug>.mp4` at 1080×1920 plus `out/<slug>-cover.png` (frame 0,
the thumbnail). If the project's Remotion app predates these features (any
project scaffolded before the cover existed), render once with
`--sync-template` (warns: overwrites local Remotion edits).

**QA for vertical**, on top of the standard pass:

- For beat styles, qa.mjs measures the cut rhythm with scenedetect and warns
  when the average shot length is outside the style's target. Trust it — a
  listicle that measures 4s/shot is not a listicle.
- Captions and stamps must stay clear of the bottom quarter and right edge
  (platform UI). Boxed captions center themselves; check bullets/headlines.
- Face beats: is the face framed well full-bleed? Split bottoms: not cropped at
  the forehead (tune `presenterFocusY` per scene if so)?
- Anchored scenes: does the caption box straddle the seam (half over demo, half
  over speaker), and does the bottom speaker run without a freeze or a jump at
  each top-pane cut?
- Inserts with a stamp: the `#N` and the title must not collide (the title
  drops to 44% when a stamp is present — check they both cleared the caption).
- After a `videoStartSec` jump: does the pan still land on the clicks? (The
  event clock is offset automatically — if it looks wrong, the events file is
  stale, not the renderer.)
- Is UI text legible at a phone width? Fix with framing/beat choice, not font.
- The cover: is `out/<slug>-cover.png` a complete, opaque card (no scene
  bleeding through, no caption over it)? Hook text clear of the right edge and
  bottom fifth? Distinct in layout *or* accent from the last three Shorts?

## Rules

- **Same money rules as demo-video** — estimate before spending, narration
  before capture, one voice, everything in the manifest.
- **`s-` prefix on every scene id.** Shared directories; collisions overwrite.
- **Hook in the first two seconds.** Never open with a logo card. The `cover`
  is not one: it carries the hook *as text*, holds ≤0.5s, and wipes out with
  the narration already running — never lengthen it, never put the product
  name on it, never remove it (frame 0 is the thumbnail).
- **Beat styles cut, they don't fade.** If a beat feels slow, cut it — don't
  ease it.
- **Never regenerate landscape assets from a shorts run.** Fix the main demo
  via `demo.json`, not `shorts.json`.
