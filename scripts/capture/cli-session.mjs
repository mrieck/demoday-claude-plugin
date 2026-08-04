/**
 * A CLI capture session: a real Terminal window running the real program.
 *
 * Thin layer over MacSession — the recording, cropping, input and event logging
 * are all inherited. What this class adds is specific to terminals:
 *
 *   - a staged Terminal window (fresh, big font, demo profile, right cwd)
 *     opened before the generic desktop staging sizes it
 *   - a focus guard before every keystroke, because the performance is usually
 *     launched FROM another terminal (a Claude Code session) and cliclick types
 *     into whatever is frontmost — typing the demo into the host session would
 *     ruin both
 *   - closing the demo window on the way out
 */
import { MacSession } from "./mac-session.mjs";
import { ensureSettingsSet, openTerminalWindow, closeTerminalWindow } from "./cli-stage.mjs";
import { frontmostApp, activate } from "../lib/mac.mjs";
import { sleep } from "../lib/cursor.mjs";
import { warn } from "../lib/log.mjs";

export class CliSession extends MacSession {
  constructor({ cwd = process.cwd(), fontSize = 20, setup = null, terminalApp = "Terminal", ...rest } = {}) {
    super({ ...rest, app: terminalApp });
    this.cwd = cwd;
    this.fontSize = fontSize;
    this.setup = setup;
    this.windowId = null;
  }

  async start() {
    await ensureSettingsSet({ fontSize: this.fontSize });
    this.windowId = await openTerminalWindow({ cwd: this.cwd, setup: this.setup });
    await super.start(); // generic desktop staging: sizes the window, probes the Retina scale
    await sleep(800);    // let the shell finish starting before anything types
    return this;
  }

  async perform(step) {
    if (step.type === "type" || step.type === "key") {
      const front = await frontmostApp().catch(() => null);
      if (front && front !== this.app) {
        warn(`"${front}" stole focus — bringing ${this.app} back before typing`);
        await activate(this.app);
      }
    }
    return super.perform(step);
  }

  async close() {
    try {
      return await super.close(); // stops the recorder, restores the desktop
    } finally {
      await closeTerminalWindow(this.windowId).catch(() => {});
      this.windowId = null;
    }
  }
}
