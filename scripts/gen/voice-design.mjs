#!/usr/bin/env node
/**
 * Character voice design — describe a voice in prose, get a reusable voice_id.
 *
 *   node scripts/gen/voice-design.mjs --project demo/<slug> --describe "Weathered New England
 *     lobster-boat captain, gravelly, thick coastal Maine accent" [--name "Captain"]
 *   node scripts/gen/voice-design.mjs --project demo/<slug> --describe "..." --audition
 *   node scripts/gen/voice-design.mjs --project demo/<slug> --pick 2
 *   node scripts/gen/voice-design.mjs --project demo/<slug> --use <voice_id>
 *   node scripts/gen/voice-design.mjs --list
 *   node scripts/gen/voice-design.mjs --delete <voice_id> [--force]
 *
 * OPTIONAL FEATURE — requires ELEVENLABS_API_KEY (see doctor.mjs). The default
 * narration path (fal.ai stock voices) does not touch this file.
 *
 * The flow ElevenLabs imposes: a description generates ~3 EPHEMERAL previews;
 * one must be persisted to become a permanent voice_id. `--describe` therefore
 * auto-accepts the first preview in the same run (the workflow's default), but
 * writes every preview to <project>/audio/voice-previews/ so a human can listen
 * (afplay) and switch with `--pick N` while the preview ids are still fresh.
 * `--audition` designs WITHOUT accepting, for a listen-first flow.
 *
 * Designed voices occupy quota'd account slots and cost design credits, so
 * identical descriptions are reused via the global voice store (zero spend) and
 * `--delete` frees a slot when a character is done with.
 */
import path from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs, boolArg, fail } from "../lib/args.mjs";
import * as manifest from "../lib/manifest.mjs";
import * as store from "../lib/voice-store.mjs";
import {
  initElevenLabs,
  designPreviews,
  createVoiceFromPreview,
  listVoices,
  getVoice,
  deleteVoice,
  TTS_MODEL,
} from "../lib/elevenlabs.mjs";
import { report, info, warn, main } from "../lib/log.mjs";

const USAGE =
  "voice-design.mjs --project <dir> --describe <text> [--name <str>] [--sample-text <str>] [--audition] | " +
  "--project <dir> --pick <1|2|3> [--name <str>] | --project <dir> --use <voice_id> | " +
  "--list | --delete <voice_id> [--force]";

const STATE_NAME = ".voice-previews.json";
const PREVIEW_DIR = path.join("audio", "voice-previews");

/** Previews expire quickly server-side; past this age a pick is likely to fail. */
const STALE_AFTER_MS = 10 * 60 * 1000;

function statePath(projectDir) {
  return path.join(projectDir, STATE_NAME);
}

