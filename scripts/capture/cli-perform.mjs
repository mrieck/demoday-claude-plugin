#!/usr/bin/env node
/**
 * Performance pass for CLI demos — records a REAL Terminal window running the
 * real program (claude, or any CLI), then retimes the take to the narration.
 *
 *   node scripts/capture/cli-perform.mjs \
 *     --actions demo/<slug>/actions/feature-1.json \
 *     --out demo/<slug>/clips/feature-1.mp4 \
 *     --cwd /path/to/demo-project \
 *     --target-duration 14.0
 *
 * Unlike web-perform/mac-perform there is NO fitting to the narration and no
 * word pinning: waitStable durations are decided by the program under demo, so
 * the take runs at natural speed and is retimed afterwards (0.5x-2x). The raw
 * take is kept beside the output — it is the expensive artifact; re-recorded
 * narration only needs a re-retime, not a new live session.
 *
 * This mutates the real desktop and opens a real terminal window; everything is
 * restored on the way out, including on Ctrl-C. Keep hands off the mouse and
 * keyboard during a take.
 */
import path from "node:path";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { parseArgs, requireArg, boolArg } from "../lib/args.mjs";
import { normalize, validate } from "../lib/actions.mjs";
import { CliSession } from "./cli-session.mjs";
import { retimeClip } from "../edit/retime.mjs";
import { sleep } from "../lib/cursor.mjs";
import { report, info, warn, main, fmtDuration } from "../lib/log.mjs";

const USAGE =
  "cli-perform.mjs --actions <file.json> --out <clip.mp4> [--cwd <dir>] " +
  "[--target-duration <sec>] [--width 1920] [--height 1080] [--fps 30] " +
  "[--font-size 20] [--keep-raw true]";

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const actionsFile = requireArg(args, "actions", USAGE);
  const outFile = requireArg(args, "out", USAGE);

  const script = JSON.parse(await readFile(actionsFile, "utf8"));
  const check = validate(script);
  if (!check.ok) {
    throw new Error(`Invalid action script ${actionsFile}:\n  - ${check.errors.join("\n  - ")}`);
  }

  const cwd = args.cwd || script.cwd || process.cwd();
  const targetSec = args["target-duration"] ? Number(args["target-duration"]) : null;
  const fps = Number(args.fps) || 30;
  const plan = normalize(script);

  // With a target we record raw and retime into --out; without one the take IS the clip.
  const rawFile = targetSec ? outFile.replace(/\.mp4$/, ".raw.mp4") : outFile;

  const session = new CliSession({
    cwd,
    width: Number(args.width) || plan.viewport?.width || 1920,
    height: Number(args.height) || plan.viewport?.height || 1080,
    fps,
    fontSize: args["font-size"] ? Number(args["font-size"]) : undefined,
    setup: args.setup || script.setup || null,
  });

  let result;
  try {
    await session.start();
    await session.startRecording(path.resolve(rawFile));

    info(`  performing ${plan.steps.length} step(s) at natural pace in ${cwd}`);
    session.markStart();

    // Same sleep-to-planned-mark loop as the other runners so typing overhead is
    // absorbed, but re-anchored to the clock after each step: waitStable makes
    // wall time diverge from planned time, and dwell must still follow it.
    let plannedElapsed = 0;
    for (const step of plan.steps) {
      info(`   ${String(step.index + 1).padStart(2)}. ${step.type.padEnd(10)} ${step.label || ""}`);
      await session.perform(step);

      plannedElapsed = Math.max(plannedElapsed + step.intrinsicMs, session.nowMs()) + step.dwellMs;
      const catchUp = plannedElapsed - session.nowMs();
      if (catchUp > 0) await sleep(catchUp);
    }
  } finally {
    // close() stops the recorder, restores the desktop and closes the demo window.
    result = await session.close();
  }

  const rawSec = result.meta?.duration ?? null;

  const eventsFile = args.events || outFile.replace(/\.mp4$/, ".events.json");
  await mkdir(path.dirname(path.resolve(eventsFile)), { recursive: true });
  await writeFile(
    eventsFile,
    `${JSON.stringify({
      version: 1,
      clip: path.basename(outFile),
      viewport: { width: session.width, height: session.height },
      durationSec: rawSec,
      events: result.events,
    }, null, 2)}\n`
  );

  let retimed = null;
  if (targetSec) {
    if (rawSec == null) throw new Error(`recording failed — nothing to retime at ${rawFile}`);
    retimed = await retimeClip({
      input: rawFile,
      output: outFile,
      targetSec,
      eventsFile,
      fps,
    });
    if (!boolArg(args["keep-raw"], true)) {
      await unlink(path.resolve(rawFile)).catch(() => {});
      warn("raw take deleted (--keep-raw false) — a narration change will need a fresh live take.");
    }
  }

  const finalSec = retimed?.durationSec ?? rawSec;
  report(
    `  done: ${outFile}${finalSec != null ? ` (${fmtDuration(finalSec)}` : ""}` +
    `${retimed ? `, ${retimed.factor.toFixed(2)}x from a ${fmtDuration(rawSec)} take)` : finalSec != null ? ")" : ""}`,
    {
      ok: true,
      video: path.resolve(outFile),
      events: path.resolve(eventsFile),
      rawVideo: targetSec && boolArg(args["keep-raw"], true) ? path.resolve(rawFile) : null,
      durationSec: finalSec,
      rawSec,
      targetSec,
      factor: retimed?.factor ?? 1,
      clamped: retimed?.clamped ?? false,
      steps: plan.steps.length,
      eventCount: result.events.length,
    }
  );
});
