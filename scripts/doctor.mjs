#!/usr/bin/env node
/**
 * Preflight check. Run this first, and run it again whenever something fails
 * mysteriously — most first-run problems are a missing binary or an ungranted
 * macOS permission, and both are invisible until you try to record.
 *
 *   node scripts/doctor.mjs              # everything
 *   node scripts/doctor.mjs --target web # only what a web demo needs
 *
 * stdout: one JSON line { ok, checks: [...] }
 * stderr: a human table with exact remediation commands
 *
 * Exit 0 only if every REQUIRED check for the selected target passes.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "./lib/args.mjs";
import { loadDotenv, secretSource, KEYCHAIN_SERVICE } from "./lib/env.mjs";
import { which } from "./lib/ff.mjs";
import { checkAccessibility, checkScreenRecording, permissionHelp, hostApp } from "./lib/mac.mjs";
import { report } from "./lib/log.mjs";

const execFileAsync = promisify(execFile);
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

loadDotenv();

const args = parseArgs(process.argv.slice(2));
const target = args.target || "all"; // all | web | mac | cli

/** Does this check matter for the selected target? */
function needed(scope) {
  if (scope === "core") return true;
  if (target === "all") return true;
  // A cli demo records a real Terminal window through the mac backend, so it
  // needs everything a mac demo needs plus its own checks.
  if (target === "cli") return scope === "cli" || scope === "mac";
  return scope === target;
}

const checks = [];
function add(c) {
  checks.push(c);
}

async function checkNodeDep(dep) {
  return existsSync(path.join(PLUGIN_ROOT, "node_modules", dep));
}

