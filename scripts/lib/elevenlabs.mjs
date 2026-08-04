/**
 * Direct ElevenLabs API client — the optional "character voice" path.
 *
 * fal.ai hosts ElevenLabs TTS with stock voices, which is the default narration
 * path and needs only FAL_API_KEY. What fal does NOT expose is Voice Design:
 * describing a voice in prose ("gruff New England lobster-boat captain") and
 * getting a brand-new voice back. That requires the ElevenLabs API directly,
 * so this module exists — and everything in it is OPTIONAL, gated on
 * ELEVENLABS_API_KEY. Without the key the plugin behaves exactly as before.
 *
 * Raw fetch, no SDK dependency. Endpoints confirmed against
 * https://elevenlabs.io/docs/api-reference (2026-07):
 *
 *   POST /v1/text-to-voice/design                      description -> ~3 previews
 *   POST /v1/text-to-voice                             preview -> permanent voice
 *   POST /v1/text-to-speech/{id}/with-timestamps       voice -> audio + char timings
 *   GET/DELETE /v1/voices...                           list / verify / free a slot
 *
 * The docs have previously used /v1/text-to-voice/create-previews and
 * /create-voice-from-preview for the first two — if a 404 ever comes back from
 * design/persist, check whether the names moved again.
 */
import { loadSecrets, KEYCHAIN_SERVICE } from "./env.mjs";

const BASE = "https://api.elevenlabs.io";

/** Model that powers Voice Design itself (the preview generation). */
export const DESIGN_MODEL = "eleven_ttv_v3";

/**
 * Default TTS model for designed voices, and the fallback when the primary is
 * rejected on the /with-timestamps endpoint (eleven_v3 timestamp support is not
 * guaranteed; multilingual_v2 is).
 */
export const TTS_MODEL = "eleven_v3";
export const TTS_FALLBACK_MODEL = "eleven_multilingual_v2";

/** Is the optional key configured? Never exits — for feature-gating. */
export function hasElevenLabs() {
  loadSecrets();
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

/** Return the key, or hard-fail with the same remediation shape as initFal. */
export function initElevenLabs() {
  loadSecrets();
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    console.error(
      "Error: ELEVENLABS_API_KEY is not set (needed for character voice design).\n" +
        `  security add-generic-password -s ${KEYCHAIN_SERVICE} -a ELEVENLABS_API_KEY -w   ` +
        "(run in your own terminal; it prompts without echoing)\n" +
        "  Get a key at https://elevenlabs.io/app/settings/api-keys"
    );
    process.exit(1);
  }
  return key;
}

/**
 * One API call. Throws an Error carrying `httpStatus` and the ElevenLabs
 * `apiStatus` string so callers can branch on specific failures
 * (voice_not_found -> evict cache, model rejection -> fall back).
 */
async function api(pathname, { method = "GET", body, binary = false } = {}) {
  const key = initElevenLabs();
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      "xi-api-key": key,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await apiError(pathname, res);
  if (res.status === 204) return null;
  return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
}

/** Map the error body to an actionable message; keep raw status for branching. */
async function apiError(pathname, res) {
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON error body */
  }
  const apiStatus = payload?.detail?.status || null;
  const apiMessage =
    payload?.detail?.message ||
    (typeof payload?.detail === "string" ? payload.detail : null) ||
    res.statusText;

  let message = `ElevenLabs ${res.status} on ${pathname}: ${apiMessage}`;
  if (res.status === 401) {
    message = "ElevenLabs rejected the API key (401) — check ELEVENLABS_API_KEY.";
  } else if (
    (res.status === 402 || res.status === 403) &&
    /free (users|plan)|paid plan|upgrade/i.test(String(apiMessage))
  ) {
    // Confirmed live: the FREE tier can neither create voices via the API (403)
    // nor speak with library voices via the API (402). The feature needs a paid
    // plan — Starter and up — which also carries the commercial license a
    // published demo video needs anyway.
    message =
      `ElevenLabs ${res.status}: ${apiMessage}\n` +
      "  Character voices need a paid ElevenLabs plan (Starter or above) — the free tier\n" +
      "  cannot create or use voices through the API: https://try.elevenlabs.io/zecjglkbwy6x";
  } else if (apiStatus === "voice_limit_reached") {
    message =
      "ElevenLabs voice slots are full — your plan's custom-voice quota is used up.\n" +
      "  List voices:  node scripts/gen/voice-design.mjs --list\n" +
      "  Free a slot:  node scripts/gen/voice-design.mjs --delete <voice_id>";
  } else if (apiStatus === "quota_exceeded") {
    message = `ElevenLabs character credits are exhausted: ${apiMessage}`;
  }

  const err = new Error(message);
  err.httpStatus = res.status;
  err.apiStatus = apiStatus;
  return err;
}

