/**
 * Scene timing: how long a scene runs, given how long its narration is.
 *
 * THE INVARIANT, and why it exists:
 *
 *   durationSec >= narrationSec + transitionAfterSec + breathSec
 *
 * Transitions OVERLAP the scenes they join — that is what makes them transitions.
 * So if a scene is exactly as long as its narration, the next scene (and its
 * narration) begins `transition` seconds before the current line has finished, and
 * you hear the tail of one sentence underneath the start of the next. It sounds
 * like the voice talking over itself, and it happens at every single cut.
 *
 * The fix is not to shorten the transition or duck the audio — it is to give each
 * scene enough tail that the overlap lands on silence. `breathSec` is what is left
 * over as an audible gap once the transition has taken its share.
 *
 * This module is the single place that computes it, so the TTS step, the capture
 * pacing and the renderer cannot disagree about how long a scene is.
 */

export const DEFAULT_BREATH_SEC = 0.45;

/** Transition duration in seconds that follows a given scene id (0 if none). */
export function transitionAfterSec(manifest, sceneId) {
  const t = (manifest.transitions || []).find((x) => x.after === sceneId);
  return t ? (t.ms ?? 400) / 1000 : 0;
}

/** The breath configured for this project. */
export function breathSec(manifest) {
  const v = manifest?.pacing?.breathSec;
  return Number.isFinite(v) ? v : DEFAULT_BREATH_SEC;
}

/**
 * How long a scene must run so its narration finishes cleanly before the next
 * line starts. This is also the target the capture runner should be paced to —
 * the extra tail becomes a natural hold on the final state of the demo.
 */
export function sceneDuration(manifest, scene, narrationSec) {
  const n = Number(narrationSec) || 0;
  if (!n) return scene.durationSec || 0;
  return round(n + transitionAfterSec(manifest, scene.id) + breathSec(manifest));
}

/** The minimum a scene may be shortened to without clipping its own narration. */
export function minSceneDuration(manifest, scene) {
  const n = Number(scene.narrationSec) || 0;
  if (!n) return 0;
  return round(n + transitionAfterSec(manifest, scene.id) + breathSec(manifest));
}

/**
 * Audible gap between this scene's narration ending and the next one starting.
 * Negative means the two lines overlap — which is the bug this module prevents.
 */
export function gapAfter(manifest, scene) {
  const n = Number(scene.narrationSec) || 0;
  if (!n || !scene.durationSec) return null;
  return round(scene.durationSec - n - transitionAfterSec(manifest, scene.id));
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
