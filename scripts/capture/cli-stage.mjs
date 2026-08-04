/**
 * Terminal.app staging for CLI demos.
 *
 * A demo terminal cannot be the user's terminal: their font is sized for work,
 * their prompt is noisy, and their scrollback is full of secrets. So we keep a
 * dedicated Terminal settings set ("demoday-demo") — big font, dark theme — created
 * once and never touching the user's own profiles, and open a fresh window with
 * it for every take.
 *
 * Terminal.app only in v1. It is pre-installed, and it is the only macOS
 * terminal whose profiles and windows are fully scriptable without plugins.
 *
 * Terminal's scripting dictionary has no cursor-blink property; the blinking
 * cursor is instead absorbed by waitStable's pixel-diff tolerance (a block
 * cursor is far below 0.4% of the frame).
 */
import { osa } from "../lib/mac.mjs";
import { warn } from "../lib/log.mjs";

export const SETTINGS_SET = "demoday-demo";

/** Single-quote a string for /bin/sh embedding. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Create (or refresh) the demo settings set. Idempotent; only ever touches the
 * namespaced set, never the user's profiles. Colors are 16-bit RGB triples.
 */
export async function ensureSettingsSet({ fontName = "Menlo", fontSize = 20 } = {}) {
  await osa(`
    tell application "Terminal"
      if not (exists settings set ${JSON.stringify(SETTINGS_SET)}) then
        make new settings set with properties {name:${JSON.stringify(SETTINGS_SET)}}
      end if
      tell settings set ${JSON.stringify(SETTINGS_SET)}
        set font name to ${JSON.stringify(fontName)}
        set font size to ${Math.round(fontSize)}
        set background color to {3341, 4369, 5911}
        set normal text color to {59110, 60909, 62451}
        set bold text color to {65535, 65535, 65535}
        set cursor color to {31611, 37008, 45746}
      end tell
    end tell`);
  return SETTINGS_SET;
}

/**
 * Open a fresh Terminal window in `cwd` using the demo settings set.
 * `setup` is an optional extra shell command run before the screen is cleared —
 * use it for a minimal prompt (e.g. `export PS1='%% '`) or env vars.
 * Returns the window id, for closeTerminalWindow.
 */
export async function openTerminalWindow({ cwd, setup = null } = {}) {
  const cmd = [
    cwd ? `cd ${shellQuote(cwd)}` : null,
    setup,
    "clear",
  ].filter(Boolean).join("; ");

  // If Terminal is not running, launching it opens its startup window — reuse
  // that one instead of leaving a stray window behind the demo.
  return osa(`
    tell application "Terminal"
      if not running then
        launch
        delay 0.8
        do script ${JSON.stringify(cmd)} in front window
        set demoTab to selected tab of front window
      else
        set demoTab to do script ${JSON.stringify(cmd)}
      end if
      set current settings of demoTab to settings set ${JSON.stringify(SETTINGS_SET)}
      activate
      return id of front window
    end tell`);
}

/**
 * Close the demo window. Best-effort: exit the shell first so Terminal does not
 * ask about a running process; if something (claude, a server) is still running
 * the window may survive — that is better than force-killing it mid-write.
 */
export async function closeTerminalWindow(windowId) {
  if (!windowId) return;
  try {
    await osa(`
      tell application "Terminal"
        do script "exit" in window id ${Number(windowId)}
        delay 0.5
        close window id ${Number(windowId)}
      end tell`);
  } catch (e) {
    warn(`could not close the demo terminal window — close it manually. (${e.message})`);
  }
}
