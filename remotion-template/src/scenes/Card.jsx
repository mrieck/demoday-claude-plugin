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
export const Card = ({ scene, theme, band = null }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = typeScale(width, height);

  const rise = (delayFrames) =>
    spring({ frame: frame - delayFrames, fps, config: { damping: 200 }, durationInFrames: Math.round(fps * 0.6) });

  const titleIn = rise(0);
  const subIn = rise(Math.round(fps * 0.18));
  const ruleIn = rise(Math.round(fps * 0.32));

  // Band mode (the dynamic style's `face-band` closer): the presenter owns the
  // top of the frame, so the card is a strip along the bottom — logo left of
  // the title, the CTA button under them — on the theme background. The rest
  // of the frame is the same background, underneath the presenter.
  if (band) {
    const bandH = Math.round(height * band);
    const logoH = Math.round(bandH * 0.26);
    return (
      <AbsoluteFill style={{ backgroundColor: theme.bg }}>
        <div
          style={{
            position: "absolute",
            left: 0, right: 0, bottom: 0,
            height: bandH,
            backgroundColor: theme.bg,
            borderTop: `${Math.max(1, Math.round(2 * scale))}px solid ${theme.primary}55`,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            gap: Math.round(bandH * 0.11),
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: Math.round(logoH * 0.45),
              opacity: titleIn,
              transform: `translateY(${interpolate(titleIn, [0, 1], [18, 0])}px)`,
            }}
          >
            {scene.logo ? (
              <Img src={staticFile(scene.logo)} style={{ height: logoH, width: "auto", borderRadius: Math.round(logoH * 0.22) }} />
            ) : null}
            <div style={{ font: `800 ${Math.round(bandH * 0.24)}px/1.1 ${theme.font}`, color: theme.text }}>
              {scene.title}
            </div>
          </div>
          {scene.cta ? (
            <div
              style={{
                font: `700 ${Math.round(bandH * 0.135)}px ${theme.font}`,
                color: theme.text,
                background: theme.primary,
                padding: `${Math.round(bandH * 0.05)}px ${Math.round(bandH * 0.14)}px`,
                borderRadius: Math.round(bandH * 0.05),
                opacity: subIn,
                transform: `translateY(${interpolate(subIn, [0, 1], [14, 0])}px)`,
              }}
            >
              {scene.cta}
            </div>
          ) : null}
        </div>
      </AbsoluteFill>
    );
  }

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
