#!/usr/bin/env node
/**
 * The on-camera presenter — the "paid actor" half of a demo.
 *
 *   node scripts/gen/presenter.mjs --project demo --character   # make the face
 *   node scripts/gen/presenter.mjs --project demo --all         # animate every presenter scene
 *   node scripts/gen/presenter.mjs --project demo --scene intro
 *
 * TWO DECISIONS ARE BAKED IN HERE:
 *
 * 1. One character image, reused for every presenter shot. Regenerating the face
 *    per scene produces a subtly different person each time, which is far more
 *    unsettling than a slightly static one. The image is generated once, stored on
 *    the manifest, and every shot animates from it.
 *
 * 2. Image + narration audio -> talking video, in ONE step (infinitalk /
 *    kling-avatar / omnihuman). The alternative — generate a video of a person,
 *    then lip-sync it — costs more and fights itself, because the video model
 *    invents mouth movements the lip-sync model then has to overwrite.
 *
 * The audio is whatever gen/tts.mjs already produced for that scene, so the
 * presenter speaks in the same voice as the narration over the screen segments.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs, boolArg } from "../lib/args.mjs";
import { submitAndWait, extractUrl, download, toUrl } from "../lib/fal.mjs";
import { probe } from "../lib/ff.mjs";
import { isContentRestrictionError } from "../lib/image.mjs";
import * as manifest from "../lib/manifest.mjs";
import * as cache from "../lib/cache.mjs";
import { AVATAR, IMAGE, resolve } from "../lib/models.mjs";
import { report, info, warn, main, fmtDuration } from "../lib/log.mjs";

const USAGE =
  "presenter.mjs --project <dir> (--character | --all | --scene <id>) " +
  "[--engine infinitalk|kling-avatar|omnihuman] [--force]";

/**
 * Generate the presenter's face once.
 *
 * The prompt deliberately asks for a neutral, forward-facing, well-lit portrait:
 * avatar models animate a still, so an extreme pose or heavy shadow in the source
 * becomes an artefact in every single shot.
 */
export async function makeCharacter({ projectDir, description, model = "nano-banana-pro", force = false }) {
  const spec = resolve(IMAGE, model);
  const prompt =
    `${description}. Professional headshot for a product video: facing the camera, ` +
    `neutral friendly expression, mouth closed, even soft studio lighting, ` +
    `plain uncluttered background, sharp focus, shoulders visible, photorealistic.`;

  const outFile = path.join(projectDir, "assets", "presenter.png");
  await mkdir(path.dirname(outFile), { recursive: true });

  const result = await cache.memo(
    projectDir,
    { kind: "character", model: spec.endpoint, params: { prompt } },
    async () => {
      const data = await submitAndWait(spec.endpoint, {
        prompt,
        num_images: 1,
        aspect_ratio: "1:1",
      });
      const url = extractUrl(data);
      if (!url) throw new Error(`${spec.endpoint} returned no image`);
      return download(url, outFile);
    },
    { force }
  );
  return result;
}

