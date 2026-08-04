/**
 * A desktop capture session: real clicks, real keystrokes, real screen recording.
 *
 * Mirrors WebSession's interface (prepare/screenshot/perform/record/close) so
 * mac-perform.mjs and web-perform.mjs are the same program with a different
 * backend, and so the iOS and terminal targets can slot in later without changing
 * the action-script format.
 *
 * Differences from the web backend, all forced by the medium:
 *   - the cursor is REAL, so there is nothing to draw (avfoundation captures it)
 *   - there are no selectors, only coordinates, so steps carry anchor screenshots
 *   - the recording is of a display, cropped to the window, rather than of a page
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { startRecorder, stopRecorder, probe, which } from "../lib/ff.mjs";
import { screenshot, diffFraction } from "./screenshot.mjs";
import * as input from "./mac-input.mjs";
import { Stage } from "./mac-stage.mjs";
import { desktopBounds } from "../lib/mac.mjs";
import * as motion from "../lib/cursor.mjs";
import { info, warn } from "../lib/log.mjs";

export class MacSession {
  constructor({ app = null, width = 1920, height = 1080, x = 60, y = 80, fps = 30 } = {}) {
    Object.assign(this, { app, width, height, x, y, fps });
    this.stage = new Stage();
    this.window = null;
    this.recorder = null;
    this.events = [];
    this.t0 = null;
    this.recordStart = null;
    this.scale = 2;
  }

  async start() {
    this.window = await this.stage.prepare({
      app: this.app, width: this.width, height: this.height, x: this.x, y: this.y,
    });
    // Measure, don't assume: a probe screenshot tells us the real backing scale.
    const probeShot = await screenshot(
      path.join(process.env.TMPDIR || "/tmp", `demoday-probe-${process.pid}.png`)
    );
    this.scale = probeShot.retinaScale;
    info(`  display scale: ${this.scale.toFixed(2)}x`);
    return this;
  }

  markStart() {
    this.t0 = Date.now();
    this.events = [];
  }

  nowMs() {
    return this.t0 ? Date.now() - this.t0 : 0;
  }

  logEvent(type, extra = {}) {
    this.events.push({ type, atMs: this.nowMs(), ...extra });
  }

  /** The region we record, in points. Defaults to the whole desktop. */
  async region() {
    if (this.window?.bounds) {
      const b = this.window.bounds;
      return { x: b.x, y: b.y, w: b.w, h: b.h };
    }
    const d = await desktopBounds();
    return { x: 0, y: 0, w: d.width, h: d.height };
  }

  async screenshot(file, { maxWidth = null } = {}) {
    return screenshot(file, { region: await this.region(), maxWidth });
  }

  // ---- recording -----------------------------------------------------------

  /**
   * Start recording the display, cropped to the target window.
   *
   * avfoundation captures the whole display in PIXELS, so the crop rectangle is
   * the window's point bounds multiplied by the measured backing scale. Crop
   * dimensions are forced even because h264 rejects odd ones.
   */
  async startRecording(outPath) {
    const device = await this.screenDevice();
    const r = await this.region();
    const s = this.scale;
    const even = (n) => Math.max(2, Math.round(n) - (Math.round(n) % 2));

    const cropW = even(r.w * s);
    const cropH = even(r.h * s);
    const cropX = Math.round(r.x * s);
    const cropY = Math.round(r.y * s);

    await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });

    this.recorder = startRecorder([
      "-f", "avfoundation",
      "-capture_cursor", "1",
      "-capture_mouse_clicks", "1",
      "-framerate", String(this.fps),
      "-i", `${device}:none`,
      "-vf", `crop=${cropW}:${cropH}:${cropX}:${cropY},format=yuv420p`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-movflags", "+faststart",
      path.resolve(outPath),
    ]);
    this.recordStart = Date.now();
    this.recordPath = path.resolve(outPath);

    // Give the encoder a moment to open the device before the demo begins,
    // otherwise the first second of the performance is missing from the file.
    await motion.sleep(1200);
    return this.recordPath;
  }

  /** Find avfoundation's screen-capture device index. */
  async screenDevice() {
    if (!(await which("ffmpeg"))) throw new Error("ffmpeg not found — brew install ffmpeg");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    // This command always exits non-zero; the device list is on stderr.
    const res = await run("ffmpeg", [
      "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", "",
    ]).catch((e) => e);
    const listing = String(res.stderr || "");
    const match = listing.match(/\[(\d+)\]\s+Capture screen/i);
    if (!match) {
      throw new Error(
        "No avfoundation screen device found. This usually means Screen Recording " +
        "permission is not granted to your terminal."
      );
    }
    return match[1];
  }

  async stopRecording() {
    if (!this.recorder) return null;
    await stopRecorder(this.recorder);
    this.recorder = null;
    const meta = await probe(this.recordPath).catch(() => null);
    return { path: this.recordPath, meta };
  }

  // ---- steps ---------------------------------------------------------------

  /**
   * Execute one step. Desktop steps address the screen by point, either absolute
   * or relative to the recorded window (`windowPoint`), which is what makes a
   * rehearsed script survive the window being at a different position next time.
   */
  async perform(step) {
    const r = await this.region();
    const toScreen = (p, relative) =>
      relative ? { x: r.x + p[0], y: r.y + p[1] } : { x: p[0], y: p[1] };

    switch (step.type) {
      case "click": {
        const pt = step.windowPoint
          ? toScreen(step.windowPoint, true)
          : toScreen(step.point, false);
        await input.click(pt.x, pt.y, { double: step.clickCount === 2 });
        this.logEvent("click", {
          x: pt.x - r.x, y: pt.y - r.y,   // logged relative to the frame
          label: step.label || "click",
        });
        break;
      }

      case "hover": {
        const pt = step.windowPoint ? toScreen(step.windowPoint, true) : toScreen(step.point, false);
        await input.glideTo(pt.x, pt.y);
        this.logEvent("hover", { x: pt.x - r.x, y: pt.y - r.y, label: step.label || "hover" });
        break;
      }

      case "type":
        await input.type(step.text, { cps: step.cps });
        this.logEvent("type", { text: step.text, label: step.label || "type" });
        break;

      case "key":
        await input.key(step.key);
        this.logEvent("key", { key: step.key, label: step.label || step.key });
        break;

      case "scroll":
        await input.scroll(step.dy ?? 400, { durationMs: step.intrinsicMs || 700 });
        this.logEvent("scroll", { dy: step.dy ?? 400, label: step.label || "scroll" });
        break;

      case "wait":
      case "dwell":
        await motion.sleep(step.intrinsicMs || 0);
        break;

      case "waitStable": {
        // Wait for the window to stop changing — the primitive that lets a demo
        // sit through work whose duration nobody controls (a build, a model).
        // The diff tolerance absorbs a blinking cursor; anything that animates
        // while working (a spinner, a timer) keeps this from firing early.
        const minMs = step.minMs ?? 1000;
        const maxMs = step.maxMs ?? 90_000;
        const need = step.stableFrames ?? 3;
        const intervalMs = step.intervalMs ?? 500;
        const tolerance = step.tolerance ?? 0.004;

        const tmpDir = process.env.TMPDIR || "/tmp";
        const shots = [
          path.join(tmpDir, `demoday-stable-a-${process.pid}.png`),
          path.join(tmpDir, `demoday-stable-b-${process.pid}.png`),
        ];

        const started = Date.now();
        let prev = null;
        let flip = 0;
        let stable = 0;
        let timedOut = false;

        for (;;) {
          if (Date.now() - started >= maxMs) {
            timedOut = true;
            break;
          }
          await motion.sleep(intervalMs);
          flip ^= 1;
          const cur = shots[flip];
          await screenshot(cur, { region: r });
          if (prev) {
            const frac = await diffFraction(prev, cur);
            stable = frac < tolerance ? stable + 1 : 0;
          }
          prev = cur;
          if (stable >= need && Date.now() - started >= minMs) break;
        }

        const waitedMs = Date.now() - started;
        if (timedOut) {
          warn(
            `waitStable${step.label ? ` (${step.label})` : ""} hit its ${maxMs}ms ceiling ` +
            `while the screen was still changing — continuing anyway.`
          );
        }
        this.logEvent("waitStable", { waitedMs, timedOut, label: step.label || "waitStable" });
        break;
      }

      case "highlight":
        // No DOM to ring on the desktop — the renderer draws this overlay instead,
        // driven by the event log, so we only need to hold and record the moment.
        this.logEvent("highlight", {
          x: step.windowPoint?.[0] ?? null,
          y: step.windowPoint?.[1] ?? null,
          width: step.width ?? null,
          height: step.height ?? null,
          label: step.label || "highlight",
        });
        await motion.sleep(step.intrinsicMs || 1200);
        break;

      case "goto":
        warn(`"goto" is a web-only step; ignoring it in a desktop scene.`);
        break;

      default:
        throw new Error(`Unsupported step type for the desktop backend: ${step.type}`);
    }
  }

  /** Stop recording and put the desktop back. Always safe to call. */
  async close() {
    let recorded = null;
    try {
      recorded = await this.stopRecording();
    } finally {
      await this.stage.restore();
    }
    return { video: recorded?.path || null, meta: recorded?.meta || null, events: this.events };
  }
}
