#!/usr/bin/env node
/**
 * B-roll cutscenes: the shots between demo segments where a person is using the
 * product, a team is reacting, an office establishes context.
 *
 *   node scripts/gen/broll.mjs --project demo/<slug> --all
 *   node scripts/gen/broll.mjs --project demo/<slug> --scene broll-1 --model veo-3.1
 *
 * Two-stage by default: generate a still, then animate it. Image-to-video gives far
 * more control over who is in the shot and what it looks like than text-to-video,
 * and a bad still costs cents to redo where a bad video costs dollars.
 *
 * Falls through VIDEO_LADDER when a model refuses a prompt on content grounds
 * (people, brands and workplaces trip different models' filters), reporting which
 * model actually produced each shot.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs, boolArg } from "../lib/args.mjs";
import { submitAndWait, extractUrl, download, toUrl } from "../lib/fal.mjs";
import { probe } from "../lib/ff.mjs";
import { isContentRestrictionError, getImageDimensions, isValidVeoAspectRatio } from "../lib/image.mjs";
import * as manifest from "../lib/manifest.mjs";
import * as cache from "../lib/cache.mjs";
import { IMAGE, VIDEO, VIDEO_LADDER, resolve } from "../lib/models.mjs";
import { report, info, warn, main, fmtDuration } from "../lib/log.mjs";

const USAGE =
  "broll.mjs --project <dir> [--manifest <file>] (--all | --scene <id>) " +
  "[--model grok-imagine|sora-2|veo-3.1|...] [--aspect 9:16] [--force]";

/** Generate the reference still for a shot. */
async function makeStill({ projectDir, prompt, outFile, model = "nano-banana-pro", aspect = "16:9", force }) {
  const spec = resolve(IMAGE, model);
  return cache.memo(
    projectDir,
    { kind: "broll-still", model: spec.endpoint, params: { prompt, aspect } },
    async () => {
      const data = await submitAndWait(spec.endpoint, {
        prompt: `${prompt}. Cinematic still, natural lighting, shallow depth of field, photorealistic.`,
        num_images: 1,
        aspect_ratio: aspect,
      });
      const url = extractUrl(data);
      if (!url) throw new Error(`${spec.endpoint} returned no image`);
      return download(url, outFile);
    },
    { force }
  );
}

/**
 * Build the per-model input for a video call.
 * Each model has its own idea of how duration is expressed; getting this wrong is
 * the most common cause of a confusing 422 from fal.
 */
function videoInput(modelName, { imageUrl, prompt, durationSec }) {
  const input = { prompt };
  if (imageUrl) input.image_url = imageUrl;

  switch (modelName) {
    case "grok-imagine":
      input.duration = 6; // fixed by the model
      break;
    case "sora-2": {
      const allowed = [4, 8, 12];
      input.duration = allowed.reduce((a, b) =>
        Math.abs(b - durationSec) < Math.abs(a - durationSec) ? b : a);
      input.resolution = "720p";
      break;
    }
    case "veo-3.1":
      input.duration = `${Math.min(8, Math.max(4, Math.round(durationSec)))}s`;
      break;
    default:
      input.duration = Math.round(durationSec);
  }
  return input;
}

