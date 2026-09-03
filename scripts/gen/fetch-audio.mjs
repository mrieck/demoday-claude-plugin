#!/usr/bin/env node
/**
 * Pull a music cue / sound bite from a URL (YouTube etc.) into the project via
 * yt-dlp, optionally trimmed — the "sad violin under the freeze frame" step.
 *
 *   node scripts/gen/fetch-audio.mjs --project demo/<slug> \
 *     --url https://www.youtube.com/watch?v=7ODcC5z6Ca0 \
 *     --out assets/meme/sad-violin.wav --duration 8 [--start 0] [--trim-silence]
 *
 * YouTube frequently answers a bare yt-dlp with "Sign in to confirm you're
 * not a bot". The download is retried through a cookie ladder: no cookies →
 * the default Chrome profile → the profiles in DEMODAY_YTDLP_COOKIES (a
 * colon-separated list of `chrome:<user-data-dir>` specs; the logged-in
 * SocialCue Chrome at ~/.socialcue-chrome is tried by default).
 *
 * The raw download is kept beside the output (`<out>.source.<ext>`) so a
 * re-trim is free. Re-running with the same --out is a no-op unless --force.
 * You are responsible for having the rights to use what you fetch.
 */
import path from "node:path";
import os from "node:os";
import { mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs, requireArg, boolArg } from "../lib/args.mjs";
import { ffmpeg, probe, which } from "../lib/ff.mjs";
import * as manifest from "../lib/manifest.mjs";
import { report, info, warn, main } from "../lib/log.mjs";

const execFileAsync = promisify(execFile);
const USAGE =
  "fetch-audio.mjs --project <dir> --url <url> --out <file.(wav|mp3)> [--start <sec>] [--duration <sec>] [--trim-silence] [--force]";

function cookieLadder() {
  const extra = (process.env.DEMODAY_YTDLP_COOKIES || "").split(":").filter(Boolean);
  const ladder = [[], ["--cookies-from-browser", "chrome"]];
  const socialcue = path.join(os.homedir(), ".socialcue-chrome");
  const dirs = [...extra, ...(existsSync(socialcue) ? [`chrome:${socialcue}`] : [])];
  for (const d of dirs) ladder.push(["--cookies-from-browser", d]);
  return ladder;
}

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = manifest.resolveProjectDir(args.project);
  const url = requireArg(args, "url", USAGE);
  const out = manifest.resolveIn(projectDir, requireArg(args, "out", USAGE));
  const force = boolArg(args.force, false);
  if (existsSync(out) && !force) {
    const meta = await probe(out);
    return report(`  cached: ${path.relative(projectDir, out)} (${meta.duration?.toFixed(1)}s) — pass --force to refetch`, { ok: true, path: out, cached: true, durationSec: meta.duration });
  }
  if (!(await which("yt-dlp"))) throw new Error("yt-dlp not found — brew install yt-dlp");
  await mkdir(path.dirname(out), { recursive: true });

  const stem = out.replace(/\.[^.]+$/, "");
  const sourceGlob = `${stem}.source`;
  let source = (await readdir(path.dirname(out))).map((f) => path.join(path.dirname(out), f)).find((f) => f.startsWith(sourceGlob));
  if (!source || force) {
    let lastErr;
    for (const cookies of cookieLadder()) {
      const label = cookies.length ? cookies[1] : "no cookies";
      try {
        await execFileAsync("yt-dlp", ["-q", "--no-warnings", ...cookies, "-f", "bestaudio/best", "-x", "-o", `${sourceGlob}.%(ext)s`, url], { maxBuffer: 1 << 24 });
        source = (await readdir(path.dirname(out))).map((f) => path.join(path.dirname(out), f)).find((f) => f.startsWith(sourceGlob));
        if (source) { info(`  downloaded via yt-dlp (${label})`); break; }
      } catch (e) {
        lastErr = e;
        warn(`yt-dlp (${label}) failed: ${String(e.stderr || e.message).split("\n").find((l) => l.includes("ERROR")) || e.message}`);
      }
    }
    if (!source) throw lastErr ?? new Error("yt-dlp produced no file");
  }

  const af = [];
  if (boolArg(args["trim-silence"], false)) af.push("silenceremove=start_periods=1:start_threshold=-40dB");
  const ff = [];
  if (args.start) ff.push("-ss", String(args.start));
  ff.push("-i", source);
  if (args.duration) ff.push("-t", String(args.duration));
  ff.push("-vn");
  if (af.length) ff.push("-af", af.join(","));
  if (/\.mp3$/i.test(out)) ff.push("-c:a", "libmp3lame", "-q:a", "2");
  ff.push(out);
  await ffmpeg(ff);
  const meta = await probe(out);
  report(`  ${path.relative(projectDir, out)}: ${meta.duration?.toFixed(1)}s`, { ok: true, path: out, source, durationSec: meta.duration, cached: false });
});
