import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, spring } from "remotion";

/**
 * The presenter as a corner bubble over a demo clip — only used when
 * presenter.mode is "always".
 *
 * Deliberately small and bottom-left: it must not cover the UI the narration is
 * talking about, and most apps put their primary content top-left, so the bottom
 * corner is the safest place to stand.
 */
export const PresenterPip = ({ video, theme, sizePct = 22 }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: Math.round(fps * 0.5) });
  const size = Math.round((width * sizePct) / 100);
  const margin = Math.round(height * 0.05);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: margin,
          bottom: margin,
          width: size,
          height: size,
          borderRadius: "50%",
          overflow: "hidden",
          border: `4px solid ${theme.primary}`,
          boxShadow: "0 18px 48px rgba(0,0,0,.5)",
          transform: `scale(${enter})`,
        }}
      >
        <OffthreadVideo
          src={staticFile(video)}
          muted
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </div>
    </AbsoluteFill>
  );
};
