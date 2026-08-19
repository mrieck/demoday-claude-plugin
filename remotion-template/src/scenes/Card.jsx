import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Img, staticFile } from "remotion";
import { typeScale } from "../theme.js";

/**
 * A pure motion-graphics beat: title card, section break, or the closing CTA.
 *
 * This is what stands in for the presenter when presenter.mode is "none", so it has
 * to carry a scene on its own — hence the animated accent rule and the staggered
 * entrance rather than static text on a colour.
 */
export const Card = ({ scene, theme }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = typeScale(width, height);

  const rise = (delayFrames) =>
    spring({ frame: frame - delayFrames, fps, config: { damping: 200 }, durationInFrames: Math.round(fps * 0.6) });

  const titleIn = rise(0);
  const subIn = rise(Math.round(fps * 0.18));
  const ruleIn = rise(Math.round(fps * 0.32));

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
        padding: "0 10%",
      }}
    >
      {/* A soft brand-tinted glow keeps a flat colour from looking like a render error. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 50% 40%, ${theme.primary}22 0%, transparent 62%)`,
        }}
      />

      {scene.logo ? (
        <Img
          src={staticFile(scene.logo)}
          style={{ width: Math.round(width * 0.09), marginBottom: 34, opacity: titleIn }}
        />
      ) : null}

      <div
        style={{
          font: `800 ${Math.round((scene.titleSize || 84) * scale)}px ${theme.font}`,
          color: theme.text,
          opacity: titleIn,
          transform: `translateY(${interpolate(titleIn, [0, 1], [26, 0])}px)`,
          lineHeight: 1.12,
        }}
      >
        {scene.title}
      </div>

      <div
        style={{
          width: interpolate(ruleIn, [0, 1], [0, Math.round(width * 0.09)]),
          height: 5,
          background: theme.primary,
          borderRadius: 3,
          margin: "30px 0",
        }}
      />

      {scene.subtitle ? (
        <div
          style={{
            font: `500 ${Math.round(38 * scale)}px ${theme.font}`,
            color: theme.muted,
            opacity: subIn,
            transform: `translateY(${interpolate(subIn, [0, 1], [18, 0])}px)`,
            maxWidth: "70%",
          }}
        >
          {scene.subtitle}
        </div>
      ) : null}

      {scene.cta ? (
        <div
          style={{
            marginTop: 46,
            font: `700 ${Math.round(40 * scale)}px ${theme.font}`,
            color: theme.text,
            background: theme.primary,
            padding: "16px 40px",
            borderRadius: 14,
            opacity: subIn,
          }}
        >
          {scene.cta}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
