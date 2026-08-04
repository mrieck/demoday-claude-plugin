/**
 * A live browser session with a drawn cursor, used by BOTH passes:
 *
 *   MCP server (rehearsal)  -> new WebSession({ record: false }), model in the loop
 *   web-perform.mjs         -> new WebSession({ record: true }),  no model, records
 *
 * Sharing one implementation is deliberate: if rehearsal and performance resolved
 * selectors or clicked differently, a rehearsed demo could fail only when recording,
 * which is exactly when it is most expensive to discover.
 */
import path from "node:path";
import { mkdir, rename, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CURSOR_INIT_SCRIPT, STABILISE_CSS } from "../lib/web-cursor.mjs";
import * as motion from "../lib/cursor.mjs";
import { ffmpeg, probe } from "../lib/ff.mjs";
import { info, warn } from "../lib/log.mjs";

export class WebSession {
  constructor({
    width = 1920,
    height = 1080,
    deviceScaleFactor = 2,
    record = false,
    outDir = null,
    headless = false,
    storageState = null,
    baseUrl = null,
  } = {}) {
    Object.assign(this, {
      width, height, deviceScaleFactor, record, outDir, headless, storageState, baseUrl,
    });
    this.browser = null;
    this.context = null;
    this.page = null;
    this.events = [];
    this.cursorPos = { x: Math.round(width / 2), y: Math.round(height * 0.6) };
    this.t0 = null;          // wall clock at which the performance proper began
    this.contextStart = null; // wall clock at which recording began
  }

  async start() {
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({
      headless: this.headless,
      args: ["--hide-scrollbars", "--force-device-scale-factor=1"],
    });

    const contextOpts = {
      viewport: { width: this.width, height: this.height },
      deviceScaleFactor: this.deviceScaleFactor,
      ignoreHTTPSErrors: true,
      // A stable, neutral locale/timezone keeps dates and number formats from
      // varying between takes, which would otherwise show up as diffs on screen.
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "no-preference",
    };
    if (this.storageState && existsSync(this.storageState)) {
      contextOpts.storageState = this.storageState;
    }
    if (this.record) {
      if (!this.outDir) throw new Error("record: true requires an outDir");
      await mkdir(this.outDir, { recursive: true });
      contextOpts.recordVideo = {
        dir: path.join(this.outDir, ".rawvideo"),
        size: { width: this.width, height: this.height },
      };
    }

    this.context = await this.browser.newContext(contextOpts);
    this.contextStart = Date.now();

    await this.context.addInitScript(CURSOR_INIT_SCRIPT);
    this.page = await this.context.newPage();
    await this.page.addStyleTag({ content: STABILISE_CSS }).catch(() => {});
    await this.page.setDefaultTimeout(15_000);
    return this;
  }

  /**
   * Mark the start of the performance. Everything recorded before this — browser
   * chrome settling, the first navigation, login — gets trimmed off the front.
   */
  markStart() {
    this.t0 = Date.now();
    this.events = [];
  }

  /** Milliseconds since the performance began (not since the recording began). */
  nowMs() {
    return this.t0 ? Date.now() - this.t0 : 0;
  }

  logEvent(type, extra = {}) {
    this.events.push({ type, atMs: this.nowMs(), ...extra });
  }

  // ---- element resolution --------------------------------------------------

  /**
   * Try each selector in the ladder until one resolves to a visible element.
   * Returns { locator, selector, box }. Throws listing everything it tried, so a
   * failure during performance tells you exactly which fallbacks were stale.
   */
  async resolve(selectors, { timeout = 8000 } = {}) {
    const tried = [];
    for (const sel of selectors) {
      try {
        const locator = this.page.locator(sel).first();
        await locator.waitFor({ state: "visible", timeout: timeout / selectors.length });
        const box = await locator.boundingBox();
        if (box) return { locator, selector: sel, box };
        tried.push(`${sel} (no bounding box)`);
      } catch (e) {
        tried.push(`${sel} (${e.name === "TimeoutError" ? "not visible" : e.message.split("\n")[0]})`);
      }
    }
    throw new Error(`No selector resolved. Tried:\n  - ${tried.join("\n  - ")}`);
  }

  // ---- cursor --------------------------------------------------------------

