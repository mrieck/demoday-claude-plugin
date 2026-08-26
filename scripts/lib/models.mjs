/**
 * The fal.ai model registry: endpoints, what they take, and roughly what they cost.
 *
 * Kept in one place because these are the numbers the cost gate quotes to the user
 * before anything is spent, and because model IDs drift — when a generation starts
 * failing, this is the file to check against https://fal.ai/models.
 *
 * Endpoints marked VERIFIED were confirmed against fal's docs while this plugin was
 * built. The rest are carried over from the reference plugin and are UNVERIFIED —
 * treat a 404 from one of those as "the ID moved", not "the code is broken".
 *
 * Prices are approximate USD and exist to size a decision ("this costs dollars not
 * cents"), not to bill anyone. Always confirm on fal's pricing page.
 */

export const TTS = {
  "eleven-v3": {
    endpoint: "fal-ai/elevenlabs/tts/eleven-v3",     // VERIFIED
    verified: true,
    supportsTimestamps: true,
    notes: "Most expressive. Returns word-level timestamps when timestamps: true.",
    approxUsdPerMinute: 0.3,
  },
  "multilingual-v2": {
    endpoint: "fal-ai/elevenlabs/tts/multilingual-v2", // VERIFIED
    verified: true,
    supportsTimestamps: true,
    notes: "Stable narration across 29 languages.",
    approxUsdPerMinute: 0.3,
  },
  "turbo-v2.5": {
    endpoint: "fal-ai/elevenlabs/tts/turbo-v2.5",     // VERIFIED
    verified: true,
    supportsTimestamps: true,
    notes: "Lowest latency; less expressive.",
    approxUsdPerMinute: 0.15,
  },
};

/**
 * Direct ElevenLabs pricing (the OPTIONAL character-voice path, not fal).
 *
 * ElevenLabs bills in credits (~1 credit per character of TTS), and the $/credit
 * depends on the subscription tier, so both numbers are UNVERIFIED order-of-
 * magnitude figures (Creator-tier-ish) — confirm at https://elevenlabs.io/pricing.
 * Voice Design charges a flat batch of credits per preview generation, once per
 * NEW voice; reused descriptions cost nothing (see lib/voice-store.mjs).
 */
export const ELEVENLABS = {
  ttsUsdPer1kChars: 0.22, // UNVERIFIED
  designUsdPerRun: 0.25,  // UNVERIFIED
};

/**
 * Presenter engines: image + audio -> a talking person.
 *
 * This one-step form is strongly preferred over "generate a video, then lip-sync
 * it" — it is cheaper, and the mouth is driven by the real narration from the
 * start rather than being corrected afterwards.
 */
export const AVATAR = {
  "kling-avatar": {
    endpoint: "fal-ai/kling-video/ai-avatar/v2/standard",
    // VERIFIED against the live API: takes image_url + audio_url, returns { video, duration }.
    // This is the DEFAULT because it is the one confirmed to accept a still image.
    verified: true,
    inputs: { image: "image_url", audio: "audio_url" },
    notes:
      "Audio-driven facial animation from a still. Output is quantised to 5s or 10s, " +
      "so a shorter narration yields a longer clip — the scene duration still comes " +
      "from the audio, and the renderer plays only that much.",
    approxUsdPerSecond: 0.056,
  },
  infinitalk: {
    // CAUTION: the bare `fal-ai/infinitalk` endpoint is the VIDEO-to-video variant and
    // rejects image_url with a 422. The image+audio form lives under a subpath whose
    // exact name was not confirmed — verify against https://fal.ai/models before using.
    endpoint: "fal-ai/infinitalk",
    verified: false,
    inputs: { video: "video_url", audio: "audio_url" },
    notes: "Video-to-video lip animation. Not a drop-in for a still image.",
    approxUsdPerSecond: 0.06,
  },
  omnihuman: {
    endpoint: "fal-ai/bytedance/omnihuman",           // VERIFIED
    verified: true,
    inputs: { image: "image_url", audio: "audio_url" },
    notes: "Most expressive body/emotion coupling; pricier.",
    approxUsdPerSecond: 0.12,
  },
};

