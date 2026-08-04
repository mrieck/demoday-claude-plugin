/**
 * The action script — the contract between the two passes.
 *
 *   Rehearsal (MCP, model in the loop)  writes  actions.json
 *   Performance (CLI, no model)          reads   actions.json  and records
 *
 * This split exists because recording a model while it explores produces jerky
 * footage full of dead air. Rehearsal figures out what works; performance replays
 * it smoothly at a pace chosen to land on the narration.
 *
 * Pacing model
 * ------------
 * Each step has an intrinsic cost (how long it takes to actually do) plus dwell
 * (deliberate pause so a viewer can read the result). When the runner is given a
 * --target-duration, it keeps intrinsic costs fixed and scales DWELL only, weighted
 * by each step's `weight`. That way a demo stretched to fit a long narration gets
 * calmer pauses rather than absurdly slow mouse movement.
 *
 * A step may instead pin itself to a spoken word (`pinToWord`), in which case the
 * runner schedules it against the narration's word timestamps — so the cursor
 * clicks "Save" exactly as the voice says it.
 */

export const STEP_TYPES = [
  "goto", "click", "hover", "type", "key", "scroll", "wait", "highlight", "dwell",
  "waitStable",
];

/** Default milliseconds each step type takes to perform, before dwell. */
const INTRINSIC_MS = {
  goto: 1200,
  click: 500,     // includes the cursor travel that precedes it
  hover: 400,
  type: 0,        // computed from text length and cps
  key: 180,
  scroll: 700,
  wait: 0,        // explicit
  highlight: 0,   // explicit
  dwell: 0,       // pure pause
  waitStable: 0,  // estimated from minMs in normalize(); real cost is decided by the app
};

/** Characters per second for "human" typing. Slow enough to read along with. */
export const DEFAULT_CPS = 14;

export function blankScript({ id, target = "web", url = null } = {}) {
  return {
    version: 1,
    id,
    target,
    url,
    viewport: { width: 1920, height: 1080 },
    steps: [],
  };
}

/**
 * Fill in defaults and compute timing for every step.
 * Returns a new script; does not mutate the input.
 */
export function normalize(script) {
  const steps = (script.steps || []).map((raw, i) => {
    const step = { ...raw };
    step.index = i;
    step.type = step.type || "wait";
    if (!STEP_TYPES.includes(step.type)) {
      throw new Error(`steps[${i}]: unknown type "${step.type}" (expected ${STEP_TYPES.join(", ")})`);
    }

    // A selector ladder: try each in order so replay survives minor DOM drift.
    if (step.selector && !step.selectors) step.selectors = [step.selector];
    if (step.selectors) step.selectors = step.selectors.filter(Boolean);

    if (step.type === "type") {
      step.cps = step.cps || DEFAULT_CPS;
      step.intrinsicMs = Math.round(((step.text || "").length / step.cps) * 1000);
    } else if (step.type === "wait" || step.type === "dwell") {
      step.intrinsicMs = Number(step.ms) || 0;
    } else if (step.type === "highlight") {
      step.intrinsicMs = Number(step.ms) || 1200;
    } else if (step.type === "waitStable") {
      // Wait until the screen stops changing (the app under demo finished its
      // work). The true duration is unknowable ahead of time, so intrinsicMs is
      // only the floor — targets that lean on waitStable (cli) retime the clip
      // in post instead of fitting the script to the narration.
      step.minMs = Number(step.minMs) || 1000;
      step.maxMs = Number(step.maxMs) || 90_000;
      step.stableFrames = Number(step.stableFrames) || 3;
      step.intervalMs = Number(step.intervalMs) || 500;
      step.intrinsicMs = step.minMs;
    } else {
      step.intrinsicMs = step.intrinsicMs ?? INTRINSIC_MS[step.type];
    }

    // Dwell after the step. Clicks default to a readable beat; pure motion doesn't.
    step.dwellMs = step.dwellMs ?? (step.type === "click" || step.type === "goto" ? 900 : 250);
    step.weight = step.weight ?? 1;
    return step;
  });

  return { ...script, steps };
}

/** Baseline duration in ms with no stretching applied. */
export function baseDuration(script) {
  return normalize(script).steps.reduce((sum, s) => sum + s.intrinsicMs + s.dwellMs, 0);
}

