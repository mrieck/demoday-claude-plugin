/**
 * Tiny CLI arg parser for the plugin scripts.
 *
 * Supports:
 *   --flag value        -> { flag: "value" }
 *   --flag=value        -> { flag: "value" }
 *   --flag              -> { flag: true }        (boolean, when no value follows)
 *   repeated flags      -> collected into an array (see `multi`)
 *
 * Usage:
 *   const args = parseArgs(process.argv.slice(2), { multi: ["image", "in"] });
 */
export function parseArgs(argv, { multi = [] } = {}) {
  const out = {};
  const multiSet = new Set(multi);

  const push = (key, value) => {
    if (multiSet.has(key)) {
      (out[key] ||= []).push(value);
    } else {
      out[key] = value;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;

    let key = tok.slice(2);
    let value;

    const eq = key.indexOf("=");
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = true; // bare boolean flag
      }
    }
    push(key, value);
  }
  return out;
}

/** Exit with a usage error on stderr (non-zero) so the caller sees why it failed. */
export function fail(message, usage) {
  console.error(`Error: ${message}`);
  if (usage) console.error(`\nUsage: ${usage}`);
  process.exit(1);
}

/** Require a string flag; fail with usage if missing. */
export function requireArg(args, name, usage) {
  const v = args[name];
  if (v === undefined || v === true || v === "") {
    fail(`missing required --${name}`, usage);
  }
  return v;
}

/** Coerce a truthy/falsy string flag to boolean, with a default. */
export function boolArg(value, dflt = false) {
  if (value === undefined) return dflt;
  if (value === true) return true;
  const s = String(value).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}
