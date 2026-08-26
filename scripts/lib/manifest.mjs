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
import { STYLES, STYLE_NAMES } from "./styles.mjs";

export const MANIFEST_NAME = "demo.json";

/** Scene kinds the renderer knows how to draw. */
export const SCENE_KINDS = ["presenter", "demo", "broll", "card"];

/**
 * How a demo (screen-capture) scene is fitted when the composition aspect differs
 * from the capture aspect — the central question of a vertical Short built from a
 * landscape recording. "split" (the house style, and the auto-default on a
 * mismatch) puts the demo in the top zone with a content slot below; "pan"
 * follows the click log with a sliding full-frame window; "card" letterboxes the
 * full UI into a styled card; "cover" center-crops (the original behavior, still
 * the default when the aspects roughly match).
 */
export const FRAMINGS = ["pan", "card", "cover", "split"];

/** What a split scene's bottom zone shows. Absent bottom means "captions". */
export const SPLIT_BOTTOM_KINDS = ["presenter", "image", "captions", "bullets"];

/**
 * Shot types a beat can cut to. Beats let ONE narrated scene cut its visuals
 * every second or two — the grammar of fast social video — while the voice
 * flows continuously: "face" is the full-bleed talking presenter, "screen" the
 * scene's capture, "split" the top/bottom layout, "insert" a full-frame image
 * or typographic card, "card" the classic motion card.
 */
export const BEAT_SHOTS = ["face", "screen", "split", "insert", "card"];

/** Caption renderings: "clean" pill, "shorts" karaoke, "boxed" phrase cards. */
export const CAPTION_STYLES = ["clean", "shorts", "boxed"];
export const CAPTION_PLACEMENTS = ["seam", "mid", "low"];

