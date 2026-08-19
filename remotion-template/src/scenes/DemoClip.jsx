import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { Callout } from "../components/Callout.jsx";
import { typeScale } from "../theme.js";

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
 *
 * FRAMING. When the composition and the capture have roughly the same aspect, the
 * clip fills the frame ("cover", the classic behavior). When the composition is
 * much taller than the capture — a 16:9 recording inside a 9:16 Short — cover
 * would keep only the middle third of the UI, so the default becomes "pan": the
 * source fills the frame's height and a sliding window follows the click log,
 * arriving on each click and HOLDING there until the next one (constant drifting
 * reads as jitter at this scale). "card" letterboxes the whole UI into a styled
 * card with an optional headline, for dashboards where any crop destroys context.
 */

const ZOOM = 1.18;
const LEAD_MS = 500;   // start moving before the click, so the motion feels intentional
const HOLD_MS = 1100;  // stay there long enough to see the result
const OUT_MS = 600;

const PAN_RAMP_MS = 600;     // travel time into each click
const PAN_MIN_STEP_MS = 50;  // keyframe times must strictly increase

/**
 * Composition-level framing decision. `split` (demo on top, content slot below —
 * see SplitScene) is the house style for a vertical Short cut from landscape
 * footage; SplitScene then re-enters DemoClip for its top zone, where the
 * component's own internal default (pan vs cover, judged against the ZONE's
 * aspect) takes over. Without a known viewport the scene stays full-frame.
 */
export function framingFor(scene, compW, compH) {
  if (scene.framing) return scene.framing;
  const vw = scene.viewport?.width || compW;
  const vh = scene.viewport?.height || compH;
  return compW / compH < (vw / vh) * 0.85 ? "split" : "cover";
}

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

/**
 * Horizontal pan center (in SOURCE percent) at a given time.
 *
 * Piecewise keyframes built from the click log: hold the previous position until
 * PAN_RAMP_MS before a click, ease to the click's x by the moment it lands, hold
 * until the next click's ramp. No return-to-center — a resting frame should sit
 * still. Clicks closer together than the ramp simply chain into continuous motion.
 */
function panCenterAt(ms, events, enabled) {
  const clicks = enabled
    ? events.filter((e) => e.type === "click" && e.x != null).slice().sort((a, b) => a.atMs - b.atMs)
    : [];
  if (!clicks.length) return 50;

  const times = [0];
  const values = [50];
  for (const c of clicks) {
    const rampStart = c.atMs - PAN_RAMP_MS;
    if (rampStart > times[times.length - 1] + PAN_MIN_STEP_MS) {
      times.push(rampStart);
      values.push(values[values.length - 1]);
    }
    times.push(Math.max(c.atMs, times[times.length - 1] + PAN_MIN_STEP_MS));
    values.push(c.xPct);
  }
  if (times.length < 2) return values[values.length - 1];

  return interpolate(ms, times, values, {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.ease),
  });
}

