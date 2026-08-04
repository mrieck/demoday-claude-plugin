import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Word-timed captions, driven by the ElevenLabs timestamps saved alongside each
 * narration track. Grouped into short phrases rather than shown one word at a time,
 * which is easier to read and less strobing on a product video.
 *
 * Most demo videos are watched muted at least once, so this is on by default.
 */
const MAX_WORDS = 7;
const MAX_GAP_SEC = 0.55;

function groupIntoPhrases(words) {
  const phrases = [];
  let current = null;
  for (const w of words) {
    const startNew =
      !current ||
      current.words.length >= MAX_WORDS ||
      w.startSec - current.endSec > MAX_GAP_SEC ||
      /[.!?]$/.test(current.words.at(-1).text);
    if (startNew) {
      current = { startSec: w.startSec, endSec: w.endSec, words: [w] };
      phrases.push(current);
    } else {
      current.words.push(w);
      current.endSec = w.endSec;
    }
  }
  return phrases;
}

export const Captions = ({ words, theme, offsetSec = 0 }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  if (!words?.length) return null;

  const t = frame / fps + offsetSec;
  const phrases = groupIntoPhrases(words);
  const active = phrases.find((p) => t >= p.startSec - 0.08 && t <= p.endSec + 0.35);
  if (!active) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: 0, right: 0,
        bottom: Math.round(height * 0.075),
        display: "flex",
        justifyContent: "center",
        padding: "0 8%",
      }}
    >
      <div
        style={{
          background: "rgba(8,10,16,.82)",
          backdropFilter: "blur(6px)",
          borderRadius: 14,
          padding: "14px 26px",
          font: `600 36px/1.28 ${theme.font}`,
          color: theme.text,
          textAlign: "center",
          maxWidth: "100%",
        }}
      >
        {active.words.map((w, i) => {
          // Light emphasis on the word currently being spoken.
          const on = t >= w.startSec && t <= w.endSec;
          return (
            <span key={i} style={{ color: on ? theme.primary : theme.text }}>
              {w.text}
              {i < active.words.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
};