/** Nearest generation-model aspect label for a format. */
export function aspectOf(format = {}) {
  const { width = 1920, height = 1080 } = format;
  const r = width / height;
  const candidates = [["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1]];
  return candidates.reduce((best, c) => (Math.abs(c[1] - r) < Math.abs(best[1] - r) ? c : best))[0];
}

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

// Watermark placements. Right-edge and true-bottom slots are deliberately
// absent from the "bottom" row names' insets in the renderer: on vertical video
// the platform UI (like/share rail, caption strip) covers those zones.
export const WATERMARK_POSITIONS = ["top-left", "top-center", "top-right", "bottom-left", "bottom-right"];

// Corner-bubble presenter (presenter.mode "always"). Configured globally at
// presenter.pip = { shape, position, sizePct }; a scene may override with its own
// pip object, or opt out entirely with pip: false (a step the bubble would cover).
export const PIP_SHAPES = ["circle", "square"];
export const PIP_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"];

/**
 * The cover — a hook card baked into FRAME 0 and wiped away ~0.5s later.
 *
 * Every vertical platform takes an early frame as the thumbnail (TikTok frame 0,
 * Instagram thumb_offset 0, Shorts an early frame) and the posting API cannot
 * override it, so a run of Shorts that all open on the presenter's face looks
 * like one video posted eight times. `cover` makes frame 0 a distinct
 * typographic card: it is FULLY rendered at frame 0 (no entrance animation —
 * a fading-in card would give the platforms a black thumbnail), holds for
 * `holdSec`, then exits over `outSec` while narration already runs underneath.
 * Layout and accent are meant to be rotated per video so the channel grid varies.
 */
export const COVER_LAYOUTS = ["stack", "band", "corner", "stripe"];
export const COVER_EXITS = ["wipe-up", "dissolve", "slide-left", "cut"];
export const COVER_DEFAULTS = { layout: "stack", exit: "wipe-up", holdSec: 0.5, outSec: 0.5 };
/**
 * cover.kind:
 *   "card"  (default) — the typographic hook card above.
 *   "frame" — no card at all: frame 0 is a frozen frame of the video itself,
 *             taken from a later timestamp (`atSec`, absolute; or `scene` +
 *             `atSec` scene-relative — typically an anchored split with the
 *             presenter below and a full caption phrase on the seam). It holds
 *             for `holdSec` then hard-cuts to the real start, like a video
 *             whose poster was picked from a timestamp. `captions: false`
 *             drops the caption box from the frozen frame (a mid-phrase box
 *             reads as a glitch). Rotate the timestamp per video so the
 *             channel grid still varies.
 */
export const COVER_KINDS = ["card", "frame"];
export const COVER_FRAME_DEFAULTS = { kind: "frame", exit: "cut", holdSec: 0.45, outSec: 0 };

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
    /** Frame-0 hook card; see COVER_LAYOUTS. Null = the first scene is the cover. */
    cover: null,
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

/**
 * `name` selects a sibling manifest in the same project dir (e.g. "shorts.json"
 * for a vertical cut that shares the project's clips and .cache.json). Artifacts
 * stay project-relative either way, so both manifests can reference the same files.
 */
export function manifestPath(projectDir, name = MANIFEST_NAME) {
  return path.join(projectDir, name || MANIFEST_NAME);
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

export async function load(projectDir, { name = MANIFEST_NAME } = {}) {
  const file = manifestPath(projectDir, name);
  if (!existsSync(file)) {
    throw new Error(`No ${name} at ${file} — run the demo-video skill to create one.`);
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
export async function save(projectDir, manifest, { name = MANIFEST_NAME } = {}) {
  await mkdir(projectDir, { recursive: true });
  const file = manifestPath(projectDir, name);
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
export async function update(projectDir, mutate, { name = MANIFEST_NAME } = {}) {
  const manifest = await load(projectDir, { name });
  const next = (await mutate(manifest)) || manifest;
  await save(projectDir, next, { name });
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

  const capStyle = manifest?.captions?.style;
  if (capStyle && !CAPTION_STYLES.includes(capStyle)) {
    push(warnings, `captions.style "${capStyle}" is unknown — the renderer will fall back to "clean"`);
  }

  const wm = manifest?.watermark;
  if (wm) {
    if (!wm.text && !wm.image) {
      push(warnings, "watermark has neither text nor image — it will not render");
    }
    if (wm.position && !WATERMARK_POSITIONS.includes(wm.position)) {
      push(warnings, `watermark.position "${wm.position}" is unknown (${WATERMARK_POSITIONS.join(", ")}) — the renderer will fall back to "top-left"`);
    }
  }

  // Shared field checks for presenter.pip and a scene-level pip override.
  const checkPip = (pip, at) => {
    if (pip.shape && !PIP_SHAPES.includes(pip.shape)) {
      push(warnings, `${at}.shape "${pip.shape}" is unknown (${PIP_SHAPES.join(", ")}) — the renderer will fall back to "circle"`);
    }
    if (pip.position && !PIP_POSITIONS.includes(pip.position)) {
      push(warnings, `${at}.position "${pip.position}" is unknown (${PIP_POSITIONS.join(", ")}) — the renderer will fall back to "bottom-left"`);
    }
    if (pip.sizePct != null && !(pip.sizePct >= 10 && pip.sizePct <= 40)) {
      push(warnings, `${at}.sizePct ${pip.sizePct} is outside 10-40 — under 10 is unreadable, over 40 covers the UI`);
    }
  };
  if (manifest?.presenter?.pip) {
    checkPip(manifest.presenter.pip, "presenter.pip");
    if (mode !== "always") {
      push(warnings, `presenter.pip is set but presenter.mode is "${mode || "hybrid"}" — the corner bubble only renders in mode "always"`);
    }
  }

  if (manifest?.style) {
    const st = STYLES[manifest.style];
    if (!st) {
      push(warnings, `style "${manifest.style}" is not in the catalog (${STYLE_NAMES.join(", ")})`);
    } else if ((st.aspect === "9:16") !== (fmt.height > fmt.width)) {
      push(warnings, `style "${manifest.style}" is ${st.aspect} but the format is ${fmt.width}x${fmt.height}`);
    }
  }
  if (provider === "elevenlabs" && !manifest?.voice?.voiceId) {
    push(errors, 'voice.provider is "elevenlabs" but voice.voiceId is missing — run gen/voice-design.mjs');
  }

  const cover = manifest?.cover;
  if (cover) {
    if (typeof cover !== "object" || Array.isArray(cover)) {
      push(errors, "cover must be an object { hook, kicker?, layout?, accent?, portrait?, holdSec?, outSec?, exit? } or { kind: \"frame\", atSec, scene?, holdSec? }");
    } else {
      const kind = cover.kind || "card";
      if (!COVER_KINDS.includes(kind)) {
        push(errors, `cover.kind must be one of ${COVER_KINDS.join(" | ")}, got "${kind}"`);
      }
      if (kind === "frame") {
        if (!(typeof cover.atSec === "number" && cover.atSec >= 0)) {
          push(errors, 'cover.kind "frame" needs cover.atSec (seconds into the video, or into cover.scene when set) — the frozen frame that becomes the thumbnail');
        }
        if (cover.scene && !manifest?.timeline?.some((sc) => sc.id === cover.scene)) {
          push(errors, `cover.scene "${cover.scene}" is not a scene id in the timeline`);
        }
        if (cover.exit && !COVER_EXITS.includes(cover.exit)) {
          push(errors, `cover.exit must be one of ${COVER_EXITS.join(" | ")}, got "${cover.exit}"`);
        }
        for (const k of ["holdSec", "outSec"]) {
          if (cover[k] != null && !(cover[k] >= 0)) push(errors, `cover.${k} must be >= 0`);
        }
        const hold = cover.holdSec ?? COVER_FRAME_DEFAULTS.holdSec;
        if (hold > 0.8) push(warnings, `cover holds a frozen frame for ${hold}s — past ~0.6s it reads as a stalled video, not a poster`);
        if (fmt.width && fmt.height && fmt.width > fmt.height) {
          push(warnings, "cover is set on a landscape video — it exists for vertical Shorts, where platforms take frame 0 as the thumbnail");
        }
      } else if (!cover.hook || typeof cover.hook !== "string") {
        push(errors, "cover.hook is required — the big text on the frame-0 card (this is the thumbnail every platform shows)");
      } else if (cover.hook.length > 60) {
        push(warnings, `cover.hook is ${cover.hook.length} chars — over 60 it wraps past three lines and shrinks below thumbnail-legible size`);
      }
      if (kind === "card" && cover.layout && !COVER_LAYOUTS.includes(cover.layout)) {
        push(errors, `cover.layout must be one of ${COVER_LAYOUTS.join(" | ")}, got "${cover.layout}"`);
      }
      if (kind === "card" && cover.exit && !COVER_EXITS.includes(cover.exit)) {
        push(errors, `cover.exit must be one of ${COVER_EXITS.join(" | ")}, got "${cover.exit}"`);
      }
      if (kind === "card" && cover.accent && !/^#[0-9a-f]{6}$/i.test(cover.accent)) {
        push(warnings, `cover.accent "${cover.accent}" is not a #rrggbb colour — the renderer will fall back to brand.colors.primary`);
      }
      if (kind === "card") for (const k of ["holdSec", "outSec"]) {
        if (cover[k] != null && !(cover[k] >= 0)) push(errors, `cover.${k} must be >= 0`);
      }
      const coverSec = kind === "card" ? (cover.holdSec ?? COVER_DEFAULTS.holdSec) + (cover.outSec ?? COVER_DEFAULTS.outSec) : 0;
      if (coverSec > 2) {
        push(warnings, `cover holds ${coverSec}s before the first scene shows — a card past 2s is a logo-card open, not a hook`);
      }
      const first = manifest?.timeline?.[0];
      if (first?.durationSec != null && coverSec > first.durationSec) {
        push(warnings, `cover (${coverSec}s) outlasts the first scene "${first.id}" (${first.durationSec}s) — it will cover a scene cut`);
      }
      if (fmt.width && fmt.height && fmt.width > fmt.height) {
        push(warnings, "cover is set on a landscape video — it exists for vertical Shorts, where platforms take frame 0 as the thumbnail");
      }
    }
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

    if (scene.framing && !FRAMINGS.includes(scene.framing)) {
      push(errors, `${at}: framing must be one of ${FRAMINGS.join(" | ")}, got "${scene.framing}"`);
    }
    if (scene.aspect && !/^\d+:\d+$/.test(scene.aspect)) {
      push(errors, `${at}: aspect must look like "9:16", got "${scene.aspect}"`);
    }
    if (scene.headline && scene.framing !== "card" && scene.kind !== "card") {
      push(warnings, `${at}: headline is only drawn with framing "card"`);
    }

    if (scene.framing === "split" && scene.kind !== "demo") {
      push(errors, `${at}: framing "split" only applies to demo scenes`);
    }
    if (scene.bottom && scene.framing && scene.framing !== "split") {
      push(warnings, `${at}: bottom is only drawn with framing "split"`);
    }
    if (scene.splitPct != null && !(scene.splitPct >= 0.35 && scene.splitPct <= 0.75)) {
      push(errors, `${at}: splitPct must be between 0.35 and 0.75`);
    }
    if (scene.topFraming && !["pan", "cover"].includes(scene.topFraming)) {
      push(errors, `${at}: topFraming must be "pan" or "cover"`);
    }
    if (scene.bottom) {
      const b = scene.bottom;
      if (!SPLIT_BOTTOM_KINDS.includes(b.kind)) {
        push(errors, `${at}: bottom.kind must be one of ${SPLIT_BOTTOM_KINDS.join(" | ")}, got "${b.kind}"`);
      }
      if (b.kind === "image" && !b.image) {
        push(errors, `${at}: bottom.kind "image" needs bottom.image`);
      }
      if (b.kind === "bullets") {
        const ok = Array.isArray(b.bullets) && b.bullets.length &&
          b.bullets.every((x) => x?.text && (x.atSec == null || typeof x.atSec === "number"));
        if (!ok) push(errors, `${at}: bottom.kind "bullets" needs a non-empty bullets array of { text, atSec? }`);
      }
      if (b.kind === "presenter") {
        if (!scene.audio && !scene.presenterVideo) {
          push(errors, `${at}: bottom presenter needs narration audio to animate to, or an existing presenterVideo`);
        }
        if (mode === "none") {
          push(warnings, `${at}: bottom presenter while presenter.mode is "none" — it will render as captions`);
        }
      }
    }

    if (scene.kind === "demo") {
      if (!CAPTURE_TARGETS.includes(scene.target)) {
        push(errors, `${at}: target must be one of ${CAPTURE_TARGETS.join(" | ")}`);
      }
      if (!scene.actions && !scene.video) {
        push(errors, `${at}: needs an actions file to perform, or an already-recorded video`);
      }
    }

    if (scene.videoStartSec != null) {
      if (!(scene.videoStartSec >= 0)) {
        push(errors, `${at}: videoStartSec must be >= 0`);
      }
      if (scene.kind !== "demo") {
        push(warnings, `${at}: videoStartSec only affects demo scenes`);
      }
      if (scene.beats?.length) {
        push(warnings, `${at}: beats carry their own videoStartSec — the scene-level value is ignored`);
      }
    }
    if (scene.pip != null) {
      if (scene.pip !== false && (typeof scene.pip !== "object" || Array.isArray(scene.pip))) {
        push(warnings, `${at}: pip must be false or { shape, position, sizePct } — it will be ignored`);
      } else if (scene.pip !== false) {
        checkPip(scene.pip, `${at}: pip`);
      }
      if (mode !== "always") {
        push(warnings, `${at}: pip is set but presenter.mode is "${mode || "hybrid"}" — the corner bubble only renders in mode "always"`);
      }
    }

    if (scene.beats && scene.kind !== "demo") {
      push(errors, `${at}: beats only apply to demo scenes`);
    }
    if (scene.beatLayout) {
      if (scene.beatLayout !== "anchored") {
        push(errors, `${at}: beatLayout must be "anchored" if set, got "${scene.beatLayout}"`);
      }
      if (!Array.isArray(scene.beats) || !scene.beats.length) {
        push(errors, `${at}: beatLayout needs beats — it shapes how the beat windows render`);
      }
      if (!scene.bottom) {
        push(warnings, `${at}: beatLayout "anchored" without a bottom slot — it will render as plain beat cuts`);
      }
    }
    if (scene.captionPlacement && !CAPTION_PLACEMENTS.includes(scene.captionPlacement)) {
      push(errors, `${at}: captionPlacement must be one of ${CAPTION_PLACEMENTS.join(" | ")}`);
    }
    if (scene.beats && scene.kind === "demo") {
      if (!Array.isArray(scene.beats) || !scene.beats.length) {
        push(errors, `${at}: beats must be a non-empty array`);
      } else {
        if (scene.beats[0].atSec !== 0) push(errors, `${at}: the first beat must start at atSec 0`);
        for (const [bi, b] of scene.beats.entries()) {
          const bat = `${at} beats[${bi}]`;
          if (!BEAT_SHOTS.includes(b?.shot)) {
            push(errors, `${bat}: shot must be one of ${BEAT_SHOTS.join(" | ")}, got "${b?.shot}"`);
          }
          if (typeof b?.atSec !== "number" || b.atSec < 0) {
            push(errors, `${bat}: atSec must be a non-negative number`);
          }
          if (bi > 0 && !(b.atSec > scene.beats[bi - 1].atSec)) {
            push(errors, `${bat}: atSec must be strictly increasing`);
          }
          const windowEnd = bi < scene.beats.length - 1 ? scene.beats[bi + 1].atSec : scene.durationSec;
          if (bi > 0 && windowEnd != null && windowEnd - b.atSec < 0.4) {
            push(warnings, `${bat}: window is under 0.4s — faster than 2.5 cuts/sec reads as flicker`);
          }
          if (b.shot === "insert" && !b.image && !b.images?.length && !b.prompt && !b.title) {
            push(errors, `${bat}: an insert beat needs an image (or images), a prompt to generate one, or a title`);
          }
          if (b.images != null) {
            const ok = Array.isArray(b.images) && b.images.length >= 2 && b.images.length <= 5 &&
              b.images.every((p) => typeof p === "string" && p);
            if (!ok) push(errors, `${bat}: images must be 2-5 asset paths`);
            if (b.image) push(errors, `${bat}: image and images are mutually exclusive`);
            if (b.shot !== "insert") push(warnings, `${bat}: images only affects insert beats`);
          }
          if (b.captionPlacement && !CAPTION_PLACEMENTS.includes(b.captionPlacement)) {
            push(errors, `${bat}: captionPlacement must be one of ${CAPTION_PLACEMENTS.join(" | ")}`);
          }
          if (b.framing != null) {
            if (!["pan", "cover"].includes(b.framing)) {
              push(errors, `${bat}: framing must be "pan" or "cover"`);
            }
            if (!["screen", "split"].includes(b.shot)) {
              push(warnings, `${bat}: framing only affects screen/split beats`);
            }
          }
          if (b.videoStartSec != null) {
            if (!["screen", "split"].includes(b.shot)) {
              push(warnings, `${bat}: videoStartSec only affects screen/split beats`);
            }
            if (!(b.videoStartSec >= 0)) push(errors, `${bat}: videoStartSec must be >= 0`);
          }
        }
        if (scene.durationSec != null) {
          const last = scene.beats[scene.beats.length - 1];
          if (last.atSec >= scene.durationSec) {
            push(errors, `${at}: the last beat starts at ${last.atSec}s, past the scene's ${scene.durationSec}s`);
          } else if (last.atSec > scene.durationSec - 0.5) {
            push(warnings, `${at}: the last beat has under 0.5s of screen time`);
          }
        }
      }
    }
    if (scene.captionEmphasis) {
      const ok = Array.isArray(scene.captionEmphasis) &&
        scene.captionEmphasis.every((e) => e?.match && ["neg", "pos"].includes(e?.tone));
      if (!ok) push(errors, `${at}: captionEmphasis must be [{ match, tone: "neg" | "pos" }]`);
    }
    if (scene.captionsStyle && !CAPTION_STYLES.includes(scene.captionsStyle)) {
      push(warnings, `${at}: captionsStyle "${scene.captionsStyle}" is unknown — the renderer will fall back`);
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
    // A demo scene reusing an already-recorded clip (a Short cut from the main
    // demo) declares no actions file at all — that is complete, not pending.
    const missingActions = scene.actions ? !has(scene.actions) : !has(scene.video);
    if (scene.kind === "demo" && missingActions) needs.push("actions");
    if (scene.kind !== "card" && !has(scene.video)) needs.push("video");
    const wantsPresenterClip =
      scene.bottom?.kind === "presenter" ||
      (scene.beats || []).some((b) => b.shot === "face" || (b.shot === "split" && scene.bottom?.kind === "presenter")) ||
      // Corner pip: mode "always" puts the presenter over every plain demo scene
      // unless the scene opted out with pip: false.
      (manifest.presenter?.mode === "always" && scene.kind === "demo" &&
        !scene.beats?.length && scene.pip !== false);
    if (wantsPresenterClip && scene.audio && !has(scene.presenterVideo)) {
      needs.push("presenterVideo");
    }
    if (needs.length) out.push({ sceneId: scene.id, kind: scene.kind, needs });
  }
  return out;
}

/** Total runtime in seconds from scene durations (transitions overlap, so they don't add). */
export function totalDuration(manifest) {
  return (manifest.timeline || []).reduce((sum, s) => sum + (s.durationSec || 0), 0);
}
