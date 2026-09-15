/**
 * The style catalog — named looks a user picks from at direction time
 * ("which of these is it most like?"), each mapping to concrete defaults.
 *
 * A style is a starting point, not a cage: it seeds format, presenter mode,
 * caption style and transition policy at --init, and records itself on the
 * manifest so the skills can teach the matching beat sheet. Everything it
 * sets can still be overridden per scene.
 *
 * `coverLayout` is the frame-0 hook-card layout a vertical style scaffolds
 * (manifest.COVER_LAYOUTS); each style defaults to a different one so Shorts of
 * different styles never share a thumbnail silhouette. Null for landscape.
 */

export const STYLES = {
  launch: {
    coverLayout: null,
    sfxAuto: { transition: "whoosh", card: "riser" },
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
    coverLayout: null,
    sfxAuto: { transition: "whoosh", card: "riser" },
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
  tutorial: {
    coverLayout: null,
    sfxAuto: { transition: "whoosh", card: "riser", bullet: "tick" },
    aspect: "16:9",
    presenterMode: "always",
    // The bubble is ONE continuous lip-synced take laid under every cut
    // (gen/presenter.mjs --take is what --all does for this style), so it
    // never pops in/out between steps. Bottom-right: most apps put their
    // primary content and navigation top-left. Zoom-to-click is off because
    // the whole UI is the point of a walkthrough and the push-in crops it.
    pip: { shape: "circle", position: "bottom-right", sizePct: 18 },
    continuousPip: true,
    zoomToClick: false,
    // Avatar-seconds bill per second of finished video, and the bubble runs
    // the whole length — so tutorials default short. A user can ask for more.
    targetLengthSec: 75,
    captionsStyle: "clean",
    transitionPolicy: "cuts",
    targetShotSec: null,
    usesBeats: false,
    oneLiner: "Step-by-step walkthrough: the full workflow on screen, the presenter riding along as a corner bubble.",
    beatSheetHints: [
      "Default length ~60-90s (the bubble bills avatar-seconds for the whole runtime); go longer only when the user asks",
      "Open with a 5-8s framing scene: what we are setting up and why, bubble talking over the app's start state",
      "One scene per step, numbered in the narration ('Step two: paste your API key'), ~5-9s each — short steps, quick cuts",
      "The screen is the hero: full-frame capture throughout, hard cuts between steps, no b-roll, no zoom-to-click",
      "Capture per step (default), or chop one continuous screen take with scene-level videoStartSec",
      "Recap over the finished state, then a card with the CTA — the bubble stays up through the card",
    ],
  },
  dynamic: {
    coverLayout: null,
    // Frame 0 is the poster of every README/embedded player, so the style
    // scaffolds the hook band over the real first frame (validate() refuses
    // to render until cover.hook is written; delete the block to opt out).
    coverKind: "overlay",
    sfxAuto: { transition: "whoosh", card: "riser" },
    aspect: "16:9",
    presenterMode: "always",
    // ONE continuous lip-synced take (like tutorial) — but instead of a fixed
    // corner bubble it is RE-FRAMED every few seconds: full-frame face, a tall
    // side panel next to the screen, a small corner card over it. Beats carry
    // `layout`; the renderer moves the frame between layouts over frame.morphMs
    // with the screen content fading beneath. Measured from the reference
    // tutorial (2026-09-13): 48 shots in 268s, ~40% face / ~40% panel / ~20%
    // card, every move ~0.2s ease-out, content zoomed 2-3x into the element
    // being discussed, word-by-word captions always on.
    continuousPip: true,
    takeAspect: "16:9",        // face shots fill the frame, so the take is shot wide
    // morphMs: the move; pace "lively" = a move every 4-6s (measured), "calm"
    // = one layout per step for a plain walkthrough (plan.mjs --pace calm);
    // faceFit "auto" letterboxes a square/vertical take instead of cropping it.
    frame: { morphMs: 200, pace: "lively", faceFit: "auto" },
    zoomToClick: false,        // beats zoom with `focus` instead
    targetLengthSec: 120,
    captionsStyle: "buildup",
    transitionPolicy: "cuts",
    targetShotSec: [4, 6],
    usesBeats: true,
    rules: {
      layouts: true,           // enables the layout-track checks in validate()/qa
      openWithinSec: 3,        // first layout change (the hook cut) by this second
      maxLayoutHoldSec: 12,    // nothing stays in one framing longer
      calmMaxLayoutHoldSec: 30, // pace "calm": a whole step in one framing is fine, a minute is not
      targetShots: [20, 28],   // at ~120s; scaled by runtime when shorter
      layoutMix: { face: 0.4, panel: 0.4, card: 0.2 },
      mixTolerance: 0.15,
      closeOnFace: true,       // the CTA is spoken to camera
      noTransitions: true,     // scene transitions would drift the take's lip-sync
      focusMinW: 0.3,          // tighter than 30% of the frame is mush
    },
    oneLiner: "Dynamic tutorial: one continuous presenter take re-framed every 4-6s (full-face / side panel / corner card) over zoomed-in screen beats, build-up captions always on.",
    beatSheetHints: [
      "Default length ~120s (~300 words at 2.5 wps); the take bills avatar-seconds for the whole runtime",
      "Open on a `face` beat for ≤3s with the hook/proof, then move to `panel-left` over the app",
      "One scene per tutorial step, 10-15s, with 2-3 layout beats each: { atSec, layout, videoStartSec?, focus? }",
      "Mix ≈ 40% face / 40% panel / 20% card; never hold one layout past 12s; cut on clause boundaries",
      "Ask which pace: lively (the creator look above) or calm — presenter.frame.pace \"calm\" (plan.mjs --pace calm) for a plain walkthrough: face for the intro/outro, one panel or card layout per step, moves only at step boundaries",
      "Every screen beat gets a `focus` box (w 0.3-0.5) around the field/button the narration names; whole-window shots only when the layout is the point",
      "Pick the card corner AWAY from the UI element being shown; use `layout: \"none\"` (never pip: false) to clear the frame",
      "A videoStartSec jump inside a layout is a 0.2s zoom-dissolve; a focus change on the same clip glides",
      "Close with ONE spoken CTA: the CTA card gets `layout: \"face-band\"` — the presenter across the top, logo + title + URL button in a band below (the crop also hides an avatar's stray hands at the bottom of the take)",
      "Captions are build-up phrases with one boxed emphasis word (auto-picked); add captionEmphasis only to override",
    ],
  },
  explainer: {
    coverLayout: null,
    sfxAuto: { insert: "whoosh", stamp: "pop", bullet: "tick", coverExit: "whoosh", transition: "whoosh", card: "riser" },
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
    coverLayout: "band",
    coverKind: "overlay",   // the band over the real first frame, not a full card
    sfxAuto: { insert: "whoosh", stamp: "pop", face: "hit", bullet: "tick", coverExit: "whoosh", transition: "whoosh", card: "riser" },
    aspect: "9:16",
    presenterMode: "hybrid",
    captionsStyle: "boxed",
    transitionPolicy: "cuts",
    targetShotSec: [0.9, 1.6],
    // Hard rules measured against the strongest TikTok listicles (2026-09-10,
    // ten top-performing creator Shorts, 17-24 shots in 28-37s): the screen is always
    // moving under the text, the hook cuts away from the face inside a
    // second, nothing holds longer than 2.5s, and text never sits on a blank
    // card. validate() and qa.mjs enforce them.
    rules: {
      hookCutSec: 1.0,        // first cut to a visual (screen/insert-with-image) by this second
      maxShotSec: 2.5,        // longest beat window / non-closer scene
      insertMaxSec: 0.8,      // an insert (image spread) is a flash, not a card
      textOnlyInserts: false, // insert beats must carry image(s); stamps/titles go OVER screen beats
      leadMagnetCta: true,    // closer narration names a comment/DM word, not "follow for more"
      oneCta: true,           // exactly one ask: a comment word means NO follow card / follow line
    },
    usesBeats: true,
    oneLiner: "Numbered rundown of 3-5 steps/tools: real screen recording cutting above, speaker below, #N stamps OVER the UI, never a text-only card.",
    beatSheetHints: [
      "Hook: a claim with tension ('Claude just killed X', 'You're using X wrong'), never an announcement — anchored split, top pane on a real screen from second 0, face-only for at most 1s",
      "Home base: beatLayout 'anchored' + splitPct ~0.42 + bottom presenter (presenterFocusY '50% 22%') — the top pane is a REAL recording of the tool running (terminal, app, browser being driven), not a website being scrolled",
      "One numbered step per item: put stamp '#N' on the FIRST screen beat of the step (the numeral pops over the moving UI); no insert(title) cards — a title-only insert is a stall",
      "Insert beats only as image spreads (2-5 stills) and only for ≤0.8s; a screen beat with a stamp does the job of a title card",
      "Every step shows a PROOF: the command typed, the thing happening, the result on screen — say what to do, show it done",
      "Cut the top pane every 0.9-1.6s (videoStartSec jumps to the best moments); no window over 2.5s except the closer",
      "Face punch-ins are full-bleed and SHORT (0.6-2s): the revelation line and the CTA only",
      "Closer is a FULL-SCREEN presenter scene (no split) with ONE ask: 'DM me the word DEMO and I'll send you the link. If you're on TikTok, the link's in my bio.' — never 'comment' (nothing answers comments), never a follow card or follow line after it (one CTA per video)",
      "Cover is the band overlay (cover.kind 'overlay'): the real first frame plays underneath, the hook band sits over the demo pane at 22-46% and slides up after 0.5s",
      "Boxed captions are 1-3 words at the seam; captionEmphasis: pain words neg, payoff words pos",
    ],
  },
  cohost: {
    coverLayout: "corner",
    sfxAuto: { transition: "whoosh", coverExit: "whoosh", bullet: "tick", card: "riser" },
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
    coverLayout: "stack",
    sfxAuto: { insert: "whoosh", stamp: "pop", bullet: "tick", coverExit: "whoosh", transition: "whoosh", card: "riser" },
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
    coverLayout: "stripe",
    sfxAuto: { transition: "whoosh", coverExit: "whoosh", card: "riser" },
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