/** Video + audio -> lip-synced video. Only needed when the shot must come from a video model. */
export const LIPSYNC = {
  "sync-v3": {
    endpoint: "fal-ai/sync-lipsync/v3",               // VERIFIED
    verified: true,
    inputs: { video: "video_url", audio: "audio_url" },
    notes: "Highest quality; supports active-speaker detection.",
    approxUsdPerMinute: 5,
  },
  "sync-v2-pro": {
    endpoint: "fal-ai/sync-lipsync/v2/pro",           // VERIFIED
    verified: true,
    inputs: { video: "video_url", audio: "audio_url" },
    approxUsdPerMinute: 5,
  },
};

export const IMAGE = {
  "nano-banana-pro": { endpoint: "fal-ai/nano-banana-pro", verified: false, approxUsdPerImage: 0.05 },
  "nano-banana-2": { endpoint: "fal-ai/nano-banana-2", verified: false, approxUsdPerImage: 0.03 },
  "grok-imagine": { endpoint: "xai/grok-imagine-image", verified: false, approxUsdPerImage: 0.02 },
};

export const IMAGE_EDIT = {
  "nano-banana-pro": { endpoint: "fal-ai/nano-banana-pro/edit", verified: false },
  "nano-banana-2": { endpoint: "fal-ai/nano-banana-2/edit", verified: false },
  "grok-imagine": { endpoint: "xai/grok-imagine-image/edit", verified: false },
};

/**
 * B-roll video models, in the order to fall back through when one refuses a prompt
 * on content grounds. Carried over from the reference plugin's ladder.
 */
export const VIDEO = {
  "grok-imagine": {
    i2v: "xai/grok-imagine-video/image-to-video",
    t2v: "xai/grok-imagine-video/text-to-video",
    verified: false, fixedDuration: 6, approxUsdPerSecond: 0.05,
  },
  "sora-2": {
    i2v: "fal-ai/sora-2/image-to-video",
    t2v: "fal-ai/sora-2/text-to-video",
    verified: false, allowedDurations: [4, 8, 12], maxHeight: 720, approxUsdPerSecond: 0.15,
  },
  "veo-3.1": {
    i2v: "fal-ai/veo3.1/image-to-video",
    t2v: "fal-ai/veo3.1",
    verified: false, requiresStandardAspect: true, approxUsdPerSecond: 0.2,
  },
  "hailuo-2.3": {
    i2v: "fal-ai/minimax/hailuo-2.3/pro/image-to-video",
    verified: false, approxUsdPerSecond: 0.08,
  },
  "kling-2.5": {
    i2v: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    verified: false, approxUsdPerSecond: 0.1,
  },
};

/** The order to try when a model refuses a prompt on content grounds. */
export const VIDEO_LADDER = ["grok-imagine", "sora-2", "hailuo-2.3", "veo-3.1", "kling-2.5"];

/** Resolve a friendly name to an endpoint, accepting a raw endpoint too. */
export function resolve(registry, name) {
  if (!name) return null;
  if (registry[name]) return registry[name];
  // Allow passing a full endpoint id straight through.
  const match = Object.values(registry).find((m) => m.endpoint === name || m.i2v === name);
  return match || { endpoint: name, verified: false };
}

/**
 * Rough cost of a whole manifest, for the confirmation gate.
 * Deliberately errs high: a surprise that costs less than quoted is fine.
 */
