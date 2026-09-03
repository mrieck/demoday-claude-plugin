/**
 * Timing formulas shared between the compositor and the Node-side pipeline.
 *
 * Anything that decides WHEN something appears on screen and also needs to be
 * known outside the render (a sound-effect cue placed by build-props, say)
 * lives here, and is mirrored byte-for-byte in scripts/lib/sfx.mjs —
 * scripts/selftest-sfx.mjs asserts the two agree.
 */

/** When bullet `index` of `count` reveals, in scene-relative seconds. */
export function bulletAppearSec(bullet, index, count, durationSec) {
  return bullet?.atSec ?? ((index + 1) * (durationSec || 6)) / (count + 1);
}
