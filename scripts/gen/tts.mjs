#!/usr/bin/env node
/**
 * Narration — the first thing generated, and the clock everything else runs on.
 *
 *   node scripts/gen/tts.mjs --project demo/<slug> --all
 *   node scripts/gen/tts.mjs --project demo/<slug> --scene intro
 *   node scripts/gen/tts.mjs --text "Hello there" --out demo/<slug>/audio/test.mp3
 *
 * Why audio first: once a line is spoken we know exactly how long it takes, so the
 * screen capture can be paced to it and the presenter can be lip-synced to it.
 * Generating video first and trying to fit narration afterwards is how demos end
 * up with rushed voiceover or dead air.
 *
 * ONE VOICE for the whole video. The same audio that plays as background narration
 * over the screen segments is the audio the on-camera presenter is animated to, so
 * the narrator and the presenter are audibly the same person. That is why the voice
 * lives on the manifest rather than being a per-call argument.
 *
 * `timestamps: true` returns word-level timings, which drive two things downstream:
 * captions, and pinning a click to the exact moment its word is spoken.
 *
 * Two providers, one output shape. The default is fal.ai with a stock voice name.
 * When the manifest says `voice.provider: "elevenlabs"`, the line is spoken by a
 * DESIGNED character voice (see gen/voice-design.mjs) through the ElevenLabs API
 * directly — same mp3 + .words.json artifacts, so nothing downstream cares.
 */
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { parseArgs, boolArg } from "../lib/args.mjs";
import { submitAndWait, extractUrl, download } from "../lib/fal.mjs";
import {
  hasElevenLabs,
  ttsWithTimestamps,
  TTS_MODEL as ELEVEN_MODEL,
  TTS_FALLBACK_MODEL as ELEVEN_FALLBACK_MODEL,
} from "../lib/elevenlabs.mjs";
import { removeVoice } from "../lib/voice-store.mjs";
import { probe } from "../lib/ff.mjs";
import * as manifest from "../lib/manifest.mjs";
import * as cache from "../lib/cache.mjs";
import { sceneDuration, gapAfter } from "../lib/pacing.mjs";
import { report, info, warn, main, fmtDuration } from "../lib/log.mjs";

const USAGE =
  "tts.mjs (--project <dir> [--manifest <file>] (--all | --scene <id>)) | (--text <str> --out <file.mp3>) " +
  "[--voice Rachel] [--model fal-ai/elevenlabs/tts/eleven-v3] [--force] " +
  "[--provider fal|elevenlabs] [--voice-id <id>]   (elevenlabs = designed character voice, " +
  "see gen/voice-design.mjs)";

const DEFAULT_MODEL = "fal-ai/elevenlabs/tts/eleven-v3";

/**
 * Normalise fal's timestamp payload to WORDS: [{ text, startSec, endSec }].
 *
 * ElevenLabs on fal returns CHARACTER-level timings, grouped into chunks:
 *
 *   [{ characters: ["T","e","s","t"," ","o","n","e"],
 *      character_start_times_seconds: [0, 0.07, 0.14, ...],
 *      character_end_times_seconds:   [0.07, 0.14, ...] }, ...]
 *
 * Everything downstream — captions, and pinning a click to a spoken word — wants
 * words, so the character stream is flattened across chunks and split on
 * whitespace. A word's start is its first character's start and its end is its
 * last character's end.
 *
 * A per-word shape is also accepted, in case another model returns one; getting
 * this wrong produces no captions rather than an error, so both are handled
 * explicitly instead of assumed.
 */
export function normalizeTimestamps(raw) {
  const list = Array.isArray(raw) ? raw : raw?.timestamps || raw?.words || [];
  if (!list.length) return [];

  const isCharacterChunks = list.some((t) => Array.isArray(t?.characters));

  if (!isCharacterChunks) {
    return list
      .map((t) => ({
        text: String(t.text ?? t.word ?? "").trim(),
        startSec: Number(t.start ?? t.start_time ?? t.startTime ?? 0),
        endSec: Number(t.end ?? t.end_time ?? t.endTime ?? 0),
      }))
      .filter((t) => t.text);
  }

  // Flatten every chunk into one character stream.
  const chars = [];
  for (const chunk of list) {
    const cs = chunk?.characters || [];
    const starts = chunk?.character_start_times_seconds || [];
    const ends = chunk?.character_end_times_seconds || [];
    for (let i = 0; i < cs.length; i++) {
      chars.push({ ch: cs[i], start: Number(starts[i] ?? 0), end: Number(ends[i] ?? starts[i] ?? 0) });
    }
  }

  const words = [];
  let current = null;
  for (const c of chars) {
    if (/\s/.test(c.ch)) {
      if (current) { words.push(current); current = null; }
      continue;
    }
    if (!current) current = { text: c.ch, startSec: c.start, endSec: c.end };
    else { current.text += c.ch; current.endSec = c.end; }
  }
  if (current) words.push(current);

  return words.filter((w) => w.text.trim());
}

