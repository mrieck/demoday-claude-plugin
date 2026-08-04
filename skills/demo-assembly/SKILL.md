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
node scripts/render/render.mjs --project demo             # render
node scripts/render/render.mjs --project demo --studio    # open the editor
```

The first run copies `remotion-template/` into `demo/remotion/` and installs it.
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

## Captions

Driven by the word timings from `gen/tts.mjs`, grouped into short phrases with the
spoken word tinted. On by default — most product videos are watched muted at least
once. Turn off with `"captions": { "enabled": false }`.

Captions only exist for scenes that have a `.words.json`.

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
node scripts/qa.mjs --project demo
```

Extracts frames and scans narration and typed text for credentials. **Then read
the frames.** No automated check can tell you whether the demo is convincing,
whether the text is legible at the target size, or whether something private is
sitting in a sidebar on screen.
