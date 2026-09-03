#!/usr/bin/env node
/**
 * Build a layered "meme composite" clip for one scene from a declarative
 * `composite` block on that scene — a background plate, video/image layers
 * placed on the canvas (slow-mo, crop, alpha cutouts, freeze on the last
 * frame), a timed push-in, and a mixed audio track (a layer's own audio plus
 * a music cue). Writes `clips/<scene-id>.mp4` and points the scene at it.
 *
 *   node scripts/edit/composite.mjs --project demo/<slug> --manifest shorts.json --scene s-meme
 *   node scripts/edit/composite.mjs --project demo/<slug> --manifest shorts.json --all
 *
 * Scene block (all paths relative to the project dir, or absolute):
 *
 *   "composite": {
 *     "durationSec": 6.3,
 *     "size": "frame",                       // "frame" (format w×h) | "pane" (top pane of an anchored split) | [w, h]
 *     "plate": { "image": "assets/meme/hall.png", "brightness": -0.05 },   // or { "color": "#0B0D12" }
 *     "layers": [
 *       { "src": "../meme/chamath.webm", "speed": 0.44, "crop": [1200, 1080, 290, 0],
 *         "fit": { "h": 1000 }, "at": ["center", -40], "freezeEnd": true },
 *       { "src": "../meme/sacks.mp4", "region": [0, 960, 1080, 960], "audio": true, "freezeEnd": true }
 *     ],
 *     "zoom": { "fromSec": 2.8, "toSec": 6.1, "factor": 1.95, "focus": [540, 420], "ease": "out" },
 *     "music": { "src": "assets/meme/violin.wav", "atSec": 2.6, "fadeInSec": 0.4, "gain": 1.1, "fadeOutSec": 0.5 }
 *   }
 *
 * Layer fields: `src` (mp4/webm/png; a .webm or `alpha: true` is decoded with
 * its alpha channel), `speed` (0.5 = half speed), `crop` [w,h,x,y] on the
 * source, then EITHER `region` [x,y,w,h] on the canvas with `fill` cover|contain
 * (default cover) OR `fit` {h}|{w} plus `at` [x,y] ("center" allowed for x).
 * `startSec` delays the layer's entry; `freezeEnd` holds its last frame until
 * the clip ends; `audio: true` mixes the layer's own soundtrack in (delayed by
 * `startSec`); `opacity` 0–1.
 *
 * Zoom is a pixel-sharp push-in: the canvas is composited at 2× and `zoompan`
 * crops back to the output size, easing from 1 to `factor` between `fromSec`
 * and `toSec`, keeping `focus` (canvas px) centred. `ease`: out | in | linear.
 *
 * The scene is patched: `video`, `durationSec` (when it has no narration),
 * `muteSource: false` when any audio was mixed, `captions: false` and
 * `zoomToClick: false` unless already set. Beats/presenter scenes stay muted
 * by the renderer, so give a composite with audio a plain `demo` scene and
 * use `size: "pane"` for one that rides the top of an anchored split.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs, fail } from "../lib/args.mjs";
import { ffmpeg, probe } from "../lib/ff.mjs";
import * as manifest from "../lib/manifest.mjs";
import { report, info, warn, main } from "../lib/log.mjs";

const USAGE =
  "composite.mjs --project <dir> [--manifest <file>] (--scene <id> | --all) [--supersample 2]";

const ms = (sec) => Math.round(sec * 1000);
const px = (v, s) => Math.round(v * s);

/** Resolve a size spec against the manifest format (and the scene's split). */
function canvasSize(spec, m, scene) {
  const W = m.format?.width ?? 1920;
  const H = m.format?.height ?? 1080;
  if (Array.isArray(spec)) return [spec[0], spec[1]];
  if (spec === "pane") {
    const pct = scene.splitPct ?? 0.42;
    return [W, Math.round(H * pct)];
  }
  return [W, H];
}

function easeExpr(kind, p) {
  if (kind === "in") return `pow(${p},2)`;
  if (kind === "linear") return p;
  return `(1-pow(1-${p},2))`; // out
}

