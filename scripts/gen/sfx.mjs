#!/usr/bin/env node
/**
 * Sound-effect cues — design a project's SFX pack with ElevenLabs.
 *
 *   node scripts/gen/sfx.mjs --project demo/<slug> [--manifest shorts.json] --all
 *   node scripts/gen/sfx.mjs --project demo/<slug> --cue whoosh [--prompt "…"] [--duration 0.6] [--n 3] [--influence 0.4] [--force]
 *   node scripts/gen/sfx.mjs --project demo/<slug> --cue whoosh --pick 2
 *   node scripts/gen/sfx.mjs --project demo/<slug> --audition whoosh
 *   node scripts/gen/sfx.mjs --project demo/<slug> --add stinger --prompt "…" [--duration 1.0]
 *   node scripts/gen/sfx.mjs --project demo/<slug> --init            # add the default pack to a manifest without one
 *   node scripts/gen/sfx.mjs --project demo/<slug> --list
 *
 * OPTIONAL FEATURE — requires ELEVENLABS_API_KEY (see doctor.mjs). Without it
 * the renderer never sees a cue and the video sounds exactly as before.
 *
 * Each cue in manifest.sfx.cues is generated N times (default 3 — every call is
 * a fresh take), the candidates are kept under audio/sfx/previews/<cue>-<n>.mp3,
 * the first is copied to audio/sfx/<cue>.mp3 and recorded as the cue's `file`.
 * `--pick` swaps the accepted take with no API call. Every take is trimmed of
 * leading silence, given a 10ms/60ms fade and loudness-normalised so cues sit
 * at a predictable level under the voice.
 *
 * Identical prompt + duration + n is a cache hit (lib/cache.mjs, kind "sfx"),
 * and accepted cues are also stored per machine under ~/.config/demoday/sfx/
 * so the default pack is designed once, not once per project.
 */
import path from "node:path";
import os from "node:os";
import { writeFile, mkdir, copyFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs, boolArg, fail } from "../lib/args.mjs";
import * as manifest from "../lib/manifest.mjs";
import * as cache from "../lib/cache.mjs";
import { ffmpeg, probe } from "../lib/ff.mjs";
import { initElevenLabs, generateSoundEffect, SFX_MODEL } from "../lib/elevenlabs.mjs";
import { DEFAULT_CUES, FULL_AUTO, scaffoldSfx, referencedCues } from "../lib/sfx.mjs";
import { ELEVENLABS } from "../lib/models.mjs";
import { report, info, warn, main } from "../lib/log.mjs";

const USAGE =
  "sfx.mjs --project <dir> [--manifest <file>] (--all | --cue <name> [--prompt <text>] [--duration <sec>] [--n 3] [--influence 0.3] [--force] | " +
  "--cue <name> --pick <n> | --audition <name> | --add <name> --prompt <text> [--duration <sec>] | --init | --list)";

const SFX_DIR = path.join("audio", "sfx");
const PREVIEW_DIR = path.join(SFX_DIR, "previews");
const DEFAULT_N = 3;

/** Per-machine store of accepted cues, keyed by what determines the sound. */
function globalStoreDir() {
  return process.env.DEMODAY_CONFIG_DIR
    ? path.join(process.env.DEMODAY_CONFIG_DIR, "sfx")
    : path.join(os.homedir(), ".config", "demoday", "sfx");
}
function cueKey({ prompt, durationSec, promptInfluence }) {
  return createHash("sha256")
    .update(JSON.stringify({ prompt: String(prompt).trim().toLowerCase(), durationSec: durationSec ?? null, promptInfluence: promptInfluence ?? null }))
    .digest("hex")
    .slice(0, 24);
}

/**
 * Trim leading silence, add tiny fades, normalise loudness. A raw generation
 * often opens with 50-150ms of nothing, which would put the hit late on the cut.
 */
async function polish(input, output) {
  const encode = ["-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-q:a", "2", output];
  const fades = "afade=t=in:st=0:d=0.01,areverse,afade=t=in:st=0:d=0.06,areverse";
  const norm = "loudnorm=I=-16:TP=-1.5:LRA=11";
  // Pass 1: strip the lead-in. A quiet take (a soft tick) can sit entirely
  // under the threshold, in which case silenceremove returns nothing — so
  // check the result and fall back to the untrimmed take rather than ship
  // an empty file.
  await ffmpeg(["-i", input, "-af", `silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.02,${fades},${norm}`, ...encode]);
  const sec = (await probe(output).catch(() => null))?.duration || 0;
  if (sec >= 0.05) return output;
  await ffmpeg(["-i", input, "-af", `${fades},${norm}`, ...encode]);
  return output;
}

function rawPath(out) {
  return out.replace(/\.mp3$/, ".raw.mp3");
}

function cueOf(m, name) {
  const c = m.sfx?.cues?.[name];
  if (!c) fail(`no cue "${name}" in sfx.cues — --list shows them, --add defines a new one`, USAGE);
  return c;
}

