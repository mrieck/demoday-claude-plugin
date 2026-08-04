#!/usr/bin/env node
/**
 * Performance pass for web demos: replay a rehearsed action script while recording.
 *
 * No model is involved here. That is the entire point — the footage is smooth
 * because nothing pauses to think.
 *
 *   node scripts/capture/web-perform.mjs \
 *     --actions demo/actions/create.json \
 *     --out demo/clips/create.mp4 \
 *     --target-duration 12.1 \
 *     --timestamps demo/audio/create.words.json
 *
 * --target-duration paces the replay to the narration by stretching dwell, so the
 * clip lands on the voiceover instead of needing to be cut to fit afterwards.
 */
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs, requireArg, boolArg } from "../lib/args.mjs";
import { normalize, validate, fitToDuration, resolvePins } from "../lib/actions.mjs";
import { WebSession } from "./web-session.mjs";
import { sleep } from "../lib/cursor.mjs";
import { report, info, warn, main, fmtDuration } from "../lib/log.mjs";

const USAGE =
  "web-perform.mjs --actions <file.json> --out <clip.mp4> " +
  "[--target-duration <sec>] [--timestamps <words.json>] [--events <file.json>] " +
  "[--headless] [--base-url <url>] [--storage-state <file>] [--fps 30]";

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const actionsFile = requireArg(args, "actions", USAGE);
  const outFile = requireArg(args, "out", USAGE);

  const script = JSON.parse(await readFile(actionsFile, "utf8"));
  const check = validate(script);
  if (!check.ok) {
    throw new Error(`Invalid action script ${actionsFile}:\n  - ${check.errors.join("\n  - ")}`);
  }

  const fps = Number(args.fps) || 30;
  const targetSec = args["target-duration"] ? Number(args["target-duration"]) : null;
  const targetMs = targetSec ? targetSec * 1000 : null;

  // Pace the script to the narration.
  const fitted = fitToDuration(normalize(script), targetMs);
  if (fitted.overflowMs > 0) {
    warn(
      `these steps need ${fmtDuration(fitted.plannedMs / 1000)} but the narration is only ` +
      `${fmtDuration(targetSec)} — the clip will overrun by ${fmtDuration(fitted.overflowMs / 1000)}. ` +
      `Shorten the step list or lengthen the narration.`
    );
  }
  const plan = fitted.script;

  // Word timestamps let a step fire exactly as a word is spoken.
  let pins = new Map();
  if (args.timestamps && existsSync(args.timestamps)) {
    const raw = JSON.parse(await readFile(args.timestamps, "utf8"));
    pins = resolvePins(plan, raw.timestamps || raw.words || raw);
    if (pins.size) info(`  ${pins.size} step(s) pinned to spoken words`);
  }

  const session = new WebSession({
    width: plan.viewport?.width || 1920,
    height: plan.viewport?.height || 1080,
    record: true,
    outDir: path.dirname(path.resolve(outFile)),
    headless: boolArg(args.headless, false),
    storageState: args["storage-state"] || null,
    baseUrl: args["base-url"] || plan.url || null,
  });

  await session.start();

  let result;
  try {
    // Setup happens BEFORE markStart so navigation and login never appear in the clip.
    if (plan.url) {
      info(`  opening ${plan.url}`);
      await session.perform({ type: "goto", url: plan.url, intrinsicMs: 0, dwellMs: 0 });
      await sleep(Number(args["settle-ms"]) || 1200);
    }

    /**
     * Optional `setup` steps put the app into the state the scene starts from —
     * selecting a record, opening a panel, scrolling to a section — without any of
     * it appearing on camera.
     *
     * Without this, every scene after the first has to re-navigate from the home
     * screen on film, so the finished video shows the same click three times. Setup
     * steps run at full speed since nobody is watching them.
     */
    if (plan.setup?.length) {
      info(`  setup: ${plan.setup.length} step(s) (not recorded)`);
      for (const raw of normalize({ ...plan, steps: plan.setup }).steps) {
        await session.perform({ ...raw, dwellMs: 0 });
        await sleep(raw.dwellMs ?? 250);
      }
      await sleep(Number(args["setup-settle-ms"]) || 800);
    }

    info(`  performing ${plan.steps.length} step(s)${targetSec ? ` in ${fmtDuration(targetSec)}` : ""}`);
    session.markStart();

    /**
     * Pacing is a feedback loop, not a fixed schedule.
     *
     * `plannedElapsed` is where we intended to be on the timeline after each step.
     * Every step then sleeps until that mark rather than for a fixed dwell, so any
     * overhead the estimate missed — CDP latency, a slow selector, a heavy repaint —
     * is absorbed by shortening the next pause instead of accumulating. Open-loop
     * dwell drifted by up to a third of a second on short clips, which is enough to
     * pull the footage off the narration.
     */
    let plannedElapsed = 0;

    for (const step of plan.steps) {
      // A pinned step waits for its moment in the narration rather than simply
      // following the previous step.
      const pinAt = pins.get(step.index);
      if (pinAt != null) {
        const wait = pinAt - session.nowMs();
        if (wait > 0) await sleep(wait);
        else warn(`step ${step.index} (${step.label || step.type}) missed its pin by ${-wait}ms`);
        plannedElapsed = Math.max(plannedElapsed, pinAt);
      }

      const label = step.label || step.type;
      info(`   ${String(step.index + 1).padStart(2)}. ${step.type.padEnd(9)} ${label}`);

      await session.perform(step);

      plannedElapsed += step.intrinsicMs + step.dwellMs;
      const catchUp = plannedElapsed - session.nowMs();
      if (catchUp > 0) await sleep(catchUp);
    }

    // Hold the final frame so the clip fills the narration exactly rather than
    // ending early and leaving the last words over black.
    if (targetMs) {
      const remaining = targetMs - session.nowMs();
      if (remaining > 0) await sleep(remaining);
    }
  } finally {
    result = await session.close({ mp4Path: path.resolve(outFile), fps });
  }

  // The event log is what lets the renderer zoom toward each click and place
  // callouts on the right pixel. Without it a demo clip is just flat footage.
  const eventsFile = args.events || outFile.replace(/\.mp4$/, ".events.json");
  await mkdir(path.dirname(path.resolve(eventsFile)), { recursive: true });
  await writeFile(
    eventsFile,
    `${JSON.stringify({
      version: 1,
      clip: path.basename(outFile),
      viewport: plan.viewport,
      durationSec: result.meta?.duration ?? null,
      events: result.events,
    }, null, 2)}\n`
  );

  const actualSec = result.meta?.duration ?? null;
  const drift = actualSec != null && targetSec ? actualSec - targetSec : null;
  if (drift != null && Math.abs(drift) > 0.5) {
    warn(`clip is ${drift > 0 ? "" : "-"}${fmtDuration(Math.abs(drift))} off the narration length`);
  }

  report(
    `  done: ${outFile}${actualSec != null ? ` (${actualSec.toFixed(2)}s)` : ""}`,
    {
      ok: true,
      video: path.resolve(outFile),
      events: path.resolve(eventsFile),
      durationSec: actualSec,
      targetSec,
      driftSec: drift,
      steps: plan.steps.length,
      eventCount: result.events.length,
    }
  );
});
