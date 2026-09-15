---
name: demo-assembly
description: >-
  Assembling and rendering a demo video with Remotion and ffmpeg — the timeline,
  transitions, captions, zoom-to-click, audio ducking, and diagnosing a render
  that comes out wrong. Use when rendering the final video, customising its look,
  or fixing timing, black frames or missing audio.
---

# Assembling the video

Remotion owns the finished timeline. ffmpeg only prepares inputs (trimming,
cropping, normalising). That split is what makes transitions, captions and
overlays *on top of* the footage possible in a single deterministic render.

```bash
node scripts/render/render.mjs --project demo/<slug>             # render
node scripts/render/render.mjs --project demo/<slug> --studio    # open the editor
```

(`demo/<slug>` is the video's project folder, e.g. `demo/project-overview` —
one per video.)

The first run copies `remotion-template/` into `demo/<slug>/remotion/` and installs it.
**It is never overwritten afterwards**, so any edits the user makes there survive.

## How props reach the renderer

`build-props.mjs` turns `demo.json` into props and does three things the renderer
should not have to:

1. **Verifies every artifact exists.** A missing clip becomes a clear error rather
   than a black rectangle.
2. **Inlines the event log and word timings** so components never touch the disk.
3. **Reconciles durations.** Generated video comes back at whatever length the
   model chose; if a clip is shorter than its scene, the scene is trimmed to the
   clip rather than freezing on the last frame.

Media resolves through `--public-dir <project>`, so `staticFile("clips/x.mp4")`
points straight at the pipeline's output. Nothing is copied.

## What the renderer does with the event log

`DemoClip` reads the capture's event log and eases the frame toward each click
just before it lands, holding briefly, then easing out. This is the single biggest
difference between "screen recording" and "product video" — it leads the viewer's
eye across a 1920px UI.

Zoom is deliberately gentle (1.18×). The footage is already rasterised, so pushing
harder makes text mushy and reads as a jump cut. Disable per scene with
`"zoomToClick": false`.

Callouts with `"anchor": "lastClick"` place themselves next to the most recent
click — where the viewer is already looking.

## Audio

- Narration is laid out on an **absolute timeline**, not inside scenes, because
  transitions overlap scenes and two overlapping voices are instantly audible.
- Presenter clips are **muted**; the original narration track plays instead. The
  avatar's baked-in audio is a re-encode of the same thing.
- A music bed ducks under narration automatically (`music.duckDb`, default −14 dB).
  Without ducking it sounds like a stock template.

### Sound effects (opt-in only — never added unless the user asks; needs ELEVENLABS_API_KEY)

Sound effects are off by default: do not add an `sfx` block or run
`gen/sfx.mjs` unless the user explicitly asks for sound effects.
Full-screen text moments — insert cards, `#N` stamps, bullet reveals, the cover
wipe, face punch-ins — play in silence except for the voice, and that reads as
a stall. A project-level `sfx` pack fixes it: named cues designed with
ElevenLabs sound generation, fired automatically on events by style, with a
per-event override anywhere.

```jsonc
"sfx": {
  "enabled": true, "gain": 0.7, "duckDb": -6,          // master level; extra music duck under a cue
  "cues": {                                             // name -> prompt (+ durationSec 0.5-30, gain)
    "whoosh": { "prompt": "short fast air whoosh, dry", "durationSec": 0.6, "file": "audio/sfx/whoosh.mp3" },
    "pop": { "prompt": "tiny bright UI pop", "durationSec": 0.5, "file": null }   // file:null = not generated yet
  },
  "auto": { "insert": "whoosh", "stamp": "pop", "face": "hit", "bullet": "tick",   // event -> cue (null = off)
            "coverExit": "whoosh", "transition": "whoosh", "card": "riser", "sceneStart": null }
}
```

