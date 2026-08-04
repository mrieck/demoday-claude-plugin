import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useVideoConfig } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { wipe } from "@remotion/transitions/wipe";
import { slide } from "@remotion/transitions/slide";

import { DemoClip } from "./scenes/DemoClip.jsx";
import { PresenterFull } from "./scenes/PresenterFull.jsx";
import { PresenterPip } from "./scenes/PresenterPip.jsx";
import { BRollClip } from "./scenes/BRollClip.jsx";
import { Card } from "./scenes/Card.jsx";
import { Captions } from "./components/Captions.jsx";
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

const SceneBody = ({ scene, theme, fps, presenterMode, pipVideo }) => {
  switch (scene.kind) {
    case "demo":
      return (
        <>
          <DemoClip scene={scene} theme={theme} fps={fps} />
          {presenterMode === "always" && pipVideo ? (
            <PresenterPip video={pipVideo} theme={theme} />
          ) : null}
        </>
      );
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
  const { fps } = useVideoConfig();
  const theme = themeFrom(props.brand);
  const scenes = props.timeline || [];
  const presenterMode = props.presenter?.mode || "hybrid";
  const transitionsById = new Map((props.transitions || []).map((t) => [t.after, t]));

  // Narration is laid out on an absolute timeline rather than inside each scene,
  // because transitions overlap scenes and audio must NOT overlap — two voices
  // talking over each other is instantly noticeable.
  let cursor = 0;
  const audioTrack = [];
  for (const [i, scene] of scenes.entries()) {
    const frames = secToFrames(scene.durationSec || 0, fps);
    if (scene.audio) audioTrack.push({ scene, from: cursor, frames });
    cursor += frames;
    const t = transitionsById.get(scene.id);
    if (t && i < scenes.length - 1) cursor -= secToFrames((t.ms || 400) / 1000, fps);
  }

  const total = totalFrames(props, fps);

  return (
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

      {audioTrack.map(({ scene, from, frames }) => (
        <Sequence key={`a-${scene.id}`} from={from} durationInFrames={frames}>
          <Audio src={staticFile(scene.audio)} />
          {props.captions?.enabled !== false && scene.wordTimings?.length ? (
            <Captions words={scene.wordTimings} theme={theme} />
          ) : null}
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

      {/* Fade the very end to black so the video does not stop on a hard cut. */}
      <Sequence from={Math.max(0, total - secToFrames(0.5, fps))}>
        <AbsoluteFill style={{ backgroundColor: "#000", opacity: 0.0001 }} />
      </Sequence>
    </AbsoluteFill>
  );
};
