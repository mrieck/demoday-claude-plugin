/**
 * demo.json — the single source of truth for a demo video project.
 *
 * This is the piece the reference plugin never had: without it, the plan for the
 * video lives only in the model's context, so nothing can be resumed, re-run, or
 * partially regenerated. Every script reads and writes this file; a scene is
 * "done" when its artifact paths are filled in here, not when a model says so.
 *
 * All paths inside the manifest are RELATIVE to the project dir (the directory
 * containing demo.json), so a project folder can be moved or committed as-is.
 * Use `resolveIn()` / `relativeIn()` at the boundaries; never store absolute paths.
 */
import { readFile, writeFile, mkdir, rename, open, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const MANIFEST_NAME = "demo.json";

/** Scene kinds the renderer knows how to draw. */
export const SCENE_KINDS = ["presenter", "demo", "broll", "card"];

/** Presenter modes: no face at all / face only outside the demo / face always on screen. */
export const PRESENTER_MODES = ["none", "hybrid", "always"];

/** Capture backends. `ios` is declared here but not implemented yet. */
export const CAPTURE_TARGETS = ["web", "mac", "ios", "cli"];

/**
 * Narration providers. "fal" speaks with a stock voice name; "elevenlabs" speaks
 * with a designed voice_id (gen/voice-design.mjs) and needs ELEVENLABS_API_KEY.
 * An absent provider means "fal", so pre-feature manifests are untouched.
 */
export const VOICE_PROVIDERS = ["fal", "elevenlabs"];

/** A fresh manifest with sane defaults. */
export function blankManifest({ slug = "demo", name = "" } = {}) {
  return {
    version: 1,
    slug,
    product: { name, tagline: "", audience: "", valueProps: [] },
    brand: { colors: { primary: "#5B8DEF", bg: "#0B0D12", text: "#FFFFFF" }, logo: null, font: "Inter" },
    format: { width: 1920, height: 1080, fps: 30 },
    voice: {
      provider: "fal",
      model: "fal-ai/elevenlabs/tts/eleven-v3",
      voice: "Rachel",
      stability: 0.4,
      speed: 1.0,
    },
    presenter: {
      mode: "hybrid",
      description: "",
      characterImage: null,
      engine: "fal-ai/kling-video/ai-avatar/v2/standard",
    },
    music: { enabled: false, bed: null, duckDb: -14 },
    captions: { enabled: true, style: "clean" },
    /**
     * Breathing room after each narration line, in seconds, ON TOP of any
     * transition that follows the scene.
     *
     * A scene whose duration equals its narration length has no slack, and because
     * transitions overlap scenes, the next line starts before the previous one has
     * finished — two voices at once at every cut. `breathSec` is the audible gap
     * that remains after the transition has taken its share.
     */
    pacing: { breathSec: 0.45 },
    timeline: [],
    transitions: [],
  };
}

/** Locate the project dir: an explicit --project, or ./demo, or cwd if it holds a manifest. */
export function resolveProjectDir(explicit) {
  if (explicit) return path.resolve(explicit);
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, MANIFEST_NAME))) return cwd;
  return path.join(cwd, "demo");
}

export function manifestPath(projectDir) {
  return path.join(projectDir, MANIFEST_NAME);
}

/** Absolute path for a manifest-relative path. */
export function resolveIn(projectDir, rel) {
  if (!rel) return null;
  return path.isAbsolute(rel) ? rel : path.join(projectDir, rel);
}

/** Manifest-relative path for an absolute one — always use before storing a path. */
export function relativeIn(projectDir, abs) {
  if (!abs) return null;
  return path.relative(projectDir, path.resolve(abs));
}