/**
 * Turn a prose description into ~3 candidate voices.
 * Returns [{ generatedVoiceId, audioBase64, durationSecs }].
 *
 * The preview ids are EPHEMERAL — persist the chosen one with
 * `createVoiceFromPreview` in the same run or the work is lost.
 *
 * Limits enforced client-side so nothing is spent on a doomed request:
 * description >= 20 chars; sample text 100-1000 chars, else ElevenLabs
 * writes its own sample (auto_generate_text).
 */
export async function designPreviews({ description, sampleText, seed }) {
  const desc = String(description || "").trim();
  if (desc.length < 20) {
    throw new Error(
      `voice description must be at least 20 characters (got ${desc.length}) — describe age, accent, tone, character`
    );
  }
  const body = { voice_description: desc, model_id: DESIGN_MODEL };
  const text = String(sampleText || "").trim();
  if (text.length >= 100) body.text = text.slice(0, 1000);
  else body.auto_generate_text = true;
  if (seed != null) body.seed = Number(seed);

  const data = await api("/v1/text-to-voice/design", { method: "POST", body });
  const previews = (data?.previews || []).map((p) => ({
    generatedVoiceId: p.generated_voice_id,
    audioBase64: p.audio_base_64,
    durationSecs: p.duration_secs ?? null,
  }));
  if (!previews.length) throw new Error("Voice Design returned no previews");
  return previews;
}

/** Persist a preview as a permanent account voice. Returns { voiceId }. */
export async function createVoiceFromPreview({ generatedVoiceId, name, description }) {
  const data = await api("/v1/text-to-voice", {
    method: "POST",
    body: {
      voice_name: name,
      voice_description: String(description || "").trim(),
      generated_voice_id: generatedVoiceId,
    },
  });
  const voiceId = data?.voice_id;
  if (!voiceId) throw new Error("ElevenLabs did not return a voice_id for the saved preview");
  return { voiceId };
}

/**
 * Synthesize speech with character-level timings.
 * Returns { audioBase64, alignment } where alignment is
 * { characters, character_start_times_seconds, character_end_times_seconds } —
 * i.e. exactly one chunk of the shape tts.mjs normalizeTimestamps() flattens.
 */
export async function ttsWithTimestamps({ voiceId, text, modelId = TTS_MODEL, stability, speed }) {
  const body = { text, model_id: modelId };
  const settings = {};
  if (stability != null) settings.stability = Number(stability);
  if (speed != null) settings.speed = Number(speed);
  if (Object.keys(settings).length) body.voice_settings = settings;

  const data = await api(
    `/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`,
    { method: "POST", body }
  );
  if (!data?.audio_base64) throw new Error(`ElevenLabs TTS returned no audio for voice ${voiceId}`);
  return { audioBase64: data.audio_base64, alignment: data.alignment || data.normalized_alignment || null };
}

/** All voices on the account. Returns [{ voiceId, name, category, description }]. */
export async function listVoices() {
  const data = await api("/v1/voices");
  return (data?.voices || []).map((v) => ({
    voiceId: v.voice_id,
    name: v.name,
    category: v.category || null,
    description: v.description || null,
  }));
}

/** One voice, or null if it no longer exists (used to validate cache hits). */
export async function getVoice(voiceId) {
  try {
    const v = await api(`/v1/voices/${encodeURIComponent(voiceId)}`);
    return v ? { voiceId: v.voice_id, name: v.name, category: v.category || null } : null;
  } catch (e) {
    if (e.httpStatus === 404 || e.apiStatus === "voice_not_found") return null;
    throw e;
  }
}

/** Delete a voice from the account, freeing one of the quota'd slots. */
export async function deleteVoice(voiceId) {
  await api(`/v1/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" });
}
