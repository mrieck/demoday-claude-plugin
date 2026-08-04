/**
 * fal.ai client helpers shared by all generation scripts.
 *
 * `submitAndWait` BLOCKS until the job is done and returns the result data —
 * no submit/sleep/poll loop, because these run as plain local CLI processes.
 *
 * Ported from ai-video-maker-plugin with the upload cache renamed. Every fal
 * call in this plugin goes through here so credentials, progress reporting and
 * the content-hash upload cache behave identically everywhere.
 */
import { fal } from "@fal-ai/client";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadDotenv } from "./env.mjs";

loadDotenv();

let initialized = false;

/** Configure the fal client from FAL_API_KEY, or hard-fail with a clear message. */
export function initFal() {
  if (initialized) return fal;
  const key = process.env.FAL_API_KEY;
  if (!key) {
    console.error(
      "Error: FAL_API_KEY is not set.\n" +
        "  Set it in your environment (export FAL_API_KEY=...) or a .env file.\n" +
        "  Get a key at https://fal.ai/dashboard/keys"
    );
    process.exit(1);
  }
  fal.config({ credentials: key });
  initialized = true;
  return fal;
}

/**
 * Submit a job and wait for the result. Returns the `data` object.
 * Logs fal queue progress to stderr so long video jobs show life.
 */
export async function submitAndWait(endpoint, input) {
  const client = initFal();
  const result = await client.subscribe(endpoint, {
    input,
    logs: false,
    onQueueUpdate: (update) => {
      if (update.status === "IN_PROGRESS" || update.status === "IN_QUEUE") {
        process.stderr.write(`  [fal] ${endpoint}: ${update.status}\r`);
      }
    },
  });
  process.stderr.write("\n");
  return result.data;
}

/** Pull the first usable media URL out of a fal result, matching the actor's logic. */
export function extractUrl(data) {
  return (
    data?.video?.url ||
    data?.images?.[0]?.url ||
    data?.image?.url ||
    data?.audio?.url ||
    null
  );
}

/**
 * Download a URL to a local path, creating parent dirs. Returns the absolute path.
 *
 * Retries on transient failures. The generation itself has already been paid for
 * by the time we get here, so losing the result to a momentary network blip is
 * the most expensive possible way to fail — and `fetch` rejecting with a bare
 * "fetch failed" is common enough against media CDNs to be worth handling.
 */
export async function download(url, outPath, { retries = 3 } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        // 4xx means the URL is wrong or expired; retrying will not help.
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`Download failed ${res.status} for ${url}`);
        }
        throw new Error(`Download failed ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const abs = path.resolve(outPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, buf);
      return abs;
    } catch (e) {
      lastError = e;
      if (/failed 4\d\d/.test(e.message) || attempt === retries) break;
      const backoffMs = 800 * attempt;
      process.stderr.write(`  [fal] download attempt ${attempt} failed, retrying in ${backoffMs}ms\n`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw new Error(`Download failed after ${retries} attempts for ${url}: ${lastError?.message}`);
}

/**
 * Upload a local file to fal storage and return a URL.
 * fal edit/video endpoints require URLs, so any local --image must be uploaded first.
 * Results are cached by content hash for the session to avoid re-uploading the same asset.
 */
const uploadCache = new Map(); // sha256 -> url
const uploadCacheFile = path.join(os.tmpdir(), "demoday-uploads.json");

async function loadDiskCache() {
  if (uploadCache.size > 0) return;
  try {
    if (existsSync(uploadCacheFile)) {
      const obj = JSON.parse(await readFile(uploadCacheFile, "utf8"));
      for (const [k, v] of Object.entries(obj)) uploadCache.set(k, v);
    }
  } catch {
    /* ignore corrupt cache */
  }
}

async function saveDiskCache() {
  try {
    const obj = Object.fromEntries(uploadCache);
    await writeFile(uploadCacheFile, JSON.stringify(obj));
  } catch {
    /* best effort */
  }
}

/** If `ref` is already an http(s) URL, return it unchanged; otherwise upload the local file. */
export async function toUrl(ref) {
  if (/^https?:\/\//i.test(ref)) return ref;
  return uploadLocal(ref);
}

export async function uploadLocal(filePath) {
  const abs = path.resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`Local file not found: ${abs}`);
  }
  const bytes = await readFile(abs);
  const hash = createHash("sha256").update(bytes).digest("hex");

  await loadDiskCache();
  if (uploadCache.has(hash)) return uploadCache.get(hash);

  const client = initFal();
  const file = new File([bytes], path.basename(abs), {
    type: guessMime(abs),
  });
  const url = await client.storage.upload(file);
  uploadCache.set(hash, url);
  await saveDiskCache();
  return url;
}

function guessMime(p) {
  const ext = path.extname(p).toLowerCase();
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".m4a": "audio/mp4",
    }[ext] || "application/octet-stream"
  );
}

/** Print a JSON line to stdout (machine-readable) plus a human summary to stderr. */
export function report(summary, obj) {
  console.error(summary);
  console.log(JSON.stringify(obj));
}
