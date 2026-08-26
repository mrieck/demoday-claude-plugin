import React from "react";
import { AbsoluteFill, Audio, Freeze, Sequence, staticFile, useVideoConfig } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { wipe } from "@remotion/transitions/wipe";
import { slide } from "@remotion/transitions/slide";

import { DemoClip, framingFor } from "./scenes/DemoClip.jsx";
import { SplitScene, SPLIT_DEFAULT_PCT, resolveBottom } from "./scenes/SplitScene.jsx";
import { BeatScene } from "./scenes/BeatScene.jsx";
import { PresenterFull } from "./scenes/PresenterFull.jsx";
import { PresenterPip } from "./scenes/PresenterPip.jsx";
import { BRollClip } from "./scenes/BRollClip.jsx";
import { Card } from "./scenes/Card.jsx";
import { Captions } from "./components/Captions.jsx";
import { Watermark } from "./components/Watermark.jsx";
import { HookCard, FrameCover } from "./components/HookCard.jsx";
import { themeFrom } from "./theme.js";

const PRESENTATIONS = { fade, wipe, slide };

export const secToFrames = (sec, fps) => Math.max(1, Math.round(sec * fps));

/**
 * Total composition length.
 *
 * Transitions OVERLAP the scenes they join, so the finished video is shorter than
 * the sum of its scenes by the total transition time. Getting this wrong truncates
 * the last scene, so the same helper is used by calculateMetadata and by the
 * props builder.
 */
export function totalFrames(props, fps) {
  const scenes = props.timeline || [];
  const sum = scenes.reduce((n, s) => n + secToFrames(s.durationSec || 0, fps), 0);
  const overlap = (props.transitions || []).reduce(
    (n, t) => n + secToFrames((t.ms || 400) / 1000, fps),
    0
  );
  return Math.max(1, sum - overlap);
}

const SceneBody = ({ scene, theme, fps, presenterMode, pipVideo, pipDefaults, split }) => {
  switch (scene.kind) {
    case "demo": {
      if (scene.beats?.length) return <BeatScene scene={scene} theme={theme} fps={fps} presenterMode={presenterMode} />;
      if (split) return <SplitScene scene={scene} theme={theme} fps={fps} presenterMode={presenterMode} demoStartSec={scene.videoStartSec || 0} />;
      // The corner pip prefers the scene's own lip-synced clip (the tutorial
      // model) over the legacy global presenter.pipVideo; pip: false opts a
      // scene out, a pip object overrides the manifest-level config.
      const pipClip = scene.pip === false ? null : scene.presenterVideo || pipVideo;
      const pipConf = { ...pipDefaults, ...(typeof scene.pip === "object" ? scene.pip : null) };
      return (
        <>
          <DemoClip scene={scene} theme={theme} fps={fps} startFromSec={scene.videoStartSec || 0} />
          {presenterMode === "always" && pipClip ? (
            <PresenterPip video={pipClip} theme={theme} pip={pipConf} />
          ) : null}
        </>
      );
    }
    case "presenter":
      // With presenter.mode "none" a presenter beat degrades to a card rather than
      // failing the render, so switching modes never leaves a hole in the timeline.
      return presenterMode === "none" || !scene.video
        ? <Card scene={{ ...scene, title: scene.title || scene.cta || "" }} theme={theme} />
        : <PresenterFull scene={scene} theme={theme} />;
    case "broll":
      return <BRollClip scene={scene} theme={theme} />;
    case "card":
    default:
      return <Card scene={scene} theme={theme} />;
  }
};