export async function load(projectDir) {
  const file = manifestPath(projectDir);
  if (!existsSync(file)) {
    throw new Error(`No ${MANIFEST_NAME} at ${file} — run the demo-video skill to create one.`);
  }
  const raw = await readFile(file, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  loadedSnapshots.set(parsed, structuredClone(parsed));
  return parsed;
}

/* ---- concurrent-save protection ------------------------------------------ */

/**
 * Snapshot of each manifest as it came off disk, keyed by object identity.
 * Long-running gen scripts (presenter.mjs, broll.mjs) load the manifest at
 * start and save minutes later; without a base to merge against, whichever
 * finishes last overwrites the fields the other one filled in.
 */
const loadedSnapshots = new WeakMap();

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasId = (v) => isObj(v) && typeof v.id === "string";

/**
 * Three-way merge: `base` is what this process loaded, `mine` its current
 * state, `theirs` what is on disk now. A side that left a value untouched
 * yields to the side that changed it; a direct conflict goes to `mine`, since
 * the saving script is acting on its own results.
 */
function mergeValue(base, mine, theirs) {
  if (deepEqual(mine, theirs)) return mine;
  if (deepEqual(mine, base)) return theirs;
  if (deepEqual(theirs, base)) return mine;
  if (isObj(mine) && isObj(theirs)) return mergeObject(isObj(base) ? base : {}, mine, theirs);
  if (Array.isArray(mine) && Array.isArray(theirs) && (mine.some(hasId) || theirs.some(hasId))) {
    return mergeIdArray(Array.isArray(base) ? base : [], mine, theirs);
  }
  return mine;
}

function mergeObject(base, mine, theirs) {
  const out = {};
  for (const k of Object.keys(mine)) {
    if (k in theirs) out[k] = mergeValue(base[k], mine[k], theirs[k]);
    else if (!(k in base) || !deepEqual(mine[k], base[k])) out[k] = mine[k];
    // else: we did not touch it and they deleted it — accept the deletion
  }
  for (const k of Object.keys(theirs)) {
    if (k in mine) continue;
    if (!(k in base)) out[k] = theirs[k]; // they added it while we held the manifest
    // else: we deleted it — our intent wins
  }
  return out;
}

/** Arrays of { id } (the timeline) merge per scene; `mine` controls membership and order. */
function mergeIdArray(base, mine, theirs) {
  const byId = (arr) => new Map(arr.filter(hasId).map((x) => [x.id, x]));
  const baseBy = byId(base);
  const theirsBy = byId(theirs);
  const mineBy = byId(mine);
  const out = mine.map((item) =>
    hasId(item) && theirsBy.has(item.id)
      ? mergeValue(baseBy.get(item.id) ?? {}, item, theirsBy.get(item.id))
      : item
  );
  for (const t of theirs) {
    if (hasId(t) && !mineBy.has(t.id) && !baseBy.has(t.id)) out.push(t); // scene added elsewhere
  }
  return out;
}

/** Advisory lock file, so read-merge-write is atomic across processes. */
async function withLock(file, fn, { timeoutMs = 10000, staleMs = 20000 } = {}) {
  const lock = `${file}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs).catch(() => Infinity);
      if (age > staleMs) {
        await unlink(lock).catch(() => {});
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for ${lock} — delete it if no other script is running.`);
      }
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 100));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

/**
 * Write the manifest atomically and merge-safely.
 *
 * Under an advisory lock, the current disk copy is re-read and three-way
 * merged against what this process loaded, so gen scripts running in parallel
 * keep each other's fields. The temp-file + rename keeps a crash from tearing
 * the file. A manifest that was never load()ed (plan.mjs --init) has no base
 * and overwrites, which is what --init means.
 */
