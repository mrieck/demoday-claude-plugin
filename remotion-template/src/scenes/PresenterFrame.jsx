import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { typeScale } from "../theme.js";
import { presenterRectAt, MORPH_DEFAULT_MS } from "../lib/layouts.js";

/**
 * The continuous presenter take, RE-FRAMED over time — the dynamic style's
 * replacement for the fixed corner bubble (PresenterPip).
 *
 * One <OffthreadVideo> lives in one positioned div for the life of the take
 * segment; every frame asks the layout track (presenter.layoutTrack, absolute
 * seconds, built by build-props from the beats' `layout`) which rect the
 * frame occupies and paints the same element there. Because the element is
 * never re-mounted, a move from full-frame face to a corner card is the same
 * clip continuing at the same instant — lips stay on the narration.
 *
 * A layout change is a MOVE, not a cut: over the first `morphMs` of an entry
 * the rect (position, size, corner radius, inner zoom) eases out from the
 * previous layout's rect — measured at 5-6 frames in the reference tutorial.
 * `none` fades the frame out in place. Set presenter.frame.morphMs to 0 for
 * hard cuts.
 */
export const PresenterFrame = ({ video, track, segmentFromSec = 0, theme, morphMs = MORPH_DEFAULT_MS, srcAspect = null, faceFit = "auto", panelZoom = null }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = segmentFromSec + frame / fps;
  // A square/vertical take is letterboxed (centred, full height) for the
  // full-frame layouts instead of cropped to a giant face — see rectFor().
  const rect = presenterRectAt(track, t, width, height, morphMs, { srcAspect, faceFit, panelZoom });
  if (!rect) return null;

  const s = typeScale(width, height);
  // The full-frame face has no edge to draw; everything smaller gets a hairline
  // and a shadow, both fading in as the frame leaves full-bleed.
  const edge = 1 - rect.face; // face and face-band are the picture: no edge
  const borderPx = Math.round(Math.max(2, 3 * s) * edge * 100) / 100;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          borderRadius: rect.r,
          overflow: "hidden",
          opacity: rect.opacity,
          boxSizing: "border-box",
          border: borderPx >= 0.5 ? `${borderPx}px solid ${theme.primary}` : "none",
          boxShadow: edge > 0.01 ? `0 ${Math.round(18 * s)}px ${Math.round(48 * s)}px rgba(0,0,0,${(0.5 * edge).toFixed(3)})` : "none",
          backgroundColor: "#000",
        }}
      >
        <OffthreadVideo
          src={staticFile(video)}
          muted
          startFrom={0}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: `${rect.px}% ${rect.py}%`,
            transform: `scale(${rect.zoom})`,
            transformOrigin: `${rect.px}% ${rect.py}%`,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
