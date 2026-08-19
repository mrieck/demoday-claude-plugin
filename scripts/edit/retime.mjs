#!/usr/bin/env node
/**
 * Retime a recorded clip to a target duration — the post step that reconciles a
 * CLI take (which runs at whatever pace the real program ran at) with the
 * narration, whose length was fixed first.
 *
 *   node scripts/edit/retime.mjs \
 *     --in demo/<slug>/clips/feature-1.raw.mp4 \
 *     --out demo/<slug>/clips/feature-1.mp4 \
 *     --target-duration 14.0 \
 *     --events demo/<slug>/clips/feature-1.events.json
 *
 * Standalone on purpose: re-recording the narration only costs a re-retime of
 * the kept raw file, not a new live take (which spends real API usage when the
 * program under demo is claude).
 *
 * The factor is clamped to a watchable range. A clamped clip misses the target;
 * that residue is left to build-props.mjs, whose duration reconciliation already
 * trims long clips and holds the last frame of short ones, with warnings.
 */
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs, requireArg } from "../lib/args.mjs";
import { probe, retime } from "../lib/ff.mjs";
import { report, warn, main, fmtDuration } from "../lib/log.mjs";

export const MIN_FACTOR = 0.5;
export const MAX_FACTOR = 2.0;

const USAGE =
  "retime.mjs --in <raw.mp4> --out <clip.mp4> --target-duration <sec> " +
  "[--events <file.json>] [--fps 30] [--min-factor 0.5] [--max-factor 2]";

/**
 * Retime `input` to land on `targetSec`, and scale the event log to match.
 * setpts multiplies presentation times, so factor = target / raw.
 */
export async function retimeClip({
  input, output, targetSec, eventsFile = null, fps = 30,
  minFactor = MIN_FACTOR, maxFactor = MAX_FACTOR,
} = {}) {
  const rawSec = (await probe(input)).duration;
  if (!rawSec) throw new Error(`could not probe the duration of ${input}`);
  if (!targetSec || targetSec <= 0) throw new Error(`invalid target duration: ${targetSec}`);

  const wanted = targetSec / rawSec;
  const factor = Math.min(maxFactor, Math.max(minFactor, wanted));
  const clamped = factor !== wanted;
  if (clamped) {
    warn(
      `retime factor ${wanted.toFixed(2)}x is outside the watchable range ` +
      `[${minFactor}x, ${maxFactor}x] — clamping to ${factor.toFixed(2)}x. ` +
      (wanted < minFactor
        ? "The take is much longer than the narration: shorten the prompts, tighten waitStable, or lengthen the narration."
        : "The take is much shorter than the narration: add steps or dwell, or tighten the narration.")
    );
  }

  await retime(input, output, factor, { fps });
  const outSec = (await probe(output)).duration ?? null;

  let events = null;
  if (eventsFile && existsSync(eventsFile)) {
    const log = JSON.parse(await readFile(eventsFile, "utf8"));
    for (const ev of log.events || []) {
      if (typeof ev.atMs === "number") ev.atMs = Math.round(ev.atMs * factor);
    }
    log.durationSec = outSec;
    log.retime = { rawSec, factor, clamped };
    await writeFile(eventsFile, `${JSON.stringify(log, null, 2)}\n`);
    events = path.resolve(eventsFile);
  }

  return {
    video: path.resolve(output),
    events,
    rawSec,
    targetSec,
    durationSec: outSec,
    factor,
    wantedFactor: wanted,
    clamped,
  };
}

// ---- CLI -------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(async () => {
    const args = parseArgs(process.argv.slice(2));
    const r = await retimeClip({
      input: requireArg(args, "in", USAGE),
      output: requireArg(args, "out", USAGE),
      targetSec: Number(requireArg(args, "target-duration", USAGE)),
      eventsFile: args.events || null,
      fps: Number(args.fps) || 30,
      minFactor: Number(args["min-factor"]) || MIN_FACTOR,
      maxFactor: Number(args["max-factor"]) || MAX_FACTOR,
    });
    report(
      `  retimed ${fmtDuration(r.rawSec)} -> ${fmtDuration(r.durationSec)} ` +
      `(${r.factor.toFixed(2)}x${r.clamped ? ", clamped" : ""}): ${r.video}`,
      { ok: true, ...r }
    );
  });
}
