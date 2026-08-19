import React from "react";
import { interpolate, spring, useVideoConfig } from "remotion";
import { typeScale } from "../theme.js";

/**
 * A label pinned over the footage — "one click", "no config needed".
 *
 * `anchor: "lastClick"` places it next to the most recent click, which is where
 * the viewer is already looking. Otherwise it takes an explicit position.
 */
export const Callout = ({ overlay, events, ms, theme }) => {
  const { fps, width, height } = useVideoConfig();
  const startMs = (overlay.atSec ?? 0) * 1000;
  const durMs = (overlay.durationSec ?? 2.2) * 1000;
  if (ms < startMs || ms > startMs + durMs) return null;

  const localFrame = ((ms - startMs) / 1000) * fps;
  const enter = spring({ frame: localFrame, fps, config: { damping: 200 }, durationInFrames: Math.round(fps * 0.4) });
  const exit = interpolate(ms, [startMs + durMs - 350, startMs + durMs], [1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  let left = `${overlay.xPct ?? 50}%`;
  let top = `${overlay.yPct ?? 80}%`;
  if (overlay.anchor === "lastClick") {
    const prior = events.filter((e) => e.type === "click" && e.atMs <= ms + 200);
    const c = prior[prior.length - 1];
    if (c) {
      left = `${c.xPct}%`;
      // Sit above the click unless that would leave the frame.
      top = `${Math.max(8, c.yPct - 9)}%`;
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        left, top,
        transform: `translate(-50%, -50%) scale(${enter})`,
        opacity: exit,
        background: theme.primary,
        color: "#fff",
        font: `600 ${Math.round(30 * typeScale(width, height))}px ${theme.font}`,
        padding: "12px 22px",
        borderRadius: 999,
        boxShadow: "0 12px 34px rgba(0,0,0,.42)",
        whiteSpace: "nowrap",
      }}
    >
      {overlay.text}
    </div>
  );
};
