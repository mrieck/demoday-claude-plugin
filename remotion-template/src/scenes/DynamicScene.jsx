import React from "react";
import { AbsoluteFill, Sequence, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { DemoClip } from "./DemoClip.jsx";
import { InsertBeat } from "./BeatScene.jsx";
import {
  contentBoxFor, lerpRect, easeOutCubic, easeInOutQuad,
  focusTransform, lerpFocus, DISSOLVE_SEC, FOCUS_TWEEN_SEC, MORPH_DEFAULT_MS,
} from "../lib/layouts.js";

/**
 * The screen-content half of the dynamic style. The presenter is a separate
 * global layer (PresenterFrame) that moves between layouts; this scene fills
 * whatever the current layout leaves free — the full frame under a face or a
 * card, the 59% beside a side panel — and fades out under a full-frame face.
 *
 * Beats (scene.beats, `layout` already resolved by build-props, plus the
 * scene's `prevLayout`) cut the content the way BeatScene does, with two
 * additions measured from the reference tutorial:
 *
 *   focus         — { x, y, w, h } fractions of the capture: the pane zooms
 *                   2-3x into the element being talked about. A focus change
 *                   on the SAME running clip glides there over FOCUS_TWEEN_SEC.
 *   videoStartSec — a jump to another moment of the capture (or cut:
 *                   "dissolve") is a 0.2s zoom-dissolve: the old window scales
 *                   up and fades while the new one scales in on top.
 *
 * A layout-only beat is neither: the pane's box morphs with the presenter
 * frame over morphMs (the box widens as a side panel shrinks to a card, fades
 * in as a face pulls back to a panel).
 */

const toFrame = (sec, fps) => Math.round(sec * fps);

/** The pane's box + opacity at scene-second t, easing out of the previous layout's box after each change. */
function paneAt(beats, prevLayout, t, width, height, morphMs) {
  let cur = prevLayout;
  let prev = prevLayout;
  let changeAt = null;
  for (const b of beats) {
    if (t < b.atSec) break;
    if (b.layout && b.layout !== cur) { prev = cur; cur = b.layout; changeAt = b.atSec; }
  }
  const to = contentBoxFor(cur, width, height);
  if (!morphMs || changeAt == null) return to;
  const p = (t - changeAt) / (morphMs / 1000);
  if (p >= 1) return to;
  return lerpRect(contentBoxFor(prev, width, height), to, easeOutCubic(p));
}

/**
 * The capture cover-fitted into the pane, zoomed into `focus`. Used for every
 * screen beat that does not ask for DemoClip's pan/cover framing explicitly —
 * the dynamic style shows the element, not the window, so the click-following
 * pan and zoom-to-click are replaced by the author's focus box.
 */
export const FocusClip = ({ scene, fps, boxW, boxH, startFromSec = 0, focus = null, fromFocus, tweenSec = 0 }) => {
  const frame = useCurrentFrame();
  const vw = scene.viewport?.width || 1920;
  const vh = scene.viewport?.height || 1080;
  let f = focus;
  if (tweenSec > 0 && fromFocus !== undefined) {
    const p = frame / fps / tweenSec;
    if (p < 1) f = lerpFocus(fromFocus, focus, easeInOutQuad(p));
  }
  const tf = focusTransform(boxW, boxH, vw, vh, f);
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: boxW, height: boxH, overflow: "hidden", backgroundColor: "#000" }}>
      <div
        style={{
          position: "absolute",
          left: tf.left, top: tf.top, width: tf.width, height: tf.height,
          transform: `translate(${tf.tx}px, ${tf.ty}px) scale(${tf.scale})`,
          transformOrigin: `${tf.originX}px ${tf.originY}px`,
        }}
      >
        <OffthreadVideo
          src={staticFile(scene.video)}
          startFrom={Math.round(startFromSec * fps)}
          playbackRate={scene.playbackRate || 1}
          muted={scene.muteSource !== false}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      </div>
    </div>
  );
};

/** Zoom-dissolve wrapper: fade/scale in over inF frames, out over the last outF frames. */
const PaneWindow = ({ inF, outF, dur, children }) => {
  const frame = useCurrentFrame();
  let opacity = 1;
  let scale = 1;
  if (inF && frame < inF) {
    const p = easeOutCubic(frame / inF);
    opacity = p;
    scale = 1.06 - 0.06 * p;
  }
  if (outF && frame > dur - outF) {
    const p = easeOutCubic((frame - (dur - outF)) / outF);
    opacity = Math.min(opacity, 1 - p);
    scale = 1 + 0.08 * p;
  }
  return <AbsoluteFill style={{ opacity, transform: `scale(${scale})` }}>{children}</AbsoluteFill>;
};

const sameFocus = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const DynamicScene = ({ scene, theme, fps, morphMs = MORPH_DEFAULT_MS }) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const beats = scene.beats || [];
  const t = frame / fps;
  const pane = paneAt(beats, scene.prevLayout || beats[0]?.layout || "face", t, width, height, morphMs);
  const boxW = Math.max(1, Math.round(pane.w));
  const boxH = Math.max(1, Math.round(pane.h));

  const dissolveF = toFrame(DISSOLVE_SEC, fps);
  const dissolvesIn = (i) => i > 0 && (beats[i].videoStartSec != null || beats[i].cut === "dissolve");
  const windows = beats.map((b, i) => {
    const from = toFrame(b.atSec, fps);
    const end = i < beats.length - 1 ? toFrame(beats[i + 1].atSec, fps) : durationInFrames;
    const outF = i < beats.length - 1 && dissolvesIn(i + 1) ? dissolveF : 0;
    return { from, dur: Math.max(1, end - from + outF), outF, inF: dissolvesIn(i) ? dissolveF : 0 };
  });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <div
        style={{
          position: "absolute",
          left: pane.x, top: pane.y, width: boxW, height: boxH,
          overflow: "hidden",
          opacity: pane.opacity,
          backgroundColor: "#000",
        }}
      >
        {beats.map((b, i) => {
          const w = windows[i];
          const shot = b.shot ?? "screen";
          const startFromSec = b.videoStartSec ?? b.atSec;
          // Same clip still rolling and only the focus moved: glide, don't cut.
          const continues = i > 0 && !dissolvesIn(i);
          const prevFocus = i > 0 ? beats[i - 1].focus ?? null : null;
          const glide = continues && !sameFocus(prevFocus, b.focus);
          return (
            <Sequence key={i} from={w.from} durationInFrames={w.dur}>
              <PaneWindow inF={w.inF} outF={w.outF} dur={w.dur}>
                {shot === "insert" ? (
                  <InsertBeat beat={b} theme={theme} />
                ) : b.framing && !b.focus ? (
                  <DemoClip
                    scene={{ ...scene, framing: b.framing }}
                    theme={theme}
                    fps={fps}
                    boxW={boxW}
                    boxH={boxH}
                    startFromSec={startFromSec}
                  />
                ) : (
                  <FocusClip
                    scene={scene}
                    fps={fps}
                    boxW={boxW}
                    boxH={boxH}
                    startFromSec={startFromSec}
                    focus={b.focus ?? null}
                    fromFocus={glide ? prevFocus : undefined}
                    tweenSec={FOCUS_TWEEN_SEC}
                  />
                )}
              </PaneWindow>
            </Sequence>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
