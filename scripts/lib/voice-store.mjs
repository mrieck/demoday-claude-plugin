/**
 * Global cache of designed ElevenLabs voices: sha256(description) -> voice_id.
 *
 * Why GLOBAL and not <project>/.cache.json: a designed voice lives on the
 * ElevenLabs ACCOUNT, occupies one of a small quota of voice slots, and costs
 * design credits to create. Re-describing the same character in a second
 * project (or a v2 of the same video) should reuse the account voice, not burn
 * another slot — so the mapping lives beside config.json in
 * ~/.config/demoday/, which survives plugin updates.
 *
 * Entries can go stale (the voice deleted on the account, or from another
 * machine) — callers verify with elevenlabs.getVoice() before trusting a hit
 * and evict with removeVoice() on a 404.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { configPath } from "./env.mjs";

export function storePath() {
  return path.join(path.dirname(configPath()), "voices.json");
}

/** Cache key: the description, whitespace-trimmed and case-folded. */
export function descriptionKey(description) {
  return createHash("sha256")
    .update(String(description).trim().toLowerCase())
    .digest("hex")
    .slice(0, 32);
}

async function readStore() {
  const file = storePath();
  if (!existsSync(file)) return { version: 1, voices: {} };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed?.voices ? parsed : { version: 1, voices: {} };
  } catch {
    // A corrupt store must never break a run — worst case a voice is re-designed.
    return { version: 1, voices: {} };
  }
}

async function writeStore(store) {
  const file = storePath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`);
  await rename(tmp, file);
}

/** The cached voice for a description, or null. */
export async function findVoice(description) {
  const store = await readStore();
  return store.voices[descriptionKey(description)] || null;
}

/** Remember a designed voice so the same description never designs twice. */
export async function recordVoice({ description, voiceId, name }) {
  const store = await readStore();
  store.voices[descriptionKey(description)] = {
    voiceId,
    name,
    description: String(description).trim(),
    createdAt: new Date().toISOString(),
  };
  await writeStore(store);
}

/** Every cached voice — for `voice-design.mjs --list`. */
export async function listVoicesCached() {
  const store = await readStore();
  return Object.values(store.voices);
}

/** Drop every entry pointing at a voice_id (cleanup + stale-hit eviction). */
export async function removeVoice(voiceId) {
  const store = await readStore();
  let removed = 0;
  for (const [k, v] of Object.entries(store.voices)) {
    if (v.voiceId === voiceId) {
      delete store.voices[k];
      removed++;
    }
  }
  if (removed) await writeStore(store);
  return removed;
}
