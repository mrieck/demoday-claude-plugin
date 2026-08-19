import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { LowerThird } from "../components/LowerThird.jsx";
import { typeScale } from "../theme.js";

/**
 * Full-frame presenter — the intro, the outro, and any beat where a person talking
 * to camera carries more than the product would.
 *
 * The video already contains the narration audio baked in by the avatar model, but
 * we mute it and play the original narration track instead: the source audio is
 * what the mouth was animated to, and using the clean original avoids the slight
 * quality loss of a re-encoded track. The DemoVideo timeline owns the audio.
 */
export const PresenterFull = ({ scene, theme }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();

  // A slow push-in keeps a talking head from feeling like a frozen photo.
  const scale = interpolate(frame, [0, durationInFrames], [1.0, 1.05], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <AbsoluteFill style={{ transform: `scale(${scale})` }}>
        <OffthreadVideo
          src={staticFile(scene.video)}
          muted
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>

      {scene.lowerThird ? (
        <LowerThird
          title={scene.lowerThird.title}
          subtitle={scene.lowerThird.subtitle}
          theme={theme}
          startSec={scene.lowerThird.atSec ?? 0.6}
          fps={fps}
        />
      ) : null}

      {scene.cta ? (
        <div
          style={{
            position: "absolute", left: 0, right: 0,
            // Sits clear of the caption band, which is anchored at 7.5% and is
            // roughly 60px tall. At 12% the two collided on any captioned outro.
            bottom: "24%",
            textAlign: "center",
            font: `700 ${Math.round(46 * typeScale(width, height))}px ${theme.font}`,
            color: theme.text,
            textShadow: "0 4px 18px rgba(0,0,0,.6)",
            opacity: interpolate(frame, [fps * 0.5, fps * 1.2], [0, 1], {
              extrapolateLeft: "clamp", extrapolateRight: "clamp",
            }),
          }}
        >
          <span style={{ borderBottom: `4px solid ${theme.primary}`, paddingBottom: 8 }}>
            {scene.cta}
          </span>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
