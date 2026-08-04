/**
 * Stage preparation for desktop recordings.
 *
 * This is what separates a demo from a screengrab: the window is an exact size,
 * the Dock is gone, the desktop is clean, and nothing wanders into frame.
 *
 * SAFETY IS THE POINT OF THIS FILE. Everything here mutates the user's actual
 * desktop, so:
 *   - every setting is READ and stored before it is changed
 *   - restore is idempotent and only touches what we actually changed
 *   - restore is wired to normal exit, SIGINT, SIGTERM and uncaught exceptions,
 *     because a recording interrupted with Ctrl-C must not leave someone with a
 *     hidden Dock and no desktop icons
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { osa, getWindowBounds, setWindowBounds, activate, desktopBounds } from "../lib/mac.mjs";
import { info, warn } from "../lib/log.mjs";

const execFileAsync = promisify(execFile);

async function defaultsRead(domain, key) {
  try {
    const { stdout } = await execFileAsync("defaults", ["read", domain, key]);
    return stdout.trim();
  } catch {
    return null; // key not present — the domain default applies
  }
}

async function defaultsWrite(domain, key, type, value) {
  await execFileAsync("defaults", ["write", domain, key, type, String(value)]);
}

async function defaultsDelete(domain, key) {
  await execFileAsync("defaults", ["delete", domain, key]).catch(() => {});
}

async function restartApp(name) {
  await execFileAsync("killall", [name]).catch(() => {});
}

export class Stage {
  constructor({ dock = true, desktopIcons = true } = {}) {
    this.opts = { dock, desktopIcons };
    this.saved = {};          // only keys we actually changed
    this.restored = false;
    this.window = null;       // { app, bounds } after prepare()
    this._handlers = [];
  }

  /**
   * Hide desktop chrome and (optionally) size a window to exact dimensions.
   * Returns the bounds actually achieved — apps often clamp or snap, and the
   * recording must be cropped to what really happened, not what we asked for.
   */
  async prepare({ app = null, width = 1920, height = 1080, x = 60, y = 80 } = {}) {
    this._installExitHandlers();

    if (this.opts.dock) {
      const prev = await defaultsRead("com.apple.dock", "autohide");
      if (prev !== "1") {
        this.saved.dockAutohide = prev; // may be null, meaning "key absent"
        await defaultsWrite("com.apple.dock", "autohide", "-bool", "true");
        await restartApp("Dock");
        info("  stage: Dock hidden");
      }
    }

    if (this.opts.desktopIcons) {
      const prev = await defaultsRead("com.apple.finder", "CreateDesktop");
      if (prev !== "0") {
        this.saved.createDesktop = prev;
        await defaultsWrite("com.apple.finder", "CreateDesktop", "-bool", "false");
        await restartApp("Finder");
        info("  stage: desktop icons hidden");
      }
    }

    // Notifications are the one thing we cannot reliably suppress. Since macOS
    // Ventura, Focus is not settable from the command line without private APIs,
    // and silently failing would be worse than saying so.
    warn(
      "notifications cannot be disabled programmatically on modern macOS — " +
      "turn on a Focus mode manually before recording, or a banner may land in the shot."
    );

    if (app) {
      await activate(app);
      let before = null;
      try {
        before = await getWindowBounds(app);
      } catch (e) {
        throw new Error(
          `Could not read the window of "${app}": ${e.message}\n` +
          `Check the app name matches its process name, and that Accessibility is granted.`
        );
      }
      this.saved.window = { app, bounds: before };
      const achieved = await setWindowBounds(app, { x, y, w: width, h: height });
      this.window = { app, bounds: achieved };

      if (achieved.w !== width || achieved.h !== height) {
        warn(
          `"${app}" clamped its window to ${achieved.w}x${achieved.h} ` +
          `(asked for ${width}x${height}); recording will use the actual size.`
        );
      }
      info(`  stage: ${app} window at ${achieved.w}x${achieved.h} +${achieved.x}+${achieved.y}`);
    }

    return this.window;
  }

  /** Put everything back exactly as it was. Safe to call more than once. */
  async restore() {
    if (this.restored) return;
    this.restored = true;

    if ("dockAutohide" in this.saved) {
      if (this.saved.dockAutohide === null) await defaultsDelete("com.apple.dock", "autohide");
      else await defaultsWrite("com.apple.dock", "autohide", "-bool", this.saved.dockAutohide === "1");
      await restartApp("Dock");
    }

    if ("createDesktop" in this.saved) {
      if (this.saved.createDesktop === null) await defaultsDelete("com.apple.finder", "CreateDesktop");
      else await defaultsWrite("com.apple.finder", "CreateDesktop", "-bool", this.saved.createDesktop === "1");
      await restartApp("Finder");
    }

    if (this.saved.window) {
      const { app, bounds } = this.saved.window;
      await setWindowBounds(app, bounds).catch(() => {
        warn(`could not restore the window size of "${app}" — move it back manually.`);
      });
    }

    this._removeExitHandlers();
    info("  stage: restored");
  }

  /**
   * Restore on any exit path.
   *
   * `exit` handlers must be synchronous, so the async restore cannot run there.
   * Instead we handle the signals we can await on, and on a hard exit fall back to
   * a synchronous best-effort so the user is never left with a hidden Dock.
   */
  _installExitHandlers() {
    const asyncBail = async (signal) => {
      warn(`caught ${signal} — restoring the desktop before exiting`);
      await this.restore().catch(() => {});
      process.exit(signal === "uncaught" ? 1 : 0);
    };
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const h = () => { asyncBail(sig); };
      process.on(sig, h);
      this._handlers.push([sig, h]);
    }
    const onUncaught = (e) => {
      console.error(e?.stack || String(e));
      asyncBail("uncaught");
    };
    process.on("uncaughtException", onUncaught);
    this._handlers.push(["uncaughtException", onUncaught]);

    const onExit = () => { this._restoreSyncFallback(); };
    process.on("exit", onExit);
    this._handlers.push(["exit", onExit]);
  }

  _removeExitHandlers() {
    for (const [sig, h] of this._handlers) process.removeListener(sig, h);
    this._handlers = [];
  }

  /** Last resort on a synchronous exit: spawn the restores and don't wait. */
  _restoreSyncFallback() {
    if (this.restored) return;
    try {
      if ("dockAutohide" in this.saved) {
        execFileSync("defaults", ["write", "com.apple.dock", "autohide", "-bool",
          String(this.saved.dockAutohide === "1")]);
        execFileSync("killall", ["Dock"]);
      }
      if ("createDesktop" in this.saved) {
        execFileSync("defaults", ["write", "com.apple.finder", "CreateDesktop", "-bool",
          String(this.saved.createDesktop === "1")]);
        execFileSync("killall", ["Finder"]);
      }
    } catch {
      /* nothing more we can do at this point */
    }
  }
}

/** Full-display size in points, for callers that need to clamp coordinates. */
export async function stageBounds() {
  return desktopBounds();
}

/** List candidate window titles for an app, to help pick the right one. */
export async function windowTitles(app) {
  const raw = await osa(
    `tell application "System Events" to tell process ${JSON.stringify(app)} to return name of every window`
  );
  return raw.split(", ").filter(Boolean);
}
