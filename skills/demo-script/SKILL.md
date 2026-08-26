---
name: demo-script
description: >-
  Writing the script and shot list for a demo video, and the demo.json manifest
  schema. Use when planning what a product video should say and show, writing
  voiceover narration, structuring scenes, or editing demo.json.
---

# Writing the script

## Narration that works

You are writing for a voice, not a page.

- **Short sentences.** One idea each. The TTS will honour a comma; it will not
  rescue a subordinate clause.
- **Say what the viewer is watching**, half a beat before they see it. "You start
  by creating a project" lands as the cursor moves toward the button.
- **Benefit, then mechanism.** "Ship in one click" beats "click the deploy button".
- **No feature lists.** Three things well beats nine things fast.
- **Write the hook last.** It is easier once you know what the demo actually shows.
- **Spell out anything you want pronounced.** "S3" not "S₃"; "dot dev" if it must
  be said aloud.

Roughly **2.5 words per second**. A 60-second video is ~150 words total. That is
much less than it sounds — cut accordingly.

### Shape of a 60-second demo

| Beat | Time | Job |
|---|---|---|
| Hook | 0–8s | The problem, felt. Not the product name. |
| Core action | 8–24s | The single best thing it does |
| Context beat | 24–30s | B-roll, breathing room, credibility |
| Payoff | 30–50s | The result, and why it matters |
| Close | 50–60s | One clear next step |

### Presenter lines vs voiceover lines

Both use the same voice, but they read differently. A presenter line is addressed
to camera ("Let me show you what changed"). A voiceover line describes what is on
screen ("Projects appear the moment they're created"). Do not write voiceover for
a presenter shot; it sounds like someone reading a manual at you.

## The manifest

`demo/<slug>/demo.json` is the single source of truth — each video keeps its own
project folder under `demo/` (e.g. `demo/project-overview/`), and every script
reads and writes the manifest inside it.
Anything that exists only in your context is lost on the next run.

```jsonc
{
  "version": 1,
  "slug": "acme-dashboard",
  "product": { "name": "Acme", "tagline": "...", "audience": "...", "valueProps": ["..."] },
  "brand":   { "colors": { "primary": "#5B8DEF", "bg": "#0B0D12", "text": "#FFFFFF" },
               "logo": "assets/logo.png", "font": "Inter" },
  "format":  { "width": 1920, "height": 1080, "fps": 30 },
  // Default: a fal.ai stock voice. `provider` may be omitted (means "fal").
  "voice":   { "provider": "fal", "model": "fal-ai/elevenlabs/tts/eleven-v3",
               "voice": "Rachel", "stability": 0.4 },
  // OR a designed character voice (needs ELEVENLABS_API_KEY; written for you by
  // gen/voice-design.mjs — do not invent a voiceId by hand):
  // "voice": { "provider": "elevenlabs", "model": "eleven_v3",
  //            "voiceId": "abc123...", "voiceName": "Captain",
  //            "designPrompt": "weathered lobster-boat captain...", "stability": 0.4 },
  "presenter": { "mode": "hybrid", "description": "a woman in her 30s, smart casual, warm and direct",
                 "characterImage": "assets/presenter.png", "engine": "fal-ai/infinitalk" },
  // In mode "always" (the tutorial style) every plain demo scene gets a
  // lip-synced corner bubble; "pip" configures its look. All fields optional:
  // shape "circle" (default) | "square", position any corner (default
  // bottom-left), sizePct 10-40 (% of frame width, default 22).
  // "presenter": { "mode": "always", "pip": { "shape": "circle", "position": "bottom-left", "sizePct": 22 }, ... },
  "music": { "enabled": false, "bed": "assets/bed.mp3", "duckDb": -14 },
  // style: "clean" (pill near the bottom edge) or "shorts" (big centered
  // karaoke for vertical cuts — see the demo-shorts skill)
  "captions": { "enabled": true, "style": "clean" },
  // Optional persistent channel-handle watermark (text and/or a small PNG).
  // position: top-left (default) | top-center | top-right | bottom-left | bottom-right
  // — the insets already avoid the zones platform UI covers on vertical video.
  // Opt a scene out with "watermark": false on the scene (e.g. the CTA card).
  // "watermark": { "text": "@handle", "position": "top-left", "opacity": 0.55 },
  // Vertical only: the hook card that IS frame 0 — the thumbnail every platform
  // shows — held ~0.5s then wiped away over the first scene. See demo-shorts §2b.
  // layout: stack | band | corner | stripe   exit: wipe-up | dissolve | slide-left
  // "cover": { "hook": "You use AI for all your coding.", "kicker": "AI tech stack",
  //            "layout": "band", "accent": "#8B5CF6", "portrait": "assets/cover-mark.png" },
  // — or a frozen frame of the video itself instead of a card (no hook text):
  // "cover": { "kind": "frame", "scene": "s-r2", "atSec": 2.6, "holdSec": 0.45, "captions": false },
  "timeline": [ /* scenes */ ],
  "transitions": [ { "after": "hook", "type": "fade", "ms": 400 } ]
}
```