export const DemoVideo = (props) => {
  const { fps, width, height } = useVideoConfig();
  const theme = themeFrom(props.brand);
  const scenes = props.timeline || [];
  const presenterMode = props.presenter?.mode || "hybrid";
  const transitionsById = new Map((props.transitions || []).map((t) => [t.after, t]));

  // Narration is laid out on an absolute timeline rather than inside each scene,
  // because transitions overlap scenes and audio must NOT overlap — two voices
  // talking over each other is instantly noticeable.
  let cursor = 0;
  const audioTrack = [];
  const sceneRanges = [];
  for (const [i, scene] of scenes.entries()) {
    const frames = secToFrames(scene.durationSec || 0, fps);
    if (scene.audio) audioTrack.push({ scene, from: cursor, frames });
    sceneRanges.push({ scene, from: cursor, frames });
    cursor += frames;
    const t = transitionsById.get(scene.id);
    if (t && i < scenes.length - 1) cursor -= secToFrames((t.ms || 400) / 1000, fps);
  }

  const total = totalFrames(props, fps);

  // The watermark covers contiguous runs of scenes that have not opted out with
  // `watermark: false` (a CTA card whose logo it would sit on, say). Runs are
  // computed on the same absolute timeline as the audio, and adjacent scenes
  // overlap by their transition, so merging on overlap keeps the mark steady
  // through a fade instead of popping at the seam.
  const wm = props.watermark;
  const wmRuns = [];
  if (wm && (wm.text || wm.image)) {
    for (const { scene, from, frames } of sceneRanges) {
      if (scene.watermark === false) continue;
      const to = Math.min(from + frames, total);
      const last = wmRuns[wmRuns.length - 1];
      if (last && from <= last.to) last.to = Math.max(last.to, to);
      else wmRuns.push({ from, to });
    }
  }

  // Everything visible, with no audio elements: it is rendered once for real and,
  // for a frozen-frame cover, once more inside <Freeze> as frame 0.
  const renderVisual = ({ captions = true } = {}) => (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <TransitionSeries>
        {scenes.flatMap((scene, i) => {
          const frames = secToFrames(scene.durationSec || 0, fps);
          const nodes = [
            <TransitionSeries.Sequence key={`s-${scene.id}`} durationInFrames={frames}>
              <SceneBody
                scene={scene}
                theme={theme}
                fps={fps}
                presenterMode={presenterMode}
                pipVideo={props.presenter?.pipVideo}
                pipDefaults={props.presenter?.pip || {}}
                split={scene.kind === "demo" && framingFor(scene, width, height) === "split"}
              />
            </TransitionSeries.Sequence>,
          ];
          const t = transitionsById.get(scene.id);
          if (t && i < scenes.length - 1) {
            const presentation = (PRESENTATIONS[t.type] || fade)(
              t.type === "wipe" || t.type === "slide" ? { direction: t.direction || "from-right" } : undefined
            );
            nodes.push(
              <TransitionSeries.Transition
                key={`t-${scene.id}`}
                presentation={presentation}
                timing={linearTiming({ durationInFrames: secToFrames((t.ms || 400) / 1000, fps) })}
              />
            );
          }
          return nodes;
        })}
      </TransitionSeries>

      {audioTrack.map(({ scene, from, frames }) => {
        // Captions move with the split layout: centered in the bottom zone when
        // that zone is theirs, tucked under the seam when other content owns it.
        // Beat scenes: boxed captions place themselves per beat (seam over pane
        // shots in an anchored scene, low over face punch-ins, mid elsewhere);
        // shorts-style karaoke rides the seam when the scene is anchored.
        const isBeat = scene.kind === "demo" && !!scene.beats?.length;
        const anchored = isBeat && scene.beatLayout === "anchored" &&
          resolveBottom(scene, presenterMode).kind !== "captions";
        const isSplit = scene.kind === "demo" &&
          !isBeat && framingFor(scene, width, height) === "split";
        const placement = isBeat
          ? (anchored ? "seam" : "default")
          : !isSplit
            ? "default"
            : resolveBottom(scene, presenterMode).kind === "captions" ? "bottom" : "seam";
        return (
          <Sequence key={`a-${scene.id}`} from={from} durationInFrames={frames}>
            {captions && props.captions?.enabled !== false && scene.wordTimings?.length ? (
              <Captions
                words={scene.wordTimings}
                theme={theme}
                style={scene.captionsStyle || props.captions?.style}
                placement={placement}
                splitPct={scene.splitPct ?? SPLIT_DEFAULT_PCT}
                emphasis={scene.captionEmphasis}
                beats={scene.beats}
                anchored={anchored}
                scenePlacement={scene.captionPlacement}
              />
            ) : null}
          </Sequence>
        );
      })}

      {wmRuns.map((r) => (
        <Sequence key={`wm-${r.from}`} from={r.from} durationInFrames={r.to - r.from}>
          <Watermark watermark={wm} theme={theme} fps={fps} runFrames={r.to - r.from} />
        </Sequence>
      ))}

      {/* The cover sits above everything (captions, watermark) for its short
          life: frame 0 is the thumbnail every platform shows, so it must be a
          complete card, not a face with a caption over it. Narration is on the
          absolute audio track above and starts underneath it. */}
    </AbsoluteFill>
  );
  const visual = renderVisual();

  const coverFrames = props.cover
    ? secToFrames((props.cover.holdSec ?? 0.5) + (props.cover.kind === "frame" ? (props.cover.outSec ?? 0) : (props.cover.outSec ?? 0.5)), fps)
    : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      {visual}

      {audioTrack.map(({ scene, from, frames }) => (
        <Sequence key={`a-${scene.id}`} from={from} durationInFrames={frames}>
          <Audio src={staticFile(scene.audio)} />
        </Sequence>
      ))}

      {props.music?.enabled && props.music.bed ? (
        <Audio
          src={staticFile(props.music.bed)}
          loop
          // Duck under narration. Without this the bed competes with the voice and
          // the whole thing sounds like a stock template.
          volume={(f) => {
            const speaking = audioTrack.some((a) => f >= a.from && f < a.from + a.frames);
            const base = props.music.gain ?? 0.5;
            const ducked = base * Math.pow(10, (props.music.duckDb ?? -14) / 20);
            return speaking ? ducked : base;
          }}
        />
      ) : null}


      {props.cover?.kind === "frame" ? (
        <Sequence from={0} durationInFrames={coverFrames}>
          <FrameCover cover={props.cover} fps={fps}>
            <Freeze frame={secToFrames(props.cover.frameSec || 0, fps)}>
              {props.cover.captions === false ? renderVisual({ captions: false }) : visual}
            </Freeze>
          </FrameCover>
        </Sequence>
      ) : props.cover?.hook ? (
        <Sequence from={0} durationInFrames={coverFrames}>
          <HookCard cover={props.cover} theme={theme} fps={fps} />
        </Sequence>
      ) : null}

      {/* Fade the very end to black so the video does not stop on a hard cut. */}
      <Sequence from={Math.max(0, total - secToFrames(0.5, fps))}>
        <AbsoluteFill style={{ backgroundColor: "#000", opacity: 0.0001 }} />
      </Sequence>
    </AbsoluteFill>
  );
};