async function run() {
  // ---- core ----------------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add({
    name: "node >= 20",
    scope: "core",
    required: true,
    ok: nodeMajor >= 20,
    detail: `v${process.versions.node}`,
    fix: "Install Node 20 or newer (https://nodejs.org).",
  });

  // The browser-side cursor lives inside a template literal, so a stray backtick
  // in a comment silently truncates it and nothing catches that until a capture
  // fails mid-run. Parse it here instead.
  let cursorOk = false;
  let cursorDetail = "";
  try {
    const { CURSOR_INIT_SCRIPT } = await import("./lib/web-cursor.mjs");
    // eslint-disable-next-line no-new-func
    new Function(CURSOR_INIT_SCRIPT);
    cursorOk = true;
    cursorDetail = `${CURSOR_INIT_SCRIPT.length} chars, parses`;
  } catch (e) {
    cursorDetail = e.message;
  }
  add({
    name: "injected cursor script",
    scope: "core",
    required: true,
    ok: cursorOk,
    detail: cursorDetail,
    fix: "scripts/lib/web-cursor.mjs is malformed — check for stray backticks inside CURSOR_INIT_SCRIPT.",
  });

  const deps = ["@fal-ai/client", "playwright", "sharp", "@modelcontextprotocol/sdk"];
  const missingDeps = [];
  for (const d of deps) if (!(await checkNodeDep(d))) missingDeps.push(d);
  add({
    name: "node dependencies",
    scope: "core",
    required: true,
    ok: missingDeps.length === 0,
    detail: missingDeps.length ? `missing: ${missingDeps.join(", ")}` : `${deps.length} present`,
    fix: `cd "${PLUGIN_ROOT}" && npm install`,
  });

  // Report WHERE the key came from, not just that it exists. A key found in the
  // plugin's own .env works today and vanishes on the next plugin update, so the
  // two cases must not look identical in a green row.
  const falSource = secretSource("FAL_API_KEY");
  add({
    name: "FAL_API_KEY",
    scope: "core",
    required: true,
    ok: Boolean(process.env.FAL_API_KEY),
    detail: falSource ? `set (from ${falSource})` : "not set",
    warn: falSource === "plugin .env"
      ? "a key in the plugin's own .env is lost when the plugin updates — move it to the Keychain"
      : null,
    fix:
      `security add-generic-password -s ${KEYCHAIN_SERVICE} -a FAL_API_KEY -w   ` +
      `(run it in your own terminal; it prompts without echoing). Key: https://fal.ai/dashboard/keys`,
  });

  const ffmpegPath = await which("ffmpeg");
  const ffprobePath = await which("ffprobe");
  add({
    name: "ffmpeg",
    scope: "core",
    required: true,
    ok: Boolean(ffmpegPath),
    detail: ffmpegPath || "not found",
    fix: "brew install ffmpeg",
  });
  add({
    name: "ffprobe",
    scope: "core",
    required: true,
    ok: Boolean(ffprobePath),
    detail: ffprobePath || "not found",
    fix: "brew install ffmpeg",
  });

  add({
    name: "BRAVE_API_KEY",
    scope: "core",
    required: false,
    ok: Boolean(process.env.BRAVE_API_KEY),
    detail: process.env.BRAVE_API_KEY
      ? `set (from ${secretSource("BRAVE_API_KEY")})`
      : "not set (b-roll reference search disabled)",
    fix:
      `Optional. security add-generic-password -s ${KEYCHAIN_SERVICE} -a BRAVE_API_KEY -w   ` +
      `Key: https://brave.com/search/api/`,
  });

  const elevenSource = secretSource("ELEVENLABS_API_KEY");
  add({
    name: "ELEVENLABS_API_KEY",
    scope: "core",
    required: false,
    ok: Boolean(process.env.ELEVENLABS_API_KEY),
    detail: process.env.ELEVENLABS_API_KEY
      ? `set (from ${elevenSource})`
      : "not set (character voice design + sound effects disabled — narration uses fal.ai stock voices)",
    warn: elevenSource === "plugin .env"
      ? "a key in the plugin's own .env is lost when the plugin updates — move it to the Keychain"
      : null,
    fix:
      `Optional. security add-generic-password -s ${KEYCHAIN_SERVICE} -a ELEVENLABS_API_KEY -w   ` +
      `Key: https://elevenlabs.io/app/settings/api-keys`,
  });

  // ---- web capture ---------------------------------------------------------
  if (needed("web")) {
    let browsersOk = false;
    let browserDetail = "playwright not installed";
    if (await checkNodeDep("playwright")) {
      try {
        const { chromium } = await import("playwright");
        const exe = chromium.executablePath();
        browsersOk = existsSync(exe);
        browserDetail = browsersOk ? exe : "chromium binary not downloaded";
      } catch (e) {
        browserDetail = e.message;
      }
    }
    add({
      name: "playwright chromium",
      scope: "web",
      required: true,
      ok: browsersOk,
      detail: browserDetail,
      fix: `cd "${PLUGIN_ROOT}" && npx playwright install chromium`,
    });
  }

  // ---- macOS desktop capture ----------------------------------------------
  if (needed("mac")) {
    const isMac = process.platform === "darwin";
    add({
      name: "platform is macOS",
      scope: "mac",
      required: true,
      ok: isMac,
      detail: process.platform,
      fix: "The desktop capture backend is macOS-only. Use --target web elsewhere.",
    });

    const cliclickPath = await which("cliclick");
    add({
      name: "cliclick",
      scope: "mac",
      required: true,
      ok: Boolean(cliclickPath),
      detail: cliclickPath || "not found",
      fix: "brew install cliclick",
    });

    if (isMac) {
      // These two are the single most common reason a desktop demo silently
      // produces a black video or clicks that go nowhere.
      const screen = await checkScreenRecording();
      add({
        name: "Screen Recording permission",
        scope: "mac",
        required: true,
        ok: screen.ok,
        detail: screen.ok ? `granted to ${hostApp()}` : (screen.reason || "denied"),
        fix: permissionHelp("screen"),
      });

      const axs = await checkAccessibility();
      add({
        name: "Accessibility permission",
        scope: "mac",
        required: true,
        ok: axs.ok,
        detail: axs.ok ? `granted to ${hostApp()}` : (axs.reason || "denied"),
        fix: permissionHelp("accessibility"),
      });
    }

    // Nice-to-have: lets us capture a specific display cleanly.
    if (isMac && ffmpegPath) {
      let avf = false;
      try {
        const { stderr } = await execFileAsync(
          "ffmpeg",
          ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
          { timeout: 20_000 }
        ).catch((e) => e); // this command always exits non-zero; the listing is on stderr
        avf = /Capture screen/i.test(String(stderr || ""));
      } catch {
        avf = false;
      }
      add({
        name: "ffmpeg avfoundation screen device",
        scope: "mac",
        required: false,
        ok: avf,
        detail: avf ? "screen capture device available" : "no screen device listed (falls back to screencapture)",
        fix: "Usually resolves once Screen Recording permission is granted.",
      });
    }
  }

  // ---- cli / terminal capture ---------------------------------------------
  if (needed("cli")) {
    const terminalApp =
      ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"]
        .find((p) => existsSync(p)) || null;
    add({
      name: "Terminal.app",
      scope: "cli",
      required: true,
      ok: Boolean(terminalApp),
      detail: terminalApp || "not found",
      fix: "CLI demos stage Apple's Terminal.app, which ships with macOS — is this a Mac?",
    });

    const claudePath = await which("claude");
    add({
      name: "claude CLI",
      scope: "cli",
      required: false,
      ok: Boolean(claudePath),
      detail: claudePath || "not on PATH (demos of other CLIs still work)",
      fix: "Optional. Install Claude Code: npm install -g @anthropic-ai/claude-code",
    });

    add({
      name: "permission ownership",
      scope: "cli",
      required: false,
      ok: true,
      detail:
        `Screen Recording / Accessibility must be granted to ${hostApp()} (the app running ` +
        `these scripts), even though a separate Terminal window is what gets recorded`,
      fix: "",
    });
  }

  // ---- report --------------------------------------------------------------
  const relevant = checks.filter((c) => needed(c.scope));
  const failures = relevant.filter((c) => c.required && !c.ok);

  const nameWidth = Math.max(...relevant.map((c) => c.name.length));
  console.error("");
  console.error(`  DemoDay doctor  (target: ${target})`);
  console.error("");
  for (const c of relevant) {
    const mark = c.ok ? "OK  " : c.required ? "FAIL" : "warn";
    console.error(`  ${mark}  ${c.name.padEnd(nameWidth)}  ${c.detail}`);
    // A check can pass and still be set up in a way that will break later.
    if (c.ok && c.warn) console.error(`        ${" ".repeat(nameWidth)}  ^ ${c.warn}`);
  }
  console.error("");

  const actionable = relevant.filter((c) => !c.ok);
  if (actionable.length) {
    console.error("  To fix:");
    for (const c of actionable) {
      console.error(`    - ${c.name}: ${c.fix}`);
    }
    console.error("");
  }

  if (failures.length === 0) {
    console.error("  All required checks passed.");
    console.error("");
  }

  report(
    null,
    {
      ok: failures.length === 0,
      target,
      failures: failures.map((c) => c.name),
      checks: relevant.map(({ name, scope, required, ok, detail, warn }) => ({
        name, scope, required, ok, detail, ...(warn ? { warn } : {}),
      })),
    }
  );

  process.exit(failures.length === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(`doctor crashed: ${e.stack || e.message}`);
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
