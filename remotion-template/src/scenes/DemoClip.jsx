import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { Callout } from "../components/Callout.jsx";

/**
 * A screen-capture segment.
 *
 * The thing that makes this look like a produced demo rather than a screen
 * recording is the ZOOM TO CLICK: the event log written by the capture runner says
 * exactly when and where every click happened, so the frame can drift toward each
 * click just before it lands and ease back out afterwards. A viewer's eye is led to
 * the right part of a 1920px-wide UI instead of hunting for what changed.
 *
 * Zoom is deliberately gentle (1.18x) and always eases; anything punchier reads as
 * a jump cut and makes text mushy, since we are scaling already-rasterised video.
 */

const ZOOM = 1.18;
const LEAD_MS = 500;   // start moving before the click, so the motion feels intentional
const HOLD_MS = 1100;  // stay there long enough to see the result
const OUT_MS = 600;

/**
 * Zoom state at a given time: { scale, originX, originY } in percentages.
 * Overlapping click windows resolve to whichever click is nearest in time, so a
 * rapid sequence of clicks pans between them instead of fighting.
 */
function zoomAt(ms, events, enabled) {
  const clicks = enabled ? events.filter((e) => e.type === "click" && e.x != null) : [];
  if (!clicks.length) return { scale: 1, originX: 50, originY: 50 };

  let best = null;
  for (const c of clicks) {
    const start = c.atMs - LEAD_MS;
    const end = c.atMs + HOLD_MS + OUT_MS;
    if (ms < start || ms > end) continue;
    const distance = Math.abs(ms - c.atMs);
    if (!best || distance < best.distance) best = { click: c, distance, start, end };
  }
  if (!best) return { scale: 1, originX: 50, originY: 50 };

  const { click, start, end } = best;
  const scale = interpolate(
    ms,
    [start, click.atMs, click.atMs + HOLD_MS, end],
    [1, ZOOM, ZOOM, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.ease) }
  );
  return { scale, originX: click.xPct, originY: click.yPct };
}

export const DemoClip = ({ scene, theme, fps }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const ms = (frame / fps) * 1000;

  // Event coordinates are in capture-viewport space; convert to percentages so the
  // zoom origin is correct even when the clip is rendered at a different size.
  const vw = scene.viewport?.width || width;
  const vh = scene.viewport?.height || height;
  const events = (scene.events || []).map((e) => ({
    ...e,
    xPct: e.x != null ? (e.x / vw) * 100 : 50,
    yPct: e.y != null ? (e.y / vh) * 100 : 50,
  }));

  const { scale, originX, originY } = zoomAt(ms, events, scene.zoomToClick !== false);

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <AbsoluteFill
        style={{
          transform: `scale(${scale})`,
          transformOrigin: `${originX}% ${originY}%`,
        }}
      >
        <OffthreadVideo
          src={staticFile(scene.video)}
          // The clip was already paced to the narration during capture, so it plays
          // at natural speed unless the manifest explicitly asks otherwise.
          playbackRate={scene.playbackRate || 1}
          muted={scene.muteSource !== false}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>

      {(scene.overlays || []).map((o, i) => (
        <Callout key={i} overlay={o} events={events} ms={ms} theme={theme} />
      ))}
    </AbsoluteFill>
  );
};
