#!/usr/bin/env node
/**
 * Turn demo.json into Remotion props.
 *
 *   node scripts/render/build-props.mjs --project demo
 *
 * This is the seam between the pipeline and the compositor, and it does three
 * things the renderer should not have to:
 *
 *  1. VALIDATES that every artifact a scene claims actually exists on disk. A
 *     missing clip surfaces here as a clear error instead of a black rectangle in
 *     the finished render.
 *  2. INLINES the per-scene data the components need — the capture event log (for
 *     zoom-to-click) and the word timings (for captions) — so components never do
 *     file I/O.
 *  3. RECONCILES claimed durations with measured ones. Generated video comes back
 *     at whatever length the model felt like; if a presenter clip is 7.4s but the
 *     manifest says 8.0s, the scene is trimmed to what actually exists rather than
 *     holding on a frozen last frame.
 */
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "../lib/args.mjs";
import * as manifest from "../lib/manifest.mjs";
import { probe } from "../lib/ff.mjs";
import { minSceneDuration, gapAfter, transitionAfterSec } from "../lib/pacing.mjs";
import { report, info, warn, main, fmtDuration } from "../lib/log.mjs";

const USAGE = "build-props.mjs --project <dir> [--out <props.json>] [--lenient]";

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function buildProps(projectDir, { lenient = false } = {}) {
  const m = await manifest.load(projectDir);
  const manifestRef = m;

  const check = manifest.validate(m);
  for (const w of check.warnings) warn(w);
  if (!check.ok) {
    throw new Error(`demo.json is not renderable:\n  - ${check.errors.join("\n  - ")}`);
  }

  const problems = [];
  const timeline = [];

  for (const [sceneIndex, scene] of m.timeline.entries()) {
    const out = { ...scene };
    // The last scene has no following line to collide with, so it only needs to
    // outlast its own narration — it does not need the extra breath.
    const isLast = sceneIndex === m.timeline.length - 1;

    if (scene.video) {
      const abs = manifest.resolveIn(projectDir, scene.video);
      if (!existsSync(abs)) {
        problems.push(`scene "${scene.id}": video not found at ${scene.video}`);
      } else {
        const meta = await probe(abs).catch(() => null);
        if (meta?.duration) {
          const claimed = scene.durationSec || meta.duration;
          // Never ask the renderer for more video than exists — BUT never trim a
          // scene so short that it cuts its own narration off mid-word, or that the
          // next line starts before this one ends. A clip that is fractionally
          // short is a much smaller problem than audio talking over itself.
          const floor = isLast
            ? (scene.narrationSec || 0)
            : minSceneDuration(manifestRef, scene);
          if (meta.duration < claimed - 0.1) {
            if (meta.duration >= floor) {
              warn(
                `scene "${scene.id}": clip is ${fmtDuration(meta.duration)} but the timeline ` +
                `wants ${fmtDuration(claimed)} — trimming the scene to the clip.`
              );
              out.durationSec = meta.duration;
            } else {
              warn(
                `scene "${scene.id}": clip is ${fmtDuration(meta.duration)}, shorter than the ` +
                `${fmtDuration(floor)} its narration needs — holding the last frame instead of ` +
                `cutting the voice off. Re-record it with --target-duration ${floor.toFixed(2)}.`
              );
            }
          }
        }
      }
    } else if (scene.kind !== "card") {
      problems.push(`scene "${scene.id}": kind "${scene.kind}" has no video`);
    }

    if (scene.audio) {
      const abs = manifest.resolveIn(projectDir, scene.audio);
      if (!existsSync(abs)) problems.push(`scene "${scene.id}": audio not found at ${scene.audio}`);
    }

    // Inline the event log so DemoClip can zoom toward clicks.
    if (scene.events) {
      const ev = await readJson(manifest.resolveIn(projectDir, scene.events));
      if (ev) {
        out.events = ev.events || [];
        out.viewport = ev.viewport || scene.viewport;
      } else {
        warn(`scene "${scene.id}": could not read events — zoom-to-click disabled for it.`);
      }
    }

    // Inline word timings for captions.
    if (scene.words) {
      const w = await readJson(manifest.resolveIn(projectDir, scene.words));
      if (w?.timestamps?.length) out.wordTimings = w.timestamps;
    }

    if (!out.durationSec) {
      problems.push(`scene "${scene.id}": no duration could be determined`);
    }
    timeline.push(out);
  }

  /**
   * Last line of defence on the audio timeline.
   *
   * Transitions overlap scenes, so a scene that is not longer than its narration
   * makes the next line start underneath the current one. This is inaudible in any
   * still frame and only shows up when you listen, so it is checked mechanically
   * here rather than left to review.
   */
  for (const [i, scene] of timeline.entries()) {
    if (!scene.narrationSec || i === timeline.length - 1) continue;
    const gap = gapAfter(m, { ...scene, durationSec: scene.durationSec });
    if (gap != null && gap < 0) {
      const needed = scene.narrationSec + transitionAfterSec(m, scene.id) + 0.15;
      warn(
        `scene "${scene.id}": narration overlaps the next line by ${Math.abs(gap).toFixed(2)}s — ` +
        `extending the scene to ${needed.toFixed(2)}s so the voices do not collide.`
      );
      scene.durationSec = Number(needed.toFixed(3));
    }
  }

  if (problems.length) {
    const msg = `Cannot render yet:\n  - ${problems.join("\n  - ")}`;
    if (!lenient) throw new Error(msg);
    warn(msg);
  }

  return {
    slug: m.slug,
    format: m.format,
    brand: m.brand,
    presenter: m.presenter,
    music: m.music,
    captions: m.captions,
    transitions: m.transitions || [],
    timeline,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(async () => {
    const args = parseArgs(process.argv.slice(2));
    const projectDir = manifest.resolveProjectDir(args.project);
    const props = await buildProps(projectDir, { lenient: Boolean(args.lenient) });

    const out = path.resolve(args.out || path.join(projectDir, "remotion", "src", "props.json"));
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(props, null, 2)}\n`);

    const total = props.timeline.reduce((s, x) => s + (x.durationSec || 0), 0);
    const overlap = (props.transitions || []).reduce((s, t) => s + (t.ms || 400) / 1000, 0);
    info(`  ${props.timeline.length} scene(s), ${fmtDuration(total - overlap)} finished runtime`);
    report(`  props -> ${out}`, {
      ok: true, props: out, scenes: props.timeline.length,
      runtimeSec: total - overlap,
    });
  });
}
