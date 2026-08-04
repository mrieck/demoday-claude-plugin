/**
 * Secret resolution, in priority order, with no dependencies.
 *
 *   1. the process environment      (shell export, or ~/.claude/settings.json "env")
 *   2. the macOS Keychain           (recommended — no plaintext anywhere on disk)
 *   3. ~/.config/demoday/config.json
 *   4. a .env beside the plugin, or in the cwd   (development only)
 *
 * WHY THIS IS NOT JUST A .env LOADER
 *
 * An installed plugin lives in a VERSION-PINNED directory:
 *
 *   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
 *
 * Publishing 0.2.0 creates a new directory next to the 0.1.0 one. Anything a user
 * wrote inside the old tree — including a .env — is orphaned, so a key stored at
 * the plugin root silently disappears on every update. Sources 1-3 all live
 * outside the plugin and survive updates; source 4 only exists so a checkout of
 * this repo works without ceremony.
 *
 * Nothing here ever writes a secret. Reading is all a running script needs, and
 * writing would mean the key travelling through a tool call and into the session
 * transcript. Setup is a command the user runs in their own terminal — see the
 * README.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/** Keychain service name; each secret is an "account" under it. */
export const KEYCHAIN_SERVICE = "demoday";

/** Secrets we know how to resolve. Anything else must come from the environment. */
export const KNOWN_SECRETS = ["FAL_API_KEY", "BRAVE_API_KEY", "ELEVENLABS_API_KEY"];

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../scripts/lib
const PLUGIN_ROOT = path.join(HERE, "..", "..");

export function configPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "demoday", "config.json");
}

/**
 * Read one secret from the login Keychain. Returns null if absent or unavailable.
 *
 * `security` exits 44 when the item does not exist, which is the ordinary "not
 * configured" path and must stay quiet. The first read after the item is created
 * can surface a macOS permission prompt; the timeout means an unattended run
 * fails in ten seconds rather than blocking a capture forever.
 */
export function fromKeychain(name, { service = KEYCHAIN_SERVICE } = {}) {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-a", name, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }
    );
    const value = out.trim();
    return value || null;
  } catch {
    return null;
  }
}

function fromConfigFile() {
  const file = configPath();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A malformed config must not take the whole run down — the other sources
    // may still have the key, and doctor.mjs reports what was actually found.
    return {};
  }
}

function parseDotenv(file) {
  const out = {};
  try {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) out[key] = val;
    }
  } catch {
    /* ignore unreadable .env */
  }
  return out;
}

function fromDotenv() {
  for (const file of [path.join(PLUGIN_ROOT, ".env"), path.join(process.cwd(), ".env")]) {
    if (existsSync(file)) return { values: parseDotenv(file), file };
  }
  return { values: {}, file: null };
}

/** Where each resolved secret came from — for doctor.mjs, never for logs. */
const origins = new Map();
let loaded = false;

/**
 * Populate process.env from every source, highest priority first. Idempotent.
 * Call sites keep reading `process.env.FAL_API_KEY`; only the filling changes.
 */
export function loadSecrets({ force = false } = {}) {
  if (loaded && !force) return origins;
  loaded = true;
  origins.clear();

  for (const name of KNOWN_SECRETS) {
    if (process.env[name]) {
      origins.set(name, "environment");
    }
  }

  for (const name of KNOWN_SECRETS) {
    if (process.env[name]) continue;
    const value = fromKeychain(name);
    if (value) {
      process.env[name] = value;
      origins.set(name, "keychain");
    }
  }

  const config = fromConfigFile();
  for (const [name, value] of Object.entries(config)) {
    if (process.env[name] || typeof value !== "string" || !value) continue;
    process.env[name] = value;
    origins.set(name, "config file");
  }

  const { values, file } = fromDotenv();
  for (const [name, value] of Object.entries(values)) {
    if (process.env[name] || !value) continue;
    process.env[name] = value;
    origins.set(name, file === path.join(PLUGIN_ROOT, ".env") ? "plugin .env" : "local .env");
  }

  return origins;
}

/** Which source supplied a secret, or null if it is not set at all. */
export function secretSource(name) {
  loadSecrets();
  return origins.get(name) || null;
}

/** Back-compat: the old name, unchanged behaviour for existing call sites. */
export const loadDotenv = loadSecrets;
