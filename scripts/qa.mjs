#!/usr/bin/env node
/**
 * Quality and safety pass over a finished (or in-progress) demo project.
 *
 *   node scripts/qa.mjs --project demo/<slug>               # frames + checks
 *   node scripts/qa.mjs --project demo/<slug> --video out/demo.mp4
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
import { spawnSync } from "node:child_process";
import { parseArgs } from "./lib/args.mjs";
import * as manifest from "./lib/manifest.mjs";
import { STYLES } from "./lib/styles.mjs";
import { probe, extractFrames } from "./lib/ff.mjs";
import { referencedCues, buildSfxTrack } from "./lib/sfx.mjs";
import { buildLayoutTrack, layoutStats } from "./lib/layouts.mjs";
import { report, info, warn, main, fmtDuration } from "./lib/log.mjs";

const USAGE = "qa.mjs --project <dir> [--manifest <file>] [--video <file>] [--fps 0.5] [--skip-frames]";

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
  const m = await manifest.load(projectDir, { name: args.manifest || manifest.MANIFEST_NAME });

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

  // Sound effects: every referenced cue must have a file, and a track denser
  // than ~one cue per second is over-sweetened — cut some auto events.
  if (m.sfx && m.sfx.enabled !== false) {
    for (const name of referencedCues(m)) {
      const c = m.sfx.cues?.[name];
      if (!c?.file) issues.push(`sfx cue "${name}" has no file — run gen/sfx.mjs --all`);
      else if (!existsSync(manifest.resolveIn(projectDir, c.file))) issues.push(`sfx cue "${name}" file missing (${c.file})`);
    }
    const fps = m.format?.fps || 30;
    const { track } = await buildSfxTrack(m, { timeline: m.timeline, cover: m.cover, fps, projectDir, probeSec: null });
    const runtime = manifest.totalDuration(m) || 1;
    if (track.length / runtime > 1) {
      issues.push(`sfx: ${track.length} cues over ${fmtDuration(runtime)} — more than one per second reads as noise; set some sfx.auto events to null`);
    }
    info(`  ${track.length} sound-effect cue(s) placed`);
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

  // ---- pacing (styles with a shot-length target) ---------------------------
  // Measured with scenedetect (PySceneDetect) when available: fast-cut styles
  // live or die on rhythm, and "the render succeeded" says nothing about it.
  // Warning-only — adaptive detection over-counts on pan-heavy footage.
  let pacing = null;
  const style = m.style ? STYLES[m.style] : null;
  if (style?.targetShotSec && existsSync(videoArg)) {
    const probeTool = spawnSync("scenedetect", ["version"], { encoding: "utf8" });
    if (probeTool.error || probeTool.status !== 0) {
      info("  scenedetect not on PATH — skipping the pacing check (pipx install scenedetect[opencv])");
    } else {
      const qaDir = path.join(projectDir, "qa");
      const run = spawnSync(
        "scenedetect",
        ["-i", videoArg, "detect-adaptive", "list-scenes", "-o", qaDir, "-f", "pacing.csv", "-q"],
        { encoding: "utf8" }
      );
      const csvFile = path.join(qaDir, "pacing.csv");
      if (run.status === 0 && existsSync(csvFile)) {
        const rows = (await readFile(csvFile, "utf8")).split("\n").filter((l) => /^\d+,/.test(l));
        const shots = rows.length;
        const meta = await probe(videoArg).catch(() => null);
        if (shots && meta?.duration) {
          const avgShotSec = meta.duration / shots;
          const [min, max] = style.targetShotSec;
          // list-scenes CSV: col 4 = start (s), col 10 = length (s)
          const lens = rows.map((r) => r.split(",")).map((c) => ({ start: Number(c[3]), len: Number(c[9]) }))
            .filter((c) => Number.isFinite(c.len));
          const longest = lens.reduce((a, c) => (c.len > a.len ? c : a), { start: 0, len: 0 });
          const firstCutSec = lens.length > 1 ? lens[1].start : meta.duration;
          pacing = {
            shots, avgShotSec: Number(avgShotSec.toFixed(2)), target: style.targetShotSec,
            longestShotSec: Number(longest.len.toFixed(2)), longestShotAtSec: Number(longest.start.toFixed(2)),
            firstCutSec: Number(firstCutSec.toFixed(2)),
          };
          // scenedetect misses cuts that only change a dark top pane (anchored
          // terminals/dashboards), so also count what the manifest declares.
          const declared = m.timeline.reduce((n, sc) => n + Math.max(1, (sc.beats || []).length), 0);
          const declaredAvg = meta.duration / declared;
          pacing.declaredCuts = declared;
          pacing.declaredAvgShotSec = Number(declaredAvg.toFixed(2));
          info(`  pacing (manifest): ${declared} declared shots, ${declaredAvg.toFixed(2)}s average`);
          const underDetected = shots < declared * 0.6;
          if (style.rules && !underDetected) {
            const closerStart = meta.duration - 6;
            if (longest.len > style.rules.maxShotSec && longest.start < closerStart) {
              warn(`pacing: longest shot is ${longest.len.toFixed(1)}s at ${longest.start.toFixed(1)}s — the "${m.style}" style holds nothing past ${style.rules.maxShotSec}s outside the closer`);
            }
            if (firstCutSec > style.rules.hookCutSec) {
              warn(`pacing: first cut at ${firstCutSec.toFixed(1)}s — the "${m.style}" hook cuts to a visual within ${style.rules.hookCutSec}s`);
            }
          }
          if (avgShotSec > max && declaredAvg >= min && declaredAvg <= max) {
            info(`  pacing: scenedetect saw ${shots} shots (${avgShotSec.toFixed(2)}s avg) but the manifest declares ${declared} — dark top-pane cuts are under-detected; trust the frames`);
          } else if (avgShotSec < min || avgShotSec > max) {
            warn(
              `pacing: ${shots} shots, ${avgShotSec.toFixed(2)}s average — the "${m.style}" style targets ` +
              `${min}-${max}s. ${avgShotSec > max ? "Add beats or tighten scenes." : "That is faster than readable."}`
            );
          } else {
            info(`  pacing: ${shots} shots, ${avgShotSec.toFixed(2)}s average — inside the ${min}-${max}s target`);
          }
        }
      } else {
        info("  scenedetect run failed — skipping the pacing check");
      }
    }
  }

  // ---- presenter layouts (dynamic style) -----------------------------------
  // The moves are what the style is about, and scenedetect can see them but
  // not the 0.2s content dissolves inside a layout — so the manifest's own
  // layout track is the pacing number to trust here (validate() already
  // warned about anything outside the rules).
  let layouts = null;
  if (style?.rules?.layouts) {
    const track = buildLayoutTrack(m.timeline, m.transitions);
    if (track.length) {
      layouts = layoutStats(track);
      const mix = ["face", "panel", "card"].map((g) => `${Math.round((layouts.mix[g] || 0) * 100)}% ${g}`).join(" / ");
      info(
        `  layouts: ${layouts.shots} shots, ${layouts.avgShotSec}s average (${mix}); longest hold ` +
        `${layouts.longest.sec}s (${layouts.longest.layout} at ${layouts.longest.atSec}s); first move at ` +
        `${layouts.firstChangeSec}s; closes on "${layouts.lastLayout}"`
      );
    }
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
    pacing,
    layouts,
    video: existsSync(videoArg) ? videoArg : null,
  });
});
