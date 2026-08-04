import React from "react";
import { useCurrentFrame, interpolate, spring, Easing } from "remotion";

/** Name/role strap that slides in under a presenter. */
export const LowerThird = ({ title, subtitle, theme, startSec = 0.6, fps = 30, durationSec = 3.4 }) => {
  const frame = useCurrentFrame();
  const start = startSec * fps;
  const end = (startSec + durationSec) * fps;
  if (frame < start || frame > end) return null;

  const enter = spring({
    frame: frame - start, fps,
    config: { damping: 200 }, durationInFrames: Math.round(fps * 0.45),
  });
  const exit = interpolate(frame, [end - fps * 0.4, end], [1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.ease,
  });

  return (
    <div
      style={{
        position: "absolute",
        left: "7%",
        bottom: "14%",
        transform: `translateX(${interpolate(enter, [0, 1], [-40, 0])}px)`,
        opacity: Math.min(enter, exit),
        borderLeft: `6px solid ${theme.primary}`,
        paddingLeft: 22,
      }}
    >
      <div style={{ font: `700 46px ${theme.font}`, color: theme.text, textShadow: "0 3px 14px rgba(0,0,0,.6)" }}>
        {title}
      </div>
      {subtitle ? (
        <div style={{ font: `500 28px ${theme.font}`, color: theme.muted, marginTop: 6 }}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );
};
