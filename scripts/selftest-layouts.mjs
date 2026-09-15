#!/usr/bin/env node
/**
 * Presenter-layout test for the dynamic style — costs nothing, no render.
 *
 *   node scripts/selftest-layouts.mjs
 *
 * Pins the layout names shared by scripts/lib/layouts.mjs and the template's
 * lib/layouts.js, the absolute layout track built from scene-relative beats
 * (inheritance, merging across a scene boundary, scene-level layout on a
 * card, "none"), the pacing stats validate()/qa.mjs report, the morph
 * geometry, and the focus maths with known numbers.
 */
import { PRESENTER_LAYOUTS, buildLayoutTrack, layoutBefore, layoutStats, focusProblems } from "./lib/layouts.mjs";
import {
  LAYOUT_RECTS, CONTENT_BOX, rectFor, contentBoxFor, presenterRectAt, focusTransform, layoutAt, lerpFocus,
} from "../remotion-template/src/lib/layouts.js";
import * as manifest from "./lib/manifest.mjs";
import { report, info, main } from "./lib/log.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(`selftest-layouts: ${msg}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

await main(async () => {
  // ---- name parity ---------------------------------------------------------
  const templateNames = Object.keys(LAYOUT_RECTS);
  assert(
    PRESENTER_LAYOUTS.length === templateNames.length && PRESENTER_LAYOUTS.every((n) => templateNames.includes(n)),
    `layout names differ: scripts ${PRESENTER_LAYOUTS.join(",")} vs template ${templateNames.join(",")}`
  );
  assert(manifest.PRESENTER_LAYOUTS === PRESENTER_LAYOUTS, "manifest.mjs must re-export PRESENTER_LAYOUTS");
  for (const n of PRESENTER_LAYOUTS) {
    const r = LAYOUT_RECTS[n];
    assert(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9, `${n}: rect leaves the frame`);
  }
  assert(near(CONTENT_BOX["panel-left"].x + CONTENT_BOX["panel-left"].w, 1), "panel-left content box reaches the right edge");
  assert(near(LAYOUT_RECTS["panel-left"].x + LAYOUT_RECTS["panel-left"].w, CONTENT_BOX["panel-left"].x, 0.02), "panel-left content starts where the panel ends");
  info("  layout names and rects agree");

  // ---- the track -----------------------------------------------------------
  const timeline = [
    { id: "a", kind: "demo", target: "web", durationSec: 6, video: "x.mp4",
      beats: [
        { atSec: 0, layout: "face" },
        { atSec: 1.5, layout: "panel-left", focus: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } },
        { atSec: 3.5 },                              // inherits panel-left
        { atSec: 4.5, layout: "card-br", videoStartSec: 6 },
      ] },
    { id: "b", kind: "demo", target: "web", durationSec: 5, video: "x.mp4",
      beats: [
        { atSec: 0 },                                // inherits card-br across the boundary → merged hold
        { atSec: 2, layout: "none" },
        { atSec: 3, layout: "face" },
      ] },
    { id: "c", kind: "card", durationSec: 2, title: "CTA" },   // no layout → still face
    { id: "d", kind: "card", durationSec: 1, title: "end", layout: "none" },
    { id: "e", kind: "card", durationSec: 1, title: "url", layout: "face-band" },
  ];
  const track = buildLayoutTrack(timeline, []);
  const expect = [
    ["face", 0, 1.5], ["panel-left", 1.5, 4.5], ["card-br", 4.5, 8], ["none", 8, 9], ["face", 9, 13], ["none", 13, 14], ["face-band", 14, 15],
  ];
  assert(track.length === expect.length, `track has ${track.length} entries, expected ${expect.length}: ${JSON.stringify(track)}`);
  expect.forEach(([layout, from, to], i) => {
    const e = track[i];
    assert(e.layout === layout && near(e.fromSec, from) && near(e.toSec, to), `track[${i}] = ${JSON.stringify(e)}, expected ${layout} ${from}-${to}`);
  });
  assert(track[2].sceneId === "a" && track[2].beatIndex === 3, "merged hold keeps the entry that started it");
  assert(layoutBefore(track, 6) === "card-br", "scene b inherits card-br");
  assert(layoutBefore(track, 0) === "face", "nothing before the first entry → default face");

  // A transition overlap moves later entries earlier, like the composition does.
  const withFade = buildLayoutTrack(timeline, [{ after: "a", type: "fade", ms: 500 }]);
  assert(near(withFade[3].fromSec, 7.5), `transition overlap not subtracted: ${JSON.stringify(withFade[3])}`);

  const stats = layoutStats(track);
  assert(stats.shots === 5, `shots ${stats.shots} (none stretches are not shots)`);
  assert(stats.counts.face === 3 && stats.counts.panel === 1 && stats.counts.card === 1 && stats.counts.none === 2, `counts ${JSON.stringify(stats.counts)}`);
  assert(near(stats.mix.face, 0.6) && near(stats.mix.panel, 0.2), `mix ${JSON.stringify(stats.mix)}`);
  assert(stats.longest.layout === "face" && near(stats.longest.sec, 4), `longest ${JSON.stringify(stats.longest)}`);
  assert(near(stats.firstChangeSec, 1.5) && stats.lastLayout === "face-band" && near(stats.totalSec, 15), `stats ${JSON.stringify(stats)}`);
  info("  layout track and stats");

  // ---- validate() under the dynamic rules ---------------------------------
  const m = { ...manifest.blankManifest({ slug: "dyn" }), style: "dynamic", transitions: [] };
  m.presenter.mode = "always";
  m.presenter.continuousPip = true;
  m.timeline = structuredClone(timeline).map((s) => (s.kind === "demo" ? { ...s, actions: "a.json" } : s));
  let check = manifest.validate(m);
  assert(check.ok, `dynamic fixture should validate: ${check.errors.join("; ")}`);
  assert(!check.warnings.some((w) => /ends on layout/.test(w)), `face-band counts as a face close: ${JSON.stringify(check.warnings)}`);
  const endsNone = structuredClone(m);
  endsNone.timeline.pop();
  assert(manifest.validate(endsNone).warnings.some((w) => /ends on layout "none"/.test(w)), "expected a close-on-face warning when the video ends on none");

  const withTransition = structuredClone(m);
  withTransition.transitions = [{ after: "a", type: "fade", ms: 400 }];
  assert(!manifest.validate(withTransition).ok, "a transition must be an error under the dynamic style");

  const badLayout = structuredClone(m);
  badLayout.timeline[0].beats[1].layout = "panel-top";
  assert(manifest.validate(badLayout).errors.some((e) => /layout must be one of/.test(e)), "unknown layout must be an error");

  const badFocus = structuredClone(m);
  badFocus.timeline[0].beats[1].focus = { x: 0.8, y: 0.1, w: 0.5, h: 0.5 };
  assert(manifest.validate(badFocus).errors.some((e) => /past the frame edge/.test(e)), "focus past the edge must be an error");

  const faceShot = structuredClone(m);
  faceShot.timeline[0].beats[0].shot = "face";
  assert(manifest.validate(faceShot).errors.some((e) => /shot "face" is not used/.test(e)), "shot face must be rejected under dynamic");

  const noFirst = structuredClone(m);
  delete noFirst.timeline[0].beats[0].layout;
  assert(manifest.validate(noFirst).errors.some((e) => /first beat must declare a layout/.test(e)), "first beat without layout must be an error");

  const longHold = structuredClone(m);
  longHold.timeline[0].durationSec = 20;
  longHold.timeline[0].beats = [{ atSec: 0, layout: "face" }, { atSec: 14, layout: "panel-left" }];
  check = manifest.validate(longHold);
  assert(check.ok && check.warnings.some((w) => /holds 14\.0s/.test(w)), `expected a hold warning, got ${JSON.stringify(check.warnings)}`);

  const wmClash = structuredClone(m);
  wmClash.watermark = { text: "@x", position: "bottom-right" };
  assert(manifest.validate(wmClash).warnings.some((w) => /same corner as layout "card-br"/.test(w)), "watermark/card corner clash must warn");

  const hybrid = structuredClone(m);
  hybrid.presenter.mode = "hybrid";
  assert(!manifest.validate(hybrid).ok, "dynamic needs presenter.mode always");

  // pace "calm": a plain walkthrough — the frequency rules stand down, a
  // generous hold cap stays; bad frame settings are errors.
  const calm = structuredClone(longHold);
  calm.presenter.frame = { morphMs: 200, pace: "calm", faceFit: "auto" };
  check = manifest.validate(calm);
  assert(check.ok && !check.warnings.some((w) => /holds 14\.0s|first layout change|layout shots over/.test(w)), `calm pace should relax the frequency rules: ${JSON.stringify(check.warnings)}`);
  const calmLong = structuredClone(calm);
  calmLong.timeline[0].durationSec = 40;
  calmLong.timeline[0].beats = [{ atSec: 0, layout: "face" }, { atSec: 35, layout: "panel-left" }];
  assert(manifest.validate(calmLong).warnings.some((w) => /holds 35\.0s/.test(w)), "calm pace still caps a 35s hold");
  const badFrame = structuredClone(m);
  badFrame.presenter.frame = { pace: "frantic", faceFit: "stretch", morphMs: 5000, panelZoom: 3 };
  const bf = manifest.validate(badFrame);
  assert(bf.errors.filter((e) => /presenter\.frame\./.test(e)).length === 4, `frame settings must be validated: ${JSON.stringify(bf.errors)}`);
  info("  validate() rules");

  // pending(): a continuous take is one artifact.
  const needs = manifest.pending("/nonexistent", { ...m, timeline: m.timeline.map((s) => ({ ...s, audio: "a.mp3" })) });
  assert(needs.some((n) => n.sceneId === "*" && n.needs.includes("pipTake")), `pending() must report the missing take: ${JSON.stringify(needs)}`);
  assert(!needs.some((n) => n.needs.includes("presenterVideo")), "no per-scene presenter clips are pending under a continuous take");
  info("  pending() reports the take");

  // ---- geometry ------------------------------------------------------------
  const W = 1920, H = 1080;
  const face = rectFor("face", W, H);
  assert(face.x === 0 && face.w === W && face.h === H && face.opacity === 1 && face.face === 1, "face rect is full-bleed");
  const panel = rectFor("panel-left", W, H);
  assert(near(panel.w, 0.4 * W) && near(panel.h, 0.98 * H) && panel.zoom === 1.0, `panel rect ${JSON.stringify(panel)}`);
  assert(rectFor("panel-left", W, H, { panelZoom: 1.2 }).zoom === 1.2 && rectFor("card-tl", W, H, { panelZoom: 1.2 }).zoom === 1.0, "panelZoom only touches the panels");
  const cb = contentBoxFor("panel-right", W, H);
  assert(cb.x === 0 && near(cb.w, 0.59 * W) && cb.opacity === 1, `panel-right content box ${JSON.stringify(cb)}`);
  assert(contentBoxFor("face", W, H).opacity === 0, "content is hidden under a face");

  const t2 = [{ fromSec: 0, toSec: 2, layout: "face" }, { fromSec: 2, toSec: 5, layout: "card-br" }];
  assert(layoutAt(t2, 1.9).entry.layout === "face" && layoutAt(t2, 2).entry.layout === "card-br" && layoutAt(t2, 99).entry.layout === "card-br", "layoutAt picks the live entry and holds the last");
  const before = presenterRectAt(t2, 1.99, W, H, 200);
  const mid = presenterRectAt(t2, 2.1, W, H, 200);
  const after = presenterRectAt(t2, 2.3, W, H, 200);
  const card = rectFor("card-br", W, H);
  assert(near(before.w, W), "before the move: full width");
  assert(mid.w < W && mid.w > card.w && mid.x > 0 && mid.x < card.x, `mid-move rect should be between face and card: ${JSON.stringify(mid)}`);
  assert(near(after.w, card.w) && near(after.x, card.x), "after morphMs: the card rect");
  // Ease-out: more than half the travel is done at the half-way point.
  assert((W - mid.w) / (W - card.w) > 0.5, "morph is ease-out (front-loaded)");
  const hard = presenterRectAt(t2, 2.05, W, H, 0);
  assert(near(hard.w, card.w), "morphMs 0 is a hard cut");
  // A square take is letterboxed for the full-frame layouts (centred, full
  // height), never blown up into a giant face; panels/cards still crop; the
  // morph then targets the letterboxed rect. faceFit "cover" restores the crop.
  const sq = rectFor("face", W, H, { srcAspect: 1 });
  assert(near(sq.w, H) && near(sq.x, (W - H) / 2) && near(sq.h, H) && sq.face === 1, `square take face rect ${JSON.stringify(sq)}`);
  const sqNone = rectFor("none", W, H, { srcAspect: 1 });
  assert(near(sqNone.w, H) && sqNone.opacity === 0, "none follows the letterboxed face rect");
  assert(near(rectFor("panel-left", W, H, { srcAspect: 1 }).w, 0.4 * W), "panels are unaffected by the take aspect");
  assert(near(rectFor("face", W, H, { srcAspect: 1, faceFit: "cover" }).w, W), "faceFit cover keeps the full-bleed crop");
  assert(near(rectFor("face", W, H, { srcAspect: 16 / 9 }).w, W), "a 16:9 take fills the frame");
  assert(near(rectFor("face", W, H, { srcAspect: 16 / 9, faceFit: "contain" }).w, W), "contain on a matching take is still full-bleed");
  // face-band: the closer — face across the top 68%, the card's band below.
  const fb = rectFor("face-band", W, H, { srcAspect: 16 / 9 });
  assert(fb.x === 0 && fb.y === 0 && near(fb.w, W) && near(fb.h, 0.68 * H) && fb.face === 1, `face-band rect ${JSON.stringify(fb)}`);
  const fbSq = rectFor("face-band", W, H, { srcAspect: 1 });
  assert(near(fbSq.h, 0.68 * H) && near(fbSq.w, 0.68 * H) && near(fbSq.x, (W - 0.68 * H) / 2), `square take in face-band is letterboxed inside the band ${JSON.stringify(fbSq)}`);
  assert(near(contentBoxFor("face-band", W, H).y, 0.68 * H), "the content box under face-band is the bottom band");
  const tall = rectFor("face", W, H, { srcAspect: 9 / 16 });
  assert(near(tall.w, H * 9 / 16) && near(tall.x, (W - tall.w) / 2), `9:16 take is pillarboxed ${JSON.stringify(tall)}`);
  const midSq = presenterRectAt(t2, 2.1, W, H, 200, { srcAspect: 1 });
  assert(midSq.w < H && midSq.w > card.w, `morph from a letterboxed face heads to the card: ${JSON.stringify(midSq)}`);
  info("  presenter rect morph");

  // ---- focus maths ---------------------------------------------------------
  // A 16:9 capture in a 1920x1080 box: cover-fit is 1:1. Focus on the centre
  // half → scale 2, focus centre (960,540) stays put, no translate.
  let tf = focusTransform(1920, 1080, 1920, 1080, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  assert(near(tf.scale, 2) && near(tf.tx, 0) && near(tf.ty, 0) && near(tf.originX, 960), `centre focus ${JSON.stringify(tf)}`);
  // Focus in the top-left corner: scale 2 about (480,270), then translated so
  // that corner's quarter fills the box — the scaled left/top edges land at 0.
  tf = focusTransform(1920, 1080, 1920, 1080, { x: 0, y: 0, w: 0.5, h: 0.5 });
  const leftEdge = tf.left + tf.originX - tf.originX * tf.scale + tf.tx;
  const topEdge = tf.top + tf.originY - tf.originY * tf.scale + tf.ty;
  assert(near(tf.scale, 2) && near(leftEdge, 0) && near(topEdge, 0) && near(tf.tx, 480), `corner focus should fill from the edge: ${JSON.stringify(tf)}`);
  // Focus near the right edge: the window must not expose background.
  tf = focusTransform(1920, 1080, 1920, 1080, { x: 0.6, y: 0.4, w: 0.4, h: 0.4 });
  const right = tf.left + tf.originX + (tf.width - tf.originX) * tf.scale + tf.tx;
  assert(right >= 1920 - 1e-6, `right edge exposed: ${right}`);
  // A wide focus (a terminal line) in the narrow panel pane cannot fit at
  // scale ≥ 1: it anchors to its left edge instead of clipping it — the
  // focus's left edge lands at x = 0 of the box.
  tf = focusTransform(1133, 1080, 1596, 910, { x: 0, y: 0.18, w: 0.65, h: 0.35 });
  const focusLeft = tf.left + tf.originX + (0 * tf.width - tf.originX) * tf.scale + tf.tx;
  assert(near(tf.scale, 1) && near(focusLeft, 0, 0.01), `wide focus should anchor left: ${JSON.stringify(tf)} left=${focusLeft}`);
  // No focus = plain cover fit.
  tf = focusTransform(1132, 1080, 1280, 720, null);
  assert(near(tf.scale, 1) && near(tf.height, 1080) && tf.left < 0, `cover fit ${JSON.stringify(tf)}`);
  // A focus that would need less than 1x is clamped to 1 (never letterbox).
  tf = focusTransform(1920, 1080, 1920, 1080, { x: 0, y: 0, w: 1, h: 1 });
  assert(near(tf.scale, 1), "whole-frame focus is scale 1");
  const mixed = lerpFocus(null, { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, 0.5);
  assert(near(mixed.x, 0.1) && near(mixed.w, 0.7), `lerpFocus ${JSON.stringify(mixed)}`);
  assert(focusProblems({ x: 0.1, y: 0.1, w: 0.1, h: 0.5 }).length === 1, "tiny focus is one problem");
  assert(focusProblems("nope").length === 1, "non-object focus is one problem");
  info("  focus transform");

  report("  PASS — layouts, track, rules, morph and focus maths agree", { ok: true });
});