  /**
   * Run a COSMETIC page-side call that must never be able to stall the capture.
   *
   * Everything the drawn cursor does goes through here. `page.evaluate` has no
   * default timeout, so a page that stops servicing script — a stalled rAF, a
   * navigation landing mid-call, a busy main thread — would otherwise hang the
   * recording indefinitely. Losing a ripple is acceptable; losing the take is not.
   */
  async safeEval(fn, arg, timeoutMs = 2000) {
    try {
      await Promise.race([
        this.page.evaluate(fn, arg),
        motion.sleep(timeoutMs).then(() => { throw new Error("cosmetic eval timed out"); }),
      ]);
    } catch {
      /* cosmetic only — never propagate */
    }
  }

  /**
   * Glide the drawn cursor to a point, moving the real mouse along the same path.
   *
   * The drawn cursor animates inside the page from a single fire-and-forget call;
   * the real mouse is moved at a much coarser rate purely so :hover and mouseenter
   * fire. Node owns the clock throughout — we sleep for the intended duration
   * rather than waiting for the page to report that it finished animating.
   */
  async glideTo(x, y, { durationMs } = {}) {
    const from = this.cursorPos;
    const dist = Math.hypot(x - from.x, y - from.y);
    const ms = durationMs ?? motion.travelDuration(dist);
    const points = motion.path(from, { x, y }, { durationMs: ms });

    await this.safeEval(
      ([pts, dur]) => window.__demodayCursor?.animate(pts, dur),
      [points, ms]
    );

    // ~12 real mouse samples is plenty for hover fidelity and cheap over CDP.
    const stride = Math.max(1, Math.floor(points.length / 12));
    const started = Date.now();
    for (let i = 0; i < points.length; i += stride) {
      const p = points[i];
      await this.page.mouse.move(p.x, p.y).catch(() => {});
      const behind = p.atMs - (Date.now() - started);
      if (behind > 0) await motion.sleep(behind);
    }
    await this.page.mouse.move(x, y).catch(() => {});

    // Hold until the full travel time has elapsed so the visual finishes and the
    // step's duration matches what the pacing calculation assumed.
    const remaining = ms - (Date.now() - started);
    if (remaining > 0) await motion.sleep(remaining);

    this.cursorPos = { x, y };
  }

  // ---- steps ---------------------------------------------------------------