export async function save(projectDir, manifest) {
  await mkdir(projectDir, { recursive: true });
  const file = manifestPath(projectDir);
  return withLock(file, async () => {
    let toWrite = manifest;
    const base = loadedSnapshots.get(manifest);
    if (base && existsSync(file)) {
      try {
        const theirs = JSON.parse(await readFile(file, "utf8"));
        toWrite = mergeValue(base, manifest, theirs);
      } catch {
        // Unreadable disk copy: our version is the best one left.
      }
    }
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(toWrite, null, 2)}\n`);
    await rename(tmp, file);
    // Future saves of this same object should merge against what we know now.
    loadedSnapshots.set(manifest, structuredClone(manifest));
    return file;
  });
}

/**
 * Read-modify-write a manifest in one call.
 * `mutate` receives the manifest and may edit it in place or return a new one.
 */
export async function update(projectDir, mutate) {
  const manifest = await load(projectDir);
  const next = (await mutate(manifest)) || manifest;
  await save(projectDir, next);
  return next;
}

export function getScene(manifest, id) {
  const scene = manifest.timeline.find((s) => s.id === id);
  if (!scene) throw new Error(`No scene "${id}" in the timeline.`);
  return scene;
}

/** Merge fields into one scene and return the manifest (does not save). */
export function patchScene(manifest, id, patch) {
  const scene = getScene(manifest, id);
  Object.assign(scene, patch);
  return manifest;
}

/**
 * Validate a manifest. Returns { ok, errors[], warnings[] }.
 * Errors block a render; warnings are things a human should look at.
 */
export function validate(manifest) {
  const errors = [];
  const warnings = [];
  const push = (arr, msg) => arr.push(msg);

  if (manifest?.version !== 1) push(errors, `unsupported manifest version: ${manifest?.version}`);
  if (!manifest?.slug) push(errors, "missing slug");

  const fmt = manifest?.format || {};
  if (!fmt.width || !fmt.height || !fmt.fps) push(errors, "format needs width, height and fps");
  if (fmt.width % 2 || fmt.height % 2) push(errors, "format width/height must be even (h264 requirement)");

  const mode = manifest?.presenter?.mode;
  if (mode && !PRESENTER_MODES.includes(mode)) {
    push(errors, `presenter.mode must be one of ${PRESENTER_MODES.join(" | ")}, got "${mode}"`);
  }

  const provider = manifest?.voice?.provider;
  if (provider && !VOICE_PROVIDERS.includes(provider)) {
    push(errors, `voice.provider must be one of ${VOICE_PROVIDERS.join(" | ")}, got "${provider}"`);
  }
  if (provider === "elevenlabs" && !manifest?.voice?.voiceId) {
    push(errors, 'voice.provider is "elevenlabs" but voice.voiceId is missing — run gen/voice-design.mjs');
  }

  const timeline = manifest?.timeline;
  if (!Array.isArray(timeline) || timeline.length === 0) {
    push(errors, "timeline is empty — nothing to render");
    return { ok: false, errors, warnings };
  }

  const seen = new Set();
  for (const [i, scene] of timeline.entries()) {
    const at = `timeline[${i}]${scene?.id ? ` (${scene.id})` : ""}`;
    if (!scene?.id) push(errors, `${at}: missing id`);
    else if (seen.has(scene.id)) push(errors, `${at}: duplicate scene id "${scene.id}"`);
    else seen.add(scene.id);

    if (!SCENE_KINDS.includes(scene?.kind)) {
      push(errors, `${at}: kind must be one of ${SCENE_KINDS.join(" | ")}, got "${scene?.kind}"`);
      continue;
    }

    // A scene needs either a duration or an audio track we can measure one from.
    if (!scene.durationSec && !scene.audio) {
      push(errors, `${at}: needs durationSec or an audio track to derive it from`);
    }
    if (scene.durationSec != null && !(scene.durationSec > 0)) {
      push(errors, `${at}: durationSec must be positive`);
    }

    if (scene.kind === "demo") {
      if (!CAPTURE_TARGETS.includes(scene.target)) {
        push(errors, `${at}: target must be one of ${CAPTURE_TARGETS.join(" | ")}`);
      }
      if (!scene.actions && !scene.video) {
        push(errors, `${at}: needs an actions file to perform, or an already-recorded video`);
      }
    }
    if (scene.kind === "broll" && !scene.prompt && !scene.video) {
      push(errors, `${at}: needs a prompt to generate from, or an existing video`);
    }
    if (scene.kind === "presenter" && mode === "none") {
      push(warnings, `${at}: presenter scene while presenter.mode is "none" — it will render as a card`);
    }
    if (scene.narration && !scene.audio) {
      push(warnings, `${at}: has narration but no generated audio yet — run gen/tts.mjs`);
    }
  }

  for (const t of manifest.transitions || []) {
    if (t.after && !seen.has(t.after)) push(errors, `transition references unknown scene "${t.after}"`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Which artifacts are still missing, so the orchestrator can report real progress
 * instead of guessing. Returns a list of { sceneId, needs[] }.
 */
export function pending(projectDir, manifest) {
  const out = [];
  for (const scene of manifest.timeline || []) {
    const needs = [];
    const has = (rel) => rel && existsSync(resolveIn(projectDir, rel));

    if (scene.narration && !has(scene.audio)) needs.push("audio");
    if (scene.kind === "demo" && !has(scene.actions)) needs.push("actions");
    if (scene.kind !== "card" && !has(scene.video)) needs.push("video");
    if (needs.length) out.push({ sceneId: scene.id, kind: scene.kind, needs });
  }
  return out;
}

/** Total runtime in seconds from scene durations (transitions overlap, so they don't add). */
export function totalDuration(manifest) {
  return (manifest.timeline || []).reduce((sum, s) => sum + (s.durationSec || 0), 0);
}
