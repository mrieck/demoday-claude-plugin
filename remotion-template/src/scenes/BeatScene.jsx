import React from "react";
import { AbsoluteFill, Sequence, OffthreadVideo, Img, staticFile, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { DemoClip } from "./DemoClip.jsx";
import { SplitScene, BottomZone, resolveBottom, SPLIT_DEFAULT_PCT } from "./SplitScene.jsx";
import { Card } from "./Card.jsx";
import { typeScale } from "../theme.js";

/**
 * Beats: one narrated scene, many shots. The voice flows continuously while the
 * picture HARD-CUTS between windows — the grammar of fast social video, where a
 * cut lands every second or two.
 *
 * Every clip-backed shot is offset by its window's start time, so the capture
 * keeps rolling "underneath" the cuts (cutting away and back does not rewind
 * it) and the presenter's lips stay on the narration mid-scene. A screen beat
 * can jump the capture to a different moment with videoStartSec.
 *
 * Layout of a window is one of BEAT_SHOTS:
 *   face   — full-bleed presenter clip with a gentle push
 *   screen — the scene's capture through DemoClip (beat.framing overrides)
 *   split  — the split layout, both zones offset-aligned
 *   insert — a full-frame image (or `images` spread) on the theme backdrop, or
 *            an animated title-only card
 *   card   — the classic motion card (beat.title/subtitle/cta)
 * Any beat can carry a `stamp` ("#1") — the big listicle numeral.
 *
 * Anchored layout (scene.beatLayout === "anchored"): the reference-Short
 * grammar. The scene's bottom zone (usually the talking presenter) mounts ONCE
 * and runs continuously; pane shots (screen/split) hard-cut inside the top
 * pane only; overlay shots (face/insert/card) go full-bleed OVER both zones —
 * the punch-in. Falls back to the classic full-frame beat loop when the bottom
 * resolves to captions (no presenter clip, or presenter mode "none").
 */

const toFrame = (sec, fps) => Math.round(sec * fps);

/** The big numbered overlay: pops in at the start of its window. */
const Stamp = ({ text, theme }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const s = typeScale(width, height);
  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.6, stiffness: 180 } });
  return (
    <div
      style={{
        position: "absolute",
        left: 0, right: 0,
        top: Math.round(height * 0.18),
        textAlign: "center",
        transform: `scale(${0.6 + 0.4 * pop})`,
        opacity: pop,
        font: `800 ${Math.round(130 * s)}px ${theme.font}`,
        color: "#fff",
        textShadow: `${Math.round(6 * s)}px ${Math.round(6 * s)}px 0 ${theme.primary}, 0 10px 40px rgba(0,0,0,.5)`,
      }}
    >
      {text}
    </div>
  );
};

const FaceBeat = ({ scene, fps, startFromSec }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const scale = interpolate(frame, [0, durationInFrames], [1.0, 1.05], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ transform: `scale(${scale})` }}>
      <OffthreadVideo
        src={staticFile(scene.presenterVideo)}
        startFrom={Math.round(startFromSec * fps)}
        muted
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
};

/** 2–5 stills springing outward from center with a stagger — the "spread". */
const ImagesSpread = ({ images, fps, width, height, s }) => {
  const frame = useCurrentFrame();
  const n = images.length;
  const radius = Math.round(Math.min(width, height) * 0.24);
  return images.map((img, i) => {
    const enter = spring({
      frame: frame - Math.round(i * 0.06 * fps),
      fps,
      config: { damping: 14, mass: 0.6, stiffness: 180 },
    });
    // Fan the items around the center; two items sit diagonal, more go radial.
    const angle = -Math.PI / 2 + (i / n) * 2 * Math.PI + (n === 2 ? Math.PI / 4 : 0);
    const dist = interpolate(enter, [0, 1], [0, radius]);
    const tilt = (i % 2 === 0 ? -1 : 1) * (6 + (i % 3) * 3);
    return (
      <div
        key={i}
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: "44%",
          transform:
            `translate(-50%, -50%) ` +
            `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px) ` +
            `rotate(${tilt * enter}deg) scale(${0.6 + 0.4 * enter})`,
          opacity: enter,
          borderRadius: Math.round(18 * s),
          overflow: "hidden",
          boxShadow: "0 18px 60px rgba(0,0,0,.5)",
        }}
      >
        <Img src={staticFile(img)} style={{ width: "100%", display: "block" }} />
      </div>
    );
  });
};

const InsertBeat = ({ beat, theme }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const s = typeScale(width, height);
  const drift = interpolate(frame, [0, durationInFrames], [1.0, 1.06], { extrapolateRight: "clamp" });
  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.6, stiffness: 180 } });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, justifyContent: "center", alignItems: "center" }}>
      <AbsoluteFill
        style={{ background: `radial-gradient(ellipse at 50% 40%, ${theme.primary}22 0%, transparent 62%)` }}
      />
      {beat.images?.length ? (
        <ImagesSpread images={beat.images} fps={fps} width={width} height={height} s={s} />
      ) : beat.image ? (
        <div
          style={{
            width: "84%",
            borderRadius: Math.round(24 * s),
            overflow: "hidden",
            boxShadow: "0 24px 80px rgba(0,0,0,.5)",
            transform: `scale(${drift * (0.92 + 0.08 * pop)})`,
            opacity: pop,
          }}
        >
          <Img src={staticFile(beat.image)} style={{ width: "100%", display: "block" }} />
        </div>
      ) : (
        <div
          style={{
            // Upper-middle, clear of the boxed-caption band at mid-frame; drops
            // lower when a stamp occupies the 18% band above.
            position: "absolute",
            left: "8%", right: "8%",
            top: beat.stamp ? "44%" : "36%",
            textAlign: "center",
            font: `800 ${Math.round(76 * s)}px/1.12 ${theme.font}`,
            color: theme.text,
            transform: `scale(${0.85 + 0.15 * pop})`,
            opacity: pop,
          }}
        >
          {beat.title}
        </div>
      )}
    </AbsoluteFill>
  );
};

