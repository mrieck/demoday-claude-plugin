import React from "react";
import { Composition } from "remotion";
import { DemoVideo, totalFrames } from "./DemoVideo.jsx";
import defaultProps from "./props.json";

/**
 * The composition is driven entirely by props built from demo.json — nothing about
 * a particular video is hardcoded here. `props.json` is written by
 * render/build-props.mjs and is what `remotion studio` picks up, so opening the
 * studio always shows the real current project.
 */
export const RemotionRoot = () => {
  const fps = defaultProps.format?.fps || 30;
  return (
    <Composition
      id="DemoVideo"
      component={DemoVideo}
      fps={fps}
      width={defaultProps.format?.width || 1920}
      height={defaultProps.format?.height || 1080}
      durationInFrames={totalFrames(defaultProps, fps)}
      defaultProps={defaultProps}
      // Duration must follow whatever props are actually passed at render time,
      // not the baked-in defaults, or a re-render after an edit silently truncates.
      calculateMetadata={({ props }) => {
        const f = props.format?.fps || 30;
        return {
          fps: f,
          width: props.format?.width || 1920,
          height: props.format?.height || 1080,
          durationInFrames: totalFrames(props, f),
        };
      }}
    />
  );
};