- `plan.mjs --init --style <name> --sfx` scaffolds the pack (five default cues +
  the style's event map) when the key is set — without `--sfx` no pack is added; `gen/sfx.mjs --init` adds it to
  an existing manifest. `gen/sfx.mjs --all` generates **3 candidates per cue**
  (~$0.02 each), accepts #1, keeps the rest under `audio/sfx/previews/`;
  `--cue whoosh --pick 2` swaps, `--cue whoosh --prompt "…" --force` redoes
  one, `--add stinger --prompt "…"` defines a new cue. Accepted cues are
  also stored per machine, so the default pack is designed once.
- Overrides on any beat, transition, scene, bullet, or `cover`: `"sfx": "pop"`
  (a cue), `"sfx": false` (silence), or `"sfx": { "cue": "hit", "gain": 0.5,
  "offsetSec": -0.3 }` (pre-roll a riser). `bottom.sfx` sets the cue for a
  whole bullet list. A `screen` beat is not an auto event but plays an
  explicit cue.
- Placement happens in `build-props` (`lib/sfx.mjs`), on the same absolute
  timeline as narration, into `props.sfxTrack`; the template just plays it.
  A missing cue file is a render error; `sfx.enabled: false` makes the audio
  byte-identical to a project without the block.
- `qa.mjs` warns above ~1 cue/second — set some `auto` events to `null`.
- Template code changed for this: existing projects need one
  `render.mjs --sync-template` to hear cues.

## Captions

Driven by the word timings from `gen/tts.mjs`, grouped into short phrases with the
spoken word tinted. On by default — most product videos are watched muted at least
once. Turn off with `"captions": { "enabled": false }`, or per scene with
`"captions": false` on that scene (e.g. a narrated end card whose caption would
cover the logo).

Captions only exist for scenes that have a `.words.json`.

`captions.style "buildup"` (the dynamic style) is a black phrase box in the
bottom band, pre-sized to the whole 1–5 word phrase, whose words are revealed
as spoken; one word per phrase sits in an accent box — the first word with an
authored `captionEmphasis` tone, else an automatic pick (longest 5+ letter
non-function word; `captions.autoEmphasis: false` disables). Never wider than
52% of the frame, so it clears a corner card on either side. It ignores
`placement`; it lives in `components/Captions.jsx` next to the others.

## Watermark

A top-level `"watermark": { "text": "@handle", "image": "assets/logo.png",
"position": "top-left", "opacity": 0.55, "size": 34, "color": "#fff" }` block
draws a persistent channel handle over every scene (text, image, or both — all
fields optional except one of text/image). Positions: `top-left` (default),
`top-center`, `top-right`, `bottom-left`, `bottom-right`; the insets keep it
clear of the like/share rail and caption strip on vertical platforms. A scene
opts out with `"watermark": false` (e.g. a CTA card whose logo it would sit on);
the mark fades over 0.25s at the edges of each run instead of popping.

## Corner bubble (presenter.mode "always")

In mode `always` every plain demo scene overlays a lip-synced corner bubble from
its own `presenterVideo` clip. Its look lives in `presenter.pip` (`shape`
circle/square, `position` any corner, `sizePct`) and renders in
`remotion-template/src/scenes/PresenterPip.jsx`; a scene overrides with its own
`pip` object or opts out with `pip: false`. A "corner pip clip is Ns for an Ms
scene — the speaker will freeze" warning from build-props is an editing note:
the avatar engine quantises clips to 5s/10s, so split the step or shorten the
narration. Older projects only pick the bubble up after
`render.mjs --sync-template` (which overwrites local Remotion edits).

## Moving presenter frame (the dynamic style)

With a continuous take (`presenter.pipTake`) **and** a `presenter.layoutTrack`
in the props, the take renders through `scenes/PresenterFrame.jsx` instead of
the bubble: one `<OffthreadVideo>` in one positioned div for the life of each
take segment, whose rect (position, size, corner radius, inner zoom,
object-position) is recomputed every frame from the track — `face` full-bleed,
`panel-left/right` a 40%-wide full-height panel (cover-fit only; `presenter.frame.panelZoom` 1–1.6 adds a push-in, but it amplifies the presenter's movement and drifts the face off-centre),
`card-*` a 24%×47% corner card, `face-band` the face across the top 68% with a
`card` scene drawn as a bottom band (`Card.jsx` `band` prop: logo + title row,
CTA button), `none` faded out in place. The element is
never re-mounted, so lips stay on the narration through every move. A change
is a **move**: over the first `presenter.frame.morphMs` (200) of an entry the
rect eases out (`easeOutCubic`) from the previous rect; `morphMs: 0` is a hard
cut. A take whose aspect differs from the frame's (a square or 9:16 portrait,
sizes probed into `pipTake.segments[].width/height` by build-props) gets a
LETTERBOXED `face`/`none` rect — full height, centred, theme background either
side — rather than a cropped giant face (`presenter.frame.faceFit`: `auto` |
`cover` | `contain`); panels and cards crop as before. `presenter.frame.pace`
(`lively` | `calm`) changes nothing in the renderer, only which pacing rules
validate() applies. Geometry and the maths live in `lib/layouts.js` (`LAYOUT_RECTS`,
`CONTENT_BOX`, `presenterRectAt`, `focusTransform`); the Node side mirrors the
names in `scripts/lib/layouts.mjs` and `scripts/selftest-layouts.mjs` pins them.

`build-props` writes `presenter.layoutTrack` (`[{ fromSec, toSec, layout,
sceneId, beatIndex }]`, absolute seconds, adjacent identical layouts merged)
from the beats' `layout`, resolves every dynamic beat's inherited `layout`, and
stamps each dynamic scene with `prevLayout` and `beatLayout: "dynamic"`.

Dynamic scenes render through `scenes/DynamicScene.jsx`: the content pane is
the box the current layout leaves free (`CONTENT_BOX`: the 59% beside a panel,
else the full frame), hidden under a face, and its box/opacity morph over the
same `morphMs` as the frame. Inside it each beat is a `<Sequence>`: `FocusClip`
cover-fits the capture and zooms into `beat.focus` (a focus change on the same
running clip glides over 0.4s); a beat with `videoStartSec` or `cut:
"dissolve"` enters with a 0.2s zoom-dissolve (outgoing window extended and
scaled up/faded, incoming scaled in on top); `framing: pan|cover` on a beat
uses `DemoClip` instead; `shot: "insert"` reuses `InsertBeat`. Layer order in
`DemoVideo.jsx` is scenes → presenter frame → captions → watermark, so a
full-frame face never swallows the caption (the old bubble rendered above
captions; it now sits below them too).

Things build-props refuses or warns about here: no take at all under the
dynamic style (error); a take shorter than the runtime; a chunk seam (the
avatar re-poses) that does not coincide with a layout change.

## Diagnosing a bad render

| Symptom | Cause |
|---|---|
| Video shorter than expected | A clip is shorter than its scene; `build-props` warns and trims. Fix the scene duration or re-capture. |
| A scene freezes at the end | Same thing, with the warning ignored. |
| Black scene | `video` path missing or unreadable. `qa.mjs` lists these. |
| No audio | Scene has `narration` but no `audio` — run `gen/tts.mjs --all`. |
| No captions | No `words` file for the scene. |
| Demo scene never zooms | No `events` recorded in `demo.json`. |
| Two voices at once | Scene durations overlap the transitions; check `transitions[].ms`. |

Total runtime = sum of scene durations **minus** total transition time, since
transitions overlap. Both `plan.mjs` and the renderer report the real number.

## After changing anything in the template

```bash
node scripts/selftest.mjs
```

Builds a complete project from ffmpeg-generated test patterns and renders it end
to end with no API calls. It exercises the manifest, validation, duration
reconciliation, zoom, captions, transitions and audio layout. Run it before a real
render — otherwise a broken component only surfaces after the expensive steps have
already been paid for.

## Finally: look at it

```bash
node scripts/qa.mjs --project demo/<slug>
```

Extracts frames and scans narration and typed text for credentials. **Then read
the frames.** No automated check can tell you whether the demo is convincing,
whether the text is legible at the target size, or whether something private is
sitting in a sidebar on screen.
