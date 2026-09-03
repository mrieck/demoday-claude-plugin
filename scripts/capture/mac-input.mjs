/**
 * Real mouse and keyboard control on macOS, via cliclick.
 *
 * COORDINATE SPACES — the single biggest source of silent misclicks:
 *
 *   cliclick        works in logical POINTS   (e.g. 1512 x 982 on a Retina Mac)
 *   screencapture   produces physical PIXELS  (e.g. 3024 x 1964)
 *   model-facing screenshots are downscaled AGAIN to keep tokens sane
 *
 * A click that is "off by 2x" lands somewhere plausible but wrong, and you only
 * find out by watching the finished video. So nothing in this codebase asks a
 * model to do the conversion: screenshots report their scale factors and
 * `clickInImage` converts, in code, from image coordinates to screen points.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as motion from "../lib/cursor.mjs";

const execFileAsync = promisify(execFile);

async function cliclick(...args) {
  try {
    const { stdout } = await execFileAsync("cliclick", args);
    return stdout.trim();
  } catch (e) {
    const msg = `${e.stderr || e.message}`.trim();
    if (/ENOENT/.test(msg) || e.code === "ENOENT") {
      throw new Error("cliclick not found — install it with: brew install cliclick");
    }
    if (/not allowed|accessibility/i.test(msg)) {
      throw new Error(
        "cliclick was blocked by macOS. Grant your terminal Accessibility access " +
        "under System Settings > Privacy & Security > Accessibility."
      );
    }
    throw new Error(`cliclick ${args.join(" ")} failed: ${msg}`);
  }
}

/** Current pointer position in points. */
export async function position() {
  const out = await cliclick("p");
  const [x, y] = out.replace(/[^\d,.-]/g, "").split(",").map(Number);
  return { x, y };
}

/**
 * Move the pointer smoothly along an eased, slightly curved path.
 *
 * cliclick accepts many moves in one invocation, so we batch them rather than
 * spawning a process per frame — a per-frame spawn costs ~5ms and turns smooth
 * motion into a stutter. We still pace the batches so the travel takes the
 * intended time.
 */
export async function glideTo(x, y, { durationMs, fps = 60, from = null } = {}) {
  const start = from || (await position());
  const dist = Math.hypot(x - start.x, y - start.y);
  if (dist < 1) return { x, y };

  const ms = durationMs ?? motion.travelDuration(dist);
  const points = motion.path(start, { x, y }, { durationMs: ms, fps });

  // Batch into chunks so we can keep to the clock without spawning per point.
  const CHUNK = 12;
  const began = Date.now();
  for (let i = 0; i < points.length; i += CHUNK) {
    const chunk = points.slice(i, i + CHUNK);
    await cliclick(...chunk.map((p) => `m:${p.x},${p.y}`));
    const behind = (chunk.at(-1).atMs) - (Date.now() - began);
    if (behind > 0) await motion.sleep(behind);
  }
  const remaining = ms - (Date.now() - began);
  if (remaining > 0) await motion.sleep(remaining);
  return { x, y };
}

export async function click(x, y, { glide = true, double = false } = {}) {
  if (glide) await glideTo(x, y);
  else await cliclick(`m:${x},${y}`);
  await cliclick(double ? `dc:${x},${y}` : `c:${x},${y}`);
  return { x, y };
}

/**
 * Convert a point read off a (possibly downscaled) screenshot into screen points,
 * then click it. This is the ONLY sanctioned way to click from an image.
 *
 * `shot` is the metadata object returned by screenshot().
 */
export async function clickInImage(shot, imgX, imgY, opts = {}) {
  const { x, y } = imageToScreen(shot, imgX, imgY);
  return click(x, y, opts);
}

/** Image coordinates -> screen points, using a screenshot's recorded scales. */
export function imageToScreen(shot, imgX, imgY) {
  const { imagePixels, screenPoints, origin = { x: 0, y: 0 } } = shot;
  const sx = screenPoints.width / imagePixels.width;
  const sy = screenPoints.height / imagePixels.height;
  return {
    x: Math.round(origin.x + imgX * sx),
    y: Math.round(origin.y + imgY * sy),
  };
}

/** Type with human cadence. Batched per word to limit process spawns. */
export async function type(text, { cps = 14 } = {}) {
  const plan = motion.typingPlan(text, { cps });
  let buffer = "";
  let bufferedDelay = 0;

  const flush = async () => {
    if (!buffer) return;
    // `t:` types literally; cliclick needs the leading colon form for arbitrary text.
    await cliclick(`t:${buffer}`);
    buffer = "";
    await motion.sleep(bufferedDelay);
    bufferedDelay = 0;
  };

  for (const { ch, delayMs } of plan) {
    if (ch === "\n") {
      await flush();
      await cliclick("kp:return", "w:30");
      await motion.sleep(delayMs);
      continue;
    }
    buffer += ch;
    bufferedDelay += delayMs;
    // Flush at word boundaries so the cadence still reads as typing.
    if (ch === " " || buffer.length >= 12) await flush();
  }
  await flush();
}

/** cliclick key names for the keys an action script is likely to use. */
const KEY_MAP = {
  enter: "return", return: "return", tab: "tab", escape: "esc", esc: "esc",
  space: "space", backspace: "delete", delete: "delete", up: "arrow-up",
  down: "arrow-down", left: "arrow-left", right: "arrow-right",
  home: "home", end: "end", pageup: "page-up", pagedown: "page-down",
};

/**
 * Press a key or chord, e.g. "Enter", "Meta+A", "cmd+shift+p".
 * Modifiers are held with `kd:` and always released in a finally, so a crash
 * mid-chord cannot leave Command stuck down.
 */
export async function key(spec) {
  const parts = String(spec).split("+").map((p) => p.trim().toLowerCase());
  const base = parts.pop();
  const mods = parts
    .map((m) => ({ meta: "cmd", command: "cmd", control: "ctrl", option: "alt", opt: "alt" }[m] || m))
    .filter((m) => ["cmd", "ctrl", "alt", "shift", "fn"].includes(m));

  if (mods.length) await cliclick(`kd:${mods.join(",")}`);
  try {
    const mapped = KEY_MAP[base];
    // cliclick 5.1 exits before a lone key-press event is delivered, so a
    // standalone `kp:` silently does nothing (verified: `kp:return` alone never
    // reached Terminal; `kp:return w:20` always did). The trailing wait keeps
    // the process alive until the event posts.
    if (mapped) await cliclick(`kp:${mapped}`, "w:30");
    else await cliclick(`t:${base}`, "w:30");
  } finally {
    if (mods.length) await cliclick(`ku:${mods.join(",")}`).catch(() => {});
  }
}

/** Eased scroll via repeated wheel ticks. */
export async function scroll(dy, { durationMs = 700 } = {}) {
  const ticks = Math.max(1, Math.round(Math.abs(dy) / 40));
  const dir = dy > 0 ? -1 : 1; // cliclick: positive scrolls up
  const per = durationMs / ticks;
  for (let i = 0; i < ticks; i++) {
    await cliclick(`w:${dir * 3}`);
    await motion.sleep(per);
  }
}