// boxW/boxH let SplitScene render this inside a sized zone instead of the full
// composition; every calculation below runs against the box, and the absolute
// positioning resolves against the nearest positioned ancestor (the zone div).
// startFromSec (used by beat windows) offsets the source video AND the event
// clock together, so zoom/pan still land on the clicks after a mid-scene jump.
export const DemoClip = ({ scene, theme, fps, boxW, boxH, startFromSec = 0 }) => {
  const frame = useCurrentFrame();
  const { width: compW, height: compH } = useVideoConfig();
  const width = boxW ?? compW;
  const height = boxH ?? compH;
  const ms = (frame / fps + startFromSec) * 1000;

  // Event coordinates are in capture-viewport space; convert to percentages so the
  // zoom origin is correct even when the clip is rendered at a different size.
  const vw = scene.viewport?.width || width;
  const vh = scene.viewport?.height || height;
  const events = (scene.events || []).map((e) => ({
    ...e,
    xPct: e.x != null ? (e.x / vw) * 100 : 50,
    yPct: e.y != null ? (e.y / vh) * 100 : 50,
  }));

  const srcAspect = vw / vh;
  const compAspect = width / height;
  const mode =
    scene.framing || (compAspect < srcAspect * 0.85 ? "pan" : "cover");

  const video = (style) => (
    <OffthreadVideo
      src={staticFile(scene.video)}
      startFrom={Math.round(startFromSec * fps)}
      // The clip was already paced to the narration during capture, so it plays
      // at natural speed unless the manifest explicitly asks otherwise.
      playbackRate={scene.playbackRate || 1}
      muted={scene.muteSource !== false}
      style={style}
    />
  );

  // ---- card: the whole UI, letterboxed into a styled card -------------------
  if (mode === "card") {
    const pad = Math.round(width * 0.06);
    let cardW = width - pad * 2;
    let cardH = Math.round(cardW / srcAspect);
    const maxCardH = Math.round(height * 0.55);
    if (cardH > maxCardH) {
      cardH = maxCardH;
      cardW = Math.round(cardH * srcAspect);
    }
    const cardLeft = Math.round((width - cardW) / 2);
    const cardTop = Math.round(height * 0.14);

    // The card exactly matches the source aspect, so event percentages map
    // straight into the card's rectangle for callout anchoring.
    const mapX = (xPct) => ((cardLeft + (xPct / 100) * cardW) / width) * 100;
    const mapY = (yPct) => ((cardTop + (yPct / 100) * cardH) / height) * 100;
    const calloutEvents = events.map((e) => ({ ...e, xPct: mapX(e.xPct), yPct: mapY(e.yPct) }));

    return (
      <AbsoluteFill style={{ backgroundColor: theme.bg }}>
        <AbsoluteFill
          style={{ background: `radial-gradient(ellipse at 50% 28%, ${theme.primary}22 0%, transparent 62%)` }}
        />
        <div
          style={{
            position: "absolute",
            left: cardLeft, top: cardTop, width: cardW, height: cardH,
            borderRadius: 24,
            overflow: "hidden",
            border: "1px solid rgba(255,255,255,.14)",
            boxShadow: "0 24px 80px rgba(0,0,0,.5)",
            background: "#000",
          }}
        >
          {video({ width: "100%", height: "100%", objectFit: "contain" })}
        </div>
        {scene.headline ? (
          <div
            style={{
              position: "absolute",
              left: pad, right: pad,
              top: cardTop + cardH + Math.round(height * 0.035),
              textAlign: "center",
              font: `800 ${Math.round(58 * typeScale(width, height))}px ${theme.font}`,
              color: theme.text,
              lineHeight: 1.15,
            }}
          >
            {scene.headline}
          </div>
        ) : null}
        {(scene.overlays || []).map((o, i) => (
          <Callout key={i} overlay={o} events={calloutEvents} ms={ms} theme={theme} />
        ))}
      </AbsoluteFill>
    );
  }

  const zoom = zoomAt(ms, events, scene.zoomToClick !== false);

  // ---- pan: source fills the height, a sliding window follows the clicks ----
  if (mode === "pan") {
    const srcW = Math.round(height * srcAspect);
    const maxOffset = Math.max(0, srcW - width);
    const centerX = panCenterAt(ms, events, scene.panToClick !== false);
    // Clamped, so a click near the source's edge pins the window to that edge
    // instead of exposing background beyond the footage.
    const offsetX = Math.min(maxOffset, Math.max(0, (centerX / 100) * srcW - width / 2));

    // Source-space percent -> composition-space percent, after the pan.
    const mapX = (xPct) =>
      Math.min(100, Math.max(0, (((xPct / 100) * srcW - offsetX) / width) * 100));
    const calloutEvents = events.map((e) => ({ ...e, xPct: mapX(e.xPct) }));

    return (
      <AbsoluteFill style={{ backgroundColor: theme.bg }}>
        <AbsoluteFill
          style={{
            transform: `scale(${zoom.scale})`,
            // The zoom origin rides on top of the pan, so remap it the same way.
            transformOrigin: `${mapX(zoom.originX)}% ${zoom.originY}%`,
          }}
        >
          <div style={{ position: "absolute", top: 0, left: -offsetX, width: srcW, height }}>
            {video({ width: "100%", height: "100%" })}
          </div>
        </AbsoluteFill>
        {(scene.overlays || []).map((o, i) => (
          <Callout key={i} overlay={o} events={calloutEvents} ms={ms} theme={theme} />
        ))}
      </AbsoluteFill>
    );
  }

  // ---- cover: the classic full-frame crop -----------------------------------
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <AbsoluteFill
        style={{
          transform: `scale(${zoom.scale})`,
          transformOrigin: `${zoom.originX}% ${zoom.originY}%`,
        }}
      >
        {video({ width: "100%", height: "100%", objectFit: "cover" })}
      </AbsoluteFill>

      {(scene.overlays || []).map((o, i) => (
        <Callout key={i} overlay={o} events={events} ms={ms} theme={theme} />
      ))}
    </AbsoluteFill>
  );
};
