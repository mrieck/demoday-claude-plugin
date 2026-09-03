#!/usr/bin/env node
/**
 * Project status and cost estimate — the gate before anything is paid for.
 *
 *   node scripts/plan.mjs --project demo/<slug>          # what exists, what's left, what it'll cost
 *   node scripts/plan.mjs --project demo/<slug> --init --slug acme --name "Acme"
 *
 * Generation is the expensive, irreversible-ish part of this pipeline (money, not
 * data), so there is one place that answers "what is about to happen and what will
 * it cost" and the orchestrator is expected to show it to the user before spending.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs, boolArg } from "./lib/args.mjs";
import * as manifest from "./lib/manifest.mjs";
import { STYLES, STYLE_NAMES } from "./lib/styles.mjs";
import { estimateCost } from "./lib/models.mjs";
import { scaffoldSfx } from "./lib/sfx.mjs";
import { hasElevenLabs } from "./lib/elevenlabs.mjs";
import { report, info, warn, main, fmtDuration } from "./lib/log.mjs";

const USAGE =
  "plan.mjs --project <dir> [--manifest <file>] " +
  "[--init --slug <slug> --name <product> [--from <file>] [--format 9:16] [--style listicle]]";

/** Preset dimensions for --format; fps stays 30 across all of them. */
const FORMAT_PRESETS = {
  "16:9": { width: 1920, height: 1080, fps: 30 },
  "9:16": { width: 1080, height: 1920, fps: 30 },
  "1:1": { width: 1080, height: 1080, fps: 30 },
};

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = manifest.resolveProjectDir(args.project);
  const name = args.manifest || manifest.MANIFEST_NAME;

  // ---- init ----
  if (boolArg(args.init, false)) {
    if (existsSync(manifest.manifestPath(projectDir, name)) && !boolArg(args.force, false)) {
      throw new Error(`${manifest.manifestPath(projectDir, name)} already exists — pass --force to overwrite.`);
    }
    for (const sub of ["clips", "audio", "assets", "actions", "out"]) {
      await mkdir(path.join(projectDir, sub), { recursive: true });
    }

    // --from copies the identity of an existing manifest in the same project —
    // brand, voice (incl. a designed voiceId, which is reused for free), presenter —
    // so a vertical Short starts from the demo's look and sound with a fresh timeline.
    let from = null;
    if (args.from) {
      from = await manifest.load(projectDir, { name: args.from });
    }

    // --style seeds format/presenter/caption defaults from the catalog;
    // an explicit --format still wins.
    const style = args.style ? STYLES[args.style] : null;
    if (args.style && !style) {
      throw new Error(`--style must be one of ${STYLE_NAMES.join(" | ")}, got "${args.style}"`);
    }

    const formatArg = args.format || style?.aspect;
    const format = formatArg ? FORMAT_PRESETS[formatArg] : null;
    if (formatArg && !format) {
      throw new Error(`--format must be one of ${Object.keys(FORMAT_PRESETS).join(" | ")}, got "${formatArg}"`);
    }
    const vertical = format && format.height > format.width;

    const m = manifest.blankManifest({
      slug: args.slug ||
        (from
          ? `${from.slug}${vertical && !from.slug.endsWith("-short") ? "-short" : ""}`
          : path.basename(projectDir)),
      name: args.name || from?.product?.name || "",
    });
    if (from) {
      m.product = structuredClone(from.product);
      m.brand = structuredClone(from.brand);
      m.voice = structuredClone(from.voice);
      m.presenter = structuredClone(from.presenter);
      m.pacing = structuredClone(from.pacing);
    }
    if (format) m.format = format;
    // Shorts default to the karaoke caption style; landscape keeps the clean pill.
    if (vertical) m.captions = { enabled: true, style: "shorts" };
    if (style) {
      m.style = args.style;
      m.presenter.mode = style.presenterMode;
      m.captions = { enabled: true, style: style.captionsStyle };
      // Cut-driven styles carry no scene transitions; the beats do the cutting.
      if (style.transitionPolicy === "cuts") m.transitions = [];
      // Corner-bubble styles seed the bubble's look and whether it is one
      // continuous take; walkthrough styles turn the click push-in off
      // manifest-wide (a scene can still set its own zoomToClick).
      if (style.pip) m.presenter.pip = structuredClone(style.pip);
      if (style.continuousPip) m.presenter.continuousPip = true;
      if (style.zoomToClick === false) m.zoomToClick = false;
      // Sound-effect pack: the style's event map plus the default cues, files
      // not generated yet (gen/sfx.mjs --all). Only when ElevenLabs is set up —
      // a project that cannot generate cues should not carry a block that
      // build-props will refuse to render.
      if (style.sfxAuto && hasElevenLabs()) m.sfx = scaffoldSfx(style.sfxAuto);
    }
    // Vertical cuts scaffold a frame-0 hook card (the thumbnail every platform
    // shows). hook is left empty on purpose: validate() refuses to render until
    // it is written, so a Short cannot ship with the presenter's face as its cover.
    if (vertical) {
      m.cover = { hook: "", kicker: "", layout: style?.coverLayout || manifest.COVER_DEFAULTS.layout };
    }

    await manifest.save(projectDir, m, { name });
    return report(`  created ${manifest.manifestPath(projectDir, name)}`, {
      ok: true, created: true, project: projectDir, manifest: name,
    });
  }

  // ---- status ----
  const m = await manifest.load(projectDir, { name });
  const check = manifest.validate(m);
  const pending = manifest.pending(projectDir, m);
  const cost = estimateCost(m);

  const runtime = manifest.totalDuration(m) -
    (m.transitions || []).reduce((s, t) => s + (t.ms || 400) / 1000, 0);

  info("");
  info(`  ${m.product?.name || m.slug} — ${m.timeline.length} scenes, ${fmtDuration(runtime)} runtime`);
  info(`  presenter: ${m.presenter?.mode || "hybrid"}   voice: ${m.voice?.voice || "-"}`);
  info("");

  const width = Math.max(...m.timeline.map((s) => s.id.length), 8);
  for (const scene of m.timeline) {
    const need = pending.find((p) => p.sceneId === scene.id);
    const mark = need ? "todo" : "  ok";
    const detail = need ? `needs ${need.needs.join(", ")}` : "complete";
    info(`  ${mark}  ${scene.id.padEnd(width)}  ${scene.kind.padEnd(9)} ` +
      `${fmtDuration(scene.durationSec).padStart(6)}  ${detail}`);
  }
  info("");

  if (cost.lines.length) {
    info("  Estimated generation cost:");
    for (const l of cost.lines) {
      info(`    ${l.item.padEnd(16)} ${String(l.detail).padEnd(12)} ~$${l.usd.toFixed(2)}`);
    }
    info(`    ${"TOTAL".padEnd(16)} ${"".padEnd(12)} ~$${cost.totalUsd.toFixed(2)}`);
    info("");
    info("  Rough figures for sizing a decision, not a quote. Cached artifacts are free");
    info("  to re-render — only changed scenes are regenerated.");
    info("");
  }

  for (const e of check.errors) warn(e);
  for (const w of check.warnings) warn(w);

  report(null, {
    ok: check.ok,
    project: projectDir,
    scenes: m.timeline.length,
    runtimeSec: runtime,
    pending,
    estimateUsd: Number(cost.totalUsd.toFixed(2)),
    costLines: cost.lines,
    errors: check.errors,
    warnings: check.warnings,
  });
});
