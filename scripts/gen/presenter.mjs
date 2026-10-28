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

/** A chunk shorter than this rides with its neighbour (engines dislike tiny clips; a 3s card is not worth its own seam). */
const TAKE_CHUNK_MIN_SEC = 4;
/** Silent tail on every chunk but the last; the renderer fades the next chunk in over it. */
const TAKE_OVERLAP_SEC = 0.3;
const overlapSecFor = (args) => Math.max(0, Number(args["take-overlap"] ?? TAKE_OVERLAP_SEC));

const USAGE =
  "presenter.mjs --project <dir> [--manifest <file>] (--character | --all | --scene <id> | --take [false]) " +
  "[--engine infinitalk|kling-avatar|omnihuman] [--take-chunk scene|<sec>|none] [--take-overlap 0.3] " +
  "[--take-max-sec 120] [--rechunk] [--dry-run] [--only <sceneId>] [--force]";

/**
 * Generate the presenter's face once.
 *
 * The prompt deliberately asks for a neutral, forward-facing, well-lit portrait:
 * avatar models animate a still, so an extreme pose or heavy shadow in the source
 * becomes an artefact in every single shot.
 */
export async function makeCharacter({ projectDir, description, model = "nano-banana-pro", aspect = "1:1", force = false }) {
  const spec = resolve(IMAGE, model);
  // 16:9 is the dynamic style's take: it is shown full-frame AND cropped into
  // a tall panel / small card, so the head sits centred with room around it.
  const framing =
    aspect === "1:1" ? "shoulders visible"
      : aspect === "16:9" ? "webcam framing: head and shoulders centered, eyes on the upper third, the background continuing naturally on both sides"
        : "head and upper body visible";
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

/** The cache spec animate() files a clip under — shared with the lookup below. */
function animationSpec({ imageFile, audioFile, engine, prompt, aspect, spec }) {
  return {
    kind: "presenter",
    model: spec.endpoint,
    params: { engine, prompt, ...(spec.form === "reference" ? { aspect: aspect || "auto", ...spec.defaults } : {}) },
    files: [imageFile, audioFile],   // hashed, so a re-recorded line regenerates the shot
  };
}

/** The clip a previous run animated from exactly these inputs, or null. Never generates. */
export async function cachedAnimation({ projectDir, imageFile, audioFile, engine = "infinitalk", prompt = null, aspect = null }) {
  const spec = AVATAR[engine] || resolve(AVATAR, engine);
  if (!spec?.endpoint || !existsSync(imageFile) || !existsSync(audioFile)) return null;
  const hit = await cache.lookup(projectDir, await cache.key(animationSpec({ imageFile, audioFile, engine, prompt, aspect, spec })));
  return hit ? manifest.resolveIn(projectDir, hit.output) : null;
}

/** Animate the character to a narration track. */
export async function animate({
  projectDir, imageFile, audioFile, outFile, engine = "infinitalk", prompt = null, force = false, aspect = null,
}) {
  const spec = AVATAR[engine] || resolve(AVATAR, engine);
  if (!spec?.endpoint) throw new Error(`Unknown presenter engine: ${engine}`);
  // A reference-driven video model (seedance-2.5) bounds the audio it accepts.
  if (spec.maxAudioSec || spec.minAudioSec) {
    const sec = (await probe(audioFile).catch(() => null))?.duration;
    if (sec && spec.maxAudioSec && sec > spec.maxAudioSec) {
      throw new Error(`${engine} takes at most ${spec.maxAudioSec}s of audio per clip; this chunk is ${sec.toFixed(1)}s — the take is chunked per scene, so split that scene`);
    }
    if (sec && spec.minAudioSec && sec < spec.minAudioSec) {
      throw new Error(`${engine} needs at least ${spec.minAudioSec}s of audio per clip; this chunk is ${sec.toFixed(1)}s`);
    }
  }

  if (!existsSync(imageFile)) throw new Error(`Character image not found: ${imageFile}`);
  if (!existsSync(audioFile)) {
    throw new Error(
      `Narration audio not found: ${audioFile}\n` +
      `Run gen/tts.mjs first — the presenter is animated to the narration, not the other way round.`
    );
  }

  return cache.memo(
    projectDir,
    animationSpec({ imageFile, audioFile, engine, prompt, aspect, spec }),
    async () => {
      const [image_url, audio_url] = await Promise.all([toUrl(imageFile), toUrl(audioFile)]);
      let input;
      if (spec.form === "reference") {
        // The still and the narration are references the prompt points at.
        input = {
          prompt: `@Image1 is the presenter. He speaks the words in @Audio1 directly to camera, lips matching the audio exactly, ` +
            `natural expression, small head movements and light hand gestures, fixed webcam framing, the same background${prompt ? `. ${prompt}` : "."}`,
          [spec.inputs.images]: [image_url],
          [spec.inputs.audios]: [audio_url],
          duration: "auto",
          aspect_ratio: aspect || "auto",
          ...spec.defaults,
        };
      } else {
        input = { image_url, audio_url };
        if (prompt) input.prompt = prompt;
      }

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

  /**
   * Portrait for the continuous take. presenter.takeAspect (seeded "16:9" by
   * the dynamic style, whose face shots fill the frame) picks the wide still:
   * the manifest's character image when it is that variant, else
   * assets/presenter-<aspect>.png, else one generated from the description
   * (a kit character should get its wide still from still.mjs --edit instead,
   * so the face stays the same person). Default: the square bottom portrait.
   */
  let takePortraitAbs = null;
  async function takePortrait() {
    if (takePortraitAbs) return takePortraitAbs;
    const aspect = m.presenter?.takeAspect || "1:1";
    if (aspect === "1:1") return (takePortraitAbs = await bottomPortrait());
    const tag = aspect.replace(":", "x");
    const ci = m.presenter?.characterImage;
    if (ci && ci.includes(tag) && existsSync(manifest.resolveIn(projectDir, ci))) {
      return (takePortraitAbs = manifest.resolveIn(projectDir, ci));
    }
    const file = path.join(projectDir, "assets", `presenter-${tag}.png`);
    if (existsSync(file)) return (takePortraitAbs = file);
    const description = args.description || m.presenter?.description;
    if (!description) {
      throw new Error(
        `presenter.takeAspect is "${aspect}" but there is no ${manifest.relativeIn(projectDir, file)} and no presenter.description to generate one from. ` +
        `For a kit character make it with still.mjs --edit --from <portrait> --aspect ${aspect}.`
      );
    }
    if (ci) warn(`presenter.characterImage (${ci}) is not ${aspect} — generating a ${aspect} portrait from the description; a kit character should be reframed with still.mjs --edit instead so the face stays the same.`);
    info(`  generating the presenter's ${aspect} portrait for the take…`);
    const r = await makeCharacter({
      projectDir, description, model: args.image_model || "nano-banana-pro", aspect,
    });
    info(`    ${r.cached ? "cached" : "generated"} -> ${manifest.relativeIn(projectDir, r.path)}`);
    return (takePortraitAbs = r.path);
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
  // avoid.
  //
  // The take is CHUNKED AT SCENE BOUNDARIES (--take-chunk scene, the default):
  // one clip per scene (a scene under TAKE_CHUNK_MIN_SEC rides with its
  // neighbour), named after its first scene, so re-voicing one line only
  // regenerates that scene's chunk instead of re-billing the whole runtime
  // (2026-09-16: a one-word hook change on a 44s video cost the full take
  // again). Every chunk but the last carries --take-overlap (0.3s) of silence
  // at its tail; the renderer plays the next chunk over it with a fade-in, so
  // the avatar's re-pose at the seam is a short cross-dissolve instead of a
  // snap. --take-chunk none is the old greedy packing up to --take-max-sec.
  // An existing take whose chunks are all still fresh is left alone whatever
  // the chunking rule (so a project made under the old rule is not re-billed
  // just to split it); --rechunk (or --force) re-cuts it.
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
    // kling-avatar has taken a 73s take in one clip; the ceiling is not
    // documented, so a refused long chunk falls back to 60s chunks below.
    const maxSec = Number(args["take-max-sec"] || 120);
    const engineSpec = AVATAR[engine] || resolve(AVATAR, engine);
    const chunkMode = String(args["take-chunk"] ?? "scene");
    const perScene = chunkMode === "scene";
    let packMax = perScene || chunkMode === "none" ? maxSec : Math.min(maxSec, Number(chunkMode) || maxSec);
    if (engineSpec?.maxAudioSec) packMax = Math.min(packMax, Math.floor(engineSpec.maxAudioSec - overlapSecFor(args)));
    const overlapSec = overlapSecFor(args);
    const dryRun = boolArg(args["dry-run"], false);
    // --only <sceneId>: generate just that scene's chunk as a TEST clip
    // (clips/take-test-<engine>-<scene>.mp4) and leave the manifest alone —
    // the way to try another engine on one scene before committing a take.
    const only = args.only ? String(args.only) : null;
    const rechunk = boolArg(args.rechunk, false) || force || !!only;
    if (only && !ranges.some((r) => r.scene.id === only)) throw new Error(`--only: no scene "${only}" with a duration in the timeline`);
    const chunks = [];
    for (const r of ranges) {
      const last = chunks[chunks.length - 1];
      const contiguous = last && Math.abs(last.toSec - r.fromSec) < 0.01;
      const fits = contiguous && last.durationSec + r.durationSec <= packMax;
      // Per scene: a new chunk at every boundary unless the chunk so far, or
      // this scene, is too short to be a clip of its own.
      const join = fits && (!perScene || last.durationSec < TAKE_CHUNK_MIN_SEC || r.durationSec < TAKE_CHUNK_MIN_SEC);
      if (join) {
        last.ranges.push(r); last.durationSec += r.durationSec; last.toSec = r.fromSec + r.durationSec;
      } else {
        chunks.push({ ranges: [r], fromSec: r.fromSec, toSec: r.fromSec + r.durationSec, durationSec: r.durationSec });
      }
    }
    // Silent tail on every chunk but the last: the seam's cross-dissolve.
    for (const [ci, chunk] of chunks.entries()) chunk.tailSec = ci < chunks.length - 1 ? overlapSec : 0;

    const audioDir = path.join(projectDir, "audio");
    const clipsDir = path.join(projectDir, "clips");
    await mkdir(audioDir, { recursive: true });
    await mkdir(clipsDir, { recursive: true });
    // A sibling manifest (dynamic.json next to demo.json) gets its own take
    // files, so two cuts of one project never overwrite each other's take.
    const takeBase = name === manifest.MANIFEST_NAME ? "pip-take" : `pip-take-${path.basename(name, ".json")}`;
    const wantAspect = m.presenter?.takeAspect || "1:1";

    // The avatar cache is keyed on the audio file's bytes, and an mp3 encode
    // is not byte-stable run to run — so a chunk's audio is only rebuilt when
    // its inputs (the scene narrations, their padded lengths, the tail)
    // changed. Otherwise a plain re-run would regenerate (and re-bill) it.
    // The tail-less form is the pre-chunking recipe, so an old single-chunk
    // take still reads as fresh.
    // A chunk's direction: a scene-level presenterPrompt inside the chunk (the
    // Short's s-close "subtle smirk, no wide grin" note) wins over the
    // manifest-level one, and it enters the recipe so changing the note
    // regenerates just that chunk. Chunks without one keep the old recipe.
    const promptFor = (rs) => rs.find((r) => r.scene.presenterPrompt)?.scene.presenterPrompt || m.presenter?.presenterPrompt || null;
    const recipeFor = async (rs, tailSec) => {
      const scenes = await Promise.all(rs.map(async (r) => ({
        id: r.scene.id, d: r.durationSec,
        audio: r.scene.audio ? await sha256File(manifest.resolveIn(projectDir, r.scene.audio)) : null,
      })));
      const scenePrompt = rs.find((r) => r.scene.presenterPrompt)?.scene.presenterPrompt;
      if (tailSec > 0) return JSON.stringify(scenePrompt ? { scenes, tail: +tailSec.toFixed(3), prompt: scenePrompt } : { scenes, tail: +tailSec.toFixed(3) });
      return JSON.stringify(scenes);
    };
    const isFresh = async (audioAbs, recipe) =>
      existsSync(audioAbs) && existsSync(`${audioAbs}.recipe.json`) && (await readFile(`${audioAbs}.recipe.json`, "utf8")) === recipe;

    // An existing take whose every chunk is still fresh (its scenes, their
    // audio and lengths unchanged, its clip on disk) is the take — even when
    // it was cut under another chunking rule. Re-cutting it would re-bill.
    const existing = m.presenter?.pipTake?.segments || [];
    if (existing.length && !rechunk) {
      const byId = new Map(ranges.map((r) => [r.scene.id, r]));
      let ok = existing.flatMap((sg) => sg.scenes || []).join("|") === ranges.map((r) => r.scene.id).join("|");
      for (const sg of existing) {
        if (!ok) break;
        const rs = (sg.scenes || []).map((id) => byId.get(id));
        const audioAbs = sg.audio ? manifest.resolveIn(projectDir, sg.audio) : null;
        const videoAbs = sg.video ? manifest.resolveIn(projectDir, sg.video) : null;
        ok = rs.length && rs.every(Boolean) && audioAbs && videoAbs && existsSync(videoAbs) &&
          Math.abs(rs[0].fromSec - (sg.fromSec || 0)) < 0.01 &&
          (await isFresh(audioAbs, await recipeFor(rs, sg.overlapSec || 0)));
      }
      if (ok) {
        info(`  take: up to date (${existing.length} chunk(s), nothing changed) — --rechunk re-cuts it under the current rule`);
        return report(null, { ok: true, engine, mode, cached: true, take: m.presenter.pipTake });
      }
    }

    if (chunks.length > 1) {
      info(`  take: ${fmtDuration(cursor)} of narration in ${chunks.length} chunk(s) at scene boundaries — each seam is a ${overlapSec}s cross-dissolve; a re-voiced scene only regenerates its own chunk`);
    }
    const portrait = dryRun ? null : await takePortrait();
    const spec = engineSpec;
    const segments = [];
    let billSec = 0;
    for (const [ci, chunk] of chunks.entries()) {
      if (only && !chunk.ranges.some((r) => r.scene.id === only)) continue;
      // Each scene's narration padded (or trimmed) to exactly its scene duration,
      // so the take stays in phase with the picture at every cut; the chunk's
      // last scene gets the silent tail on top.
      const inputs = [];
      const filters = [];
      chunk.ranges.forEach((r, i) => {
        const src = r.scene.audio ? manifest.resolveIn(projectDir, r.scene.audio) : null;
        const len = (r.durationSec + (i === chunk.ranges.length - 1 ? chunk.tailSec : 0)).toFixed(3);
        if (src) {
          inputs.push("-i", src);
          filters.push(`[${inputs.length / 2 - 1}:a]aresample=44100,apad,atrim=0:${len},asetpts=N/SR/TB[a${i}]`);
        } else {
          filters.push(`anullsrc=r=44100:cl=mono,atrim=0:${len},asetpts=N/SR/TB[a${i}]`);
        }
      });
      const concat = chunk.ranges.map((_, i) => `[a${i}]`).join("") + `concat=n=${chunk.ranges.length}:v=0:a=1[out]`;
      // Chunks are named after their first scene, so the files (and the cache
      // hits behind them) survive a scene being added or re-voiced elsewhere.
      const suffix = chunks.length > 1 ? `-${chunk.ranges[0].scene.id}` : "";
      const audioAbs = path.join(audioDir, `${takeBase}${suffix}.mp3`);
      const recipe = await recipeFor(chunk.ranges, chunk.tailSec);
      const fresh = await isFresh(audioAbs, recipe);
      // A dry run never touches the audio or its recipe: writing them would
      // make the freshness guard above call the OLD clip up to date next run.
      if (!fresh && !dryRun) {
        await ffmpeg([...inputs, "-filter_complex", [...filters, concat].join(";"), "-map", "[out]", "-ac", "1", "-b:a", "128k", audioAbs]);
        await writeFile(`${audioAbs}.recipe.json`, recipe);
      }

      const videoAbs = only
        ? path.join(clipsDir, `take-test-${engine}-${chunk.ranges[0].scene.id}.mp4`)
        : path.join(clipsDir, `${takeBase}${suffix}.mp4`);
      const label = `${chunk.ranges[0].scene.id}${chunk.ranges.length > 1 ? ` → ${chunk.ranges[chunk.ranges.length - 1].scene.id}` : ""}`;
      if (dryRun) {
        // What a real run would bill: a cache hit on the portrait + this exact
        // audio is free, anything else is avatar-seconds.
        const portraitFile = m.presenter?.characterImage ? manifest.resolveIn(projectDir, m.presenter.characterImage) : null;
        const hit = fresh && portraitFile && existsSync(portraitFile)
          ? await cache.lookup(projectDir, await cache.key({
              kind: "presenter", model: spec?.endpoint, params: { engine, prompt: promptFor(chunk.ranges) },
              files: [portraitFile, audioAbs],
            }))
          : null;
        if (!hit) billSec += chunk.durationSec + chunk.tailSec;
        info(`  take${suffix}: ${fmtDuration(chunk.durationSec + chunk.tailSec)} (${label}) — ${hit ? "cached" : "would generate"}`);
        segments.push({ scenes: chunk.ranges.map((x) => x.scene.id), fromSec: +chunk.fromSec.toFixed(3), durationSec: +chunk.durationSec.toFixed(3), overlapSec: chunk.tailSec, cached: !!hit });
        continue;
      }
      info(`  take${suffix}: animating ${fmtDuration(chunk.durationSec + chunk.tailSec)} (${engine}, ${label})…`);
      let r;
      try {
        r = await animate({
          projectDir, imageFile: portrait, audioFile: audioAbs, outFile: videoAbs, engine,
          prompt: promptFor(chunk.ranges), force, aspect: wantAspect,
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
      if (meta?.duration && meta.duration + 0.05 < chunk.durationSec + chunk.tailSec) {
        warn(`take${suffix} came back ${meta.duration.toFixed(1)}s for ${(chunk.durationSec + chunk.tailSec).toFixed(1)}s of audio — the bubble will freeze at the tail.`);
      }
      // The engine returns whatever resolution it likes at the portrait's aspect.
      // A wide take is shown full-frame by the dynamic style, so say when it
      // came back small or at the wrong shape — those are upscale artefacts.
      if (meta?.width && meta?.height) {
        const gotAspect = manifest.aspectOf({ width: meta.width, height: meta.height });
        info(`    take${suffix} is ${meta.width}x${meta.height} (${gotAspect})`);
        if (gotAspect !== wantAspect) {
          warn(`take${suffix} is ${gotAspect} but presenter.takeAspect is ${wantAspect} — full-frame shots will be cropped; use a ${wantAspect} portrait.`);
        }
        const compH = m.format?.height || 1080;
        if (wantAspect === "16:9" && meta.height < Math.min(720, compH)) {
          warn(`take${suffix} is only ${meta.height}px tall — full-frame face shots will be a ${(compH / meta.height).toFixed(1)}x upscale.`);
        }
      }
      segments.push({
        video: manifest.relativeIn(projectDir, r.path),
        audio: manifest.relativeIn(projectDir, audioAbs),
        fromSec: +chunk.fromSec.toFixed(3),
        durationSec: +chunk.durationSec.toFixed(3),
        // Silent tail the next chunk fades in over (0 on the last chunk).
        overlapSec: chunk.tailSec,
        videoDurationSec: meta?.duration ?? null,
        width: meta?.width ?? null,
        height: meta?.height ?? null,
        scenes: chunk.ranges.map((x) => x.scene.id),
      });
    }
    if (only) {
      info(`  test clip${segments.length ? `: ${segments.map((x) => x.video).join(", ")}` : ""} — manifest untouched (presenter.pipTake unchanged)`);
      return report(null, { ok: true, test: true, engine, mode, only, segments });
    }
    if (dryRun) {
      const usd = billSec * (engineSpec?.approxUsdPerSecond || 0.056);
      info(`  dry run: ${segments.filter((x) => !x.cached).length} of ${segments.length} chunk(s) would be generated — ${fmtDuration(billSec)} of avatar (~$${usd.toFixed(2)}); manifest untouched`);
      return report(null, { ok: true, dryRun: true, engine, mode, chunks: segments, billSec: +billSec.toFixed(2), estimateUsd: +usd.toFixed(2) });
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
    const imageFile = isBottom ? (hasFaceBeats ? await facePortrait() : await bottomPortrait()) : characterAbs;
    const prompt = scene.presenterPrompt || null;
    const narrationAbs = manifest.resolveIn(projectDir, scene.audio);

    /**
     * The clip runs for the whole scene, which is the line plus the breath
     * (pacing.breathSec) before the next cut. An avatar animated to the bare
     * line is exactly as long as the line, so the speaker froze on the last
     * frame through the breath and then jumped into the next take — a visible
     * stutter at every seam. Animate to the narration padded with silence to
     * the scene length instead, like the continuous take does. A clip an
     * earlier run made from the bare line is kept when it already covers the
     * scene (the engine quantises upward, so most do) — only if it was filed
     * under these exact inputs, so a re-voiced line still regenerates.
     */
    let audioFile = narrationAbs;
    let reuse = null;
    const padTo = Number(scene.durationSec) || 0;
    const narrSec = (await probe(narrationAbs).catch(() => null))?.duration || 0;
    if (padTo > narrSec + 0.05) {
      const legacy = force ? null : await cachedAnimation({ projectDir, imageFile, audioFile: narrationAbs, engine, prompt });
      const legacySec = legacy ? (await probe(legacy).catch(() => null))?.duration || 0 : 0;
      if (legacy && legacySec >= padTo - 0.1) {
        reuse = legacy;
      } else {
        const paddedAbs = path.join(projectDir, "audio", `${scene.id}.presenter.mp3`);
        const recipe = JSON.stringify({ audio: await sha256File(narrationAbs), d: +padTo.toFixed(3) });
        const fresh = existsSync(paddedAbs) && existsSync(`${paddedAbs}.recipe.json`) &&
          (await readFile(`${paddedAbs}.recipe.json`, "utf8")) === recipe;
        if (!fresh) {
          await mkdir(path.dirname(paddedAbs), { recursive: true });
          await ffmpeg(["-y", "-i", narrationAbs, "-af", `aresample=44100,apad,atrim=0:${padTo.toFixed(3)},asetpts=N/SR/TB`, "-ac", "1", "-b:a", "128k", paddedAbs]);
          await writeFile(`${paddedAbs}.recipe.json`, recipe);
        }
        audioFile = paddedAbs;
      }
    }

    info(`  ${scene.id}: animating presenter (${engine}${isBottom ? (hasFaceBeats ? ", face beats" : isPip ? ", corner pip" : ", bottom zone") : ""}${audioFile !== narrationAbs ? `, padded to ${fmtDuration(padTo)}` : ""})…`);
    const r = reuse
      ? { path: reuse, cached: true }
      : await animate({ projectDir, imageFile, audioFile, outFile: videoAbs, engine, prompt, force });

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
