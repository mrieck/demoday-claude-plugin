#!/usr/bin/env node
/**
 * Regression test for concurrent manifest saves. Costs nothing, runs in
 * well under a second:
 *
 *   node scripts/selftest-manifest.mjs
 *
 * The original bug: presenter.mjs and broll.mjs ran in parallel, each loaded
 * the manifest at start and saved at the end, and the later save (presenter)
 * overwrote the `video` field broll had just written — breaking the render.
 * save() now three-way merges against what each process loaded, under an
 * advisory lock.
 */
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import * as manifest from "./lib/manifest.mjs";
import { report, info, main } from "./lib/log.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

await main(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "demoday-manifest-test-"));
  try {
    const m = manifest.blankManifest({ slug: "race" });
    m.timeline = [
      { id: "hook", kind: "presenter", durationSec: 5, narration: "hi" },
      { id: "broll", kind: "broll", durationSec: 5, prompt: "a shot" },
    ];
    await manifest.save(dir, m);

    // The exact production failure: two scripts hold the manifest, each fills
    // in a different scene, and the later save must not clobber the earlier.
    const presenter = await manifest.load(dir);
    const broll = await manifest.load(dir);
    manifest.patchScene(broll, "broll", { video: "clips/broll.mp4", model: "grok-imagine" });
    await manifest.save(dir, broll);
    manifest.patchScene(presenter, "hook", { video: "clips/hook.mp4" });
    await manifest.save(dir, presenter);

    const merged = await manifest.load(dir);
    assert(manifest.getScene(merged, "hook").video === "clips/hook.mp4", "presenter's field lost");
    assert(
      manifest.getScene(merged, "broll").video === "clips/broll.mp4",
      "broll's video clobbered by the later presenter save (the original bug)"
    );
    assert(manifest.getScene(merged, "broll").model === "grok-imagine", "broll's model clobbered");
    info("  interleaved saves: both scripts' fields survived");

    // A direct conflict on the same field goes to the later saver.
    const a = await manifest.load(dir);
    const b = await manifest.load(dir);
    manifest.patchScene(a, "hook", { durationSec: 7 });
    await manifest.save(dir, a);
    manifest.patchScene(b, "hook", { durationSec: 9 });
    await manifest.save(dir, b);
    assert(
      manifest.getScene(await manifest.load(dir), "hook").durationSec === 9,
      "later save should win a direct conflict"
    );
    info("  direct conflict: later save wins");

    // A scene added on disk while we held the manifest survives our save.
    const c = await manifest.load(dir);
    const d = await manifest.load(dir);
    d.timeline.push({ id: "outro", kind: "card", durationSec: 3, title: "bye" });
    await manifest.save(dir, d);
    c.timeline[0].narration = "hello";
    await manifest.save(dir, c);
    const withOutro = await manifest.load(dir);
    assert(withOutro.timeline.some((s) => s.id === "outro"), "scene added by the other script was dropped");
    assert(withOutro.timeline[0].narration === "hello", "own edit lost");
    info("  scene added elsewhere survives");

    // Truly concurrent saves: the lock serialises them without deadlock.
    const writers = [];
    for (let i = 0; i < 6; i++) {
      writers.push(
        (async () => {
          const mm = await manifest.load(dir);
          manifest.patchScene(mm, "broll", { [`f${i}`]: i });
          await manifest.save(dir, mm);
        })()
      );
    }
    await Promise.all(writers);
    const finalScene = manifest.getScene(await manifest.load(dir), "broll");
    for (let i = 0; i < 6; i++) assert(finalScene[`f${i}`] === i, `concurrent field f${i} lost`);
    info("  6 concurrent saves: all fields survived");

    report("  PASS — manifest merge + lock behave", { ok: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
