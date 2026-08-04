/**
 * Content-addressed artifact cache.
 *
 * fal video generation is the dominant cost of a demo video, and the workflow is
 * inherently iterative — fix one line of narration, re-render, look again. Without
 * this, every re-run re-spends on all the scenes that did not change.
 *
 * The key is a SHA-256 of everything that determines the output: the model, the
 * full input params, and the *content* of any local input files (hashed, not path-
 * named, so editing a source image correctly busts the key). If the key matches and
 * the recorded output file still exists, we skip the call.
 *
 * Stored in <project>/.cache.json. Safe to delete — it only ever costs money to
 * rebuild, never correctness.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveIn, relativeIn } from "./manifest.mjs";

const CACHE_NAME = ".cache.json";

function cachePath(projectDir) {
  return path.join(projectDir, CACHE_NAME);
}

async function readCache(projectDir) {
  const file = cachePath(projectDir);
  if (!existsSync(file)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed?.entries ? parsed : { version: 1, entries: {} };
  } catch {
    // A corrupt cache must never break a run — worst case we regenerate.
    return { version: 1, entries: {} };
  }
}

async function writeCache(projectDir, cache) {
  const file = cachePath(projectDir);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`);
  await rename(tmp, file);
}

/** SHA-256 of a file's contents, or a marker if it is unreadable. */
export async function hashFile(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch {
    return "missing";
  }
}

/**
 * Build a cache key.
 *
 * `files` are local inputs whose *contents* participate in the key — pass the
 * presenter image, the narration audio, anything that would change the output.
 * Object keys are sorted so that param ordering never produces a spurious miss.
 */
export async function key({ kind, model = null, params = {}, files = [] }) {
  const fileHashes = [];
  for (const f of files.filter(Boolean)) {
    fileHashes.push(`${path.basename(f)}:${await hashFile(f)}`);
  }
  const payload = JSON.stringify(
    { kind, model, params: sortDeep(params), files: fileHashes.sort() }
  );
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, sortDeep(value[k])])
    );
  }
  return value;
}

/**
 * Look up a cached artifact. Returns the manifest-relative output path on a hit,
 * or null. A recorded entry whose file has since been deleted counts as a miss.
 */
export async function lookup(projectDir, cacheKey) {
  const cache = await readCache(projectDir);
  const entry = cache.entries[cacheKey];
  if (!entry) return null;
  const abs = resolveIn(projectDir, entry.output);
  if (!abs || !existsSync(abs)) return null;
  return entry;
}

/** Record a produced artifact under `cacheKey`. */
export async function record(projectDir, cacheKey, outputPath, meta = {}) {
  const cache = await readCache(projectDir);
  const abs = path.resolve(outputPath);
  let bytes = null;
  try {
    bytes = (await stat(abs)).size;
  } catch {
    /* size is informational only */
  }
  cache.entries[cacheKey] = {
    output: relativeIn(projectDir, abs),
    bytes,
    ...meta,
  };
  await writeCache(projectDir, cache);
  return cache.entries[cacheKey];
}

/**
 * The whole pattern in one call: return the cached artifact if the inputs are
 * unchanged, otherwise run `produce()` and record what it made.
 *
 *   const { path, cached } = await memo(projectDir,
 *     { kind: "tts", model, params: { text, voice } },
 *     () => generate());
 *
 * `produce` must resolve to the absolute path of the file it created.
 * Pass `{ force: true }` to regenerate regardless — used by `--force` flags.
 */
export async function memo(projectDir, spec, produce, { force = false } = {}) {
  const cacheKey = await key(spec);
  if (!force) {
    const hit = await lookup(projectDir, cacheKey);
    if (hit) {
      return { path: resolveIn(projectDir, hit.output), cached: true, key: cacheKey, meta: hit };
    }
  }
  const produced = await produce();
  const meta = await record(projectDir, cacheKey, produced, {
    kind: spec.kind,
    model: spec.model ?? null,
  });
  return { path: path.resolve(produced), cached: false, key: cacheKey, meta };
}

/** Drop entries by kind (or all) — backs a `--clear-cache` flag. */
export async function clear(projectDir, kind = null) {
  const cache = await readCache(projectDir);
  let removed = 0;
  for (const [k, entry] of Object.entries(cache.entries)) {
    if (!kind || entry.kind === kind) {
      delete cache.entries[k];
      removed++;
    }
  }
  await writeCache(projectDir, cache);
  return removed;
}