/** Generate N candidates for one cue (cache-aware); returns absolute preview paths. */
async function designCue(projectDir, name, cue, { n, influence, force }) {
  const params = { prompt: cue.prompt, durationSec: cue.durationSec ?? null, promptInfluence: influence ?? null };
  const previewDirAbs = path.join(projectDir, PREVIEW_DIR);
  await mkdir(previewDirAbs, { recursive: true });

  // Same prompt designed on this machine before? Reuse the accepted take as
  // candidate 1 for free (the other candidates still generate, unless n is 1).
  const storeFile = path.join(globalStoreDir(), `${cueKey(params)}.mp3`);
  const files = [];
  let spent = 0;
  for (let i = 1; i <= n; i++) {
    const out = path.join(previewDirAbs, `${name}-${i}.mp3`);
    const { path: produced, cached } = await cache.memo(
      projectDir,
      { kind: "sfx", model: SFX_MODEL, params: { ...params, n: i } },
      async () => {
        if (i === 1 && !force && existsSync(storeFile)) {
          await copyFile(storeFile, out);
          info(`    ${name} #1: reused from the machine store (no spend)`);
          return out;
        }
        initElevenLabs();
        const bytes = await generateSoundEffect({ text: cue.prompt, durationSec: cue.durationSec, promptInfluence: influence });
        const raw = rawPath(out);
        await writeFile(raw, bytes);
        await polish(raw, out);
        spent += ELEVENLABS.sfxUsdPerGeneration;
        return out;
      },
      { force }
    );
    if (cached) info(`    ${name} #${i}: cached`);
    files.push(produced);
  }
  return { files, spent };
}

