import React from "react";
import { useCurrentFrame, useVideoConfig, spring } from "remotion";
import { typeScale } from "../theme.js";

/**
 * Word-timed captions, driven by the ElevenLabs timestamps saved alongside each
 * narration track. Grouped into short phrases rather than shown one word at a time,
 * which is easier to read and less strobing on a product video.
 *
 * Most demo videos are watched muted at least once, so this is on by default.
 *
 * Two styles, chosen by captions.style in the manifest:
 *
 *   "clean"  — the original pill: 7-word phrases in a blurred strap near the
 *              bottom edge. Right for landscape demos.
 *   "shorts" — big centered karaoke for vertical Shorts: 2-3 word bursts, the
 *              spoken word pops on a spring in the brand color, heavy black
 *              outline so it survives any footage, and anchored a third of the
 *              way up the frame — clear of the bottom band where the TikTok /
 *              Reels / YouTube-Shorts UI sits. Phrases HOLD until the next one
 *              starts, so captions never flicker off between words.
 */
const MAX_WORDS = 7;
const MAX_GAP_SEC = 0.55;
const SHORTS_MAX_WORDS = 3;
const BOXED_MAX_WORDS = 3;

const NEG_COLOR = "#FF453A";

/** Normalized token for emphasis matching: lowercase, letters/digits/apostrophes. */
const normToken = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * Tone per word index from scene.captionEmphasis [{ match, tone }]. A match may
 * be one word or a phrase of consecutive words; matching is case-insensitive
 * and ignores punctuation.
 */
function emphasisTones(words, emphasis) {
  const tones = new Array(words.length).fill(null);
  if (!emphasis?.length) return tones;
  const tokens = words.map((w) => normToken(w.text));
  for (const e of emphasis) {
    const target = String(e.match).split(/\s+/).map(normToken).filter(Boolean);
    if (!target.length) continue;
    for (let i = 0; i + target.length <= tokens.length; i++) {
      if (target.every((t, j) => tokens[i + j] === t)) {
        for (let j = 0; j < target.length; j++) tones[i + j] = e.tone;
      }
    }
  }
  return tones;
}

function groupIntoPhrases(words, maxWords = MAX_WORDS) {
  const phrases = [];
  let current = null;
  for (const w of words) {
    const startNew =
      !current ||
      current.words.length >= maxWords ||
      w.startSec - current.endSec > MAX_GAP_SEC ||
      /[.!?]$/.test(current.words.at(-1).text);
    if (startNew) {
      current = { startSec: w.startSec, endSec: w.endSec, words: [w] };
      phrases.push(current);
    } else {
      current.words.push(w);
      current.endSec = w.endSec;
    }
  }
  return phrases;
}

/**
 * Where the boxed caption sits, as a fraction of frame height. Three named
 * placements:
 *   "seam" — centered ON the split seam line (half over the demo, half over
 *            the speaker) — the reference-Short look for anchored beat scenes
 *   "mid"  — the classic 52% center (the default; old manifests unchanged)
 *   "low"  — ~68%, for full-bleed face punch-ins (clear of the face)
 * A beat's captionPlacement wins; otherwise an anchored scene derives it from
 * the active beat's shot (pane → seam, face → low, else mid); otherwise the
 * scene's captionPlacement; otherwise mid.
 */
function boxedTopFraction(t, { beats, anchored, scenePlacement, splitPct }) {
  let p = scenePlacement;
  if (beats?.length) {
    let active = null;
    for (const b of beats) {
      if (t >= b.atSec) active = b;
      else break;
    }
    if (active) {
      if (active.captionPlacement) p = active.captionPlacement;
      else if (anchored) {
        const shot = active.shot ?? "screen";
        p = shot === "screen" || shot === "split" ? "seam" : shot === "face" ? "low" : "mid";
      }
    }
  }
  return p === "seam" ? splitPct : p === "low" ? 0.68 : 0.52;
}

/**
 * Boxed phrase cards — the fast-social-video caption: 1-3 words at a time,
 * white on a translucent box, centered mid-frame so it reads over any shot
 * (face, screen, insert alike). The phrase enters as a UNIT with one spring
 * pop — no per-word karaoke; the per-word channel is COLOR, driven by the
 * scene's captionEmphasis: pain words in red, payoff words in the brand color.
 */
const BoxedCaptions = ({ words, theme, t, fps, width, height, emphasis, beats, anchored, scenePlacement, splitPct = 0.55 }) => {
  const phrases = groupIntoPhrases(words, BOXED_MAX_WORDS);
  const tones = emphasisTones(words, emphasis);
  // Word index base per phrase, so tone lookup survives the grouping.
  let base = 0;
  const withBase = phrases.map((p) => {
    const entry = { phrase: p, base };
    base += p.words.length;
    return entry;
  });

  let active = null;
  for (let i = 0; i < withBase.length; i++) {
    const start = withBase[i].phrase.startSec - 0.08;
    const end = i < withBase.length - 1 ? withBase[i + 1].phrase.startSec - 0.08 : withBase[i].phrase.endSec + 0.35;
    if (t >= start && t < end) { active = { ...withBase[i], start }; break; }
  }
  if (!active) return null;

  const s = typeScale(width, height);
  const pop = spring({
    frame: Math.round((t - active.start) * fps),
    fps,
    config: { damping: 200 },
    durationInFrames: Math.round(fps * 0.18),
  });

  const topPct = boxedTopFraction(t, { beats, anchored, scenePlacement, splitPct });

  return (
    <div
      style={{
        position: "absolute",
        left: "6%", right: "6%",
        top: `${(topPct * 100).toFixed(2)}%`,
        display: "flex",
        justifyContent: "center",
        transform: `translateY(-50%) scale(${0.92 + 0.08 * pop})`,
      }}
    >
      <div
        style={{
          background: "rgba(40,40,40,.75)",
          borderRadius: Math.round(18 * s),
          padding: "0.32em 0.7em",
          font: `800 ${Math.round(58 * s)}px/1.2 ${theme.font}`,
          textAlign: "center",
        }}
      >
        {active.phrase.words.map((w, i) => {
          const tone = tones[active.base + i];
          // Color alone carries the emphasis — scaling adjacent emphasized
          // words eats the word gaps and fuses them.
          const color = tone === "neg" ? NEG_COLOR : tone === "pos" ? theme.primary : "#fff";
          return (
            <span
              key={i}
              style={{
                color,
                display: "inline-block",
                marginRight: i < active.phrase.words.length - 1 ? "0.28em" : 0,
              }}
            >
              {w.text}
            </span>
          );
        })}
      </div>
    </div>
  );
};

