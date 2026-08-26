import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { typeScale } from "../theme.js";

/**
 * The cover: a hook card that IS frame 0, then gets out of the way.
 *
 * Vertical platforms take an early frame as the thumbnail and the posting API
 * cannot override it, so this card is what a channel grid shows for the video.
 * That fixes its motion contract, which is the opposite of scenes/Card.jsx:
 * everything is fully drawn at frame 0 — no spring-in, no fade, nothing at
 * partial opacity — it holds for `holdSec`, then exits over `outSec` to reveal
 * the first scene (whose narration is already running underneath).
 *
 * Four layouts + an accent colour give the grid its variety; the skill rotates
 * them per video. All text stays out of the platform-UI zones (right ~14%,
 * bottom ~22%, top ~6%), the same insets Watermark.jsx uses.
 */

const EXITS = {
  "wipe-up": (p, w, h) => ({ transform: `translateY(${-h * p}px)` }),
  "slide-left": (p, w) => ({ transform: `translateX(${-w * p}px)` }),
  dissolve: (p) => ({ opacity: 1 - p }),
  cut: () => ({}),
};

/**
 * The frozen-frame cover (cover.kind "frame"): no card, just the video's own
 * frame from `frameSec` held at frame 0 — the poster a creator would pick from
 * a timestamp — then a hard cut (or one of the EXITS) to the real start.
 * The frozen content is passed in as children (the visual tree inside <Freeze>).
 */
export const FrameCover = ({ cover, fps, children }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const hold = Math.round((cover.holdSec ?? 0.45) * fps);
  const out = Math.round((cover.outSec ?? 0) * fps);
  const p = out > 0
    ? interpolate(frame, [hold, hold + out], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) })
    : 0;
  const exit = (EXITS[cover.exit] || EXITS.cut)(p, width, height);
  return <AbsoluteFill style={exit}>{children}</AbsoluteFill>;
};

/** Hook size by length: three lines of huge type beats five lines of medium. */
const hookPx = (text, s) => {
  const n = (text || "").length;
  // Judged at grid size (~270px wide): under ~9% of frame width per line the
  // hook is unreadable next to other thumbnails.
  return Math.round((n <= 22 ? 132 : n <= 38 ? 116 : n <= 50 ? 102 : 90) * s);
};

const Kicker = ({ text, accent, s, font, style }) =>
  text ? (
    <div
      style={{
        font: `700 ${Math.round(30 * s)}px ${font}`,
        letterSpacing: Math.round(4 * s),
        textTransform: "uppercase",
        color: accent,
        ...style,
      }}
    >
      {text}
    </div>
  ) : null;

const Portrait = ({ src, accent, size, style }) =>
  src ? (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        overflow: "hidden",
        border: `${Math.max(4, Math.round(size * 0.035))}px solid ${accent}`,
        boxShadow: "0 18px 60px rgba(0,0,0,.55)",
        flex: "0 0 auto",
        ...style,
      }}
    >
      <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
    </div>
  ) : null;

