/**
 * Output convention for every script in this plugin, inherited from
 * ai-video-maker-plugin because it is what makes these composable from Bash:
 *
 *   stdout = exactly one line of JSON  (machine-readable, for Claude to parse)
 *   stderr = human-readable progress   (never parsed, safe to be chatty)
 *
 * Never console.log() anything but the final result object, or callers that pipe
 * stdout into JSON.parse will break.
 */

/** Print a human summary to stderr and the machine-readable result to stdout. */
export function report(summary, obj) {
  if (summary) console.error(summary);
  console.log(JSON.stringify(obj));
}

/** Progress line to stderr. */
export function info(msg) {
  console.error(msg);
}

/** Transient same-line progress (recording timers, queue polls). */
export function tick(msg) {
  process.stderr.write(`${msg}\r`);
}

export function warn(msg) {
  console.error(`  warning: ${msg}`);
}

/**
 * Fail with a machine-readable error on stdout so a caller that only reads stdout
 * still learns what went wrong, then exit non-zero.
 * `extra` can carry a `suggestion` the skill can act on (e.g. a fallback model).
 */
export function die(message, extra = {}) {
  console.error(`Error: ${message}`);
  if (extra.suggestion) console.error(`  suggestion: ${extra.suggestion}`);
  console.log(JSON.stringify({ ok: false, error: message, ...extra }));
  process.exit(1);
}

/** Format seconds as m:ss.s for human-facing progress. */
export function fmtDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return "?";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${s.toFixed(1)}s`;
}

/**
 * Run `fn`, reporting a clean error instead of a raw stack trace on failure.
 * Every CLI entrypoint wraps its body in this.
 */
export async function main(fn) {
  try {
    await fn();
  } catch (e) {
    die(e?.message || String(e), e?.extra || {});
  }
}