const ShortsCaptions = ({ words, theme, t, fps, width, height, placement = "default", splitPct = 0.55 }) => {
  const phrases = groupIntoPhrases(words, SHORTS_MAX_WORDS);

  let active = null;
  for (let i = 0; i < phrases.length; i++) {
    const start = phrases[i].startSec - 0.08;
    // Hold through the gap: a phrase stays up until the next one begins.
    const end = i < phrases.length - 1 ? phrases[i + 1].startSec - 0.08 : phrases[i].endSec + 0.35;
    if (t >= start && t < end) { active = phrases[i]; break; }
  }
  if (!active) return null;

  const s = typeScale(width, height);
  // "bottom" = the captions own a split scene's bottom zone: bigger, centered
  // in the zone. "seam" = other content owns the zone: same size, anchored in
  // the reserved band just under the seam. "default" = the classic 33% anchor.
  const fontSize = Math.round((placement === "bottom" ? 78 : 64) * s);
  const strokePx = Math.max(2, Math.round(8 * s));

  const position =
    placement === "seam"
      ? { top: Math.round(height * (splitPct + 0.02)) }
      : placement === "bottom"
        ? { top: Math.round(height * (splitPct + (1 - splitPct) / 2)), transform: "translateY(-50%)" }
        : { bottom: Math.round(height * 0.33) };

  // The outline is an underlay: a duplicate of the line with a fat stroke,
  // sitting behind the fill. Stroking the fill span directly eats the glyphs
  // from the inside. Both layers get identical layout and transforms, so the
  // stroke pops with its word.
  const line = (isStroke) => (
    <div
      aria-hidden={isStroke || undefined}
      style={{
        position: isStroke ? "absolute" : "relative",
        inset: isStroke ? 0 : undefined,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        // The stroke underlay bleeds half the stroke width into each side of a
        // gap, so the gap must be wide enough to survive it or words fuse.
        gap: `0.1em ${Math.round(0.42 * fontSize + strokePx)}px`,
        font: `800 ${fontSize}px/1.18 ${theme.font}`,
        textShadow: isStroke ? "0 6px 28px rgba(0,0,0,.55)" : undefined,
      }}
    >
      {active.words.map((w, i) => {
        const on = t >= w.startSec && t <= w.endSec;
        const pop = t >= w.startSec
          ? spring({
              frame: Math.round((t - w.startSec) * fps),
              fps,
              config: { damping: 15, mass: 0.5, stiffness: 200 },
            })
          : 0;
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              transform: `scale(${1 + 0.15 * pop})`,
              color: isStroke ? "#000" : on ? theme.primary : "#fff",
              WebkitTextStroke: isStroke ? `${strokePx}px rgba(0,0,0,.9)` : undefined,
            }}
          >
            {w.text}
          </span>
        );
      })}
    </div>
  );

  return (
    <div
      style={{
        position: "absolute",
        left: "8%",
        right: "8%",
        ...position,
      }}
    >
      <div style={{ position: "relative" }}>
        {line(true)}
        {line(false)}
      </div>
    </div>
  );
};

export const Captions = ({ words, theme, offsetSec = 0, style = "clean", placement = "default", splitPct = 0.55, emphasis, beats, anchored, scenePlacement }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  if (!words?.length) return null;

  const t = frame / fps + offsetSec;

  if (style === "boxed") {
    return (
      <BoxedCaptions
        words={words} theme={theme} t={t} fps={fps} width={width} height={height}
        emphasis={emphasis} beats={beats} anchored={anchored}
        scenePlacement={scenePlacement} splitPct={splitPct}
      />
    );
  }

  if (style === "shorts") {
    return (
      <ShortsCaptions
        words={words} theme={theme} t={t} fps={fps} width={width} height={height}
        placement={placement} splitPct={splitPct}
      />
    );
  }

  const phrases = groupIntoPhrases(words);
  const active = phrases.find((p) => t >= p.startSec - 0.08 && t <= p.endSec + 0.35);
  if (!active) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: 0, right: 0,
        bottom: Math.round(height * 0.075),
        display: "flex",
        justifyContent: "center",
        padding: "0 8%",
      }}
    >
      <div
        style={{
          background: "rgba(8,10,16,.82)",
          backdropFilter: "blur(6px)",
          borderRadius: 14,
          padding: "14px 26px",
          font: `600 ${Math.round(36 * typeScale(width, height))}px/1.28 ${theme.font}`,
          color: theme.text,
          textAlign: "center",
          maxWidth: "100%",
        }}
      >
        {active.words.map((w, i) => {
          // Light emphasis on the word currently being spoken.
          const on = t >= w.startSec && t <= w.endSec;
          return (
            <span key={i} style={{ color: on ? theme.primary : theme.text }}>
              {w.text}
              {i < active.words.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
};
