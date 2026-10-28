/**
 * A browser-window capture session: a real browser, recorded chrome and all.
 *
 * The web backend records the PAGE, which is the right frame for a web app and
 * the wrong one for a browser extension — the toolbar icon and the side panel
 * live outside the page, so they never reach a page recording, and nothing in
 * the page's DOM can click them. This backend records the WINDOW instead.
 *
 * Thin layer over MacSession — recording, cropping, real input and event logging
 * are all inherited, so everything is driven by sight (screenshot, coordinates,
 * real clicks) exactly like a desktop app. What this class adds:
 *
 *   - launching Playwright's bundled Chrome for Testing with an unpacked
 *     extension loaded. It is a separate app with its own profile; the user's
 *     own Chrome is never touched (branded Chrome dropped --load-extension anyway)
 *   - a profile that is prepared ONCE and then never changed by a scene. A
 *     `keep` session writes to it (sign in, pin the toolbar icon, set the side
 *     panel's width); every other session — rehearsal and take alike — runs on
 *     a throwaway copy. Steps are window coordinates, so a take only replays if
 *     it starts where rehearsal started, and an extension that saves its state
 *     would otherwise carry the rehearsal's leftovers into the take
 *   - `goto`, the one step that needs the browser rather than the mouse
 *   - a focus guard before input, because the take is launched from a terminal
 *     and cliclick acts on whatever is frontmost
 */
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, cp, rm } from "node:fs/promises";
import { MacSession } from "./mac-session.mjs";
import { frontmostApp, activate, processCount } from "../lib/mac.mjs";
import { sleep } from "../lib/cursor.mjs";
import { info, warn } from "../lib/log.mjs";

const execFileAsync = promisify(execFile);

/** The browser's own preference domain — never the system-wide one. */
async function appDefault(domain, action, ...rest) {
  try {
    const { stdout } = await execFileAsync("defaults", [action, domain, "AppleShowScrollBars", ...rest]);
    return stdout.trim();
  } catch {
    return null; // not set — the system-wide setting applies
  }
}

/** Lock files and caches: copying them is at best wasted, at worst a profile Chrome refuses to open. */
const PROFILE_SKIP = new Set([
  "SingletonLock", "SingletonCookie", "SingletonSocket", "RunningChromeVersion",
  "Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache", "component_crx_cache",
]);

/** Steps that land on whatever app is frontmost. */
const INPUT_STEPS = new Set(["click", "hover", "drag", "type", "key", "scroll"]);

/**
 * One profile per extension by default, so a sign-in done once serves every demo
 * of it. Named after the extension, not its directory — that is nearly always
 * "dist". Kept in the home directory because a profile holds session cookies and
 * has no business inside a repo.
 */
