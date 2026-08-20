import React from "react";
import { staticFile, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { typeScale } from "../theme.js";

// Insets keep the mark out of the zones platform UI covers on vertical video:
// the right edge (like/share rail), the bottom fifth (caption + audio strip)
// and the very top (search/camera icons). "top-left" is the safest default.
const POSITIONS = {
  "top-left": { top: "6%", left: "5%" },
  "top-center": { top: "6%", left: "50%", transform: "translateX(-50%)" },
  "top-right": { top: "6%", right: "5%" },
  "bottom-left": { bottom: "22%", left: "5%" },
  "bottom-right": { bottom: "22%", right: "5%" },
};

export const WATERMARK_POSITIONS = Object.keys(POSITIONS);

/**
 * Persistent channel-handle watermark (text and/or small logo image).
 * Rendered inside a Sequence per contiguous run of scenes that want it, so it
 * fades at run edges instead of popping mid-transition.
 */
export const Watermark = ({ watermark, theme, fps, runFrames }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const scale = typeScale(width, height);

  const opacity = watermark.opacity ?? 0.55;
  const edge = Math.round(fps * 0.25);
  const fade = interpolate(
    frame,
    [0, edge, Math.max(edge + 1, runFrames - edge), runFrames],
    [0, opacity, opacity, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const size = Math.round((watermark.size ?? 34) * scale);

  return (
    <div
      style={{
        position: "absolute",
        display: "flex",
        alignItems: "center",
        gap: Math.round(size * 0.35),
        opacity: fade,
        ...(POSITIONS[watermark.position] || POSITIONS["top-left"]),
      }}
    >
      {watermark.image ? (
        <img
          src={staticFile(watermark.image)}
          style={{ height: Math.round(size * 1.4), width: "auto", display: "block" }}
        />
      ) : null}
      {watermark.text ? (
        <div
          style={{
            font: `600 ${size}px ${theme.font}`,
            color: watermark.color || theme.text,
            textShadow: "0 2px 10px rgba(0,0,0,.55)",
            letterSpacing: 0.5,
            whiteSpace: "nowrap",
          }}
        >
          {watermark.text}
        </div>
      ) : null}
    </div>
  );
};
