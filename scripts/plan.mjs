#!/usr/bin/env node
/**
 * Project status and cost estimate — the gate before anything is paid for.
 *
 *   node scripts/plan.mjs --project demo          # what exists, what's left, what it'll cost
 *   node scripts/plan.mjs --project demo --init --slug acme --name "Acme"
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
import { estimateCost } from "./lib/models.mjs";
import { report, info, warn, main, fmtDuration } from "./lib/log.mjs";

const USAGE = "plan.mjs --project <dir> [--init --slug <slug> --name <product>]";

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = manifest.resolveProjectDir(args.project);

  // ---- init ----
  if (boolArg(args.init, false)) {
    if (existsSync(manifest.manifestPath(projectDir)) && !boolArg(args.force, false)) {
      throw new Error(`${manifest.manifestPath(projectDir)} already exists — pass --force to overwrite.`);
    }
    for (const sub of ["clips", "audio", "assets", "actions", "out"]) {
      await mkdir(path.join(projectDir, sub), { recursive: true });
    }
    const m = manifest.blankManifest({
      slug: args.slug || path.basename(projectDir),
      name: args.name || "",
    });
    await manifest.save(projectDir, m);
    return report(`  created ${manifest.manifestPath(projectDir)}`, {
      ok: true, created: true, project: projectDir,
    });
  }

  // ---- status ----
  const m = await manifest.load(projectDir);
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