/** Copy candidate N to the cue's canonical file, record it, and stash it globally. */
async function acceptCandidate(projectDir, name, n, { candidates, params }) {
  const src = candidates[n - 1];
  if (!src || !existsSync(src)) fail(`no candidate #${n} for "${name}" — candidates run 1-${candidates.length}`);
  const outAbs = path.join(projectDir, SFX_DIR, `${name}.mp3`);
  await mkdir(path.dirname(outAbs), { recursive: true });
  await copyFile(src, outAbs);
  const sec = (await probe(outAbs).catch(() => null))?.duration || null;
  try {
    await mkdir(globalStoreDir(), { recursive: true });
    await copyFile(outAbs, path.join(globalStoreDir(), `${cueKey(params)}.mp3`));
  } catch {
    /* the machine store is a convenience — never fail a run over it */
  }
  return { file: manifest.relativeIn(projectDir, outAbs), picked: n, measuredSec: sec };
}

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = manifest.resolveProjectDir(args.project);
  const name = args.manifest || manifest.MANIFEST_NAME;
  let m = await manifest.load(projectDir, { name });

  // ---- --init: add the default pack to a manifest that has none -------------
  if (boolArg(args.init, false)) {
    if (m.sfx && !boolArg(args.force, false)) fail("this manifest already has an sfx block — pass --force to replace it");
    const styleAuto = m.style ? (await import("../lib/styles.mjs")).STYLES[m.style]?.sfxAuto : null;
    await manifest.update(projectDir, (mm) => { mm.sfx = scaffoldSfx(styleAuto || FULL_AUTO); }, { name });
    return report(`  added sfx pack (${Object.keys(DEFAULT_CUES).join(", ")}) — next: gen/sfx.mjs --all`, {
      ok: true, cues: Object.keys(DEFAULT_CUES), auto: styleAuto || FULL_AUTO,
    });
  }

  if (!m.sfx) fail("this manifest has no sfx block — run gen/sfx.mjs --init (or plan.mjs --init --style <name>)", USAGE);

  // ---- --list ----------------------------------------------------------------
  if (boolArg(args.list, false)) {
    const used = new Set(referencedCues(m));
    info("");
    for (const [cname, c] of Object.entries(m.sfx.cues || {})) {
      info(`    ${cname.padEnd(10)} ${c.file ? "ready " : "TODO  "} ${used.has(cname) ? "used  " : "unused"}  ${c.durationSec ?? "auto"}s  "${c.prompt}"`);
    }
    info("");
    info(`    auto: ${JSON.stringify(m.sfx.auto || {})}`);
    return report(null, { ok: true, cues: m.sfx.cues, auto: m.sfx.auto, enabled: m.sfx.enabled !== false });
  }

  // ---- --add <name> --prompt "…" --------------------------------------------
  if (args.add) {
    const cname = String(args.add);
    if (cname === "true" || !/^[a-z][a-z0-9-]*$/i.test(cname)) fail("--add needs a cue name (letters, digits, dashes)", USAGE);
    if (!args.prompt || args.prompt === true) fail("--add needs --prompt", USAGE);
    const cue = { prompt: String(args.prompt), durationSec: args.duration ? Number(args.duration) : null, file: null, gain: 1 };
    await manifest.update(projectDir, (mm) => { (mm.sfx.cues ||= {})[cname] = cue; }, { name });
    m = await manifest.load(projectDir, { name });
    args.cue = cname; // fall through to generate it
  }

  // ---- --repolish: re-run the trim/fade/normalise over the kept raw takes ----
  // No API call. For after tuning polish(), or when a take came out empty.
  if (boolArg(args.repolish, false)) {
    const dir = path.join(projectDir, PREVIEW_DIR);
    const names = args.cue ? [String(args.cue)] : Object.keys(m.sfx.cues || {});
    const redone = [];
    for (const cname of names) {
      const cue = cueOf(m, cname);
      for (let i = 1; ; i++) {
        const out = path.join(dir, `${cname}-${i}.mp3`);
        const raw = rawPath(out);
        if (!existsSync(raw)) break;
        await polish(raw, out);
        redone.push(out);
        if (i === (cue.picked || 1) && cue.file) await copyFile(out, path.join(projectDir, cue.file));
      }
    }
    return report(`  re-polished ${redone.length} take(s) from raw`, { ok: true, files: redone });
  }

  // ---- --audition <name> ------------------------------------------------------
  if (args.audition) {
    const cname = String(args.audition);
    cueOf(m, cname);
    const dir = path.join(projectDir, PREVIEW_DIR);
    const files = [1, 2, 3, 4, 5].map((i) => path.join(dir, `${cname}-${i}.mp3`)).filter((f) => existsSync(f));
    if (!files.length) fail(`no candidates for "${cname}" yet — run --cue ${cname} first`);
    for (const f of files) info(`  afplay ${f}`);
    info(`  then: node scripts/gen/sfx.mjs --project <dir> --cue ${cname} --pick <n>`);
    return report(null, { ok: true, cue: cname, candidates: files });
  }

  // ---- --cue <name> --pick <n> ----------------------------------------------
  if (args.cue && args.pick) {
    const cname = String(args.cue);
    const cue = cueOf(m, cname);
    const n = Number(args.pick);
    if (!Number.isInteger(n) || n < 1) fail("--pick needs a candidate number (1, 2, 3)", USAGE);
    const dir = path.join(projectDir, PREVIEW_DIR);
    const candidates = [];
    for (let i = 1; existsSync(path.join(dir, `${cname}-${i}.mp3`)); i++) candidates.push(path.join(dir, `${cname}-${i}.mp3`));
    const params = { prompt: cue.prompt, durationSec: cue.durationSec ?? null, promptInfluence: args.influence ? Number(args.influence) : null };
    const picked = await acceptCandidate(projectDir, cname, n, { candidates, params });
    await manifest.update(projectDir, (mm) => { Object.assign(mm.sfx.cues[cname], { file: picked.file, picked: n }); }, { name });
    return report(`  ${cname}: candidate #${n} accepted -> ${picked.file}`, { ok: true, cue: cname, ...picked });
  }

  // ---- generate: --all or --cue <name> -------------------------------------
  const targets = boolArg(args.all, false)
    ? Object.keys(m.sfx.cues || {}).filter((c) => !m.sfx.cues[c].file || boolArg(args.force, false))
    : args.cue ? [String(args.cue)] : [];
  if (!targets.length) {
    if (boolArg(args.all, false)) return report("  every cue already has a file — nothing to generate (pass --force to redo)", { ok: true, cues: [], usd: 0 });
    fail("nothing to do", USAGE);
  }
  if (targets.length === 1 && args.prompt && args.prompt !== true) {
    await manifest.update(projectDir, (mm) => { mm.sfx.cues[targets[0]].prompt = String(args.prompt); }, { name });
    m = await manifest.load(projectDir, { name });
  }
  if (targets.length === 1 && args.duration) {
    await manifest.update(projectDir, (mm) => { mm.sfx.cues[targets[0]].durationSec = Number(args.duration); }, { name });
    m = await manifest.load(projectDir, { name });
  }

  const n = args.n ? Number(args.n) : (m.sfx.candidates ?? DEFAULT_N);
  const influence = args.influence ? Number(args.influence) : null;
  const force = boolArg(args.force, false);
  initElevenLabs();

  const results = [];
  let usd = 0;
  for (const cname of targets) {
    const cue = cueOf(m, cname);
    info(`  ${cname}: "${cue.prompt}" (${cue.durationSec ?? "auto"}s) x${n}`);
    const { files, spent } = await designCue(projectDir, cname, cue, { n, influence, force });
    usd += spent;
    const params = { prompt: cue.prompt, durationSec: cue.durationSec ?? null, promptInfluence: influence };
    const picked = await acceptCandidate(projectDir, cname, 1, { candidates: files, params });
    await manifest.update(projectDir, (mm) => { Object.assign(mm.sfx.cues[cname], { file: picked.file, picked: 1 }); }, { name });
    results.push({ cue: cname, file: picked.file, picked: 1, measuredSec: picked.measuredSec, candidates: files });
    info(`    accepted #1 -> ${picked.file}   hear the others: afplay ${files[1] || files[0]}`);
  }
  info("  swap a take with: node scripts/gen/sfx.mjs --project <dir> --cue <name> --pick <n>");
  return report(`  ${results.length} cue(s) ready (~$${usd.toFixed(2)} spent)`, { ok: true, cues: results, usd: Number(usd.toFixed(3)) });
});