/**
 * ElevenLabs direct call with the v3 -> multilingual_v2 fallback.
 *
 * eleven_v3's support on the /with-timestamps endpoint is not guaranteed; if the
 * API rejects the request (4xx that is not auth/quota/slot), the line is retried
 * once on multilingual_v2 rather than losing the whole run. A 404 means the
 * designed voice was deleted on the account, so the stale cache entry is evicted
 * and the remediation is a re-design, not a retry.
 */
async function elevenSpeak({ voiceId, text, modelId, stability, speed }) {
  try {
    const r = await ttsWithTimestamps({ voiceId, text, modelId, stability, speed });
    return { ...r, modelId };
  } catch (e) {
    if (e.httpStatus === 404 || e.apiStatus === "voice_not_found") {
      await removeVoice(voiceId);
      throw new Error(
        `ElevenLabs voice ${voiceId} no longer exists on the account — ` +
          "design it again: node scripts/gen/voice-design.mjs --project <dir> --describe \"...\""
      );
    }
    const retryable =
      modelId === ELEVEN_MODEL &&
      (e.httpStatus === 400 || e.httpStatus === 422) &&
      !["quota_exceeded", "voice_limit_reached"].includes(e.apiStatus);
    if (retryable) {
      warn(`${modelId} was rejected on the timestamps endpoint — falling back to ${ELEVEN_FALLBACK_MODEL}`);
      const r = await ttsWithTimestamps({
        voiceId, text, modelId: ELEVEN_FALLBACK_MODEL, stability, speed,
      });
      return { ...r, modelId: ELEVEN_FALLBACK_MODEL };
    }
    throw e;
  }
}

/**
 * Generate one narration line. Returns { audio, words, durationSec, cached }.
 * Cached on the exact text + voice + model, so re-running after editing a single
 * line only re-synthesises that line.
 *
 * provider "fal" (default) speaks with a stock voice name via fal.ai;
 * provider "elevenlabs" speaks with a designed voice_id via the direct API
 * (model is then an ElevenLabs model id like "eleven_v3", not a fal endpoint).
 */
