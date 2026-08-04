import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

/**
 * A generated cutscene. Slow Ken Burns drift, because AI b-roll is usually a few
 * seconds of near-static footage and a still push keeps it feeling filmic rather
 * than looped. Slightly darkened so narration and captions stay legible over it.
 */
export const BRollClip = ({ scene, theme }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const scale = interpolate(frame, [0, durationInFrames], [1.04, 1.12], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <AbsoluteFill style={{ transform: `scale(${scale})` }}>
        <OffthreadVideo
          src={staticFile(scene.video)}
          muted={scene.muteSource !== false}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,.18), rgba(0,0,0,.42))" }} />
    </AbsoluteFill>
  );
};
