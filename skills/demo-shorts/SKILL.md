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
| `listicle` | "Claude just killed X, here's how" — numbered steps, the real tool running on screen, a cut every ~1.3s | beat engine: face/screen/split windows, `#N` stamps over the UI, boxed captions; hard rules (no title cards, hook cut ≤1s, no hold >2.5s) |
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

The workhorse for "N steps/tools that do X". The grammar is measured from the
strongest TikTok listicles (28–37s, 17–24 shots, a cut every 1.3–1.7s, the
screen always moving under the text) and has a **home base and two kinds of
departure**:

- **Home base — the anchored split.** `beatLayout: "anchored"` + `bottom:
  {kind: "presenter"}`: the speaker talks *continuously* in the bottom pane
  while a **real recording of the tool running** hard-cuts in the top pane
  (`shot: "screen"` beats with `videoStartSec` jumps). Boxed captions ride
  the **seam**. `splitPct` ~0.42, `presenterFocusY "50% 22%"`.
- **The punch-in.** A full-bleed `face` beat, 0.6–2s, for the revelation
  line and the CTA — never for narration filler.
- **The stamp over the UI.** Each numbered item starts with a *screen* beat
  carrying `stamp: "#N"` — the numeral pops over the moving screen. Not a
  title card.

**Hard rules — `validate()` errors/warns and `qa.mjs` measures them:**

| rule | limit | why |
|---|---|---|
| Hook cuts to a visual | ≤1.0s | a face-only open loses the swipe; the top pane shows a real screen from second 0 |
| No text-only inserts | error | a title on a blank card is a stall; use `{ "shot": "screen", "stamp": "#N" }` |
| Insert (image spread) window | ≤0.8s | inserts are flashes |
| Any window / non-closer scene | ≤2.5s | nothing holds; avg target 0.9–1.6s |
| Lead-magnet CTA in narration | warn | "DM me the word DEMO and I'll send you the link; on TikTok, link in bio" |
| One CTA per video | error | a comment word plus a follow card/line is two asks; end on the closer |

**What goes in the top pane:** the actual tool doing the thing — a terminal
running the real command, the app being driven, the result appearing. A
website being scrolled is not proof of anything; if the tool cannot be run,
install it into a scratch folder and run it (cli scenes), or build the thing
on screen. Every step says *what to do* in narration and *shows it done* on
screen.

**Cost rule (hybrid):** anchor only 2–3 scenes — hook, one middle beat, the
closer. Anchored scenes and face beats need that scene's presenter clip
(billed avatar-seconds); everything else is free. Structure (28–40s):

1. **Hook (anchored)** — a claim with tension ("Claude just killed X",
   "You're using X wrong"), never an announcement. Top pane: the proof
   (the result) from second 0; speaker below; `neg` on the pain word.
2. **One scene per step** — first screen beat carries `stamp "#N"`, then
   1–3 more screen cuts (`videoStartSec` to the moments that matter: the
   command typed → the thing happening → the result).
3. **Revelation** — one full-bleed face punch-in on the twist line.
4. **Closer** — anchored or face: the payoff + the lead-magnet word.
5. **Closer = full-screen presenter, one ask.** A `presenter` scene (no
   split — the split at the very end reads as an unfinished cut): the payoff
   line, then "DM me the word DEMO and I'll send you the link. If you're on
   TikTok, the link's in my bio." Say **DM**, not comment (a DM can be
   answered by hand or by a keyword autoresponder; nothing answers
   comments). No follow card and no "follow for more" after it —
   `validate()` errors on two CTAs. A channel card is only for videos whose
   single ask is the follow.

Rules of the style: a cut every **0.9–1.6s** (`atSec` steps); hard cuts only
(no scene transitions — `--style` already emptied them); boxed captions (1–3
words) with `captionEmphasis` — pain words `neg`, payoff words `pos`:

```jsonc
{ "id": "s-1", "kind": "demo", "target": "cli", "cwd": "/path/to/scratch",
  "narration": "One: install it. Two commands in your terminal, and Claude has the skill.",
  "actions": "actions/s-1.json", "video": "clips/s-1.mp4",
  "beatLayout": "anchored", "splitPct": 0.42,
  "bottom": { "kind": "presenter" }, "presenterFocusY": "50% 22%",
  "captionEmphasis": [ { "match": "two commands", "tone": "pos" } ],
  "beats": [
    { "atSec": 0,   "shot": "screen", "stamp": "#1", "videoStartSec": 0.5 },
    { "atSec": 1.3, "shot": "screen", "videoStartSec": 4.0 },
    { "atSec": 2.6, "shot": "screen", "videoStartSec": 9.5 },
    { "atSec": 3.8, "shot": "screen", "videoStartSec": 14.0 }
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
of them. Whatever the first frame shows is what the channel grid shows.

### The band overlay — `cover.kind: "overlay"` (listicle default)

Not a card. The video's **real first frame** is the background and is already
playing with the narration; a solid accent band carrying the hook sits across
the upper-middle of the frame, holds 0.5s, then slides up and off. It reads
like a creator's "text over the first frame" cover, not a title slide.

```jsonc
"cover": {
  "kind": "overlay",
  "hook": "Claude just killed video editors.",  // required, ≤60 chars
  "kicker": "HERE'S HOW",                        // optional eyebrow inside the band
  "accent": "#14B8A6",                           // defaults to brand.colors.primary
  "portrait": "assets/cover-mark.png",           // optional small circle at the band's right
  "top": 0.22, "height": 0.24,                   // fractions of frame height (defaults)
  "holdSec": 0.5, "outSec": 0.4, "exit": "wipe-up"
}
```

Rules that follow from the platforms: profile grids crop the 9:16 cover to
~3:4 (TikTok) or 4:5 (Instagram), so the band must live inside ~12%–78% of
the height — `validate()` warns outside that. The default 22%–46% sits over
the **demo pane** of an anchored hook and leaves the presenter's face clear.
Captions are hidden while the band is up (a mid-phrase box under a band
reads as a glitch). Preview with `--cover-only` exactly like a card and make
sure the first frame underneath is a real screen, not black.

### The full card — `cover.kind: "card"` (cohost / flashcard / glide default)

A typographic hook card that **is** frame 0, holds 0.5s, then wipes away over
the first scene while the narration is already running underneath.

```jsonc
"cover": {
  "hook": "You use AI for all your coding.",   // required, ≤60 chars, the strongest line
  "kicker": "AI TECH STACK",                    // optional eyebrow label
  "layout": "band",                             // stack | band | corner | stripe
  "accent": "#8B5CF6",                          // defaults to brand.colors.primary
  "portrait": "assets/cover-mark.png",          // optional circular presenter portrait
  "holdSec": 0.5, "outSec": 0.5,                // fully visible, then the exit
  "exit": "wipe-up"                             // wipe-up | wipe-down | dissolve | slide-left
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

## 2c. Meme cold opens — `composite` scenes

Engagement-bait Shorts often open on a *meme*: a reaction clip with its own
audio, a cutout in slow motion on a themed plate, a freeze on the last frame
while a music cue plays, a push-in on a face. None of that is a capture —
declare it as a `composite` block on a plain `demo` scene and let
`scripts/edit/composite.mjs` bake the clip with ffmpeg:

```jsonc
{ "id": "s-meme", "kind": "demo", "target": "web", "framing": "cover",
  "note": "Sacks: a ban is coming; freeze, sad violin, push-in on Chamath",   // shows up in SCRIPT.md
  "composite": {
    "durationSec": 6.3,
    "size": "frame",                                   // or "pane" for the top of an anchored split, or [w,h]
    "plate": { "image": "assets/meme/hall.png", "brightness": -0.05 },
    "layers": [
      { "src": "../meme/chamath-cutout.webm", "speed": 0.44, "crop": [1200,1080,290,0],
        "fit": { "h": 1000 }, "at": ["center", -40], "freezeEnd": true },       // alpha webm, slow-mo
      { "src": "../meme/sacks.mp4", "region": [0,960,1080,960], "audio": true, "freezeEnd": true }
    ],
    "zoom":  { "fromSec": 2.8, "toSec": 6.1, "factor": 1.95, "focus": [540,420], "ease": "out" },
    "music": { "src": "assets/meme/sad-violin.wav", "atSec": 2.6, "fadeInSec": 0.4, "gain": 1.1, "fadeOutSec": 0.5 }
  } }
```

```bash
node scripts/gen/still.mjs      --project demo/<slug> --manifest shorts.json --out assets/meme/hall.png --prompt "empty marble hallway inside the US Capitol, dusk, no people"
node scripts/gen/fetch-audio.mjs --project demo/<slug> --url <youtube url> --out assets/meme/sad-violin.wav --duration 8 --trim-silence
node scripts/edit/composite.mjs  --project demo/<slug> --manifest shorts.json --scene s-meme
```

`composite.mjs` writes `clips/<id>.mp4` and patches the scene (`video`,
`durationSec` when there is no narration, `muteSource: false` when audio was
mixed, `captions: false`). Rules that follow from the renderer:

- A composite **with audio** must be a plain `demo` scene — beats and
  presenter bottoms are always muted.
- To put a slow-mo cutout above the presenter, use `size: "pane"` on an
  anchored scene (the clip is built at the top-pane size, so `focus`/`at`
  are in pane pixels) — the closer of the open-source-ban Short does this.
- Zoom is pixel-sharp: the canvas is built at 2× and cropped back, so a 2×
  push-in on a 1080p cutout loses nothing. Keep `factor` ≤ 2.
- Hand the presenter the **hook line about the meme** ("Why does it look like
  Chamath is about to cry?") in an anchored scene whose top pane is the
  reaction clip (a plain `video`, cropped/slowed with ffmpeg or a `size:
  "pane"` composite), then cut to the meme scene. Cover: none — frame 0 of
  that open is the thumbnail, and a frozen-frame cover hides the first caption.
- `fetch-audio.mjs` retries yt-dlp through a cookie ladder (bare → default
  Chrome → `DEMODAY_YTDLP_COOKIES` / the SocialCue Chrome profile) because
  YouTube bot-checks bare downloads. Rights are on you.

## 2d. Sound effects — OFF unless the user explicitly asks

Do **not** add sound effects to a Short unless the user asks for them by name
("add sound effects", "add a whoosh on the cards"). `--init --style` never
scaffolds an `sfx` pack on its own; do not run `gen/sfx.mjs`, do not add an
`sfx` block, and do not suggest it in the plan or the review. When they are
asked for, pass `--sfx` to `plan.mjs --init` (or `gen/sfx.mjs --init` on an
existing manifest) and generate once per project:

```bash
node scripts/gen/sfx.mjs --project demo/<slug> --manifest shorts.json --all      # 3 takes per cue, #1 accepted
node scripts/gen/sfx.mjs --project demo/<slug> --manifest shorts.json --cue pop --pick 2   # swap a take
```

Then, per beat, tune with `"sfx": false`, `"sfx": "hit"`, or
`"sfx": { "cue": "riser", "offsetSec": -0.8 }`. Keep it under one cue a
second — `qa.mjs` warns past that. Schema and event list: demo-assembly
skill § Audio. Existing projects: `render.mjs --sync-template` once.

## 3. Generate, render, QA

```bash
node scripts/gen/tts.mjs       --project demo/<slug> --manifest shorts.json --all
node scripts/gen/presenter.mjs --project demo/<slug> --manifest shorts.json --all   # face beats / split bottoms
node scripts/gen/broll.mjs     --project demo/<slug> --manifest shorts.json --all   # stills auto-generate at 9:16
node scripts/gen/sfx.mjs       --project demo/<slug> --manifest shorts.json --all   # ONLY if the user asked for sound effects
node scripts/render/render.mjs --project demo/<slug> --manifest shorts.json --cover-only   # preview frame 0
node scripts/render/render.mjs --project demo/<slug> --manifest shorts.json
node scripts/qa.mjs            --project demo/<slug> --manifest shorts.json
```

Every render also rewrites the generated block of `SCRIPT.md` (narration in
order, no-narration scenes called out, watermark, cover) from the manifest —
that file is what the cross-posting agent reads, so it must never describe a
dropped scene. Hand-written notes outside the `<!-- demoday:script -->`
markers survive; put a "removed from earlier drafts" list there when a cut
changes a lot. Give no-narration scenes a `note` so the block can describe them.

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
