#!/usr/bin/env node
/**
 * Generate or iteratively edit a still image — the cheap half of every
 * generated shot.
 *
 *   node scripts/gen/still.mjs --project demo --out assets/net.png \
 *     --prompt "wide shot on the deck of a trawler at golden hour…"
 *
 *   node scripts/gen/still.mjs --project demo --out assets/net-v2.png \
 *     --edit "give each creature a soft contact shadow on the wet deck" \
 *     --from assets/net.png --ref assets/presenter.png
 *
 * Hard shots (a specific character, in a specific place, doing a specific
 * thing) rarely land in one prompt. A still costs cents where a video costs
 * dollars, so the workflow is: generate, LOOK at the file, --edit what is
 * wrong, look again — and only animate once the still is right.
 *
 * --ref passes extra reference images to the edit model (the presenter
 * portrait, a product screenshot) so identities stay consistent across shots.
 * --scene <id> records the result as that scene's `still` (what broll.mjs
 * animates); --character records it as presenter.characterImage — the way to
 * give a themed character a portrait that makeCharacter's corporate-headshot
 * prompt would fight. Results are cached by content: re-running an identical
 * generate or edit is free.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs, boolArg, requireArg, fail } from "../lib/args.mjs";
import { submitAndWait, extractUrl, download, toUrl } from "../lib/fal.mjs";
import * as manifest from "../lib/manifest.mjs";
import * as cache from "../lib/cache.mjs";
import { IMAGE, IMAGE_EDIT, resolve } from "../lib/models.mjs";
import { report, info, main } from "../lib/log.mjs";

const USAGE =
  "still.mjs --project <dir> --out <file.png> " +
  '(--prompt "…" [--aspect 16:9] | --edit "…" --from <image> [--ref <image>]…) ' +
  "[--scene <id>] [--character] [--model nano-banana-pro] [--force]";

await main(async () => {
  const args = parseArgs(process.argv.slice(2), { multi: ["ref"] });
  const force = boolArg(args.force, false);
  const projectDir = manifest.resolveProjectDir(args.project);
  const outAbs = manifest.resolveIn(projectDir, requireArg(args, "out", USAGE));
  await mkdir(path.dirname(outAbs), { recursive: true });

  const modelName = args.model || "nano-banana-pro";
  const editing = args.edit !== undefined;
  if (editing === (args.prompt !== undefined)) {
    fail("pass exactly one of --prompt (generate) or --edit (refine an existing image)", USAGE);
  }

  let result;
  if (editing) {
    const instruction = requireArg(args, "edit", USAGE);
    const from = manifest.resolveIn(projectDir, requireArg(args, "from", USAGE));
    const refs = (args.ref || []).map((r) => manifest.resolveIn(projectDir, r));
    const sources = [from, ...refs];
    const spec = resolve(IMAGE_EDIT, modelName);
    info(`  editing ${path.basename(from)} (${sources.length} source image(s)) via ${spec.endpoint}`);
    result = await cache.memo(
      projectDir,
      { kind: "still-edit", model: spec.endpoint, params: { instruction }, files: sources },
      async () => {
        const image_urls = [];
        for (const s of sources) image_urls.push(await toUrl(s));
        const data = await submitAndWait(spec.endpoint, {
          prompt: instruction,
          image_urls,
          num_images: 1,
        });
        const url = extractUrl(data);
        if (!url) throw new Error(`${spec.endpoint} returned no image`);
        return download(url, outAbs);
      },
      { force }
    );
  } else {
    const prompt = requireArg(args, "prompt", USAGE);
    const aspect = args.aspect || "16:9";
    const spec = resolve(IMAGE, modelName);
    info(`  generating via ${spec.endpoint} (${aspect})`);
    result = await cache.memo(
      projectDir,
      { kind: "still-gen", model: spec.endpoint, params: { prompt, aspect } },
      async () => {
        const data = await submitAndWait(spec.endpoint, {
          prompt,
          num_images: 1,
          aspect_ratio: aspect,
        });
        const url = extractUrl(data);
        if (!url) throw new Error(`${spec.endpoint} returned no image`);
        return download(url, outAbs);
      },
      { force }
    );
  }

  const rel = manifest.relativeIn(projectDir, result.path);
  const attached = [];
  if (args.scene || boolArg(args.character, false)) {
    await manifest.update(projectDir, (m) => {
      if (args.scene) {
        manifest.patchScene(m, args.scene, { still: rel });
        attached.push(`scene "${args.scene}".still`);
      }
      if (boolArg(args.character, false)) {
        (m.presenter ||= {}).characterImage = rel;
        attached.push("presenter.characterImage");
      }
    });
  }

  report(
    `  ${result.cached ? "cached" : "generated"}: ${result.path}` +
      (attached.length ? `\n  attached as ${attached.join(", ")}` : "") +
      "\n  LOOK at the image before animating; --edit what is wrong.",
    { ok: true, path: result.path, cached: result.cached, attachedTo: attached }
  );
});
