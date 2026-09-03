#!/usr/bin/env node
/**
 * Sound-effect placement test — costs nothing.
 *
 *   node scripts/selftest-sfx.mjs
 *
 * Builds a fixture manifest (cover, an anchored beat scene with insert/stamp/
 * face, a bullets split, a transition, a card) with silent cue files, runs
 * lib/sfx.mjs buildSfxTrack, and asserts every cue lands on the frame the
 * compositor draws the event on. Also pins the bullet-timing formula shared
 * with remotion-template/src/lib/timing.js.
 */
import path from "node:path";
import os from "node:os";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildSfxTrack, bulletAppearSec, resolveCue, scaffoldSfx, referencedCues, missingCues } from "./lib/sfx.mjs";
import { bulletAppearSec as templateBulletAppearSec } from "../remotion-template/src/lib/timing.js";
import * as manifest from "./lib/manifest.mjs";
import { report, info, main } from "./lib/log.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond, msg) {
  if (!cond) throw new Error(`selftest-sfx: ${msg}`);
}

await main(async () => {
  const dir = path.join(os.tmpdir(), `demoday-sfx-${Date.now()}`);
  await mkdir(path.join(dir, "audio", "sfx"), { recursive: true });
  const fps = 30;

  const sfx = scaffoldSfx({ insert: "whoosh", stamp: "pop", face: "hit", bullet: "tick", coverExit: "whoosh", transition: "whoosh", card: "riser", sceneStart: null });
  for (const name of Object.keys(sfx.cues)) {
    await writeFile(path.join(dir, "audio", "sfx", `${name}.mp3`), "");
    sfx.cues[name].file = `audio/sfx/${name}.mp3`;
  }

  const m = {
    ...manifest.blankManifest({ slug: "sfx-test" }),
    format: { width: 1080, height: 1920, fps },
    cover: { hook: "x", holdSec: 0.5, outSec: 0.5 },
    sfx,
    transitions: [{ after: "b", type: "fade", ms: 400 }],
    timeline: [
      { id: "a", kind: "demo", target: "web", durationSec: 6, video: "x.mp4", beatLayout: "anchored",
        beats: [
          { atSec: 0, shot: "insert", title: "T", stamp: "#1" },
          { atSec: 1.5, shot: "screen" },
          { atSec: 3.0, shot: "face" },
          { atSec: 4.0, shot: "insert", title: "U", sfx: false },
          { atSec: 5.0, shot: "screen", sfx: { cue: "riser", offsetSec: -0.5, gain: 0.5 } },
        ] },
      { id: "b", kind: "demo", target: "web", durationSec: 4, video: "x.mp4", framing: "split",
        bottom: { kind: "bullets", bullets: [{ text: "one" }, { text: "two", atSec: 3 }, { text: "three", sfx: false }] } },
      { id: "c", kind: "card", durationSec: 3, title: "CTA" },
    ],
  };

  // Formula parity with the template.
  for (const [i, n, d] of [[0, 3, 4], [1, 3, 4], [2, 3, 6], [0, 1, 10]]) {
    assert(bulletAppearSec({}, i, n, d) === templateBulletAppearSec({}, i, n, d), "bulletAppearSec differs from the template");
  }
  assert(bulletAppearSec({ atSec: 2 }, 0, 3, 4) === 2, "explicit atSec must win");

  // resolveCue semantics.
  assert(resolveCue(sfx, "insert", undefined).cue === "whoosh", "auto map");
  assert(resolveCue(sfx, "insert", false) === null, "false silences");
  assert(resolveCue(sfx, "insert", "pop").cue === "pop", "string override");
  assert(resolveCue(sfx, "sceneStart", undefined) === null, "null auto = off");
  assert(referencedCues(m).includes("riser") && !missingCues(m).length, "referenced / missing");

  const check = manifest.validate(m);
  assert(check.ok, `fixture should validate: ${check.errors.join("; ")}`);

  const { track, problems } = await buildSfxTrack(m, { timeline: m.timeline, cover: m.cover, fps, projectDir: dir, probeSec: async () => 0.5 });
  assert(!problems.length, `problems: ${problems.join("; ")}`);

  const at = (event, frame) => track.find((c) => c.event === event && c.atFrame === frame);
  const f = (sec) => Math.round(sec * fps);
  // cover exit at holdSec
  assert(at("coverExit", f(0.5)), "cover exit whoosh at 0.5s");
  // scene a: insert + stamp at frame 0; face at 3.0; insert at 4.0 silenced; screen at 5.0 override riser pre-rolled 0.5
  assert(at("insert", 0) && at("stamp", 0), "insert whoosh + stamp pop at scene a frame 0");
  assert(at("face", f(3.0)), "face hit at 3.0s");
  assert(!track.some((c) => c.atFrame === f(4.0)), "sfx:false beat is silent");
  const ov = track.find((c) => c.cue === "riser" && c.atFrame === f(4.5));
  assert(ov && ov.gain === 0.5, "object override with offsetSec/gain");
  // scene b starts at 6s (no transition after a); bullets: one at 6 + 4/4=1s, two at 6+3, three silenced
  assert(at("bullet", f(7.0)), "bullet one at 7.0s");
  assert(at("bullet", f(9.0)), "bullet two (explicit atSec) at 9.0s");
  assert(track.filter((c) => c.event === "bullet").length === 2, "third bullet silenced");
  // transition after b: scene b ends at 10s, overlap 0.4 → scene c starts at 9.6s
  assert(at("transition", f(9.6)), "transition whoosh at 9.6s");
  assert(at("card", f(9.6)), "card riser at scene c start");
  assert(track.every((c) => c.frames === f(0.5)), "cue window uses the probed length");

  // Disabled = empty track, no problems.
  const off = await buildSfxTrack({ ...m, sfx: { ...sfx, enabled: false } }, { timeline: m.timeline, cover: m.cover, fps, projectDir: dir });
  assert(off.track.length === 0 && !off.problems.length, "disabled pack is silent");

  // A referenced cue without a file is a render problem.
  const broken = structuredClone(m);
  broken.sfx.cues.pop.file = null;
  const b = await buildSfxTrack(broken, { timeline: m.timeline, cover: m.cover, fps, projectDir: dir });
  assert(b.problems.some((p) => /pop/.test(p)), "missing cue file surfaces as a problem");

  await rm(dir, { recursive: true, force: true });
  info(`  ${track.length} cues placed as expected`);
  report("  selftest-sfx: ok", { ok: true, cues: track.length, pluginRoot: PLUGIN_ROOT });
});
