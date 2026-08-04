#!/usr/bin/env node
/**
 * Screen capture with an explicit coordinate mapping.
 *
 * Usable as a library (`screenshot()`) or a CLI:
 *   node scripts/capture/screenshot.mjs --out shot.png [--region x,y,w,h] [--max-width 1400]
 *
 * The returned metadata is the contract that keeps clicks accurate:
 *
 *   screenPoints  the region's size in LOGICAL POINTS   (what cliclick uses)
 *   imagePixels   the saved image's size in PIXELS      (what you look at)
 *   origin        the region's top-left in points       (0,0 for a full screen)
 *   scale         imagePixels / screenPoints            (2.0 on a Retina display)
 *
 * The Retina scale is MEASURED, never assumed: we compare the captured pixel size
 * against the logical desktop size. Mixed-DPI setups and non-default scaled modes
 * both break the "it's always 2x" assumption.
 */
import path from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "../lib/args.mjs";
import { desktopBounds } from "../lib/mac.mjs";
import { report, main } from "../lib/log.mjs";

const execFileAsync = promisify(execFile);

/**
 * Capture the screen (or a region) and report the mapping.
 * `region` is { x, y, w, h } in POINTS — pass a window's bounds to frame it.
 */
export async function screenshot(outPath, { region = null, maxWidth = null } = {}) {
  const abs = path.resolve(outPath);
  await mkdir(path.dirname(abs), { recursive: true });

  const args = ["-x"]; // -x: no camera sound
  if (region) args.push("-R", `${region.x},${region.y},${region.w},${region.h}`);
  args.push(abs);

  try {
    await execFileAsync("screencapture", args, { timeout: 20_000 });
  } catch (e) {
    const msg = `${e.stderr || e.message}`.trim();
    if (/could not create image/i.test(msg)) {
      throw new Error(
        "Screen Recording permission is not granted. Enable it for your terminal " +
        "under System Settings > Privacy & Security > Screen & System Audio Recording, " +
        "then restart the terminal."
      );
    }
    throw new Error(`screencapture failed: ${msg}`);
  }

  if (!existsSync(abs)) throw new Error("screencapture produced no file");

  const sharp = (await import("sharp")).default;
  let meta = await sharp(abs).metadata();

  // Logical size of what we captured.
  const desktop = await desktopBounds();
  const points = region
    ? { width: region.w, height: region.h }
    : { width: desktop.width, height: desktop.height };

  const fullScale = meta.width / points.width;

  // Optionally downscale for model consumption. The mapping is recomputed from
  // the FINAL image size, so callers never have to compose two scale factors.
  if (maxWidth && meta.width > maxWidth) {
    const buf = await sharp(abs).resize({ width: maxWidth }).png().toBuffer();
    await sharp(buf).toFile(abs);
    meta = await sharp(abs).metadata();
  }

  return {
    path: abs,
    imagePixels: { width: meta.width, height: meta.height },
    screenPoints: { width: points.width, height: points.height },
    origin: region ? { x: region.x, y: region.y } : { x: 0, y: 0 },
    scale: meta.width / points.width,
    retinaScale: fullScale,
  };
}

/**
 * Fraction of pixels that differ between two images (0..1).
 *
 * Both images are downscaled to a common width so polling stays cheap; a pixel
 * counts as changed when any channel moves by more than `threshold` (out of 255),
 * which ignores compression noise but not real screen updates. Returns 1 when
 * the images cannot be compared (different aspect, unreadable file).
 */
export async function diffFraction(fileA, fileB, { width = 640, threshold = 12 } = {}) {
  const sharp = (await import("sharp")).default;
  const load = (f) =>
    sharp(f).resize({ width }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  let a;
  let b;
  try {
    [a, b] = await Promise.all([load(fileA), load(fileB)]);
  } catch {
    return 1;
  }
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) return 1;

  const ch = a.info.channels;
  const total = a.info.width * a.info.height;
  let changed = 0;
  for (let i = 0; i < a.data.length; i += ch) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2])
    );
    if (d > threshold) changed++;
  }
  return changed / total;
}

/** Probe the display's backing scale factor without keeping the image. */
export async function detectScale() {
  const tmp = path.join(process.env.TMPDIR || "/tmp", `demoday-scale-${process.pid}.png`);
  try {
    const shot = await screenshot(tmp);
    return shot.retinaScale;
  } finally {
    if (existsSync(tmp)) await unlink(tmp).catch(() => {});
  }
}

// ---- CLI -------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(async () => {
    const args = parseArgs(process.argv.slice(2));
    const out = args.out || "screenshot.png";
    let region = null;
    if (args.region) {
      const [x, y, w, h] = String(args.region).split(",").map(Number);
      region = { x, y, w, h };
    }
    const shot = await screenshot(out, {
      region,
      maxWidth: args["max-width"] ? Number(args["max-width"]) : null,
    });
    report(
      `  ${shot.path}  ${shot.imagePixels.width}x${shot.imagePixels.height}px ` +
      `for ${shot.screenPoints.width}x${shot.screenPoints.height}pt (scale ${shot.scale.toFixed(2)})`,
      { ok: true, ...shot }
    );
  });
}
