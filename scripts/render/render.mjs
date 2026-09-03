#!/usr/bin/env node
/**
 * Scaffold the Remotion app if needed, build props, and render the final video.
 *
 *   node scripts/render/render.mjs --project demo/<slug>
 *   node scripts/render/render.mjs --project demo/<slug> --studio    # open the editor instead
 *
 * The Remotion app is COPIED into <project>/remotion rather than run from the
 * plugin, so the user can open it, change a transition, restyle a card, and keep
 * those edits. It is only copied when missing; an existing app is never overwritten.
 *
 * `--public-dir` is pointed at the demo project, so staticFile("clips/x.mp4")
 * resolves directly to the files the pipeline produced — no copying media around.
 */
import path from "node:path";
import { cp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, boolArg } from "../lib/args.mjs";
import * as manifest from "../lib/manifest.mjs";
import { buildProps } from "./build-props.mjs";
import { probe } from "../lib/ff.mjs";
import { report, info, warn, main, fmtDuration } from "../lib/log.mjs";
import { writeScript } from "../script-md.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATE = path.join(PLUGIN_ROOT, "remotion-template");
const ENTRY = "src/index.jsx";

const USAGE =
  "render.mjs --project <dir> [--manifest <file>] [--out final.mp4] [--studio] " +
  "[--scene <id>] [--quality 18] [--sync-template] [--cover-only]";

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

/** Copy the template in and install its dependencies, once. */
async function scaffold(projectDir) {
  const appDir = path.join(projectDir, "remotion");
  if (!existsSync(appDir)) {
    info("  scaffolding the Remotion app (first run)…");
    await cp(TEMPLATE, appDir, { recursive: true });
    // props.json must exist before the app can be loaded at all.
    await mkdir(path.join(appDir, "src"), { recursive: true });
    await writeFile(
      path.join(appDir, "src", "props.json"),
      JSON.stringify({ format: { width: 1920, height: 1080, fps: 30 }, timeline: [] }, null, 2)
    );
  }
  if (!existsSync(path.join(appDir, "node_modules"))) {
    info("  installing Remotion (this takes a minute the first time)…");
    await run("npm", ["install", "--no-audit", "--no-fund"], appDir);
  }
  return appDir;
}

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = manifest.resolveProjectDir(args.project);
  const name = args.manifest || manifest.MANIFEST_NAME;
  if (!existsSync(manifest.manifestPath(projectDir, name))) {
    throw new Error(`No ${name} in ${projectDir} — nothing to render.`);
  }

  const appDir = await scaffold(projectDir);

  // The template is copied once and then owned by the user, so template fixes
  // in the plugin never reach an existing project on their own. --sync-template
  // is the explicit opt-in: it OVERWRITES <project>/remotion/src with the
  // plugin's current template (props.json is rewritten every run anyway).
  if (boolArg(args["sync-template"], false)) {
    warn("  --sync-template: overwriting the project's remotion/src with the plugin template — local Remotion edits are lost.");
    await cp(path.join(TEMPLATE, "src"), path.join(appDir, "src"), { recursive: true });
  }

  // Props are rebuilt every time so the render always reflects the manifest.
  const props = await buildProps(projectDir, { lenient: boolArg(args.lenient, false), name });
  const propsFile = path.join(appDir, "src", "props.json");
  await writeFile(propsFile, `${JSON.stringify(props, null, 2)}\n`);

  const runtime = props.timeline.reduce((s, x) => s + (x.durationSec || 0), 0) -
    (props.transitions || []).reduce((s, t) => s + (t.ms || 400) / 1000, 0);
  info(`  ${props.timeline.length} scene(s), ${fmtDuration(runtime)} runtime`);

  if (boolArg(args.studio, false)) {
    info(`  opening Remotion studio — edit freely, then re-run this to render.`);
    await run("npx", ["remotion", "studio", ENTRY, "--public-dir", projectDir], appDir);
    return report("  studio closed", { ok: true, studio: true });
  }

  const outFile = path.resolve(args.out || path.join(projectDir, "out", `${props.slug || "demo"}.mp4`));
  await mkdir(path.dirname(outFile), { recursive: true });

  // The cover PNG: frame 0, which is what every vertical platform shows as the
  // thumbnail. Rendered alongside the video whenever the manifest has a cover,
  // and on its own with --cover-only — the seconds-long preview loop for
  // getting the hook card right before paying for a full render.
  const coverOnly = boolArg(args["cover-only"], false);
  const coverFile = props.cover ? outFile.replace(/\.mp4$/i, "") + "-cover.png" : null;
  const renderCover = async () => {
    info(`  cover (frame 0) -> ${coverFile}`);
    await run("npx", [
      "remotion", "still", ENTRY, "DemoVideo", coverFile,
      "--frame", "0",
      "--props", propsFile,
      "--public-dir", projectDir,
      "--log", args.verbose ? "verbose" : "info",
    ], appDir);
  };
  if (coverOnly) {
    if (!coverFile) throw new Error("--cover-only needs a `cover` block in the manifest (cover.hook is the card's text).");
    await renderCover();
    return report(`  done: ${coverFile} — Read it to preview the thumbnail`, { ok: true, cover: coverFile, coverOnly: true });
  }

  const renderArgs = [
    // The entry point is passed explicitly: Remotion's auto-detection does not
    // find src/index.jsx reliably, and the failure message is unhelpful.
    "remotion", "render", ENTRY, "DemoVideo", outFile,
    "--props", propsFile,
    "--public-dir", projectDir,
    "--crf", String(args.quality || 18),
    "--log", args.verbose ? "verbose" : "info",
  ];

  info(`  rendering -> ${outFile}`);
  await run("npx", renderArgs, appDir);

  if (coverFile) await renderCover();

  const meta = await probe(outFile).catch(() => null);
  if (meta && Math.abs((meta.duration || 0) - runtime) > 1) {
    warn(
      `rendered ${fmtDuration(meta.duration)} but the timeline expected ${fmtDuration(runtime)} — ` +
      `check for a scene whose clip is shorter than its declared duration.`
    );
  }

  // SCRIPT.md is what other tools (cross-posting) read to describe the video;
  // regenerate its narration block from the manifest so it never lags the cut.
  const scriptFile = await manifest.load(projectDir, { name })
    .then((m) => writeScript(projectDir, m, { rendered: new Date().toLocaleDateString("en-CA") }))
    .catch((e) => (warn(`SCRIPT.md not updated: ${e.message}`), null));

  report(
    `  done: ${outFile} (${fmtDuration(meta?.duration)}, ${meta?.width}x${meta?.height})`,
    {
      ok: true,
      video: outFile,
      durationSec: meta?.duration ?? null,
      width: meta?.width ?? null,
      height: meta?.height ?? null,
      scenes: props.timeline.length,
      cover: coverFile,
      script: scriptFile,
    }
  );
});
