#!/usr/bin/env node
/**
 * Performance pass for desktop demos — the counterpart to web-perform.mjs.
 *
 *   node scripts/capture/mac-perform.mjs \
 *     --actions demo/<slug>/actions/settings.json \
 *     --out demo/<slug>/clips/settings.mp4 \
 *     --app "Visual Studio Code" \
 *     --target-duration 12.1
 *
 * Same pacing model as the web runner: a feedback loop that corrects drift each
 * step so the clip lands on the narration.
 *
 * This mutates the real desktop (window size, Dock, desktop icons) and restores
 * everything on the way out, including on Ctrl-C.
 */
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs, requireArg } from "../lib/args.mjs";
import { normalize, validate, fitToDuration, resolvePins } from "../lib/actions.mjs";
import { MacSession } from "./mac-session.mjs";
import { sleep } from "../lib/cursor.mjs";
import { report, info, warn, main, fmtDuration } from "../lib/log.mjs";

const USAGE =
  "mac-perform.mjs --actions <file.json> --out <clip.mp4> [--app <name>] " +
  "[--target-duration <sec>] [--timestamps <words.json>] [--width 1920] [--height 1080] [--fps 30]";

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const actionsFile = requireArg(args, "actions", USAGE);
  const outFile = requireArg(args, "out", USAGE);

  const script = JSON.parse(await readFile(actionsFile, "utf8"));
  const check = validate(script);
  if (!check.ok) {
    throw new Error(`Invalid action script ${actionsFile}:\n  - ${check.errors.join("\n  - ")}`);
  }

  const targetSec = args["target-duration"] ? Number(args["target-duration"]) : null;
  const targetMs = targetSec ? targetSec * 1000 : null;

  const fitted = fitToDuration(normalize(script), targetMs);
  if (fitted.overflowMs > 0) {
    warn(
      `these steps need ${fmtDuration(fitted.plannedMs / 1000)} but the narration is only ` +
      `${fmtDuration(targetSec)} — the clip will overrun by ${fmtDuration(fitted.overflowMs / 1000)}.`
    );
  }
  const plan = fitted.script;

  let pins = new Map();
  if (args.timestamps && existsSync(args.timestamps)) {
    const raw = JSON.parse(await readFile(args.timestamps, "utf8"));
    pins = resolvePins(plan, raw.timestamps || raw.words || raw);
    if (pins.size) info(`  ${pins.size} step(s) pinned to spoken words`);
  }

  const session = new MacSession({
    app: args.app || script.app || null,
    width: Number(args.width) || plan.viewport?.width || 1920,
    height: Number(args.height) || plan.viewport?.height || 1080,
    fps: Number(args.fps) || 30,
  });

  let result;
  try {
    await session.start();
    await session.startRecording(path.resolve(outFile));

    info(`  performing ${plan.steps.length} step(s)${targetSec ? ` in ${fmtDuration(targetSec)}` : ""}`);
    session.markStart();

    // Identical feedback-loop pacing to the web runner: sleep until the mark we
    // intended to hit, so overhead is absorbed rather than accumulated.
    let plannedElapsed = 0;

    for (const step of plan.steps) {
      const pinAt = pins.get(step.index);
      if (pinAt != null) {
        const wait = pinAt - session.nowMs();
        if (wait > 0) await sleep(wait);
        else warn(`step ${step.index} (${step.label || step.type}) missed its pin by ${-wait}ms`);
        plannedElapsed = Math.max(plannedElapsed, pinAt);
      }

      info(`   ${String(step.index + 1).padStart(2)}. ${step.type.padEnd(9)} ${step.label || ""}`);
      await session.perform(step);

      plannedElapsed += step.intrinsicMs + step.dwellMs;
      const catchUp = plannedElapsed - session.nowMs();
      if (catchUp > 0) await sleep(catchUp);
    }

    if (targetMs) {
      const remaining = targetMs - session.nowMs();
      if (remaining > 0) await sleep(remaining);
    }
  } finally {
    // close() stops the recorder and restores the desktop even if a step threw.
    result = await session.close();
  }

  const eventsFile = args.events || outFile.replace(/\.mp4$/, ".events.json");
  await mkdir(path.dirname(path.resolve(eventsFile)), { recursive: true });
  await writeFile(
    eventsFile,
    `${JSON.stringify({
      version: 1,
      clip: path.basename(outFile),
      viewport: { width: session.width, height: session.height },
      durationSec: result.meta?.duration ?? null,
      events: result.events,
    }, null, 2)}\n`
  );

  const actualSec = result.meta?.duration ?? null;
  const drift = actualSec != null && targetSec ? actualSec - targetSec : null;
  if (drift != null && Math.abs(drift) > 0.5) {
    warn(`clip is ${fmtDuration(Math.abs(drift))} ${drift > 0 ? "longer" : "shorter"} than the narration`);
  }

  report(
    `  done: ${outFile}${actualSec != null ? ` (${actualSec.toFixed(2)}s)` : ""}`,
    {
      ok: true,
      video: result.video,
      events: path.resolve(eventsFile),
      durationSec: actualSec,
      targetSec,
      driftSec: drift,
      steps: plan.steps.length,
      eventCount: result.events.length,
    }
  );
});
