/**
 * Cursor motion and typing cadence — the difference between footage that looks
 * recorded and footage that looks generated.
 *
 * Shared by both backends: the web backend feeds these points to a synthetic DOM
 * cursor, the macOS backend feeds them to cliclick. The maths is identical; only
 * the thing being moved differs.
 *
 * Three details do most of the work:
 *   1. Ease in AND out. Linear mouse motion reads as robotic instantly.
 *   2. Travel time scales with distance, but sub-linearly (Fitts's law-ish) and is
 *      clamped — a cursor crossing a 4K screen should not take four seconds.
 *   3. A slight arc. Real hands do not move in perfect straight lines.
 */

/** Classic ease-in-out cubic. */
export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Slight overshoot then settle — good for short, decisive moves to a button. */
export function easeOutBack(t, overshoot = 1.1) {
  const c3 = overshoot + 1;
  return 1 + c3 * (t - 1) ** 3 + overshoot * (t - 1) ** 2;
}

/**
 * How long a move of `distance` pixels should take.
 * Sub-linear so long journeys don't drag, clamped at both ends.
 */
export function travelDuration(distance, { minMs = 180, maxMs = 900, perPx = 1.6 } = {}) {
  const ms = Math.sqrt(Math.max(distance, 0)) * perPx * 10;
  return Math.round(Math.min(maxMs, Math.max(minMs, ms)));
}

/**
 * Interpolate a cursor path from `from` to `to`.
 * Returns [{ x, y, atMs }] including both endpoints, sampled at `fps`.
 *
 * `arc` bows the path perpendicular to the direction of travel, proportional to
 * distance, so the cursor curves the way a hand does.
 */
export function path(from, to, { durationMs, fps = 60, ease = easeInOutCubic, arc = 0.08 } = {}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const ms = durationMs ?? travelDuration(distance);

  if (distance < 1) return [{ x: to.x, y: to.y, atMs: 0 }];

  const steps = Math.max(2, Math.round((ms / 1000) * fps));
  // Perpendicular unit vector, for the bow.
  const px = -dy / distance;
  const py = dx / distance;
  const bow = distance * arc;

  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const e = ease(t);
    // sin(pi*t) peaks in the middle and is zero at both ends, so endpoints stay exact.
    const off = Math.sin(Math.PI * t) * bow;
    points.push({
      x: Math.round(from.x + dx * e + px * off),
      y: Math.round(from.y + dy * e + py * off),
      atMs: Math.round(ms * t),
    });
  }
  return points;
}

/**
 * Split text into typing chunks with per-chunk delays.
 *
 * Real typing is not metronomic: it comes in bursts, slows at punctuation, and
 * pauses fractionally at spaces. Typing character-by-character at a fixed interval
 * looks as artificial as pasting the whole string at once.
 */
export function typingPlan(text, { cps = 14, jitter = 0.35 } = {}) {
  const baseMs = 1000 / cps;
  const plan = [];
  let rngState = 1;
  // Deterministic pseudo-random so a re-recorded take is identical.
  const rand = () => {
    rngState = (rngState * 1664525 + 1013904223) % 4294967296;
    return rngState / 4294967296;
  };

  for (const ch of text) {
    let delay = baseMs * (1 + (rand() - 0.5) * 2 * jitter);
    if (ch === " ") delay *= 1.15;
    if (".,;:!?".includes(ch)) delay *= 2.4;  // beat at punctuation
    if (ch === "\n") delay *= 3;
    plan.push({ ch, delayMs: Math.max(8, Math.round(delay)) });
  }
  return plan;
}

/** Total time a typing plan will take, for the pacing calculation. */
export function typingDuration(text, opts) {
  return typingPlan(text, opts).reduce((sum, p) => sum + p.delayMs, 0);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
