#!/usr/bin/env node
/**
 * The on-camera presenter — the "paid actor" half of a demo.
 *
 *   node scripts/gen/presenter.mjs --project demo/<slug> --character   # make the face
 *   node scripts/gen/presenter.mjs --project demo/<slug> --all         # animate every presenter scene
 *   node scripts/gen/presenter.mjs --project demo/<slug> --scene intro
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
  "presenter.mjs --project <dir> [--manifest <file>] (--character | --all | --scene <id>) " +
  "[--engine infinitalk|kling-avatar|omnihuman] [--force]";

/**
 * Generate the presenter's face once.
 *
 * The prompt deliberately asks for a neutral, forward-facing, well-lit portrait:
 * avatar models animate a still, so an extreme pose or heavy shadow in the source
 * becomes an artefact in every single shot.
 */
export async function makeCharacter({ projectDir, description, model = "nano-banana-pro", aspect = "1:1", force = false }) {
  const spec = resolve(IMAGE, model);
  const framing = aspect === "1:1" ? "shoulders visible" : "head and upper body visible";
  const prompt =
    `${description}. Professional headshot for a product video: facing the camera, ` +
    `neutral friendly expression, mouth closed, even soft studio lighting, ` +
    `plain uncluttered background, sharp focus, ${framing}, photorealistic.`;

  // Avatar models inherit the portrait's aspect, so a vertical video wants a
  // vertical portrait — stored under its own name so it never clobbers the
  // square one a landscape manifest in the same project is using.
  const outFile = path.join(
    projectDir, "assets",
    aspect === "1:1" ? "presenter.png" : `presenter-${aspect.replace(":", "x")}.png`
  );
  await mkdir(path.dirname(outFile), { recursive: true });

  // aspect joins the key only when non-default, so every existing "1:1" cache
  // entry keeps its hit (same convention as the tts provider key).
  const params = aspect === "1:1" ? { prompt } : { prompt, aspect };

  const result = await cache.memo(
    projectDir,
    { kind: "character", model: spec.endpoint, params },
    async () => {
      const data = await submitAndWait(spec.endpoint, {
        prompt,
        num_images: 1,
        aspect_ratio: aspect,
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
  const name = args.manifest || manifest.MANIFEST_NAME;
  const m = await manifest.load(projectDir, { name });

  const mode = m.presenter?.mode || "hybrid";
  if (mode === "none" && !args.character) {
    return report(
      "  presenter.mode is \"none\" — no on-camera shots to generate.",
      { ok: true, skipped: true, mode }
    );
  }

  // Three uses of a presenter clip: full presenter scenes, the bottom zone of a
  // split demo scene, and full-bleed face beats inside a beat-cut demo scene.
  const wantsClip = (s) =>
    s.kind === "demo" &&
    (s.bottom?.kind === "presenter" || (s.beats || []).some((b) => b.shot === "face"));
  const scenes = args.character
    ? []
    : args.all
      ? m.timeline.filter((s) => s.kind === "presenter" || wantsClip(s))
      : [manifest.getScene(m, args.scene)];
  const needsFullPortrait = boolArg(args.character, false) || scenes.some((s) => s.kind === "presenter");

  // A vertical video wants a vertical portrait for FULL-FRAME shots (the avatar
  // output inherits it). Bottom-zone shots live in a roughly square zone, so a
  // bottom-only run sticks with the square headshot.
  const charAspect = needsFullPortrait && manifest.aspectOf(m.format) === "9:16" ? "9:16" : "1:1";

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
      projectDir, description, model: args.image_model || "nano-banana-pro",
      aspect: charAspect, force: args.character ? force : false,
    });
    characterAbs = r.path;
    m.presenter = m.presenter || {};
    m.presenter.characterImage = manifest.relativeIn(projectDir, r.path);
    m.presenter.description = description;
    await manifest.save(projectDir, m, { name });
    info(`    ${r.cached ? "cached" : "generated"} -> ${m.presenter.characterImage}`);
    if (args.character) {
      return report(`  presenter face ready: ${m.presenter.characterImage}`, {
        ok: true, image: r.path, cached: r.cached,
      });
    }
  } else if (charAspect === "9:16" && !m.presenter.characterImage.includes("9x16")) {
    // A vertical manifest inherited a portrait from its landscape sibling. Not
    // regenerated silently — it may be a hand-crafted character — but full-bleed
    // vertical shots need a vertical source. (Bottom-zone-only runs never get
    // here: their charAspect is "1:1".)
    warn(
      `format is 9:16 but the presenter portrait (${m.presenter.characterImage}) is not — ` +
      "shots will be cropped. Regenerate with --character, or attach a 9:16 still via still.mjs --character."
    );
  }

  /**
   * Portrait for bottom-zone shots: the manifest's character image when it is
   * not the 9:16 variant (a custom character stays the character), else the
   * square default portrait — generated once if missing, WITHOUT touching
   * presenter.characterImage (which may deliberately point at the 9:16 file).
   */
  let bottomPortraitAbs = null;
  async function bottomPortrait() {
    if (bottomPortraitAbs) return bottomPortraitAbs;
    const ci = m.presenter?.characterImage;
    if (ci && !ci.includes("9x16") && existsSync(manifest.resolveIn(projectDir, ci))) {
      return (bottomPortraitAbs = manifest.resolveIn(projectDir, ci));
    }
    const square = path.join(projectDir, "assets", "presenter.png");
    if (existsSync(square)) return (bottomPortraitAbs = square);
    const description = args.description || m.presenter?.description;
    if (!description) {
      throw new Error(
        "A bottom-zone presenter shot needs a portrait, and there is no presenter.description to generate one from."
      );
    }
    info("  generating the presenter's square portrait for bottom-zone shots…");
    const r = await makeCharacter({
      projectDir, description, model: args.image_model || "nano-banana-pro", aspect: "1:1",
    });
    info(`    ${r.cached ? "cached" : "generated"} -> ${manifest.relativeIn(projectDir, r.path)}`);
    return (bottomPortraitAbs = r.path);
  }

  /**
   * Portrait for scenes with full-bleed FACE beats: on a vertical manifest the
   * clip fills the whole 9:16 frame, so it must come from the 9:16 portrait —
   * a square source would be blown up and cropped. Elsewhere, same as bottoms.
   */
  let facePortraitAbs = null;
  async function facePortrait() {
    if (facePortraitAbs) return facePortraitAbs;
    if (manifest.aspectOf(m.format) !== "9:16") return (facePortraitAbs = await bottomPortrait());
    const ci = m.presenter?.characterImage;
    if (ci && ci.includes("9x16") && existsSync(manifest.resolveIn(projectDir, ci))) {
      return (facePortraitAbs = manifest.resolveIn(projectDir, ci));
    }
    const nine = path.join(projectDir, "assets", "presenter-9x16.png");
    if (existsSync(nine)) return (facePortraitAbs = nine);
    const description = args.description || m.presenter?.description;
    if (!description) {
      throw new Error(
        "Face beats need a 9:16 portrait, and there is no presenter.description to generate one from."
      );
    }
    info("  generating the presenter's 9:16 portrait for face beats…");
    const r = await makeCharacter({
      projectDir, description, model: args.image_model || "nano-banana-pro", aspect: "9:16",
    });
    info(`    ${r.cached ? "cached" : "generated"} -> ${manifest.relativeIn(projectDir, r.path)}`);
    return (facePortraitAbs = r.path);
  }

  // ---- the shots ----
  const engine = args.engine ||
    Object.keys(AVATAR).find((k) => AVATAR[k].endpoint === m.presenter?.engine) ||
    "infinitalk";

  if (!scenes.length) {
    return report("  no presenter scenes in the timeline", { ok: true, generated: 0 });
  }

  const out = [];
  for (const scene of scenes) {
    if (scene.kind === "demo" && !wantsClip(scene)) {
      warn(`scene "${scene.id}" is a demo scene with no presenter bottom or face beats — nothing to animate. Skipping.`);
      continue;
    }
    if (!scene.audio) {
      warn(`scene "${scene.id}" has no narration audio yet — run gen/tts.mjs --all first. Skipping.`);
      continue;
    }
    // A demo scene here means a split bottom-zone shot: its own output name
    // (never scene.video — that is the screen capture) and the square portrait.
    const isBottom = scene.kind === "demo";
    const videoRel = isBottom
      ? scene.presenterVideo || path.join("clips", `${scene.id}-presenter.mp4`)
      : scene.video || path.join("clips", `${scene.id}.mp4`);
    const videoAbs = manifest.resolveIn(projectDir, videoRel);
    await mkdir(path.dirname(videoAbs), { recursive: true });

    const hasFaceBeats = (scene.beats || []).some((b) => b.shot === "face");
    info(`  ${scene.id}: animating presenter (${engine}${isBottom ? (hasFaceBeats ? ", face beats" : ", bottom zone") : ""})…`);
    const r = await animate({
      projectDir,
      imageFile: isBottom ? (hasFaceBeats ? await facePortrait() : await bottomPortrait()) : characterAbs,
      audioFile: manifest.resolveIn(projectDir, scene.audio),
      outFile: videoAbs,
      engine,
      prompt: scene.presenterPrompt || null,
      force,
    });

    const meta = await probe(r.path).catch(() => null);
    if (isBottom) {
      scene.presenterVideo = manifest.relativeIn(projectDir, r.path);
      if (meta?.duration) scene.presenterVideoDurationSec = meta.duration;
    } else {
      scene.video = manifest.relativeIn(projectDir, r.path);
      if (meta?.duration) scene.videoDurationSec = meta.duration;
    }

    info(`    ${r.cached ? "cached" : "generated"} ${fmtDuration(meta?.duration)} -> ${manifest.relativeIn(projectDir, r.path)}`);
    out.push({ scene: scene.id, video: r.path, cached: r.cached, durationSec: meta?.duration ?? null });
  }

  await manifest.save(projectDir, m, { name });
  report(
    `  presenter: ${out.length} shot(s) ready (engine: ${engine}, mode: ${mode})`,
    { ok: true, engine, mode, character: m.presenter.characterImage, scenes: out }
  );
});