/** Animate the character to a narration track. */
export async function animate({
  projectDir, imageFile, audioFile, outFile, engine = "infinitalk", prompt = null, force = false,
}) {
  const spec = AVATAR[engine] || resolve(AVATAR, engine);
  if (!spec?.endpoint) throw new Error(`Unknown presenter engine: ${engine}`);

  if (!existsSync(imageFile)) throw new Error(`Character image not found: ${imageFile}`);
  if (!existsSync(audioFile)) {
    throw new Error(
      `Narration audio not found: ${audioFile}\n` +
      `Run gen/tts.mjs first — the presenter is animated to the narration, not the other way round.`
    );
  }

  return cache.memo(
    projectDir,
    {
      kind: "presenter",
      model: spec.endpoint,
      params: { engine, prompt },
      files: [imageFile, audioFile],   // hashed, so a re-recorded line regenerates the shot
    },
    async () => {
      const [image_url, audio_url] = await Promise.all([toUrl(imageFile), toUrl(audioFile)]);
      const input = { image_url, audio_url };
      if (prompt) input.prompt = prompt;

      let data;
      try {
        data = await submitAndWait(spec.endpoint, input);
      } catch (e) {
        if (isContentRestrictionError(e)) {
          const err = new Error(
            `${spec.endpoint} refused this presenter shot on content grounds: ${e.message}`
          );
          err.extra = {
            content_blocked: true,
            suggestion: "Try a different --engine, or soften the character description.",
          };
          throw err;
        }
        throw e;
      }
      const url = extractUrl(data);
      if (!url) throw new Error(`${spec.endpoint} returned no video`);
      return download(url, outFile);
    },
    { force }
  );
}

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const force = boolArg(args.force, false);
  const projectDir = manifest.resolveProjectDir(args.project);
  const m = await manifest.load(projectDir);

  const mode = m.presenter?.mode || "hybrid";
  if (mode === "none" && !args.character) {
    return report(
      "  presenter.mode is \"none\" — no on-camera shots to generate.",
      { ok: true, skipped: true, mode }
    );
  }

  // ---- the face ----
  let characterAbs = m.presenter?.characterImage
    ? manifest.resolveIn(projectDir, m.presenter.characterImage)
    : null;

  if (args.character || !characterAbs || !existsSync(characterAbs)) {
    const description = args.description || m.presenter?.description;
    if (!description) {
      throw new Error(
        "No presenter description. Set presenter.description in demo.json " +
        "(e.g. \"a woman in her 30s, smart casual, warm and direct\") or pass --description."
      );
    }
    info(`  generating the presenter's face…`);
    const r = await makeCharacter({
      projectDir, description, model: args.image_model || "nano-banana-pro", force: args.character ? force : false,
    });
    characterAbs = r.path;
    m.presenter = m.presenter || {};
    m.presenter.characterImage = manifest.relativeIn(projectDir, r.path);
    m.presenter.description = description;
    await manifest.save(projectDir, m);
    info(`    ${r.cached ? "cached" : "generated"} -> ${m.presenter.characterImage}`);
    if (args.character) {
      return report(`  presenter face ready: ${m.presenter.characterImage}`, {
        ok: true, image: r.path, cached: r.cached,
      });
    }
  }

  // ---- the shots ----
  const engine = args.engine ||
    Object.keys(AVATAR).find((k) => AVATAR[k].endpoint === m.presenter?.engine) ||
    "infinitalk";

  const scenes = args.all
    ? m.timeline.filter((s) => s.kind === "presenter")
    : [manifest.getScene(m, args.scene)];

  if (!scenes.length) {
    return report("  no presenter scenes in the timeline", { ok: true, generated: 0 });
  }

  const out = [];
  for (const scene of scenes) {
    if (!scene.audio) {
      warn(`scene "${scene.id}" has no narration audio yet — run gen/tts.mjs --all first. Skipping.`);
      continue;
    }
    const videoRel = scene.video || path.join("clips", `${scene.id}.mp4`);
    const videoAbs = manifest.resolveIn(projectDir, videoRel);
    await mkdir(path.dirname(videoAbs), { recursive: true });

    info(`  ${scene.id}: animating presenter (${engine})…`);
    const r = await animate({
      projectDir,
      imageFile: characterAbs,
      audioFile: manifest.resolveIn(projectDir, scene.audio),
      outFile: videoAbs,
      engine,
      prompt: scene.presenterPrompt || null,
      force,
    });

    const meta = await probe(r.path).catch(() => null);
    scene.video = manifest.relativeIn(projectDir, r.path);
    if (meta?.duration) scene.videoDurationSec = meta.duration;

    info(`    ${r.cached ? "cached" : "generated"} ${fmtDuration(meta?.duration)} -> ${scene.video}`);
    out.push({ scene: scene.id, video: r.path, cached: r.cached, durationSec: meta?.duration ?? null });
  }

  await manifest.save(projectDir, m);
  report(
    `  presenter: ${out.length} shot(s) ready (engine: ${engine}, mode: ${mode})`,
    { ok: true, engine, mode, character: m.presenter.characterImage, scenes: out }
  );
});