export function defaultProfileDir(extensions = []) {
  let name = "default";
  if (extensions.length) {
    const dir = path.resolve(extensions[0]);
    name = `${path.basename(path.dirname(dir))}-${path.basename(dir)}`;
    try {
      const declared = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")).name;
      // "__MSG_appName__" is a locale lookup, not a name.
      if (declared && !declared.startsWith("__MSG_")) name = declared;
    } catch {}
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
  return path.join(os.homedir(), ".demoday", "browser-profiles", slug);
}

export class BrowserSession extends MacSession {
  constructor({ url = null, extension = null, profile = null, keep = false, width = 1600, height = 900, ...rest } = {}) {
    super({ ...rest, width, height, app: null });
    this.url = url;
    this.keep = keep;
    this.scratch = null;
    this.bundleId = null;
    this.savedScrollBars = undefined;
    this.extensions = [extension].flat().filter(Boolean).map((p) => path.resolve(p));
    this.profile = path.resolve(profile || defaultProfileDir(this.extensions));
    this.context = null;
    this.page = null;
  }

  async start() {
    for (const dir of this.extensions) {
      if (!existsSync(path.join(dir, "manifest.json"))) {
        throw new Error(
          `No manifest.json in ${dir} — pass the extension's built, unpacked directory (often dist/).`
        );
      }
    }

    const { chromium } = await import("playwright");
    // ".../Google Chrome for Testing.app/Contents/MacOS/…" -> the process name
    // System Events knows the window by.
    const bundle = chromium.executablePath().split(path.sep).find((part) => part.endsWith(".app"));
    if (!bundle) throw new Error("The browser target needs Playwright's macOS browser build.");
    this.app = bundle.replace(/\.app$/, "");
    const appPath = chromium.executablePath().split(`${bundle}${path.sep}`)[0] + bundle;

    // Staging addresses "window 1 of process <name>", so a second browser with
    // the same name (a web rehearsal, another project's e2e run) would get staged
    // and recorded instead of ours.
    if (await processCount(this.app).catch(() => 0)) {
      throw new Error(
        `"${this.app}" is already running. Close that window first — the take must be the only one.`
      );
    }

    try {
      await this.launch(chromium, appPath);
      await super.start(); // generic desktop staging: sizes the window, probes the Retina scale
    } catch (e) {
      await this.closeBrowser();
      throw e;
    }
    await sleep(600); // let the layout settle at its final size
    return this;
  }

  async launch(chromium, appPath) {
    // Left on "automatic", macOS draws scrollbars that take up layout width while
    // a mouse is connected and overlay ones when it is not — so a page rehearsed
    // with a mouse plugged in is ~15pt narrower than the same page in a take
    // recorded after it went to sleep, and every click on it lands off target.
    // Pin the overlay style for this browser only, and put it back on close.
    this.bundleId = await execFileAsync("defaults", ["read", path.join(appPath, "Contents", "Info"), "CFBundleIdentifier"])
      .then(({ stdout }) => stdout.trim(), () => null);
    if (this.bundleId) {
      this.savedScrollBars = await appDefault(this.bundleId, "read");
      await appDefault(this.bundleId, "write", "-string", "WhenScrolling");
    }

    await mkdir(this.profile, { recursive: true });
    let launchDir = this.profile;
    if (!this.keep) {
      this.scratch = await mkdtemp(path.join(os.tmpdir(), "demoday-browser-"));
      await cp(this.profile, this.scratch, {
        recursive: true,
        filter: (src) => !PROFILE_SKIP.has(path.basename(src)),
      });
      launchDir = this.scratch;
    }
    const args = [
      `--window-size=${this.width},${this.height}`,
      `--window-position=${this.x},${this.y}`,
      "--hide-crash-restore-bubble",
    ];
    if (this.extensions.length) {
      const list = this.extensions.join(",");
      args.push(`--disable-extensions-except=${list}`, `--load-extension=${list}`);
    }

    this.context = await chromium.launchPersistentContext(launchDir, {
      headless: false,
      // The page takes the real window size; an emulated viewport would not
      // shrink when a side panel opens beside it.
      viewport: null,
      // Both of these put an infobar across the top of the window otherwise.
      ignoreDefaultArgs: ["--enable-automation"],
      chromiumSandbox: true,
      args,
    });
    this.page = this.context.pages()[0] || (await this.context.newPage());
    info(
      `  browser: ${this.app}, profile ${this.profile} ` +
      `(${this.keep ? "changes are KEPT" : "throwaway copy — nothing this session does is kept"})`
    );
    if (this.extensions.length) info(`  extension: ${this.extensions.join(", ")}`);

    if (this.url) await this.page.goto(this.url, { waitUntil: "load" });
  }

  async perform(step) {
    if (step.type === "goto") {
      await this.page.goto(step.url, { waitUntil: "load" });
      this.logEvent("goto", { url: step.url, label: step.label || step.url });
      return;
    }
    if (INPUT_STEPS.has(step.type)) {
      const front = await frontmostApp().catch(() => null);
      if (front && front !== this.app) {
        warn(`"${front}" stole focus — bringing ${this.app} back`);
        await activate(this.app);
      }
    }
    return super.perform(step);
  }

  async close() {
    try {
      return await super.close(); // stops the recorder, restores the desktop
    } finally {
      await this.closeBrowser();
    }
  }

  async closeBrowser() {
    // Closed through Playwright, not killed, so a kept profile is flushed to disk.
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.page = null;
    if (this.scratch) await rm(this.scratch, { recursive: true, force: true }).catch(() => {});
    this.scratch = null;
    if (this.bundleId && this.savedScrollBars !== undefined) {
      if (this.savedScrollBars === null) await appDefault(this.bundleId, "delete");
      else await appDefault(this.bundleId, "write", "-string", this.savedScrollBars);
      this.savedScrollBars = undefined;
    }
  }
}