/** Build ffmpeg args for one scene's composite. Returns { args, hasAudio }. */
export function buildArgs({ comp, out, fps, size, resolveFile }) {
  const dur = comp.durationSec;
  if (!dur || dur <= 0) throw new Error("composite.durationSec is required");
  const [OW, OH] = size;
  const S = comp.zoom ? Number(comp.supersample ?? 2) : 1;
  const W = OW * S;
  const H = OH * S;

  const inputs = [];
  const filters = [];
  const audio = [];
  let n = 0;

  // Plate
  let bgLabel;
  if (comp.plate?.image) {
    inputs.push("-loop", "1", "-framerate", String(fps), "-t", String(dur), "-i", resolveFile(comp.plate.image));
    const b = comp.plate.brightness ? `,eq=brightness=${comp.plate.brightness}` : "";
    filters.push(`[${n}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}${b},setsar=1[bg]`);
    n++;
    bgLabel = "bg";
  } else {
    const color = (comp.plate?.color ?? "#000000").replace("#", "0x");
    filters.push(`color=c=${color}:s=${W}x${H}:r=${fps}:d=${dur}[bg]`);
    bgLabel = "bg";
  }

  // Layers
  let last = bgLabel;
  (comp.layers ?? []).forEach((L, i) => {
    const file = resolveFile(L.src);
    const alpha = L.alpha ?? /\.webm$/i.test(file);
    const isImage = /\.(png|jpe?g|webp)$/i.test(file);
    if (isImage) inputs.push("-loop", "1", "-framerate", String(fps), "-t", String(dur));
    if (alpha) inputs.push("-c:v", "libvpx-vp9");
    inputs.push("-i", file);
    const idx = n++;

    const chain = [];
    if (L.speed && L.speed !== 1) chain.push(`setpts=PTS/${L.speed}`);
    chain.push(`fps=${fps}`);
    if (L.crop) chain.push(`crop=${L.crop[0]}:${L.crop[1]}:${L.crop[2] ?? 0}:${L.crop[3] ?? 0}`);

    let ox = 0;
    let oy = 0;
    if (L.region) {
      const [rx, ry, rw, rh] = L.region;
      const mode = L.fill === "contain" ? "decrease" : "increase";
      chain.push(`scale=${px(rw, S)}:${px(rh, S)}:force_original_aspect_ratio=${mode}`);
      if (mode === "increase") chain.push(`crop=${px(rw, S)}:${px(rh, S)}`);
      else chain.push(`pad=${px(rw, S)}:${px(rh, S)}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
      ox = px(rx, S);
      oy = px(ry, S);
    } else if (L.fit) {
      if (L.fit.h) chain.push(`scale=-2:${px(L.fit.h, S)}`);
      else if (L.fit.w) chain.push(`scale=${px(L.fit.w, S)}:-2`);
      const [ax = "center", ay = 0] = L.at ?? [];
      ox = ax === "center" ? "(W-w)/2" : px(ax, S);
      oy = ay === "center" ? "(H-h)/2" : px(ay, S);
    } else {
      chain.push(`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`);
    }
    if (alpha || L.fill === "contain") chain.push("format=rgba");
    if (L.opacity !== undefined && L.opacity < 1) chain.push(`format=rgba,colorchannelmixer=aa=${L.opacity}`);
    if (L.freezeEnd) chain.push(`tpad=stop_mode=clone:stop_duration=${dur}`);
    if (L.startSec) chain.push(`setpts=PTS+${L.startSec}/TB`);
    chain.push("setsar=1");
    const lab = `l${i}`;
    filters.push(`[${idx}:v]${chain.join(",")}[${lab}]`);
    const enable = L.startSec ? `:enable='gte(t,${L.startSec})'` : "";
    filters.push(`[${last}][${lab}]overlay=${ox}:${oy}:eof_action=pass:format=auto${enable}[v${i}]`);
    last = `v${i}`;

    if (L.audio) {
      const a = [];
      if (L.startSec) a.push(`adelay=${ms(L.startSec)}|${ms(L.startSec)}`);
      if (L.gain && L.gain !== 1) a.push(`volume=${L.gain}`);
      a.push("aresample=48000");
      filters.push(`[${idx}:a]${a.join(",")}[a${i}]`);
      audio.push(`a${i}`);
    }
  });

  // Zoom / output scaling
  const tail = [];
  if (comp.zoom) {
    const z = comp.zoom;
    const f0 = Math.round((z.fromSec ?? 0) * fps);
    const f1 = Math.max(f0 + 1, Math.round((z.toSec ?? dur) * fps));
    const p = `min((in-${f0})/${f1 - f0},1)`;
    const zexpr = `if(lt(in,${f0}),1,1+${(z.factor ?? 1.5) - 1}*${easeExpr(z.ease, p)})`;
    const [fx = OW / 2, fy = OH / 2] = z.focus ?? [];
    const x = `min(max(0,${px(fx, S)}-(iw/zoom)/2),iw-iw/zoom)`;
    const y = `min(max(0,${px(fy, S)}-(ih/zoom)/2),ih-ih/zoom)`;
    tail.push(`zoompan=z='${zexpr}':x='${x}':y='${y}':d=1:s=${OW}x${OH}:fps=${fps}`);
  } else if (S !== 1) {
    tail.push(`scale=${OW}:${OH}`);
  }
  tail.push("format=yuv420p", `trim=duration=${dur}`);
  filters.push(`[${last}]${tail.join(",")}[vout]`);

  // Music
  if (comp.music?.src) {
    inputs.push("-i", resolveFile(comp.music.src));
    const idx = n++;
    const M = comp.music;
    const at = M.atSec ?? 0;
    const a = [];
    if (M.startSec) a.push(`atrim=start=${M.startSec}`, "asetpts=PTS-STARTPTS");
    if (at) a.push(`adelay=${ms(at)}|${ms(at)}`);
    if (M.fadeInSec) a.push(`afade=t=in:st=${at}:d=${M.fadeInSec}`);
    if (M.gain && M.gain !== 1) a.push(`volume=${M.gain}`);
    a.push("aresample=48000");
    filters.push(`[${idx}:a]${a.join(",")}[am]`);
    audio.push("am");
  }

  const hasAudio = audio.length > 0;
  if (hasAudio) {
    const fadeOut = comp.music?.fadeOutSec ?? comp.fadeOutSec ?? 0;
    const fo = fadeOut ? `,afade=t=out:st=${Math.max(0, dur - fadeOut)}:d=${fadeOut}` : "";
    const mix =
      audio.length === 1
        ? `[${audio[0]}]anull${fo},atrim=duration=${dur}[aout]`
        : `[${audio.map((a) => `[${a}]`).join("")}amix=inputs=${audio.length}:duration=longest:normalize=0${fo},atrim=duration=${dur}[aout]`.replace(/^\[\[/, "[");
    filters.push(mix.startsWith("[[") ? mix.slice(1) : mix);
  }

  const args = [
    ...inputs,
    "-filter_complex", filters.join(";\n"),
    "-map", "[vout]",
    ...(hasAudio ? ["-map", "[aout]", "-c:a", "aac", "-b:a", "160k"] : ["-an"]),
    "-t", String(dur),
    "-r", String(fps),
    "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    out,
  ];
  return { args, hasAudio, supersample: S };
}

async function buildScene(projectDir, m, scene) {
  const comp = scene.composite;
  if (!comp) throw new Error(`scene ${scene.id} has no composite block`);
  const fps = m.format?.fps ?? 30;
  const size = canvasSize(comp.size ?? "frame", m, scene);
  const out = manifest.resolveIn(projectDir, `clips/${scene.id}.mp4`);
  await mkdir(path.dirname(out), { recursive: true });
  const resolveFile = (p) => (path.isAbsolute(p) ? p : manifest.resolveIn(projectDir, p));
  const { args, hasAudio, supersample } = buildArgs({ comp, out, fps, size, resolveFile });
  info(`  compositing ${scene.id}: ${size[0]}x${size[1]} @${fps} ${comp.durationSec}s, ${comp.layers?.length ?? 0} layer(s)${comp.zoom ? `, zoom ×${comp.zoom.factor} (${supersample}× supersampled)` : ""}${hasAudio ? ", audio" : ""}`);
  await ffmpeg(args);
  const meta = await probe(out);
  const patch = { video: manifest.relativeIn(projectDir, out) };
  if (!scene.narration) patch.durationSec = comp.durationSec;
  if (hasAudio) patch.muteSource = false;
  if (scene.captions === undefined && !scene.narration) patch.captions = false;
  if (scene.zoomToClick === undefined) patch.zoomToClick = false;
  if (scene.narration && scene.durationSec && comp.durationSec < scene.durationSec) {
    warn(`${scene.id}: composite (${comp.durationSec}s) is shorter than the narration (${scene.durationSec}s) — the renderer will hold its last frame`);
  }
  return { patch, durationSec: meta.duration, hasAudio, video: out };
}

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = manifest.resolveProjectDir(args.project);
  const name = args.manifest || manifest.MANIFEST_NAME;
  const m = await manifest.load(projectDir, { name });
  const targets = args.all
    ? m.timeline.filter((s) => s.composite)
    : args.scene
      ? [manifest.getScene(m, args.scene)].filter(Boolean)
      : fail("pass --scene <id> or --all", USAGE);
  if (!targets.length) fail(args.all ? "no scenes carry a composite block" : `scene ${args.scene} not found`, USAGE);
  if (args.supersample) for (const s of targets) s.composite.supersample = Number(args.supersample);

  const results = [];
  for (const scene of targets) {
    const r = await buildScene(projectDir, m, scene);
    await manifest.update(projectDir, (mm) => manifest.patchScene(mm, scene.id, r.patch), { name });
    results.push({ scene: scene.id, video: manifest.relativeIn(projectDir, r.video), durationSec: r.durationSec, audio: r.hasAudio });
  }
  report(`  composited ${results.length} scene(s)`, { ok: true, scenes: results });
});