const BeatShot = ({ beat, scene, theme, fps, presenterMode }) => {
  switch (beat.shot) {
    case "face":
      return <FaceBeat scene={scene} fps={fps} startFromSec={beat.atSec} />;
    case "split":
      return (
        <SplitScene
          scene={scene}
          theme={theme}
          fps={fps}
          presenterMode={presenterMode}
          presenterStartSec={beat.atSec}
          demoStartSec={beat.videoStartSec ?? beat.atSec}
        />
      );
    case "insert":
      return <InsertBeat beat={beat} theme={theme} />;
    case "card":
      return <Card scene={{ ...scene, ...beat }} theme={theme} />;
    case "screen":
    default:
      return (
        <DemoClip
          // undefined framing → DemoClip's aspect-aware default (pan for a
          // landscape capture in a portrait comp), not a blind center-crop.
          scene={{ ...scene, framing: beat.framing }}
          theme={theme}
          fps={fps}
          startFromSec={beat.videoStartSec ?? beat.atSec}
        />
      );
  }
};

const PANE_SHOTS = new Set(["screen", "split"]);
const isPaneShot = (beat) => PANE_SHOTS.has(beat.shot ?? "screen");

/**
 * Anchored layout: bottom zone mounted once (presenter runs the whole scene),
 * pane shots cut inside the top pane, overlay shots punch in full-bleed.
 */
const AnchoredBeats = ({ scene, beats, theme, fps, presenterMode, bottom }) => {
  const { width, height, durationInFrames } = useVideoConfig();
  const pct = scene.splitPct ?? SPLIT_DEFAULT_PCT;
  const topH = Math.round(height * pct);

  const windowOf = (i, nextOf) => {
    const from = toFrame(beats[i].atSec, fps);
    const end = nextOf(i);
    return { from, dur: Math.max(1, end - from) };
  };
  // Pane windows run to the NEXT PANE beat (not the next beat overall), so the
  // pane stays filled underneath full-bleed punch-ins.
  const nextPane = (i) => {
    for (let j = i + 1; j < beats.length; j++) {
      if (isPaneShot(beats[j])) return toFrame(beats[j].atSec, fps);
    }
    return durationInFrames;
  };
  const nextAny = (i) =>
    i < beats.length - 1 ? toFrame(beats[i + 1].atSec, fps) : durationInFrames;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <div style={{ position: "absolute", top: 0, left: 0, width, height: topH, overflow: "hidden" }}>
        {beats.map((beat, i) => {
          if (!isPaneShot(beat)) return null;
          const { from, dur } = windowOf(i, nextPane);
          return (
            <Sequence key={i} from={from} durationInFrames={dur}>
              <DemoClip
                scene={{ ...scene, framing: beat.framing ?? scene.topFraming }}
                theme={theme}
                fps={fps}
                boxW={width}
                boxH={topH}
                startFromSec={beat.videoStartSec ?? beat.atSec}
              />
            </Sequence>
          );
        })}
      </div>

      <BottomZone
        scene={scene} bottom={bottom} theme={theme} fps={fps}
        width={width} height={height} topH={topH}
        presenterStartSec={0} durationInFrames={durationInFrames}
      />

      {beats.map((beat, i) => {
        if (isPaneShot(beat)) return null;
        const { from, dur } = windowOf(i, nextAny);
        return (
          <Sequence key={`o${i}`} from={from} durationInFrames={dur}>
            <BeatShot beat={beat} scene={scene} theme={theme} fps={fps} presenterMode={presenterMode} />
          </Sequence>
        );
      })}

      {beats.map((beat, i) =>
        beat.stamp ? (
          <Sequence key={`s${i}`} from={windowOf(i, nextAny).from} durationInFrames={windowOf(i, nextAny).dur}>
            <Stamp text={beat.stamp} theme={theme} />
          </Sequence>
        ) : null
      )}
    </AbsoluteFill>
  );
};

export const BeatScene = ({ scene, theme, fps, presenterMode }) => {
  const { durationInFrames } = useVideoConfig();
  const beats = scene.beats || [];
  const bottom = resolveBottom(scene, presenterMode);

  if (scene.beatLayout === "anchored" && bottom.kind !== "captions") {
    return (
      <AnchoredBeats
        scene={scene} beats={beats} theme={theme} fps={fps}
        presenterMode={presenterMode} bottom={bottom}
      />
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      {beats.map((beat, i) => {
        const from = toFrame(beat.atSec, fps);
        const end = i < beats.length - 1 ? toFrame(beats[i + 1].atSec, fps) : durationInFrames;
        const dur = Math.max(1, end - from);
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            <BeatShot beat={beat} scene={scene} theme={theme} fps={fps} presenterMode={presenterMode} />
            {beat.stamp ? <Stamp text={beat.stamp} theme={theme} /> : null}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