All paths are **relative to the project directory**. Never store absolute paths.

A vertical Short is a **sibling manifest** (`shorts.json`) in the same project
dir — same schema, `format` 1080×1920, its own timeline with `s-`-prefixed scene
ids. Created with `plan.mjs --init --manifest shorts.json --from demo.json
--style <listicle|cohost|flashcard|glide>`; the whole workflow is in the
**demo-shorts** skill.

Demo scenes in beat styles carry a `beats` array — the voice flows while the
picture hard-cuts between windows:

```jsonc
"captionsStyle": "boxed",                      // per-scene caption override
"captions": false,                             // no captions on this scene at all
"captionEmphasis": [ { "match": "average", "tone": "neg" },   // red
                     { "match": "one click", "tone": "pos" } ], // brand color
"beats": [
  { "atSec": 0,   "shot": "face" },                    // full-bleed presenterVideo
  { "atSec": 1.4, "shot": "screen" },                  // the scene's capture
  { "atSec": 3.0, "shot": "split" },                   // scene.bottom applies
  { "atSec": 4.6, "shot": "insert", "title": "DemoDay", "stamp": "#1" },  // or "image"
  { "atSec": 6.0, "shot": "screen", "videoStartSec": 12 }  // jump the capture
]
```

### Scene kinds

```jsonc
// A screen-capture segment. target: "web" | "mac" | "cli".
// A cli scene records a real Terminal window running the real program; add
// "cwd" (the project the demo shell starts in) and expect a *.raw.mp4 kept
// beside the clip (the unretimed take).
{ "id": "feature-1", "kind": "demo", "target": "web",
  "narration": "Creating a project takes one click.",
  "audio": "audio/feature-1.mp3",        // written by gen/tts.mjs
  "words": "audio/feature-1.words.json", // word timings, for captions and pins
  "durationSec": 14.0,                   // measured from the audio
  "actions": "actions/feature-1.json",   // written by demo_save_actions
  "video": "clips/feature-1.mp4",        // written by the perform runner
  "events": "clips/feature-1.events.json",
  "overlays": [ { "type": "callout", "atSec": 3.2, "text": "One click", "anchor": "lastClick" } ],
  // Only when the composition aspect differs from the capture (a Short cut from
  // 16:9 footage): "pan" (default — window follows the clicks), "card" (whole UI
  // letterboxed in a card, with an optional "headline" below), or "cover" (crop).
  "framing": "pan",
  // Chop one continuous take: play this scene's `video` from 22s in (tutorial
  // style — every step shares the take). Ignored when the scene has beats
  // (each beat carries its own videoStartSec).
  "videoStartSec": 22,
  // Corner bubble (presenter.mode "always" only): false suppresses it on this
  // scene; an object overrides presenter.pip for this scene.
  "pip": { "position": "bottom-right" } }

// On-camera presenter
{ "id": "hook", "kind": "presenter",
  "narration": "Shipping used to take us three days.",
  "lowerThird": { "title": "Alex Rivera", "subtitle": "Product Lead" } }

// Generated cutscene
{ "id": "broll-1", "kind": "broll", "durationSec": 5,
  "prompt": "a developer at a sunlit desk, closing a laptop, relieved" }

// Pure motion graphics — also what a presenter scene degrades to in mode "none"
{ "id": "outro", "kind": "card", "durationSec": 4,
  "title": "Start free today", "subtitle": "No card required", "cta": "acme.dev/start" }
```

`transitions[].type` is `fade`, `wipe` or `slide`. They **overlap** the scenes they
join, so the finished video is shorter than the sum of its scenes — the renderer
accounts for this, but keep it in mind when hitting a target length.

## Writing b-roll prompts

Describe a **shot**, not a concept. "A developer at a sunlit desk closing a laptop"
works; "productivity" does not.

- Say the framing and light: *close-up*, *wide*, *golden hour*, *overhead*.
- Keep people generic. Named people, logos and brands trip content filters, and
  the model ladder will burn through several attempts before failing.
- 4–6 seconds. Generated video gets strange beyond that, and it is priced per second.
- For a hard composite shot, build the still first with `gen/still.mjs`
  (generate → look → `--edit` → look; see the **demo-video** skill) and set the
  scene's `still` field — broll.mjs animates a supplied still instead of
  generating its own.

## Order that saves money

1. Write all narration into `demo.json` first.
2. `node scripts/plan.mjs --project demo/<slug>` — check the estimate.
3. `gen/tts.mjs --all` — now every scene has a real duration.
4. Capture and generate against those durations.

Artifacts are cached on the hash of their inputs, so editing one line of narration
regenerates one audio file and one presenter shot — not the whole video.