  /** Execute one normalized step from an action script. */
  async perform(step) {
    switch (step.type) {
      case "goto": {
        const url = this.baseUrl && !/^https?:\/\//i.test(step.url)
          ? new URL(step.url, this.baseUrl).toString()
          : step.url;
        await this.page.goto(url, { waitUntil: "domcontentloaded" });
        // Re-apply after navigation: addStyleTag does not survive a page load.
        await this.page.addStyleTag({ content: STABILISE_CSS }).catch(() => {});
        await this.safeEval(
          ([x, y]) => window.__demodayCursor?.place(x, y),
          [this.cursorPos.x, this.cursorPos.y]
        );
        this.logEvent("goto", { url, label: step.label || url });
        break;
      }

      case "click": {
        const target = await this.targetPoint(step);
        await this.glideTo(target.x, target.y);
        await this.safeEval(() => window.__demodayCursor?.click());
        await this.page.mouse.click(target.x, target.y, {
          button: step.button || "left",
          clickCount: step.clickCount || 1,
        });
        this.logEvent("click", {
          x: target.x, y: target.y,
          label: step.label || step.selectors?.[0] || "click",
          selector: target.selector || null,
        });
        break;
      }

      case "hover": {
        const target = await this.targetPoint(step);
        await this.glideTo(target.x, target.y);
        this.logEvent("hover", { x: target.x, y: target.y, label: step.label || "hover" });
        break;
      }

      case "type": {
        if (step.selectors?.length) {
          const { locator, box, selector } = await this.resolve(step.selectors);
          await this.glideTo(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
          await this.safeEval(() => window.__demodayCursor?.click());
          await locator.click();
          this.logEvent("focus", { selector, label: step.label || selector });
        }
        // Character-by-character with human cadence — pressSequentially would use a
        // fixed delay, which reads as a machine typing.
        for (const { ch, delayMs } of motion.typingPlan(step.text, { cps: step.cps })) {
          await this.page.keyboard.type(ch);
          await motion.sleep(delayMs);
        }
        this.logEvent("type", { text: step.text, label: step.label || "type" });
        break;
      }

      case "key": {
        await this.page.keyboard.press(step.key);
        this.logEvent("key", { key: step.key, label: step.label || step.key });
        break;
      }

      case "scroll": {
        await this.smoothScroll(step.dy ?? 400, step.dx ?? 0, step.intrinsicMs || 700);
        this.logEvent("scroll", { dy: step.dy ?? 400, label: step.label || "scroll" });
        break;
      }

      case "highlight": {
        const { box } = await this.resolve(step.selectors);
        await this.safeEval((r) => window.__demodayCursor?.ring(r), box);
        await motion.sleep(step.intrinsicMs || 1200);
        await this.safeEval(() => window.__demodayCursor?.ring(null));
        this.logEvent("highlight", {
          x: Math.round(box.x + box.width / 2),
          y: Math.round(box.y + box.height / 2),
          width: Math.round(box.width), height: Math.round(box.height),
          label: step.label || "highlight",
        });
        break;
      }

      case "wait":
      case "dwell": {
        if (step.selector && step.type === "wait") {
          await this.page.locator(step.selector).first()
            .waitFor({ state: step.state || "visible" });
        } else {
          await motion.sleep(step.intrinsicMs || 0);
        }
        break;
      }

      default:
        throw new Error(`Unsupported step type: ${step.type}`);
    }
  }

  /** Where a step points: an explicit point, or the centre of a resolved element. */
  async targetPoint(step) {
    if (step.point) return { x: step.point[0], y: step.point[1], selector: null };
    const { box, selector } = await this.resolve(step.selectors || []);
    return {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      selector,
    };
  }

  /** Eased scrolling — a single jump reads as a cut, and CSS smooth scroll is off. */
  async smoothScroll(dy, dx = 0, durationMs = 700) {
    const frames = Math.max(2, Math.round((durationMs / 1000) * 60));
    let prev = 0;
    const started = Date.now();
    for (let i = 1; i <= frames; i++) {
      const e = motion.easeInOutCubic(i / frames);
      const target = dy * e;
      await this.page.mouse.wheel(dx / frames, target - prev);
      prev = target;
      const behind = (durationMs * i) / frames - (Date.now() - started);
      if (behind > 0) await motion.sleep(behind);
    }
  }

  async screenshot(file, { fullPage = false } = {}) {
    await mkdir(path.dirname(file), { recursive: true });
    await this.page.screenshot({ path: file, fullPage });
    return file;
  }

  // ---- teardown ------------------------------------------------------------

  /**
   * Close the session and finalise the recording.
   *
   * Playwright only writes the video file when the CONTEXT closes, and the
   * recording covers the context's whole lifetime — including setup and login.
   * We trim off everything before markStart() so the clip begins on the demo.
   */
  async close({ mp4Path = null, fps = 30 } = {}) {
    let rawVideo = null;

    if (this.record && this.page) {
      const video = this.page.video();
      await this.context.close();
      this.context = null;
      if (video) rawVideo = await video.path();
    } else if (this.context) {
      await this.context.close();
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    if (!rawVideo || !mp4Path) return { video: null, events: this.events };

    const leadMs = this.t0 ? this.t0 - this.contextStart : 0;
    const trimSec = Math.max(0, leadMs / 1000);

    await mkdir(path.dirname(mp4Path), { recursive: true });
    await ffmpeg([
      "-ss", trimSec.toFixed(3),
      "-i", rawVideo,
      "-vf", `fps=${fps},format=yuv420p`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-movflags", "+faststart",
      "-an",
      mp4Path,
    ]);

    const meta = await probe(mp4Path).catch(() => null);
    if (meta?.duration != null) {
      info(`  recorded ${meta.duration.toFixed(2)}s -> ${mp4Path}`);
    }
    return { video: mp4Path, rawVideo, trimmedSec: trimSec, events: this.events, meta };
  }
}

/** Convenience for the QA pass: newest .webm Playwright left in a directory. */
export async function findRawVideo(dir) {
  if (!existsSync(dir)) return null;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".webm"));
  if (!files.length) return null;
  return path.join(dir, files.sort().at(-1));
}