/**
 * Fit the script to `targetMs` by scaling dwell only.
 *
 * If the target is shorter than the intrinsic cost of the steps themselves, dwell
 * collapses to a small floor and we report the overflow rather than silently
 * producing a clip that is too long — the caller should shorten the narration or
 * cut steps, and needs to be told.
 */
export function fitToDuration(script, targetMs, { minDwellMs = 120 } = {}) {
  const norm = normalize(script);
  const intrinsic = norm.steps.reduce((s, x) => s + x.intrinsicMs, 0);
  const dwellTotal = norm.steps.reduce((s, x) => s + x.dwellMs, 0);
  const weightTotal = norm.steps.reduce((s, x) => s + x.weight, 0) || 1;

  if (!targetMs) return { script: norm, scale: 1, overflowMs: 0, plannedMs: intrinsic + dwellTotal };

  const floor = norm.steps.length * minDwellMs;
  const available = targetMs - intrinsic;

  if (available < floor) {
    const steps = norm.steps.map((s) => ({ ...s, dwellMs: minDwellMs }));
    const plannedMs = intrinsic + floor;
    return { script: { ...norm, steps }, scale: 0, overflowMs: plannedMs - targetMs, plannedMs };
  }

  // Distribute the available dwell budget across steps by weight.
  const steps = norm.steps.map((s) => ({
    ...s,
    dwellMs: Math.max(minDwellMs, Math.round((available * s.weight) / weightTotal)),
  }));
  const plannedMs = intrinsic + steps.reduce((sum, s) => sum + s.dwellMs, 0);
  return { script: { ...norm, steps }, scale: available / (dwellTotal || 1), overflowMs: 0, plannedMs };
}

/**
 * Resolve `pinToWord` against ElevenLabs word timestamps.
 * Returns a map of step index -> absolute start time in ms.
 *
 * `timestamps` is the array fal returns when `timestamps: true` was requested.
 * We accept a few shapes because the field naming varies by model version.
 */
export function resolvePins(script, timestamps) {
  const pins = new Map();
  if (!Array.isArray(timestamps) || !timestamps.length) return pins;

  const words = timestamps.map((t) => ({
    text: String(t.text ?? t.word ?? "").trim().toLowerCase().replace(/[^a-z0-9']/g, ""),
    startMs: Math.round(Number(t.start ?? t.start_time ?? t.startTime ?? 0) * 1000),
  })).filter((w) => w.text);

  for (const step of script.steps || []) {
    if (!step.pinToWord) continue;
    const wanted = String(step.pinToWord).trim().toLowerCase().replace(/[^a-z0-9']/g, "");
    // `word#2` selects the second occurrence.
    const [base, nthRaw] = wanted.split("#");
    const nth = Number(nthRaw) || 1;
    let seen = 0;
    for (const w of words) {
      if (w.text === base && ++seen === nth) {
        pins.set(step.index, w.startMs);
        break;
      }
    }
  }
  return pins;
}

export function validate(script) {
  const errors = [];
  if (script?.version !== 1) errors.push(`unsupported action script version: ${script?.version}`);
  if (!script?.id) errors.push("missing id");
  if (!Array.isArray(script?.steps) || !script.steps.length) errors.push("no steps");

  for (const [i, s] of (script.steps || []).entries()) {
    const at = `steps[${i}]`;
    if (!STEP_TYPES.includes(s?.type)) {
      errors.push(`${at}: unknown type "${s?.type}"`);
      continue;
    }
    if (s.type === "goto" && !s.url) errors.push(`${at}: goto needs a url`);
    if (s.type === "type" && !s.text) errors.push(`${at}: type needs text`);
    if (s.type === "key" && !s.key) errors.push(`${at}: key needs a key name`);
    if (["click", "hover", "highlight"].includes(s.type) && !s.selectors?.length && !s.point) {
      errors.push(`${at}: ${s.type} needs a selector or a point`);
    }
    if (s.type === "waitStable" && s.minMs != null && s.maxMs != null &&
        Number(s.maxMs) < Number(s.minMs)) {
      errors.push(`${at}: waitStable maxMs must be >= minMs`);
    }
  }
  return { ok: errors.length === 0, errors };
}
