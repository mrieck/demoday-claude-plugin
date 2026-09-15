/**
 * Presenter layouts for the `dynamic` (16:9) style — the Node-side half.
 *
 * One continuous lip-synced take is re-FRAMED over the video: full-frame face,
 * a tall side panel, a small corner card, or hidden. Beats carry `layout`
 * (scene-relative); this module flattens them onto the absolute timeline so
 * the renderer's single presenter layer can ask "which layout at second t?"
 * and so validate()/qa.mjs can measure the pacing the style is about.
 *
 * The pixel geometry of each layout lives in
 * remotion-template/src/lib/layouts.js (LAYOUT_RECTS); scripts/selftest-layouts.mjs
 * pins the two name lists to each other.
 */

export const PRESENTER_LAYOUTS = [
  "face",
  "face-band",   // face across the top 68%, a band below for a card's logo/title/URL — the closer
  "panel-left",
  "panel-right",
  "card-tl",
  "card-tr",
  "card-bl",
  "card-br",
  "none",
];

/** Coarse family per layout, for the mix rule and the stats line. */
export function layoutGroup(layout) {
  if (layout === "face" || layout === "face-band") return "face";
  if (layout === "none") return layout;
  if (layout?.startsWith("panel-")) return "panel";
  if (layout?.startsWith("card-")) return "card";
  return "unknown";
}

/** The watermark corner a card layout would collide with. */
export const CARD_CORNER = {
  "card-tl": "top-left",
  "card-tr": "top-right",
  "card-bl": "bottom-left",
  "card-br": "bottom-right",
};

/** Layout in effect when nothing has declared one yet. */
export const DEFAULT_LAYOUT = "face";

/**
 * Walk the timeline the way the composition lays scenes out (transitions
 * overlap, so the cursor steps back by each one) and emit
 *   [{ fromSec, toSec, layout, sceneId, beatIndex }]
 * A beat without `layout` inherits the previous one; a non-demo scene may carry
 * a scene-level `layout`. Consecutive identical layouts merge, so a hold that
 * spans a scene boundary counts as ONE shot — that is what the pacing rules
 * need to measure.
 */
export function buildLayoutTrack(timeline = [], transitions = []) {
  const byAfter = new Map((transitions || []).map((t) => [t.after, t]));
  const changes = [];
  let cursor = 0;
  let current = null;
  for (const [i, scene] of timeline.entries()) {
    const d = scene.durationSec || 0;
    const beats = scene.kind === "demo" ? scene.beats || [] : [];
    if (beats.length) {
      for (const [bi, b] of beats.entries()) {
        if (!b?.layout) continue;
        current = b.layout;
        changes.push({ atSec: cursor + (b.atSec || 0), layout: current, sceneId: scene.id, beatIndex: bi });
      }
    } else if (scene.layout) {
      current = scene.layout;
      changes.push({ atSec: cursor, layout: current, sceneId: scene.id, beatIndex: null });
    }
    cursor += d;
    const t = byAfter.get(scene.id);
    if (t && i < timeline.length - 1) cursor -= (t.ms ?? 400) / 1000;
  }
  const totalSec = cursor;
  if (!changes.length) return [];

  // The opening stretch before the first declared layout is the default.
  const entries = [];
  if (changes[0].atSec > 0) {
    entries.push({ fromSec: 0, layout: DEFAULT_LAYOUT, sceneId: timeline[0]?.id ?? null, beatIndex: null, implicit: true });
  }
  for (const c of changes) {
    const last = entries[entries.length - 1];
    if (last && last.layout === c.layout) continue; // merge holds
    entries.push({ fromSec: r3(c.atSec), layout: c.layout, sceneId: c.sceneId, beatIndex: c.beatIndex });
  }
  for (const [i, e] of entries.entries()) {
    e.toSec = r3(i < entries.length - 1 ? entries[i + 1].fromSec : totalSec);
  }
  return entries.filter((e) => e.toSec > e.fromSec);
}

/**
 * The effective layout just before `sceneId` starts (what a scene's first
 * beat inherits), or the default.
 */
export function layoutBefore(track, sceneStartSec) {
  let out = DEFAULT_LAYOUT;
  for (const e of track) {
    if (e.fromSec < sceneStartSec - 1e-6) out = e.layout;
    else break;
  }
  return out;
}

/**
 * Pacing numbers the dynamic rules are written against. `none` stretches are
 * not shots (the presenter is off screen) but still count toward the hold rule.
 */
export function layoutStats(track = [], totalSec = null) {
  const shots = track.filter((e) => e.layout !== "none");
  const total = totalSec ?? (track.length ? track[track.length - 1].toSec : 0);
  const counts = { face: 0, panel: 0, card: 0, none: 0 };
  const seconds = { face: 0, panel: 0, card: 0, none: 0 };
  let longest = null;
  for (const e of track) {
    const g = layoutGroup(e.layout);
    if (g in counts) { counts[g] += 1; seconds[g] += e.toSec - e.fromSec; }
    const len = e.toSec - e.fromSec;
    if (!longest || len > longest.sec) longest = { sec: r3(len), atSec: e.fromSec, layout: e.layout, sceneId: e.sceneId };
  }
  const n = shots.length;
  const mix = {};
  for (const g of ["face", "panel", "card"]) mix[g] = n ? r3(counts[g] / n) : 0;
  const firstChangeSec = track.length > 1 ? track[1].fromSec : total;
  return {
    shots: n,
    avgShotSec: n ? r3(shots.reduce((s, e) => s + (e.toSec - e.fromSec), 0) / n) : 0,
    longest,
    counts,
    seconds: Object.fromEntries(Object.entries(seconds).map(([k, v]) => [k, r3(v)])),
    mix,
    firstChangeSec: r3(firstChangeSec),
    lastLayout: track.length ? track[track.length - 1].layout : null,
    totalSec: r3(total),
  };
}

/** A beat's focus rect, validated shape: fractions of the capture frame. */
export function focusProblems(f) {
  const out = [];
  if (!f || typeof f !== "object" || Array.isArray(f)) return ["focus must be { x, y, w, h } as fractions of the capture frame"];
  for (const k of ["x", "y", "w", "h"]) {
    if (typeof f[k] !== "number" || !(f[k] >= 0 && f[k] <= 1)) out.push(`focus.${k} must be a number between 0 and 1`);
  }
  if (out.length) return out;
  if (f.w < 0.15 || f.h < 0.15) out.push("focus is under 15% of the frame — that is a >6x blow-up of rasterised UI");
  if (f.x + f.w > 1 + 1e-6 || f.y + f.h > 1 + 1e-6) out.push("focus runs past the frame edge (x+w and y+h must be ≤ 1)");
  return out;
}

function r3(n) {
  return Math.round(n * 1000) / 1000;
}
