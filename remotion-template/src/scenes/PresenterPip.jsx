import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, spring } from "remotion";
import { typeScale } from "../theme.js";

/**
 * The presenter as a corner bubble over a demo clip — only used when
 * presenter.mode is "always".
 *
 * Deliberately small so it never covers the UI the narration is talking about.
 * Bottom-left is the default: most apps put their primary content top-left, so
 * the bottom corner is the safest place to stand. `pip` carries the manifest's
 * presenter.pip config merged with any scene-level override:
 * { shape: "circle" | "square", position: one of POSITIONS, sizePct, focusY }.
 */
const POSITIONS = {
  "top-left": (m) => ({ left: m, top: m }),
  "top-right": (m) => ({ right: m, top: m }),
  "bottom-left": (m) => ({ left: m, bottom: m }),
  "bottom-right": (m) => ({ right: m, bottom: m }),
};

export const PresenterPip = ({ video, theme, pip = {}, startFromSec = 0 }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = typeScale(width, height);

  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: Math.round(fps * 0.5) });
  const size = Math.round((width * (pip.sizePct ?? 22)) / 100);
  const margin = Math.round(height * 0.05);
  const place = (POSITIONS[pip.position] || POSITIONS["bottom-left"])(margin);
  const radius = pip.shape === "square" ? Math.round(size * 0.12) : "50%";

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          ...place,
          width: size,
          height: size,
          borderRadius: radius,
          overflow: "hidden",
          border: `${Math.max(2, Math.round(4 * scale))}px solid ${theme.primary}`,
          boxShadow: "0 18px 48px rgba(0,0,0,.5)",
          transform: `scale(${enter})`,
        }}
      >
        <OffthreadVideo
          src={staticFile(video)}
          muted
          startFrom={Math.round(startFromSec * fps)}
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: pip.focusY ?? "50% 30%" }}
        />
      </div>
    </AbsoluteFill>
  );
};