/** Try each model in the ladder until one produces a shot. */
async function animateStill({ projectDir, stillFile, prompt, durationSec, outFile, preferred, force }) {
  const ladder = preferred
    ? [preferred, ...VIDEO_LADDER.filter((m) => m !== preferred)]
    : VIDEO_LADDER;

  const imageUrl = stillFile ? await toUrl(stillFile) : null;
  const refusals = [];

  for (const name of ladder) {
    const spec = VIDEO[name];
    const endpoint = imageUrl ? spec?.i2v : spec?.t2v;
    if (!endpoint) continue;

    // veo is strict about aspect ratio; check before spending the call.
    if (name === "veo-3.1" && stillFile) {
      const dims = await getImageDimensions(imageUrl).catch(() => null);
      if (dims && !isValidVeoAspectRatio(dims.width, dims.height)) {
        refusals.push(`${name}: still is ${dims.width}x${dims.height}, not a 16:9/9:16 ratio`);
        continue;
      }
    }

    try {
      info(`    trying ${name} (${endpoint})…`);
      const result = await cache.memo(
        projectDir,
        {
          kind: "broll-video",
          model: endpoint,
          params: { prompt, durationSec },
          files: stillFile ? [stillFile] : [],
        },
        async () => {
          const data = await submitAndWait(
            endpoint,
            videoInput(name, { imageUrl, prompt, durationSec })
          );
          const url = extractUrl(data);
          if (!url) throw new Error(`${endpoint} returned no video`);
          return download(url, outFile);
        },
        { force }
      );
      return { ...result, model: name, endpoint };
    } catch (e) {
      if (isContentRestrictionError(e)) {
        warn(`${name} refused this prompt — trying the next model`);
        refusals.push(`${name}: ${e.message.split("\n")[0]}`);
        continue;
      }
      throw e;
    }
  }

  const err = new Error(
    `Every video model refused or failed this shot:\n  - ${refusals.join("\n  - ")}`
  );
  err.extra = { content_blocked: true, suggestion: "Rewrite the prompt to be less specific about people or brands." };
  throw err;
}

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const force = boolArg(args.force, false);
  const projectDir = manifest.resolveProjectDir(args.project);
  const name = args.manifest || manifest.MANIFEST_NAME;
  const m = await manifest.load(projectDir, { name });

  const scenes = args.all
    ? m.timeline.filter((s) => s.kind === "broll")
    : [manifest.getScene(m, args.scene)];

  if (!scenes.length) {
    return report("  no b-roll scenes in the timeline", { ok: true, generated: 0 });
  }

  const out = [];
  for (const scene of scenes) {
    if (!scene.prompt) {
      warn(`scene "${scene.id}" has no prompt — skipping`);
      continue;
    }
    const durationSec = scene.durationSec || 6;
    const videoAbs = manifest.resolveIn(projectDir, scene.video || path.join("clips", `${scene.id}.mp4`));
    const stillAbs = manifest.resolveIn(projectDir, path.join("assets", `${scene.id}-still.png`));
    await mkdir(path.dirname(videoAbs), { recursive: true });
    await mkdir(path.dirname(stillAbs), { recursive: true });

    info(`  ${scene.id}: "${scene.prompt.slice(0, 60)}…"`);

    // A caller can supply their own still (a real product photo, a brand asset).
    let still = scene.still ? manifest.resolveIn(projectDir, scene.still) : null;
    if (!still && !boolArg(args["text-to-video"], false)) {
      // The still carries the geometry: i2v models inherit its aspect, so a
      // vertical manifest gets vertical b-roll with no per-model plumbing.
      const s = await makeStill({
        projectDir, prompt: scene.prompt, outFile: stillAbs,
        model: args.image_model || "nano-banana-pro",
        aspect: args.aspect || scene.aspect || manifest.aspectOf(m.format),
        force,
      });
      still = s.path;
      scene.still = manifest.relativeIn(projectDir, s.path);
      info(`    still ${s.cached ? "cached" : "generated"}`);
    }

    const v = await animateStill({
      projectDir, stillFile: still, prompt: scene.prompt, durationSec,
      outFile: videoAbs, preferred: args.model || scene.model || null, force,
    });

    const meta = await probe(v.path).catch(() => null);
    scene.video = manifest.relativeIn(projectDir, v.path);
    scene.model = v.model;
    if (meta?.duration) scene.videoDurationSec = meta.duration;

    info(`    ${v.cached ? "cached" : "generated"} via ${v.model}, ${fmtDuration(meta?.duration)}`);
    out.push({ scene: scene.id, video: v.path, model: v.model, cached: v.cached, durationSec: meta?.duration ?? null });
  }

  await manifest.save(projectDir, m, { name });
  report(`  b-roll: ${out.length} shot(s) ready`, { ok: true, scenes: out });
});