export function estimateCost(m) {
  const lines = [];
  let total = 0;

  if (m.voice?.provider === "elevenlabs") {
    // Direct ElevenLabs bills per character, not per minute.
    const narrationChars = (m.timeline || [])
      .filter((s) => s.narration)
      .reduce((sum, s) => sum + String(s.narration).length, 0);
    if (narrationChars) {
      const usd = (narrationChars / 1000) * ELEVENLABS.ttsUsdPer1kChars;
      lines.push({ item: "narration (elevenlabs)", detail: `${narrationChars} chars`, usd });
      total += usd;
    }
    if (!m.voice?.voiceId) {
      // A voice still to be designed — one-time; reused descriptions are free.
      lines.push({ item: "voice design", detail: "one-time", usd: ELEVENLABS.designUsdPerRun });
      total += ELEVENLABS.designUsdPerRun;
    }
  } else {
    const narrationSec = (m.timeline || [])
      .filter((s) => s.narration)
      .reduce((sum, s) => sum + (s.durationSec || 8), 0);
    if (narrationSec) {
      const usd = (narrationSec / 60) * (TTS["eleven-v3"].approxUsdPerMinute);
      lines.push({ item: "narration", detail: `${Math.round(narrationSec)}s`, usd });
      total += usd;
    }
  }

  const presenterMode = m.presenter?.mode || "hybrid";
  if (presenterMode !== "none") {
    const engine = AVATAR[Object.keys(AVATAR).find((k) => AVATAR[k].endpoint === m.presenter?.engine)] ||
      AVATAR.infinitalk;
    // Full presenter scenes plus demo scenes that need a talking clip (split
    // bottom zone, face beats, or the mode-"always" corner pip) — all bill
    // avatar-seconds. On a tutorial the pip is the dominant line item, so it is
    // counted separately: the plan gate is where the user approves that spend.
    const isPipScene = (s) =>
      presenterMode === "always" && s.kind === "demo" &&
      !s.beats?.length && s.pip !== false &&
      s.bottom?.kind !== "presenter";
    const presenterScenes = (m.timeline || []).filter(
      (s) =>
        s.kind === "presenter" ||
        (s.kind === "demo" &&
          (s.bottom?.kind === "presenter" ||
            (s.beats || []).some((b) => b.shot === "face") ||
            isPipScene(s)))
    );
    const presenterSec = presenterScenes.reduce((sum, s) => sum + (s.durationSec || 8), 0);
    const pipCount = presenterScenes.filter(isPipScene).length;
    const bottomCount = presenterScenes.filter((s) => s.kind === "demo" && !isPipScene(s)).length;
    if (presenterSec) {
      const usd = presenterSec * engine.approxUsdPerSecond;
      const extras = [
        bottomCount ? `${bottomCount} split bottom` : "",
        pipCount ? `${pipCount} corner pip` : "",
      ].filter(Boolean).join(", ");
      const detail = `${Math.round(presenterSec)}s${extras ? ` (incl. ${extras})` : ""}`;
      lines.push({ item: "presenter", detail, usd });
      total += usd;
    }
    if (!m.presenter?.characterImage) {
      lines.push({ item: "character image", detail: "1 image", usd: 0.05 });
      total += 0.05;
    }
  }

  const brollSec = (m.timeline || [])
    .filter((s) => s.kind === "broll")
    .reduce((sum, s) => sum + (s.durationSec || 6), 0);
  if (brollSec) {
    const usd = brollSec * 0.1;
    lines.push({ item: "b-roll", detail: `${Math.round(brollSec)}s`, usd });
    total += usd;
  }

  // Insert beats with a prompt get a generated still; ones with an image are free.
  const insertStills = (m.timeline || [])
    .flatMap((s) => s.beats || [])
    .filter((b) => b.shot === "insert" && b.prompt && !b.image).length;
  if (insertStills) {
    const usd = insertStills * 0.05;
    lines.push({ item: "insert stills", detail: `${insertStills} image(s)`, usd });
    total += usd;
  }

  const demoCount = (m.timeline || []).filter((s) => s.kind === "demo").length;
  if (demoCount) lines.push({ item: "screen capture", detail: `${demoCount} scene(s)`, usd: 0 });

  return { lines, totalUsd: total };
}
