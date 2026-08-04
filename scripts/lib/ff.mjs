/**
 * Local ffmpeg / ffprobe helpers.
 *
 * The `ffmpeg()` / `probe()` pair is ported from ai-video-maker-plugin. Everything
 * below them is new and exists for the capture pipeline: long-running recorders
 * that must be stopped *gracefully* (see `stopRecorder`), frame extraction for the
 * QA pass, and binary presence checks for the doctor.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** Run ffmpeg with args; streams progress to stderr; rejects on non-zero exit. */
export function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    proc.on("error", (e) =>
      reject(new Error(e.code === "ENOENT" ? "ffmpeg not found — install it first" : e.message))
    );
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))
    );
  });
}

/** Probe a media file: { width, height, fps, duration, hasAudio }. */
export async function probe(file) {
  let width = null;
  let height = null;
  let fps = null;
  let duration = null;
  let hasAudio = false;

  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      file,
    ]);
    const info = JSON.parse(stdout);
    for (const s of info.streams || []) {
      if (s.codec_type === "video" && width === null) {
        width = s.width ?? null;
        height = s.height ?? null;
        if (s.r_frame_rate && s.r_frame_rate !== "0/0") {
          const [n, d] = s.r_frame_rate.split("/").map(Number);
          if (d) fps = n / d;
        }
      }
      if (s.codec_type === "audio") hasAudio = true;
    }
    if (info.format?.duration) duration = Number(info.format.duration);
  } catch (e) {
    if (e.code === "ENOENT") throw new Error("ffprobe not found — install ffmpeg first");
    throw e;
  }
  return { width, height, fps, duration, hasAudio };
}

/** Duration in seconds, or null if the file can't be probed. */
export async function duration(file) {
  try {
    return (await probe(file)).duration;
  } catch {
    return null;
  }
}

/** Is a binary on PATH? Used by doctor.mjs. Returns the resolved path or null. */
export async function which(bin) {
  try {
    const { stdout } = await execFileAsync("which", [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Start a long-running ffmpeg recorder.
 *
 * IMPORTANT: stdin is a pipe, not "ignore". An mp4 finalises its moov atom only
 * on a clean shutdown — SIGKILL leaves an unplayable file. `stopRecorder` writes
 * "q" to this stdin to ask ffmpeg to wrap up, which is the only reliable way to
 * end a capture with usable output.
 */
export function startRecorder(args) {
  const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  const exited = new Promise((resolve, reject) => {
    proc.on("error", (e) =>
      reject(new Error(e.code === "ENOENT" ? "ffmpeg not found — install it first" : e.message))
    );
    // ffmpeg exits 255 when told to quit via "q"; that is a normal stop, not a failure.
    proc.on("close", (code) =>
      code === 0 || code === 255 ? resolve(code) : reject(new Error(`ffmpeg recorder exited ${code}`))
    );
  });
  return { proc, exited };
}

/**
 * Stop a recorder started by `startRecorder` and wait for the file to finalise.
 * Escalates to SIGINT then SIGKILL if ffmpeg ignores the quit request.
 */
export async function stopRecorder(rec, { timeoutMs = 10_000 } = {}) {
  const { proc, exited } = rec;
  if (proc.exitCode !== null || proc.signalCode !== null) return exited.catch(() => null);

  try {
    proc.stdin.write("q");
    proc.stdin.end();
  } catch {
    /* stdin already closed — fall through to signals */
  }

  const timer = setTimeout(() => {
    try { proc.kill("SIGINT"); } catch { /* already gone */ }
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, 2000);
  }, timeoutMs);

  try {
    return await exited;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract sampled frames for the visual QA pass.
 * `fps: 1` gives one frame per second; use a fraction (0.5) for sparser sampling.
 * Returns the absolute paths of the written frames, in order.
 */
export async function extractFrames(video, outDir, { fps = 1, width = 1280 } = {}) {
  const abs = path.resolve(outDir);
  await mkdir(abs, { recursive: true });
  await ffmpeg([
    "-i", video,
    "-vf", `fps=${fps},scale=${width}:-2`,
    "-q:v", "3",
    path.join(abs, "frame-%04d.jpg"),
  ]);
  const files = (await readdir(abs)).filter((f) => /^frame-\d+\.jpg$/.test(f)).sort();
  return files.map((f) => path.join(abs, f));
}

/**
 * Retime video-only footage by `factor`: >1 slows it down (frames are duplicated
 * by the fps filter), <1 speeds it up (frames are dropped). Clips carry no audio,
 * so there is no atempo to worry about.
 */
export async function retime(input, output, factor, { fps = 30, crf = 18 } = {}) {
  await ffmpeg([
    "-i", input,
    "-vf", `setpts=PTS*${factor},fps=${fps},format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf),
    "-movflags", "+faststart",
    "-an",
    output,
  ]);
  return path.resolve(output);
}

/** Remux/transcode any container to a uniform h264+aac mp4 (Remotion-friendly). */
export async function toMp4(input, output, { width, height, fps = 30, crf = 18 } = {}) {
  const vf = [];
  if (width && height) {
    vf.push(
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      "setsar=1"
    );
  }
  vf.push(`fps=${fps}`, "format=yuv420p");
  await ffmpeg([
    "-i", input,
    "-vf", vf.join(","),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf),
    "-movflags", "+faststart",
    "-an",
    output,
  ]);
  return path.resolve(output);
}
