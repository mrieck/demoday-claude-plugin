/**
 * Sound effects: the cue pack, the auto-cue map, and the absolute-timeline
 * placement the renderer plays back.
 *
 * Full-screen text moments (insert cards, #N stamps, bullet reveals, the cover
 * wipe, face punch-ins) play in silence except for the voice; a whoosh on a
 * card and a tick per bullet is what makes them feel cut rather than stalled.
 * The manifest declares a `sfx` block:
 *
 *   "sfx": {
 *     "enabled": true, "gain": 0.7, "duckDb": -6,
 *     "cues": { "whoosh": { "prompt": "…", "durationSec": 0.6, "file": "audio/sfx/whoosh.mp3", "gain": 1 }, … },
 *     "auto": { "insert": "whoosh", "stamp": "pop", "face": "hit", "bullet": "tick",
 *               "coverExit": "whoosh", "transition": "whoosh", "card": "riser", "sceneStart": null }
 *   }
 *
 * Any event can override the auto map: a beat / transition / scene / bullet
 * carries `sfx: "pop"` (cue name), `sfx: false` (silence), or
 * `sfx: { cue, gain, offsetSec }`. `cover.sfx` overrides the exit cue and
 * `bottom.sfx` the bullet cue for a whole list.
 *
 * Placement is computed HERE (Node, testable) into a flat `sfxTrack`
 * (`{ cue, file, atFrame, frames, gain }`), not in the template — the renderer
 * only plays it. Frame math mirrors DemoVideo.jsx's narration loop exactly:
 * scene start = running cursor minus the preceding transition's overlap.
 */
import { existsSync } from "node:fs";
import { resolveIn } from "./manifest.mjs";

export const SFX_EVENTS = ["insert", "stamp", "face", "bullet", "coverExit", "transition", "card", "sceneStart"];

/** The default pack. Prompts are tuned for eleven_text_to_sound_v2: short, dry, no tail. */
export const DEFAULT_CUES = {
  whoosh: { prompt: "short fast cinematic air whoosh transition, clean, dry, no reverb tail", durationSec: 0.6 },
  pop: { prompt: "tiny bright UI pop, bubbly, single hit, dry, then silence", durationSec: 0.5 },
  hit: { prompt: "soft cinematic impact, low thud with a short bright transient, no tail", durationSec: 0.8 },
  tick: { prompt: "single crisp UI tick, notification blip, very short, dry, then silence", durationSec: 0.5 },
  riser: { prompt: "one second tension riser sweeping up, ending in a soft hit", durationSec: 1.2 },
};

export const SFX_DEFAULTS = { enabled: true, gain: 0.7, duckDb: -6 };

/** A fresh sfx block for a style's auto map (or the full map when none is given). */
export function scaffoldSfx(auto) {
  const cues = {};
  for (const [name, c] of Object.entries(DEFAULT_CUES)) cues[name] = { ...c, file: null, gain: 1 };
  return { ...SFX_DEFAULTS, cues, auto: { ...FULL_AUTO, ...(auto || {}) } };
}

/** Every event wired — what the beat styles (listicle, flashcard) scaffold. */
export const FULL_AUTO = {
  insert: "whoosh", stamp: "pop", face: "hit", bullet: "tick",
  coverExit: "whoosh", transition: "whoosh", card: "riser", sceneStart: null,
};

/**
 * Bullet reveal time — the SAME formula as remotion-template/src/lib/timing.js
 * `bulletAppearSec`; selftest-sfx.mjs asserts the two agree.
 */
export function bulletAppearSec(bullet, index, count, durationSec) {
  return bullet?.atSec ?? ((index + 1) * (durationSec || 6)) / (count + 1);
}

const secToFrames = (sec, fps) => Math.max(1, Math.round(sec * fps));
const toFrame = (sec, fps) => Math.round(sec * fps);

/**
 * Resolve one event's override + auto map to `{ cue, gain, offsetSec } | null`.
 * `override` is the `sfx` field on the beat/transition/scene/bullet (may be undefined).
 */
export function resolveCue(sfx, event, override) {
  if (override === false) return null;
  let name = null;
  let gain = 1;
  let offsetSec = 0;
  if (typeof override === "string") name = override;
  else if (override && typeof override === "object") {
    name = override.cue ?? sfx?.auto?.[event] ?? null;
    if (override.gain != null) gain = Number(override.gain);
    if (override.offsetSec != null) offsetSec = Number(override.offsetSec);
  } else name = sfx?.auto?.[event] ?? null;
  if (!name) return null;
  return { cue: name, gain, offsetSec };
}

/**
 * Build the absolute SFX track for a props timeline.
 *
 * `timeline` is the reconciled scene list build-props produces (durations
 * already trimmed to the clips); `cover` the resolved cover (or null);
 * `probeSec(file)` returns a cue file's real length so its Sequence covers it.
 * Returns { track: [...], problems: [...] } — problems are missing cue files.
 */