const Glow = ({ accent }) => (
  <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 35%, ${accent}2e 0%, transparent 60%)` }} />
);

/* ---- layouts ------------------------------------------------------------- */

const Stack = ({ cover, theme, s, width }) => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", textAlign: "center", padding: "0 9% 14% 9%" }}>
    <Glow accent={cover.accent} />
    <Portrait src={cover.portrait} accent={cover.accent} size={Math.round(width * 0.24)} style={{ marginBottom: Math.round(36 * s) }} />
    <Kicker text={cover.kicker} accent={cover.accent} s={s} font={theme.font} style={{ marginBottom: Math.round(26 * s) }} />
    <div style={{ font: `800 ${hookPx(cover.hook, s)}px/1.08 ${theme.font}`, color: theme.text, textWrap: "balance" }}>
      {cover.hook}
    </div>
    <div style={{ width: Math.round(width * 0.12), height: Math.round(7 * s), background: cover.accent, borderRadius: 4, marginTop: Math.round(40 * s) }} />
  </AbsoluteFill>
);

const Band = ({ cover, theme, s, width, height }) => (
  <AbsoluteFill>
    <Glow accent={cover.accent} />
    <Kicker
      text={cover.kicker}
      accent={theme.text}
      s={s}
      font={theme.font}
      style={{ position: "absolute", top: "13%", left: "8%", right: "16%", opacity: 0.85 }}
    />
    <div
      style={{
        position: "absolute",
        left: "-6%",
        right: "-6%",
        top: "31%",
        height: "34%",
        background: cover.accent,
        transform: "rotate(-3deg)",
        boxShadow: "0 30px 90px rgba(0,0,0,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: `0 ${Math.round(width * 0.12)}px 0 ${Math.round(width * 0.14)}px`,
      }}
    >
      <div style={{ font: `800 ${hookPx(cover.hook, s)}px/1.06 ${theme.font}`, color: theme.bg, textAlign: "left", width: "100%", textWrap: "balance" }}>
        {cover.hook}
      </div>
    </div>
    <Portrait
      src={cover.portrait}
      accent={cover.accent}
      size={Math.round(width * 0.24)}
      style={{ position: "absolute", left: "8%", bottom: "22%" }}
    />
  </AbsoluteFill>
);

const Corner = ({ cover, theme, s, width, height }) => (
  <AbsoluteFill>
    <Glow accent={cover.accent} />
    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: Math.round(width * 0.035), background: cover.accent }} />
    <div style={{ position: "absolute", top: "12%", left: "10%", right: "18%" }}>
      <Kicker text={cover.kicker} accent={cover.accent} s={s} font={theme.font} style={{ marginBottom: Math.round(28 * s) }} />
      <div style={{ font: `800 ${hookPx(cover.hook, s)}px/1.06 ${theme.font}`, color: theme.text, textAlign: "left" }}>
        {cover.hook}
      </div>
    </div>
    <Portrait
      src={cover.portrait}
      accent={cover.accent}
      size={Math.round(width * 0.3)}
      style={{ position: "absolute", right: "16%", bottom: "24%" }}
    />
    {!cover.portrait ? (
      <div style={{ position: "absolute", left: "10%", bottom: "26%", width: Math.round(width * 0.18), height: Math.round(7 * s), background: cover.accent, borderRadius: 4 }} />
    ) : null}
  </AbsoluteFill>
);

const Stripe = ({ cover, theme, s, width, height }) => (
  <AbsoluteFill>
    <Glow accent={cover.accent} />
    <div
      style={{
        position: "absolute",
        // Below the hook, never behind it: white type on a light accent is
        // the one combination that fails at grid size.
        left: "-20%",
        right: "-20%",
        top: "66%",
        height: "20%",
        background: cover.accent,
        transform: "rotate(-12deg)",
        opacity: 0.95,
      }}
    />
    <div
      style={{
        position: "absolute",
        left: "-20%",
        right: "-20%",
        top: "88%",
        height: "4%",
        background: theme.text,
        opacity: 0.12,
        transform: "rotate(-12deg)",
      }}
    />
    <Kicker
      text={cover.kicker}
      accent={cover.accent}
      s={s}
      font={theme.font}
      style={{ position: "absolute", top: "12%", left: "8%", right: "16%" }}
    />
    <Portrait
      src={cover.portrait}
      accent={cover.accent}
      size={Math.round(width * 0.22)}
      style={{ position: "absolute", top: "18%", right: "16%" }}
    />
    <div
      style={{
        position: "absolute",
        left: "8%",
        right: "16%",
        bottom: "40%",
        font: `800 ${hookPx(cover.hook, s)}px/1.06 ${theme.font}`,
        color: theme.text,
        textAlign: "left",
        textShadow: "0 6px 30px rgba(0,0,0,.5)",
      }}
    >
      {cover.hook}
    </div>
  </AbsoluteFill>
);

const LAYOUTS = { stack: Stack, band: Band, corner: Corner, stripe: Stripe };

export const HookCard = ({ cover, theme, fps }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const s = typeScale(width, height);

  const hold = Math.round((cover.holdSec ?? 0.5) * fps);
  const out = Math.max(1, Math.round((cover.outSec ?? 0.5) * fps));
  // 0 through the hold, 0→1 across the exit. Frame 0 is always p = 0: fully drawn.
  const p = interpolate(frame, [hold, hold + out], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const exit = (EXITS[cover.exit] || EXITS["wipe-up"])(p, width, height);
  const Layout = LAYOUTS[cover.layout] || Stack;
  const accent = /^#[0-9a-f]{6}$/i.test(cover.accent || "") ? cover.accent : theme.primary;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, ...exit }}>
      <Layout cover={{ ...cover, accent }} theme={theme} s={s} width={width} height={height} />
    </AbsoluteFill>
  );
};
