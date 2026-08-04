/**
 * macOS system helpers: AppleScript, TCC permission probes, display metrics,
 * and window geometry.
 *
 * The permission probes below were derived empirically, not from docs, because
 * macOS reports these failures inconsistently:
 *
 *   Accessibility denied   -> osascript errors -1719 / -25211 on WINDOW properties.
 *                             Note that `name of first application process` succeeds
 *                             WITHOUT accessibility, so it is useless as a probe —
 *                             you must touch a window property to force the check.
 *   Screen Recording denied -> `screencapture` exits 1 with
 *                             "could not create image from display".
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** Run an AppleScript, returning trimmed stdout. Throws with the OSA error code attached. */
export async function osa(script) {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 15_000 });
    return stdout.trim();
  } catch (e) {
    const msg = `${e.stderr || e.message || ""}`.trim();
    const code = Number(msg.match(/\((-?\d+)\)/)?.[1]) || null;
    const err = new Error(msg || "osascript failed");
    err.osaCode = code;
    throw err;
  }
}

const ACCESSIBILITY_DENIED = new Set([-1719, -25211]);

/**
 * Is this terminal allowed to control the computer (send clicks/keys, read windows)?
 * Probes a window property specifically — see the note at the top of this file.
 */
export async function checkAccessibility() {
  try {
    await osa(
      'tell application "System Events" to get position of window 1 of (first application process whose frontmost is true)'
    );
    return { ok: true };
  } catch (e) {
    if (ACCESSIBILITY_DENIED.has(e.osaCode)) {
      return { ok: false, reason: "not authorized", code: e.osaCode };
    }
    // Some other failure (e.g. the frontmost app genuinely has no windows).
    // That still proves we were *allowed* to ask, so accessibility is granted.
    return { ok: true, note: e.message };
  }
}

/** Can we capture the screen? Probes with a 64x64 grab that costs nothing. */
export async function checkScreenRecording() {
  const probe = path.join(os.tmpdir(), `demoday-screen-probe-${process.pid}.png`);
  try {
    await execFileAsync("screencapture", ["-x", "-R", "0,0,64,64", probe], { timeout: 15_000 });
    const ok = existsSync(probe);
    return ok ? { ok: true } : { ok: false, reason: "capture produced no file" };
  } catch (e) {
    const msg = `${e.stderr || e.message || ""}`.trim();
    if (/could not create image/i.test(msg)) {
      return { ok: false, reason: "not authorized", detail: msg };
    }
    return { ok: false, reason: msg || "screencapture failed" };
  } finally {
    if (existsSync(probe)) await unlink(probe).catch(() => {});
  }
}

/** Which terminal app owns this process — so permission instructions can name it. */
export function hostApp() {
  const p = process.env.TERM_PROGRAM;
  if (!p) return "your terminal";
  return p.replace(/\.app$/, "");
}

/**
 * Logical desktop size in POINTS (not pixels).
 * Pair with a real screenshot's pixel dimensions to derive the Retina scale factor
 * rather than assuming 2x — see capture/screenshot.mjs.
 */
export async function desktopBounds() {
  const raw = await osa('tell application "Finder" to get bounds of window of desktop');
  const [x1, y1, x2, y2] = raw.split(",").map((n) => Number(n.trim()));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Every visible app with at least one window: [{ app, windows: [{ title, x, y, w, h }] }] */
export async function listWindows() {
  const script = `
    set out to ""
    tell application "System Events"
      repeat with proc in (every application process whose visible is true)
        set procName to name of proc
        repeat with w in (every window of proc)
          try
            set p to position of w
            set s to size of w
            set out to out & procName & tab & (name of w) & tab & (item 1 of p) & tab & (item 2 of p) & tab & (item 1 of s) & tab & (item 2 of s) & linefeed
          end try
        end repeat
      end repeat
    end tell
    return out`;
  const raw = await osa(script);
  const byApp = new Map();
  for (const line of raw.split("\n").filter(Boolean)) {
    const [app, title, x, y, w, h] = line.split("\t");
    if (!byApp.has(app)) byApp.set(app, { app, windows: [] });
    byApp.get(app).windows.push({
      title: title || "",
      x: Number(x), y: Number(y), w: Number(w), h: Number(h),
    });
  }
  return [...byApp.values()];
}

/** Bounds of an app's front window, in points. */
export async function getWindowBounds(appName) {
  const raw = await osa(`
    tell application "System Events" to tell process ${JSON.stringify(appName)}
      set p to position of window 1
      set s to size of window 1
      return (item 1 of p as string) & "," & (item 2 of p as string) & "," & (item 1 of s as string) & "," & (item 2 of s as string)
    end tell`);
  const [x, y, w, h] = raw.split(",").map((n) => Number(n.trim()));
  return { x, y, w, h };
}

/**
 * Move and size an app's front window. Returns the bounds actually achieved —
 * many apps clamp to a minimum size or snap to increments, so the caller must
 * record what it really got and crop the recording to that, not to what it asked for.
 */
export async function setWindowBounds(appName, { x, y, w, h }) {
  await osa(`
    tell application "System Events" to tell process ${JSON.stringify(appName)}
      set position of window 1 to {${Math.round(x)}, ${Math.round(y)}}
      set size of window 1 to {${Math.round(w)}, ${Math.round(h)}}
    end tell`);
  return getWindowBounds(appName);
}

/** Bring an app to the front and give it a beat to finish animating. */
export async function activate(appName, { settleMs = 400 } = {}) {
  await osa(`tell application ${JSON.stringify(appName)} to activate`);
  await new Promise((r) => setTimeout(r, settleMs));
}

export async function frontmostApp() {
  return osa('tell application "System Events" to return name of first application process whose frontmost is true');
}

/** Human-facing remediation text for a denied permission. */
export function permissionHelp(which) {
  const app = hostApp();
  const pane = which === "screen"
    ? "Privacy & Security > Screen & System Audio Recording"
    : "Privacy & Security > Accessibility";
  return [
    `Grant ${app} access under System Settings > ${pane}.`,
    `You may need to quit and reopen ${app} for the change to take effect.`,
  ].join(" ");
}
