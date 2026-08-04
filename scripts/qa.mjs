#!/usr/bin/env node
/**
 * Quality and safety pass over a finished (or in-progress) demo project.
 *
 *   node scripts/qa.mjs --project demo               # frames + checks
 *   node scripts/qa.mjs --project demo --video out/demo.mp4
 *
 * Does three things:
 *
 *  1. EXTRACTS FRAMES for visual review. There is no automatic grader — the point
 *     is to give Claude images to actually look at, because "the render succeeded"
 *     and "the demo is good" are unrelated statements.
 *  2. SCANS TEXT FOR SECRETS. Narration and typed values are checked against
 *     common credential shapes. This catches the realistic failure — an API key
 *     typed into a field during rehearsal and replayed on camera — but it CANNOT
 *     see what was merely visible on screen. Reviewing the frames is what covers that.
 *  3. CHECKS TIMELINE HEALTH: missing artifacts, scenes whose clip is shorter than
 *     their narration, silent scenes, and clips that drift from their audio.
 */
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "./lib/args.mjs";
import * as manifest from "./lib/manifest.mjs";
import { probe, extractFrames } from "./lib/ff.mjs";
import { report, info, warn, main, fmtDuration } from "./lib/log.mjs";

const USAGE = "qa.mjs --project <dir> [--video <file>] [--fps 0.5] [--skip-frames]";

/**
 * Credential shapes worth shouting about. Deliberately conservative — a false
 * positive costs a glance, a false negative ships someone's key in a public video.
 */
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/, "OpenAI-style secret key"],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/, "Anthropic API key"],
  [/\bghp_[A-Za-z0-9]{20,}\b/, "GitHub personal access token"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/, "Google API key"],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, "Slack token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "JWT"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
  [/\b[A-Za-z0-9._%+-]+@(?!example\.|acme\.|test\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, "real-looking email address"],
];

function scanText(text, where, findings) {
  if (!text) return;
  for (const [re, label] of SECRET_PATTERNS) {
    const m = String(text).match(re);
    if (m) {
      findings.push({
        where,
        kind: label,
        // Never echo the full secret into logs or transcripts.
        sample: `${m[0].slice(0, 6)}…${m[0].slice(-3)}`,
      });
    }
  }
}

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = manifest.resolveProjectDir(args.project);
  const m = await manifest.load(projectDir);

  const issues = [];
  const secrets = [];

  // ---- timeline health -----------------------------------------------------
  for (const scene of m.timeline) {
    const where = `scene "${scene.id}"`;

    scanText(scene.narration, `${where} narration`, secrets);

    if (scene.actions) {
      const actionsAbs = manifest.resolveIn(projectDir, scene.actions);
      if (existsSync(actionsAbs)) {
        const script = JSON.parse(await readFile(actionsAbs, "utf8"));
        for (const step of script.steps || []) {
          scanText(step.text, `${where} typed text`, secrets);
          scanText(step.url, `${where} url`, secrets);
        }
      }
    }

    if (scene.video) {
      const abs = manifest.resolveIn(projectDir, scene.video);
      if (!existsSync(abs)) {
        issues.push(`${where}: video missing (${scene.video})`);
      } else {
        const v = await probe(abs).catch(() => null);
        if (v?.duration && scene.durationSec) {
          const drift = v.duration - scene.durationSec;
          if (drift < -0.35) {
            issues.push(
              `${where}: clip is ${fmtDuration(v.duration)} but the scene runs ` +
              `${fmtDuration(scene.durationSec)} — the last ${fmtDuration(-drift)} will freeze.`
            );
          }
        }
      }
    }

    if (scene.audio) {
      const abs = manifest.resolveIn(projectDir, scene.audio);
      if (!existsSync(abs)) issues.push(`${where}: audio missing (${scene.audio})`);
    } else if (scene.narration) {
      issues.push(`${where}: has narration but no audio — run gen/tts.mjs`);
    }

    if (scene.kind === "demo" && !scene.events) {
      issues.push(`${where}: no event log, so it will not zoom toward clicks`);
    }
  }

  const pending = manifest.pending(projectDir, m);
  for (const p of pending) {
    issues.push(`scene "${p.sceneId}" still needs: ${p.needs.join(", ")}`);
  }

  // ---- frames for visual review -------------------------------------------
  let frames = [];
  let framesDir = null;
  const videoArg = args.video
    ? path.resolve(args.video)
    : path.join(projectDir, "out", `${m.slug || "demo"}.mp4`);

  if (!args["skip-frames"] && existsSync(videoArg)) {
    framesDir = path.join(projectDir, "qa", "frames");
    info(`  extracting review frames from ${path.basename(videoArg)}…`);
    frames = await extractFrames(videoArg, framesDir, {
      fps: Number(args.fps) || 0.5,
      width: 1000,
    });
  } else if (!existsSync(videoArg)) {
    info(`  no rendered video at ${videoArg} yet — skipping frame extraction`);
  }

  // ---- report --------------------------------------------------------------
  for (const s of secrets) warn(`possible ${s.kind} in ${s.where} (${s.sample})`);
  for (const i of issues) warn(i);

  const lines = [
    `  ${m.timeline.length} scene(s)`,
    frames.length ? `  ${frames.length} review frames in ${framesDir}` : null,
    secrets.length ? `  ${secrets.length} possible secret(s) — REVIEW BEFORE PUBLISHING` : "  no secrets found in text",
    issues.length ? `  ${issues.length} timeline issue(s)` : "  timeline looks complete",
    frames.length
      ? `\n  Now LOOK at the frames — read a sample of them. Automated checks cannot tell\n` +
        `  you whether the demo is convincing, whether text is legible, or whether\n` +
        `  something sensitive is visible on screen.`
      : null,
  ].filter(Boolean);

  report(lines.join("\n"), {
    ok: issues.length === 0 && secrets.length === 0,
    scenes: m.timeline.length,
    issues,
    secrets,
    frames,
    framesDir,
    video: existsSync(videoArg) ? videoArg : null,
  });
});