async function readState(projectDir) {
  const file = statePath(projectDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Default account name: explicit --name, else the description's opening words. */
function voiceName(args, description) {
  if (args.name && args.name !== true) return String(args.name);
  const words = String(description).trim().replace(/\s+/g, " ");
  return words.length <= 40 ? words : `${words.slice(0, 37)}…`;
}

/**
 * Point the manifest's voice block at an ElevenLabs voice. Narration model is
 * the direct-API model id (eleven_v3), NOT a fal endpoint — tts.mjs branches on
 * provider. stability/speed carry over so tuning survives a voice swap.
 */
async function adoptVoice(projectDir, { voiceId, name, description }) {
  return manifest.update(projectDir, (m) => {
    const prev = m.voice || {};
    m.voice = {
      provider: "elevenlabs",
      model: prev.provider === "elevenlabs" && prev.model ? prev.model : TTS_MODEL,
      voiceId,
      voiceName: name,
      designPrompt: description || null,
      stability: prev.stability ?? 0.4,
      speed: prev.speed ?? 1.0,
    };
  });
}

/** Persist preview N (1-based), cache it, and adopt it in the manifest. */
async function acceptPreview(projectDir, state, n, name) {
  const preview = state.previews[n - 1];
  if (!preview) fail(`no preview #${n} — previews run 1-${state.previews.length}`, USAGE);

  // Re-picking the preview that was already persisted must not create a twin.
  if (state.accepted?.index === n) {
    await adoptVoice(projectDir, {
      voiceId: state.accepted.voiceId,
      name: state.accepted.name,
      description: state.description,
    });
    return { voiceId: state.accepted.voiceId, name: state.accepted.name, alreadyPersisted: true };
  }

  const ageMs = Date.now() - Date.parse(state.createdAt || 0);
  if (ageMs > STALE_AFTER_MS) {
    warn(
      `these previews are ${Math.round(ageMs / 60000)} min old — preview ids are ephemeral, ` +
        "so this may fail; if it does, re-run --describe"
    );
  }

  const { voiceId } = await createVoiceFromPreview({
    generatedVoiceId: preview.generatedVoiceId,
    name,
    description: state.description,
  });
  await store.recordVoice({ description: state.description, voiceId, name });
  await adoptVoice(projectDir, { voiceId, name, description: state.description });
  return { voiceId, name, alreadyPersisted: false };
}

/** First scene narration >= 100 chars, so previews audition with the real script. */
function defaultSampleText(m) {
  for (const scene of m?.timeline || []) {
    const text = String(scene?.narration || "").trim();
    if (text.length >= 100) return text;
  }
  return null;
}

await main(async () => {
  const args = parseArgs(process.argv.slice(2));

  // ---- account-level modes (no project) ------------------------------------
  if (args.list) {
    initElevenLabs();
    const [live, cached] = await Promise.all([listVoices(), store.listVoicesCached()]);
    const liveIds = new Set(live.map((v) => v.voiceId));
    const byId = new Map(cached.map((c) => [c.voiceId, c]));

    info("");
    info("  account voices (custom slots are quota-limited; premade voices are not):");
    for (const v of live) {
      const c = byId.get(v.voiceId);
      info(`    ${v.voiceId}  [${v.category || "?"}]  ${v.name}${c ? `  — designed: "${c.description.slice(0, 50)}"` : ""}`);
    }
    const stale = cached.filter((c) => !liveIds.has(c.voiceId));
    for (const c of stale) {
      info(`    ${c.voiceId}  [stale — no longer on the account]  ${c.name}`);
    }
    info("");
    return report(`  ${live.length} voice(s) on the account, ${cached.length} in the design cache`, {
      ok: true,
      voices: live.map((v) => ({ ...v, designPrompt: byId.get(v.voiceId)?.description || null })),
      staleCached: stale.map((c) => c.voiceId),
    });
  }

  if (args.delete) {
    const voiceId = args.delete;
    if (voiceId === true) fail("--delete needs a voice_id", USAGE);
    initElevenLabs();

    // Refuse to delete the voice the current project narrates with, unless forced.
    const projectDir = manifest.resolveProjectDir(args.project);
    if (!boolArg(args.force, false) && existsSync(manifest.manifestPath(projectDir))) {
      const m = await manifest.load(projectDir);
      if (m.voice?.voiceId === voiceId) {
        fail(
          `voice ${voiceId} is the current voice of ${manifest.manifestPath(projectDir)} — ` +
            "pass --force to delete it anyway"
        );
      }
    }

    await deleteVoice(voiceId);
    const evicted = await store.removeVoice(voiceId);
    return report(`  deleted ${voiceId} (freed one voice slot)`, { ok: true, voiceId, evictedCacheEntries: evicted });
  }

  // ---- project modes -------------------------------------------------------
  const projectDir = manifest.resolveProjectDir(args.project);

  if (args.use) {
    if (args.use === true) fail("--use needs a voice_id", USAGE);
    initElevenLabs();
    const v = await getVoice(args.use);
    if (!v) fail(`no voice ${args.use} on this ElevenLabs account — check --list`);
    await adoptVoice(projectDir, { voiceId: v.voiceId, name: v.name, description: null });
    return report(`  using existing voice "${v.name}" (${v.voiceId}) — no design spend`, {
      ok: true, voiceId: v.voiceId, name: v.name, reused: true,
    });
  }

  if (args.pick) {
    const n = Number(args.pick);
    if (!Number.isInteger(n) || n < 1) fail("--pick needs a preview number (1, 2, 3)", USAGE);
    const state = await readState(projectDir);
    if (!state) {
      fail("no pending previews — previews are ephemeral, re-run --describe first");
    }
    initElevenLabs();
    const name = voiceName(args, state.description);
    const picked = await acceptPreview(projectDir, state, n, name);

    // The decision is final: clear the previews and the state file.
    await rm(statePath(projectDir), { force: true });
    await rm(path.join(projectDir, PREVIEW_DIR), { recursive: true, force: true });

    const replaced =
      state.accepted && state.accepted.index !== n ? state.accepted.voiceId : null;
    if (replaced) {
      warn(`the auto-accepted voice ${replaced} is still on the account — free the slot with --delete ${replaced}`);
    }
    return report(`  voice "${picked.name}" ready (${picked.voiceId}) — preview #${n}`, {
      ok: true, voiceId: picked.voiceId, name: picked.name, picked: n,
      ...(replaced ? { replacedVoiceId: replaced } : {}),
    });
  }

  if (args.describe) {
    const description = String(args.describe === true ? "" : args.describe).trim();
    if (!description) fail("--describe needs a voice description", USAGE);
    initElevenLabs();
    const audition = boolArg(args.audition, false);
    const name = voiceName(args, description);

    // Same description designed before? Reuse the account voice — zero spend,
    // and the character sounds identical across videos.
    const cached = await store.findVoice(description);
    if (cached) {
      const live = await getVoice(cached.voiceId);
      if (live) {
        await adoptVoice(projectDir, { voiceId: cached.voiceId, name: cached.name, description });
        return report(
          `  reusing "${cached.name}" (${cached.voiceId}) designed ${cached.createdAt} — no design spend`,
          { ok: true, voiceId: cached.voiceId, name: cached.name, reused: true }
        );
      }
      warn(`cached voice ${cached.voiceId} no longer exists on the account — designing fresh`);
      await store.removeVoice(cached.voiceId);
    }

    const m = existsSync(manifest.manifestPath(projectDir)) ? await manifest.load(projectDir) : null;
    const sampleText = args["sample-text"] && args["sample-text"] !== true
      ? String(args["sample-text"])
      : defaultSampleText(m);
    if (!sampleText) info("  no narration >= 100 chars to audition with — ElevenLabs will write its own sample");

    info(`  designing: "${description.slice(0, 70)}${description.length > 70 ? "…" : ""}"`);
    const previews = await designPreviews({ description, sampleText, seed: args.seed });

    const previewDirAbs = path.join(projectDir, PREVIEW_DIR);
    await mkdir(previewDirAbs, { recursive: true });
    const state = {
      description,
      createdAt: new Date().toISOString(),
      previews: [],
    };
    for (const [i, p] of previews.entries()) {
      const file = path.join(previewDirAbs, `preview-${i + 1}.mp3`);
      await writeFile(file, Buffer.from(p.audioBase64, "base64"));
      state.previews.push({ generatedVoiceId: p.generatedVoiceId, file });
      info(`    preview ${i + 1}: ${file}`);
    }

    // The design credits are spent the moment the previews exist, so the state
    // file goes down BEFORE the accept step — if persisting or the manifest
    // write fails, --pick can still rescue the batch instead of paying again.
    await writeFile(statePath(projectDir), `${JSON.stringify(state, null, 2)}\n`);

    if (audition) {
      info(`  listen:  afplay ${path.join(previewDirAbs, "preview-1.mp3")}  (…-2, …-3)`);
      info("  then:    node scripts/gen/voice-design.mjs --project <dir> --pick <n>");
      return report(`  ${previews.length} preview(s) ready — pick one while they are fresh`, {
        ok: true, auditioning: true, previews: state.previews.map((p, i) => ({ n: i + 1, file: p.file })),
      });
    }

    // Default: accept the first preview now (previews expire), but keep the
    // others on disk + in the state file so a quick --pick 2 can swap.
    const picked = await acceptPreview(projectDir, state, 1, name);
    state.accepted = { index: 1, voiceId: picked.voiceId, name: picked.name };
    await writeFile(statePath(projectDir), `${JSON.stringify(state, null, 2)}\n`);

    info(`  hear it:   afplay ${state.previews[0].file}`);
    info("  not right? afplay the others, then --pick 2 / --pick 3 (soon — previews expire)");
    return report(`  voice "${picked.name}" ready (${picked.voiceId}) — auto-accepted preview #1`, {
      ok: true, voiceId: picked.voiceId, name: picked.name, reused: false, picked: 1,
      previews: state.previews.map((p, i) => ({ n: i + 1, file: p.file })),
    });
  }

  fail("nothing to do", USAGE);
});
