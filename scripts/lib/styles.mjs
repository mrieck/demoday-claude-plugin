/**
 * The style catalog — named looks a user picks from at direction time
 * ("which of these is it most like?"), each mapping to concrete defaults.
 *
 * A style is a starting point, not a cage: it seeds format, presenter mode,
 * caption style and transition policy at --init, and records itself on the
 * manifest so the skills can teach the matching beat sheet. Everything it
 * sets can still be overridden per scene.
 */

export const STYLES = {
  launch: {
    aspect: "16:9",
    presenterMode: "hybrid",
    captionsStyle: "clean",
    transitionPolicy: "fades",
    targetShotSec: null,
    usesBeats: false,
    oneLiner: "Classic product demo: presenter intro/outro, narrated screen capture, b-roll.",
    beatSheetHints: [
      "Hook 0-8s: the problem, felt — presenter to camera",
      "Core action 8-24s: the single best flow, voiceover over capture",
      "Context beat: 4-6s of b-roll for breathing room",
      "Payoff then one clear CTA",
    ],
  },
  anchor: {
    aspect: "16:9",
    presenterMode: "always",
    captionsStyle: "clean",
    transitionPolicy: "fades",
    targetShotSec: null,
    usesBeats: false,
    oneLiner: "Avatar-led: the presenter is always on screen — full-frame between demos, corner bubble over them.",
    beatSheetHints: [
      "The presenter carries the video; demos are exhibits",
      "Write presenter lines addressed to camera throughout",
      "Keep demo scenes short — the face is the through-line",
    ],
  },
  explainer: {
    aspect: "16:9",
    presenterMode: "none",
    captionsStyle: "clean",
    transitionPolicy: "fades",
    targetShotSec: null,
    usesBeats: false,
    oneLiner: "No face: motion-graphic cards + voiceover over demos.",
    beatSheetHints: [
      "Cards carry the argument; demos carry the proof",
      "Right for dev tools and infra where a stock face undercuts credibility",
    ],
  },
  listicle: {
    aspect: "9:16",
    presenterMode: "hybrid",
    captionsStyle: "boxed",
    transitionPolicy: "cuts",
    targetShotSec: [0.9, 1.8],
    usesBeats: true,
    oneLiner: "Numbered rundown of 3-5 tools: anchored split home base (speaker below, demo cutting above), full-bleed face punch-ins, animated inserts, #N stamps.",
    beatSheetHints: [
      "Home base: beatLayout 'anchored' + splitPct ~0.42 + bottom presenter (presenterFocusY '50% 22%') — demo cuts in the top pane while the speaker talks below; boxed captions ride the seam automatically",
      "Anchor only 2-3 scenes (hook + one middle + closer) — the rest full-bleed screen/insert beats, which cost nothing",
      "Face punch-ins are full-bleed and SHORT (0.6-2s), reserved for the revelation line ('it's your setup')",
      "One numbered segment per tool: animated insert with title + stamp '#N', then screen cuts (pan framing is the default)",
      "An insert can carry images: [2-5 stills] for the spread effect",
      "Cut the top pane every 1.2-1.5s; captionEmphasis: pain words neg, payoff words pos",
      "Face or anchored closer, then a ~4s CTA card",
    ],
  },
  cohost: {
    aspect: "9:16",
    presenterMode: "hybrid",
    captionsStyle: "shorts",
    transitionPolicy: "fades",
    targetShotSec: null,
    usesBeats: false,
    oneLiner: "Demo on top, presenter talking below throughout; steady scenes.",
    beatSheetHints: [
      "Split framing with a presenter bottom on the hook and outro",
      "Bullets or image bottoms on feature beats",
    ],
  },
  flashcard: {
    aspect: "9:16",
    presenterMode: "none",
    captionsStyle: "boxed",
    transitionPolicy: "cuts",
    targetShotSec: [0.9, 3.0],
    usesBeats: true,
    oneLiner: "No face: big typographic interstitials alternate with full-bleed UI clips on fast cuts.",
    beatSheetHints: [
      "Alternate insert (title) beats with screen beats — text asks, UI answers",
      "Keep titles under 5 words; the voiceover carries the detail",
    ],
  },
  glide: {
    aspect: "9:16",
    presenterMode: "none",
    captionsStyle: "shorts",
    transitionPolicy: "fades",
    targetShotSec: null,
    usesBeats: false,
    oneLiner: "Full-frame demo with click-following pan + karaoke captions.",
    beatSheetHints: [
      "One immersive capture per scene, pan framing, karaoke captions",
      "Right when the UI detail IS the story",
    ],
  },
};

export const STYLE_NAMES = Object.keys(STYLES);

/** One-line-per-style listing for skills and CLI help. */
export function catalog() {
  return STYLE_NAMES.map((n) => {
    const s = STYLES[n];
    return `${n} (${s.aspect}) — ${s.oneLiner}`;
  }).join("\n");
}
