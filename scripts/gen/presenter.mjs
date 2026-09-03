#!/usr/bin/env node
/**
 * The on-camera presenter — the "paid actor" half of a demo.
 *
 *   node scripts/gen/presenter.mjs --project demo/<slug> --character   # make the face
 *   node scripts/gen/presenter.mjs --project demo/<slug> --all         # animate every presenter scene
 *   node scripts/gen/presenter.mjs --project demo/<slug> --scene intro
 *   node scripts/gen/presenter.mjs --project demo/<slug> --take         # mode "always": ONE continuous
 *                                                                        # corner-bubble take for the whole video
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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs, boolArg } from "../lib/args.mjs";
import { submitAndWait, extractUrl, download, toUrl } from "../lib/fal.mjs";
import { probe, ffmpeg } from "../lib/ff.mjs";
import { isContentRestrictionError } from "../lib/image.mjs";
import * as manifest from "../lib/manifest.mjs";
import * as cache from "../lib/cache.mjs";
import { AVATAR, IMAGE, resolve } from "../lib/models.mjs";
import { report, info, warn, main, fmtDuration } from "../lib/log.mjs";

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

const USAGE =
  "presenter.mjs --project <dir> [--manifest <file>] (--character | --all | --scene <id> | --take [false]) " +
  "[--engine infinitalk|kling-avatar|omnihuman] [--take-max-sec 120] [--force]";

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

  // Four uses of a presenter clip: full presenter scenes, the bottom zone of a
  // split demo scene, full-bleed face beats inside a beat-cut demo scene, and the
  // corner pip that mode "always" puts over every plain demo scene (pip: false
  // opts a scene out; beat/split scenes have their own presenter slots).
  const wantsClip = (s) =>
    s.kind === "demo" &&
    (s.bottom?.kind === "presenter" ||
      (s.beats || []).some((b) => b.shot === "face") ||
      (mode === "always" && !s.beats?.length && s.pip !== false));
  // presenter.continuousPip (seeded by the tutorial style) makes --all produce
  // the continuous take; --take forces it, --take false forces per-scene clips.
  const take = boolArg(args.take, boolArg(args.all, false) && mode === "always" && !!m.presenter?.continuousPip);
  if (take && !args.take) info("  presenter.continuousPip is set — generating one continuous corner-bubble take (pass --take false for per-scene clips)");
  const scenes = args.character || take
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

  // ---- one continuous take (--take) ----
  // Per-scene pip clips each start from the portrait's rest pose, so the bubble
  // visibly "resets" at every cut. A take is the alternative: every scene's
  // narration, padded to its scene duration, is concatenated in timeline order
  // and lip-synced as ONE clip, which the renderer plays straight through
  // underneath the cuts. Scenes with `pip: false` are skipped (the take pauses
  // there; the renderer hides the bubble). Cards are covered too — a persistent
  // bubble that vanishes for the CTA card is exactly the pop the take exists to
  // avoid. Engines cap the audio they accept, so the take is chunked at scene
  // boundaries to --take-max-sec; one chunk seam is far better than ten.
  if (take) {
    if (mode !== "always") throw new Error(`--take needs presenter.mode "always" (it is "${mode}")`);
    if ((m.transitions || []).length) {
      warn("--take assumes hard cuts; overlapping transitions will drift the bubble's lip-sync by the overlap.");
    }
    const covered = m.timeline.filter((s) => s.pip !== false && (s.durationSec || 0) > 0);
    if (!covered.length) throw new Error("--take: no scenes with a duration — run gen/tts.mjs --all first");
    const missing = covered.filter((s) => !s.audio && s.kind !== "card");
    for (const s of missing) warn(`scene "${s.id}" has no narration audio — the bubble will hold a silent pose there.`);

    // Absolute start of every covered scene on the hard-cut timeline.
    let cursor = 0;
    const ranges = [];
    for (const s of m.timeline) {
      const d = s.durationSec || 0;
      if (s.pip !== false && d > 0) ranges.push({ scene: s, fromSec: cursor, durationSec: d });
      cursor += d;
    }
    // Chunk at scene boundaries: contiguous scenes only, total <= maxSec.
    // kling-avatar has taken a 73s take in one clip; the ceiling is not
    // documented, so a refused long chunk falls back to 60s chunks below.
    const maxSec = Number(args["take-max-sec"] || 120);
    const chunks = [];
    for (const r of ranges) {
      const last = chunks[chunks.length - 1];
      const contiguous = last && Math.abs(last.toSec - r.fromSec) < 0.01;
      if (contiguous && last.durationSec + r.durationSec <= maxSec) {
        last.ranges.push(r); last.durationSec += r.durationSec; last.toSec = r.fromSec + r.durationSec;
      } else {
        chunks.push({ ranges: [r], fromSec: r.fromSec, toSec: r.fromSec + r.durationSec, durationSec: r.durationSec });
      }
    }
    if (chunks.length > 1) {
      info(`  take: ${fmtDuration(cursor)} of narration in ${chunks.length} chunk(s) (max ${maxSec}s each) — the bubble re-poses at each chunk seam`);
    }

    const audioDir = path.join(projectDir, "audio");
    const clipsDir = path.join(projectDir, "clips");
    await mkdir(audioDir, { recursive: true });
    await mkdir(clipsDir, { recursive: true });
    const portrait = await bottomPortrait();
    const segments = [];
    for (const [ci, chunk] of chunks.entries()) {
      // Each scene's narration padded (or trimmed) to exactly its scene duration,
      // so the take stays in phase with the picture at every cut.
      const inputs = [];
      const filters = [];
      chunk.ranges.forEach((r, i) => {
        const src = r.scene.audio ? manifest.resolveIn(projectDir, r.scene.audio) : null;
        if (src) {
          inputs.push("-i", src);
          filters.push(`[${inputs.length / 2 - 1}:a]aresample=44100,apad,atrim=0:${r.durationSec.toFixed(3)},asetpts=N/SR/TB[a${i}]`);
        } else {
          filters.push(`anullsrc=r=44100:cl=mono,atrim=0:${r.durationSec.toFixed(3)},asetpts=N/SR/TB[a${i}]`);
        }
      });
      const concat = chunk.ranges.map((_, i) => `[a${i}]`).join("") + `concat=n=${chunk.ranges.length}:v=0:a=1[out]`;
      const suffix = chunks.length > 1 ? `-${ci + 1}` : "";
      const audioAbs = path.join(audioDir, `pip-take${suffix}.mp3`);
      // The avatar cache is keyed on the audio file's bytes, and an mp3 encode
      // is not byte-stable run to run — so only rebuild the take audio when
      // its inputs (the scene narrations and their padded lengths) changed.
      // Otherwise a plain re-run would regenerate (and re-bill) the take.
      const recipe = JSON.stringify(await Promise.all(chunk.ranges.map(async (r) => ({
        id: r.scene.id, d: r.durationSec,
        audio: r.scene.audio ? await sha256File(manifest.resolveIn(projectDir, r.scene.audio)) : null,
      }))));
      const recipeAbs = `${audioAbs}.recipe.json`;
      const fresh = existsSync(audioAbs) && existsSync(recipeAbs) && (await readFile(recipeAbs, "utf8")) === recipe;
      if (!fresh) {
        await ffmpeg([...inputs, "-filter_complex", [...filters, concat].join(";"), "-map", "[out]", "-ac", "1", "-b:a", "128k", audioAbs]);
        await writeFile(recipeAbs, recipe);
      }

      const videoAbs = path.join(clipsDir, `pip-take${suffix}.mp4`);
      info(`  take${suffix}: animating ${fmtDuration(chunk.durationSec)} corner bubble (${engine}, scenes ${chunk.ranges[0].scene.id} → ${chunk.ranges[chunk.ranges.length - 1].scene.id})…`);
      let r;
      try {
        r = await animate({
          projectDir, imageFile: portrait, audioFile: audioAbs, outFile: videoAbs, engine,
          prompt: m.presenter?.presenterPrompt || null, force,
        });
      } catch (e) {
        if (!isContentRestrictionError(e) && chunk.durationSec > 60 && !args["take-max-sec"]) {
          warn(`${engine} refused a ${chunk.durationSec.toFixed(0)}s take (${e.message}); retrying in chunks of 60s.`);
          process.argv.push("--take-max-sec", "60");
          const { spawnSync } = await import("node:child_process");
          const rr = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit" });
          process.exit(rr.status ?? 1);
        }
        throw e;
      }
      const meta = await probe(r.path).catch(() => null);
      info(`    ${r.cached ? "cached" : "generated"} ${fmtDuration(meta?.duration)} -> ${manifest.relativeIn(projectDir, r.path)}`);
      if (meta?.duration && meta.duration + 0.05 < chunk.durationSec) {
        warn(`take${suffix} came back ${meta.duration.toFixed(1)}s for ${chunk.durationSec.toFixed(1)}s of audio — the bubble will freeze at the tail.`);
      }
      segments.push({
        video: manifest.relativeIn(projectDir, r.path),
        audio: manifest.relativeIn(projectDir, audioAbs),
        fromSec: +chunk.fromSec.toFixed(3),
        durationSec: +chunk.durationSec.toFixed(3),
        videoDurationSec: meta?.duration ?? null,
        scenes: chunk.ranges.map((x) => x.scene.id),
      });
    }
    m.presenter.pipTake = { segments };
    await manifest.save(projectDir, m, { name });
    return report(
      `  presenter: continuous corner-bubble take ready (${segments.length} segment(s), engine: ${engine})`,
      { ok: true, engine, mode, take: m.presenter.pipTake }
    );
  }

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
    const isPip = isBottom && !scene.bottom && !hasFaceBeats;
    info(`  ${scene.id}: animating presenter (${engine}${isBottom ? (hasFaceBeats ? ", face beats" : isPip ? ", corner pip" : ", bottom zone") : ""})…`);
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