export async function buildSfxTrack(m, { timeline, cover, fps, projectDir, probeSec }) {
  const sfx = m.sfx;
  const track = [];
  const problems = [];
  if (!sfx || sfx.enabled === false || !sfx.cues) return { track, problems };

  const lengths = new Map();
  const fileFor = async (name, where) => {
    const cue = sfx.cues[name];
    if (!cue) { problems.push(`${where}: sfx cue "${name}" is not in sfx.cues`); return null; }
    if (!cue.file) { problems.push(`${where}: sfx cue "${name}" has no file yet — run gen/sfx.mjs --all`); return null; }
    const abs = resolveIn(projectDir, cue.file);
    if (!abs || !existsSync(abs)) { problems.push(`${where}: sfx cue "${name}" file not found at ${cue.file}`); return null; }
    if (!lengths.has(name)) lengths.set(name, (await probeSec?.(abs)) || cue.durationSec || 1);
    return { file: cue.file, cueGain: cue.gain ?? 1, sec: lengths.get(name) };
  };

  const transitionsById = new Map((m.transitions || []).map((t) => [t.after, t]));
  const place = async (event, override, atFrame, where) => {
    const r = resolveCue(sfx, event, override);
    if (!r) return;
    const f = await fileFor(r.cue, where);
    if (!f) return;
    const at = Math.max(0, atFrame + toFrame(r.offsetSec, fps));
    track.push({ cue: r.cue, event, file: f.file, atFrame: at, frames: secToFrames(f.sec, fps), gain: r.gain * f.cueGain });
  };

  // Cover exit: the card holds for holdSec, then wipes — the whoosh rides the wipe.
  if (cover) {
    const hold = cover.holdSec ?? (cover.kind === "frame" ? 0.45 : 0.5);
    await place("coverExit", cover.sfx, toFrame(hold, fps), "cover");
  }

  let cursor = 0;
  for (const [i, scene] of timeline.entries()) {
    const frames = secToFrames(scene.durationSec || 0, fps);
    const where = `scene "${scene.id}"`;
    const from = cursor;

    if (scene.kind === "card") await place("card", scene.sfx, from, where);
    else await place("sceneStart", scene.sfx, from, where);

    for (const [bi, b] of (scene.beats || []).entries()) {
      const at = from + toFrame(b.atSec || 0, fps);
      const bwhere = `${where} beats[${bi}]`;
      if (b.shot === "insert") await place("insert", b.sfx, at, bwhere);
      else if (b.shot === "face") await place("face", b.sfx, at, bwhere);
      else if (b.shot === "card") await place("card", b.sfx, at, bwhere);
      // screen/split beats are not auto events, but an explicit cue on one
      // ("sfx": "whoosh" on a hard jump) still plays.
      else if (b.sfx) await place("beat", b.sfx, at, bwhere);
      // A stamp is its own event: an insert with "#1" gets whoosh + pop, unless
      // the beat's override already spoke for the whole beat.
      if (b.stamp && b.sfx === undefined) await place("stamp", undefined, at, bwhere);
    }

    const bullets = scene.bottom?.kind === "bullets" ? scene.bottom.bullets || [] : [];
    for (const [bi, bl] of bullets.entries()) {
      const at = from + toFrame(bulletAppearSec(bl, bi, bullets.length, scene.durationSec), fps);
      await place("bullet", bl.sfx ?? scene.bottom.sfx, at, `${where} bullets[${bi}]`);
    }

    cursor += frames;
    const t = transitionsById.get(scene.id);
    if (t && i < timeline.length - 1) {
      cursor -= secToFrames((t.ms || 400) / 1000, fps);
      // The transition begins where the next scene starts (the overlap).
      await place("transition", t.sfx, cursor, `transition after "${scene.id}"`);
    }
  }

  // Two identical cues within 3 frames (a transition landing on an insert) is
  // a double-hit — keep the first.
  track.sort((a, b) => a.atFrame - b.atFrame);
  const deduped = [];
  for (const c of track) {
    const last = deduped[deduped.length - 1];
    if (last && last.file === c.file && c.atFrame - last.atFrame <= 3) continue;
    deduped.push(c);
  }
  return { track: deduped, problems };
}

/** Cues declared but not generated yet. */
export function missingCues(m) {
  if (!m?.sfx || m.sfx.enabled === false) return [];
  return Object.entries(m.sfx.cues || {}).filter(([, c]) => !c?.file).map(([n]) => n);
}

/** Cue names the auto map and overrides reference. */
export function referencedCues(m) {
  const names = new Set();
  const add = (v) => {
    if (typeof v === "string") names.add(v);
    else if (v && typeof v === "object" && v.cue) names.add(v.cue);
  };
  for (const v of Object.values(m?.sfx?.auto || {})) add(v);
  if (m?.cover) add(m.cover.sfx);
  for (const t of m?.transitions || []) add(t.sfx);
  for (const s of m?.timeline || []) {
    add(s.sfx);
    for (const b of s.beats || []) add(b.sfx);
    add(s.bottom?.sfx);
    for (const bl of s.bottom?.bullets || []) add(bl.sfx);
  }
  return [...names];
}