export async function speak({
  projectDir,
  text,
  outFile,
  voice = "Rachel",
  model = DEFAULT_MODEL,
  stability,
  speed,
  force = false,
  provider = "fal",
  voiceId = null,
}) {
  const input = { text, voice, timestamps: true };
  if (stability != null) input.stability = Number(stability);
  if (speed != null) input.speed = Number(speed);

  // provider/voiceId only enter the cache key on the elevenlabs path, so every
  // fal key stays byte-identical to before this feature existed — existing
  // project caches keep their hits.
  const cacheParams = provider === "elevenlabs" ? { text, provider, voiceId, stability: input.stability, speed: input.speed } : input;

  // The words file sits next to the audio and is regenerated with it.
  const wordsFile = outFile.replace(/\.[^.]+$/, ".words.json");
  let words = [];

  const result = await cache.memo(
    projectDir || path.dirname(outFile),
    { kind: "tts", model, params: cacheParams },
    async () => {
      let modelUsed = model;
      if (provider === "elevenlabs") {
        if (!voiceId) throw new Error("provider elevenlabs needs a voiceId — run gen/voice-design.mjs first");
        const r = await elevenSpeak({ voiceId, text, modelId: model, stability, speed });
        await mkdir(path.dirname(outFile), { recursive: true });
        await writeFile(outFile, Buffer.from(r.audioBase64, "base64"));
        // The direct API returns ONE alignment chunk in the exact character
        // shape normalizeTimestamps flattens — wrap it in an array and reuse.
        words = normalizeTimestamps(r.alignment ? [r.alignment] : []);
        modelUsed = r.modelId;
      } else {
        const data = await submitAndWait(model, input);
        const url = extractUrl(data);
        if (!url) throw new Error(`${model} returned no audio URL`);
        await download(url, outFile);
        words = normalizeTimestamps(data.timestamps);
      }

      if (!words.length) {
        warn(
          "no word timestamps came back — captions and word-pinned steps will be " +
          "unavailable for this line."
        );
      }
      await writeFile(
        wordsFile,
        `${JSON.stringify(
          {
            text,
            voice: provider === "elevenlabs" ? voiceId : voice,
            model: modelUsed,
            ...(provider === "elevenlabs" ? { provider } : {}),
            timestamps: words,
          },
          null,
          2
        )}\n`
      );
      return outFile;
    },
    { force }
  );

  // On a cache hit the words file is already on disk from the original run.
  if (result.cached) {
    try {
      const { readFile } = await import("node:fs/promises");
      words = JSON.parse(await readFile(wordsFile, "utf8")).timestamps || [];
    } catch {
      words = [];
    }
  }

  const meta = await probe(result.path).catch(() => null);
  return {
    audio: result.path,
    words: wordsFile,
    wordCount: words.length,
    durationSec: meta?.duration ?? null,
    cached: result.cached,
  };
}

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const force = boolArg(args.force, false);

  // ---- one-off mode (no manifest) ----
  if (args.text && args.out) {
    const provider = args.provider || "fal";
    const out = path.resolve(args.out);
    await mkdir(path.dirname(out), { recursive: true });
    const r = await speak({
      text: args.text,
      outFile: out,
      voice: args.voice || "Rachel",
      model: args.model || (provider === "elevenlabs" ? ELEVEN_MODEL : DEFAULT_MODEL),
      stability: args.stability,
      speed: args.speed,
      force,
      provider,
      voiceId: args["voice-id"] || null,
    });
    return report(
      `  ${r.cached ? "cached" : "generated"} ${fmtDuration(r.durationSec)} -> ${r.audio}`,
      { ok: true, ...r }
    );
  }

  // ---- manifest mode ----
  const projectDir = manifest.resolveProjectDir(args.project);
  const name = args.manifest || manifest.MANIFEST_NAME;
  const m = await manifest.load(projectDir, { name });
  const provider = args.provider || m.voice?.provider || "fal";
  const voice = args.voice || m.voice?.voice || "Rachel";

  // On the elevenlabs path the model is a bare ElevenLabs id; a leftover fal
  // endpoint string in the manifest (hand-edited provider) must not leak through.
  let model = args.model || m.voice?.model;
  if (provider === "elevenlabs" && (!model || model.startsWith("fal-ai/"))) model = ELEVEN_MODEL;
  if (!model) model = DEFAULT_MODEL;

  let voiceId = null;
  if (provider === "elevenlabs") {
    if (!hasElevenLabs()) {
      throw new Error(
        'voice.provider is "elevenlabs" but ELEVENLABS_API_KEY is not set — ' +
          'set the key (see README) or switch voice.provider to "fal"'
      );
    }
    voiceId = args["voice-id"] || m.voice?.voiceId;
    if (!voiceId) {
      throw new Error(
        'voice.provider is "elevenlabs" but there is no voice.voiceId — design one first: ' +
          `node scripts/gen/voice-design.mjs --project ${args.project || "demo"} --describe "..."`
      );
    }
  }

  const scenes = args.all
    ? m.timeline.filter((s) => s.narration)
    : [manifest.getScene(m, args.scene)];

  if (!scenes.length) {
    return report("  nothing to narrate", { ok: true, generated: 0, scenes: [] });
  }

  const out = [];
  for (const scene of scenes) {
    if (!scene.narration) {
      warn(`scene "${scene.id}" has no narration — skipping`);
      continue;
    }
    const audioRel = scene.audio || path.join("audio", `${scene.id}.mp3`);
    const audioAbs = manifest.resolveIn(projectDir, audioRel);
    await mkdir(path.dirname(audioAbs), { recursive: true });

    info(`  ${scene.id}: "${scene.narration.slice(0, 60)}${scene.narration.length > 60 ? "…" : ""}"`);
    const r = await speak({
      projectDir,
      text: scene.narration,
      outFile: audioAbs,
      voice,
      model,
      stability: m.voice?.stability,
      speed: m.voice?.speed,
      force,
      provider,
      voiceId,
    });

    // The manifest is the source of truth. Two DIFFERENT numbers get recorded:
    //
    //   narrationSec — how long the voice actually speaks
    //   durationSec  — how long the SCENE runs, which must be longer, or the next
    //                  line starts underneath this one during the transition
    //
    // durationSec is also what the capture runner is paced to, so the extra tail
    // becomes a deliberate hold on the final state rather than dead air.
    scene.audio = manifest.relativeIn(projectDir, r.audio);
    scene.words = manifest.relativeIn(projectDir, r.words);
    scene.narrationSec = r.durationSec ?? scene.narrationSec;
    scene.durationSec = sceneDuration(m, scene, scene.narrationSec);

    info(
      `    ${r.cached ? "cached" : "generated"} ${fmtDuration(r.narrationSec ?? r.durationSec)} speech, ` +
      `scene ${fmtDuration(scene.durationSec)}, ${r.wordCount} word timings`
    );
    out.push({ scene: scene.id, ...r });
  }

  await manifest.save(projectDir, m, { name });

  // Prove the invariant held for every scene rather than trusting the arithmetic.
  for (const scene of m.timeline) {
    const gap = gapAfter(m, scene);
    if (gap != null && gap < 0.15) {
      warn(`scene "${scene.id}" leaves only ${gap.toFixed(2)}s before the next line — raise pacing.breathSec`);
    }
  }

  const total = out.reduce((s, r) => s + (r.durationSec || 0), 0);
  const voiceLabel = provider === "elevenlabs" ? (m.voice?.voiceName || voiceId) : voice;
  report(
    `  narrated ${out.length} scene(s), ${fmtDuration(total)} total (voice: ${voiceLabel})`,
    { ok: true, provider, voice: voiceLabel, model, totalSec: total, scenes: out }
  );
});
