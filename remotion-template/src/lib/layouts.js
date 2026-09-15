/**
 * Presenter layouts for the `dynamic` style — the geometry half, shared by
 * PresenterFrame (the take, re-framed) and DynamicScene (the content pane
 * that fills whatever the presenter leaves free).
 *
 * Pure functions, no Remotion imports: scripts/selftest-layouts.mjs imports
 * this file to pin the layout names against scripts/lib/layouts.mjs and to
 * check the focus maths with known numbers.
 *
 * Measured from the reference tutorial (1280x720): the side panel is 40% of
 * the width and full height with the face ~1.3-1.4x bigger than in the
 * full-frame shot; the corner card is ~24% x 47% tucked into a corner; every
 * change between them is a ~0.2s ease-out move of the frame, with the screen
 * content fading in/out underneath over the same window.
 */

/** Fractions of the composition. `zoom` scales the cover-fitted video inside the rect. */
export const LAYOUT_RECTS = {
  face: { x: 0, y: 0, w: 1, h: 1, r: 0, zoom: 1.0, px: 50, py: 30 },
  // No extra zoom on the panel: the cover-fit already fills its full height,
  // and anything more amplifies the presenter's own movement until the face
  // drifts off-centre (Mark, 2026-09-14). presenter.frame.panelZoom overrides.
  "panel-left": { x: 0.005, y: 0.01, w: 0.40, h: 0.98, r: 0.028, zoom: 1.0, px: 50, py: 35 },
  "panel-right": { x: 0.595, y: 0.01, w: 0.40, h: 0.98, r: 0.028, zoom: 1.0, px: 50, py: 35 },
  "card-tl": { x: 0.005, y: 0.009, w: 0.24, h: 0.47, r: 0.028, zoom: 1.0, px: 50, py: 25 },
  "card-tr": { x: 0.755, y: 0.009, w: 0.24, h: 0.47, r: 0.028, zoom: 1.0, px: 50, py: 25 },
  "card-bl": { x: 0.005, y: 0.521, w: 0.24, h: 0.47, r: 0.028, zoom: 1.0, px: 50, py: 25 },
  "card-br": { x: 0.755, y: 0.521, w: 0.24, h: 0.47, r: 0.028, zoom: 1.0, px: 50, py: 25 },
  // The closer: face across the top, a band along the bottom for the card's
  // logo/title/URL. The cover crop drops the bottom of the take — where an
  // avatar's stray hand gestures live.
  "face-band": { x: 0, y: 0, w: 1, h: 0.68, r: 0, zoom: 1.0, px: 50, py: 30 },
  // Hidden: same rect as a face so a move to/from it is a plain fade.
  none: { x: 0, y: 0, w: 1, h: 1, r: 0, zoom: 1.0, px: 50, py: 30, hidden: true },
};

/** Height of the bottom band under a `face-band` presenter, as a fraction of the frame. */
export const FACE_BAND = 1 - LAYOUT_RECTS["face-band"].h;

/** Where the screen content goes, per layout (fractions). Missing = full frame. */
export const CONTENT_BOX = {
  "panel-left": { x: 0.41, y: 0, w: 0.59, h: 1 },
  "panel-right": { x: 0, y: 0, w: 0.59, h: 1 },
  "face-band": { x: 0, y: 1 - FACE_BAND, w: 1, h: FACE_BAND },
};

export const MORPH_DEFAULT_MS = 200;   // presenter move + content fade, measured 5-6 frames at 30fps
export const DISSOLVE_SEC = 0.2;       // content swap inside a layout (videoStartSec jump)
export const FOCUS_TWEEN_SEC = 0.4;    // a focus change on the same running clip glides, not cuts

/** Fast ease-out: a big first step, then settling — the look of the reference moves. */
export const easeOutCubic = (p) => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);
export const easeInOutQuad = (p) => {
  const x = Math.min(1, Math.max(0, p));
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
};
export const lerp = (a, b, p) => a + (b - a) * p;

/** Does the content pane show under this layout (1) or is it covered (0)? */
export const contentVisible = (layout) => (layout === "face" ? 0 : 1);

/** A "face" family layout: the presenter is the picture (no edge, no shadow). */
export const isFaceLayout = (layout) => layout === "face" || layout === "face-band";

/**
 * Pixel rect for a layout name.
 *
 * `srcAspect` is the take's width/height. A take narrower than the frame (a
 * square or 9:16 portrait shown 16:9) is NOT blown up and cropped for the
 * full-frame layouts: `face` (and `none`, which morphs from it) becomes the
 * CONTAINED rect — full height, centred, the theme background either side —
 * so the whole face stays in shot. `faceFit: "cover"` forces the old
 * full-bleed crop; "contain" forces the letterbox even for a matching take.
 */
export function rectFor(layout, width, height, { srcAspect = null, faceFit = "auto", panelZoom = null } = {}) {
  const r = LAYOUT_RECTS[layout] || LAYOUT_RECTS.face;
  let x = r.x * width, y = r.y * height, w = r.w * width, h = r.h * height;
  const zoom = layout.startsWith("panel-") && panelZoom ? panelZoom : r.zoom;
  const fullFrame = layout === "face" || layout === "none" || layout === "face-band";
  // Whether to letterbox is judged against the FRAME (a take shot at the
  // frame's aspect is always the picture, cropped as the layout needs — the
  // face-band crops its bottom on purpose); the letterbox itself fits the
  // layout's own box (the full frame, or the top band).
  const frameAspect = width / height;
  const boxW = w, boxH = h;
  const boxAspect = boxW / boxH;
  const contain = faceFit === "contain" || (faceFit !== "cover" && srcAspect && Math.abs(srcAspect - frameAspect) > 0.05 * frameAspect);
  if (fullFrame && contain && srcAspect) {
    if (srcAspect < boxAspect) { w = boxH * srcAspect; x = (boxW - w) / 2; }
    else { h = boxW / srcAspect; y = y + (boxH - h) / 2; }
  }
  return {
    x, y, w, h,
    r: r.r * height, zoom, px: r.px, py: r.py,
    opacity: r.hidden ? 0 : 1,
    face: fullFrame ? 1 : 0,
  };
}

/** Pixel box for the content pane under a layout name. */
export function contentBoxFor(layout, width, height) {
  const b = CONTENT_BOX[layout] || { x: 0, y: 0, w: 1, h: 1 };
  return { x: b.x * width, y: b.y * height, w: b.w * width, h: b.h * height, opacity: contentVisible(layout) };
}

/** Field-wise interpolation of two rect-like objects. */
export function lerpRect(a, b, p) {
  const out = {};
  for (const k of Object.keys(b)) out[k] = typeof b[k] === "number" && typeof a[k] === "number" ? lerp(a[k], b[k], p) : b[k];
  return out;
}

/**
 * Which track entry is live at absolute second t, and the one before it (for
 * the move). Entries are sorted and contiguous; the last one is held past its
 * end so a take that runs a hair past the timeline never loses its frame.
 */
export function layoutAt(track, t) {
  if (!track?.length) return { entry: null, prev: null };
  let idx = track.length - 1;
  for (let i = 0; i < track.length; i++) {
    if (t < track[i].toSec) { idx = i; break; }
  }
  return { entry: track[idx], prev: idx > 0 ? track[idx - 1] : null };
}

/**
 * The presenter rect at time t: the live layout's rect, or — inside the first
 * morphMs of an entry — the ease-out blend from the previous layout's rect.
 */
export function presenterRectAt(track, t, width, height, morphMs = MORPH_DEFAULT_MS, fit = {}) {
  const { entry, prev } = layoutAt(track, t);
  if (!entry) return null;
  const to = rectFor(entry.layout, width, height, fit);
  if (!prev || !morphMs) return to;
  const p = (t - entry.fromSec) / (morphMs / 1000);
  if (p >= 1) return to;
  return lerpRect(rectFor(prev.layout, width, height, fit), to, easeOutCubic(p));
}

/**
 * Cover-fit a vw x vh source into a boxW x boxH box, then zoom so that `focus`
 * (fractions of the source frame) fills the box, clamped so the source always
 * covers the box. Returns the wrapper's layout and transform:
 *   { left, top, width, height, scale, tx, ty, originX, originY }
 * No focus (or the whole frame) reduces to a plain cover fit.
 */
export function focusTransform(boxW, boxH, vw, vh, focus) {
  const b = Math.max(boxW / vw, boxH / vh);
  const rw = vw * b;
  const rh = vh * b;
  const left = (boxW - rw) / 2;
  const top = (boxH - rh) / 2;
  const f = focus && focus.w > 0 && focus.h > 0 ? focus : { x: 0, y: 0, w: 1, h: 1 };
  const originX = (f.x + f.w / 2) * rw;
  const originY = (f.y + f.h / 2) * rh;
  let scale = Math.min(boxW / (f.w * rw), boxH / (f.h * rh));
  if (!(scale >= 1)) scale = 1;
  // Scaling about the focus centre keeps that point put; translate it to the
  // box centre, then clamp so no background shows past the footage.
  let tx = boxW / 2 - (left + originX);
  let ty = boxH / 2 - (top + originY);
  // A focus region wider (or taller) than the box can show at scale ≥ 1 —
  // a wide terminal line beside a side panel — is anchored to its LEFT (top)
  // edge instead of centred: UI reads from the left, so that is the edge to keep.
  const regionW = f.w * rw * scale;
  const regionH = f.h * rh * scale;
  if (regionW > boxW + 0.5) tx = -(left + originX + (f.x * rw - originX) * scale);
  if (regionH > boxH + 0.5) ty = -(top + originY + (f.y * rh - originY) * scale);
  const sLeft = left + originX - originX * scale;
  const sRight = left + originX + (rw - originX) * scale;
  const sTop = top + originY - originY * scale;
  const sBottom = top + originY + (rh - originY) * scale;
  if (sLeft + tx > 0) tx = -sLeft;
  if (sRight + tx < boxW) tx = boxW - sRight;
  if (sTop + ty > 0) ty = -sTop;
  if (sBottom + ty < boxH) ty = boxH - sBottom;
  return { left, top, width: rw, height: rh, scale, tx, ty, originX, originY };
}

/** Field-wise blend of two focus rects (either may be null = whole frame). */
export function lerpFocus(a, b, p) {
  const A = a || { x: 0, y: 0, w: 1, h: 1 };
  const B = b || { x: 0, y: 0, w: 1, h: 1 };
  return { x: lerp(A.x, B.x, p), y: lerp(A.y, B.y, p), w: lerp(A.w, B.w, p), h: lerp(A.h, B.h, p) };
}
