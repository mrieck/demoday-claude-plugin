#!/usr/bin/env node
/**
 * demo-stage — the interactive rehearsal surface.
 *
 * This server is the REHEARSAL half of the two-pass design. Claude drives the app
 * through these tools with a screenshot after every action, working out what the
 * demo should actually show. Nothing is recorded. Every successful action is
 * appended to an action script, which `demo_save_actions` writes to disk for
 * `web-perform.mjs` to replay smoothly while recording.
 *
 * Why a stateful server rather than CLI scripts: rehearsal needs one live browser
 * across many turns, and screenshots need to come back as images inline. The CLI
 * scripts stay for the performance pass, which is a single process and needs no
 * cross-call state.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import os from "node:os";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { WebSession } from "../scripts/capture/web-session.mjs";
import { MacSession } from "../scripts/capture/mac-session.mjs";
import { CliSession } from "../scripts/capture/cli-session.mjs";
import { imageToScreen } from "../scripts/capture/mac-input.mjs";
import { blankScript } from "../scripts/lib/actions.mjs";

/** Max width we hand back to the model. Bigger costs tokens and buys nothing. */
const SCREENSHOT_MAX_WIDTH = 1400;

const state = {
  session: null,
  target: null,       // "web" | "mac" | "cli"
  script: null,       // the action script being assembled
  shotDir: path.join(os.tmpdir(), `demoday-rehearsal-${process.pid}`),
  // Metadata of the most recent screenshot. Desktop clicks are given in IMAGE
  // coordinates and converted here, in code, using this — never by the model.
  lastShot: null,
};

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (s) => ({ content: [{ type: "text", text: s }], isError: true });

/** Desktop-backed sessions (mac and cli) share screenshots, coordinates and input. */
const isDesktop = () => state.session instanceof MacSession;

function requireSession() {
  if (!state.session) {
    throw new Error("No session open. Call demo_open first.");
  }
  return state.session;
}

/**
 * Screenshot + a text summary, returned together.
 * Downscaled with sharp so the model gets a legible image without paying for
 * full Retina resolution, and the scale factor is reported so any coordinate the
 * model reads off the image can be converted back correctly.
 */
async function shot(note = "") {
  const session = requireSession();
  await mkdir(state.shotDir, { recursive: true });
  const raw = path.join(state.shotDir, `shot-${Date.now()}.png`);

  let buf;
  const lines = [note];

  if (isDesktop()) {
    // The desktop backend already reports an exact image<->points mapping.
    const meta = await session.screenshot(raw, { maxWidth: SCREENSHOT_MAX_WIDTH });
    state.lastShot = meta;
    const sharp = (await import("sharp")).default;
    buf = await sharp(meta.path).png().toBuffer();
    lines.push(
      `window: ${meta.screenPoints.width}x${meta.screenPoints.height} pt at ` +
        `(${meta.origin.x},${meta.origin.y})`,
      `image: ${meta.imagePixels.width}x${meta.imagePixels.height} px`,
      `Give demo_click the coordinates you read off THIS image — the server converts ` +
        `them to screen points for you. Do not scale them yourself.`
    );
  } else {
    await session.screenshot(raw);
    const sharp = (await import("sharp")).default;
    const img = sharp(raw);
    const meta = await img.metadata();
    const scale = Math.min(1, SCREENSHOT_MAX_WIDTH / meta.width);
    buf = scale < 1
      ? await img.resize({ width: Math.round(meta.width * scale) }).png().toBuffer()
      : await img.png().toBuffer();
    state.lastShot = {
      imagePixels: { width: Math.round(meta.width * scale), height: Math.round(meta.height * scale) },
      screenPoints: { width: session.width, height: session.height },
      origin: { x: 0, y: 0 },
    };
    lines.push(
      `viewport: ${session.width}x${session.height} css px`,
      `image: ${Math.round(meta.width * scale)}x${Math.round(meta.height * scale)} px`,
      `cursor: (${session.cursorPos.x}, ${session.cursorPos.y})`,
      `url: ${session.page ? session.page.url() : "-"}`,
      `Prefer selectors from demo_inspect over coordinates — they survive layout changes.`
    );
  }

  lines.push(`steps recorded so far: ${state.script?.steps.length ?? 0}`);

  return {
    content: [
      { type: "text", text: lines.filter(Boolean).join("\n") },
      { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
    ],
  };
}

/** Append a step to the action script being assembled. */
function recordStep(step) {
  if (!state.script) return;
  state.script.steps.push(step);
}

const server = new McpServer(
  { name: "demo-stage", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------

server.registerTool(
  "demo_open",
  {
    title: "Open a demo session",
    description:
      "Launch a browser for rehearsal and start a new action script. Nothing is " +
      "recorded — this is the pass where you work out what the demo should show. " +
      "Run this before any other demo_* tool.",
    inputSchema: {
      url: z.string().describe("URL to open (http(s) or file://)"),
      id: z.string().describe("Scene id this rehearsal is for, e.g. 'create-project'"),
      width: z.number().optional().describe("Viewport width, default 1920"),
      height: z.number().optional().describe("Viewport height, default 1080"),
      headless: z.boolean().optional().describe("Default false so you can watch it"),
      storageState: z.string().optional().describe("Path to a Playwright storageState for an authenticated session"),
    },
  },
  async ({ url, id, width, height, headless, storageState }) => {
    if (state.session) await state.session.close().catch(() => {});
    state.session = new WebSession({
      width: width || 1920,
      height: height || 1080,
      record: false,
      headless: headless ?? false,
      storageState: storageState || null,
    });
    await state.session.start();
    state.target = "web";
    state.script = blankScript({ id, target: "web", url });
    state.script.viewport = { width: width || 1920, height: height || 1080 };
    await state.session.perform({ type: "goto", url });
    return shot(`Opened ${url} for scene "${id}".`);
  }
);

server.registerTool(
  "demo_open_app",
  {
    title: "Open a desktop demo session",
    description:
      "Prepare the macOS desktop for a demo of a native, Electron or terminal app: " +
      "size the app's window exactly, hide the Dock and desktop icons, and start a " +
      "rehearsal session. Nothing is recorded yet. The desktop is restored when you " +
      "call demo_close. Requires Accessibility and Screen Recording permissions — " +
      "run `node scripts/doctor.mjs --target mac` first if unsure.",
    inputSchema: {
      app: z.string().describe('Application/process name, e.g. "Safari", "Visual Studio Code"'),
      id: z.string().describe("Scene id this rehearsal is for"),
      width: z.number().optional().describe("Window width in points, default 1920"),
      height: z.number().optional().describe("Window height in points, default 1080"),
    },
  },
  async ({ app, id, width, height }) => {
    if (state.session) await state.session.close().catch(() => {});
    state.session = new MacSession({
      app,
      width: width || 1920,
      height: height || 1080,
    });
    try {
      await state.session.start();
    } catch (e) {
      state.session = null;
      return fail(`Could not prepare the stage: ${e.message}`);
    }
    state.target = "mac";
    state.script = blankScript({ id, target: "mac" });
    state.script.app = app;
    state.script.viewport = {
      width: state.session.window?.bounds?.w || width || 1920,
      height: state.session.window?.bounds?.h || height || 1080,
    };
    return shot(`Staged "${app}" for scene "${id}". The desktop will be restored on demo_close.`);
  }
);

server.registerTool(
  "demo_open_cli",
  {
    title: "Open a terminal demo session",
    description:
      "Open a fresh, staged Terminal window for a CLI demo (claude, or any " +
      "command-line program): dedicated demo profile with a big font, exact window " +
      "size, Dock and desktop icons hidden. Nothing is recorded. NOTE: anything run " +
      "in this terminal really runs — a rehearsed claude session spends real usage, " +
      "and the demo project should have its permissions pre-approved " +
      "(.claude/settings.json allowlist) or a permission prompt will stall both the " +
      "rehearsal and the recorded take. Requires Accessibility and Screen Recording " +
      "permissions — run `node scripts/doctor.mjs --target cli` first if unsure.",
    inputSchema: {
      id: z.string().describe("Scene id this rehearsal is for"),
      cwd: z.string().describe("Directory the demo shell starts in (the project being demoed)"),
      width: z.number().optional().describe("Window width in points, default 1920"),
      height: z.number().optional().describe("Window height in points, default 1080"),
      fontSize: z.number().optional().describe("Terminal font size, default 20 — keep it big, the video gets scaled down"),
    },
  },
  async ({ id, cwd, width, height, fontSize }) => {
    if (state.session) await state.session.close().catch(() => {});
    state.session = new CliSession({
      cwd,
      width: width || 1920,
      height: height || 1080,
      ...(fontSize ? { fontSize } : {}),
    });
    try {
      await state.session.start();
    } catch (e) {
      state.session = null;
      return fail(`Could not prepare the terminal stage: ${e.message}`);
    }
    state.target = "cli";
    state.script = blankScript({ id, target: "cli" });
    state.script.app = state.session.app;
    state.script.cwd = cwd;
    state.script.viewport = {
      width: state.session.window?.bounds?.w || width || 1920,
      height: state.session.window?.bounds?.h || height || 1080,
    };
    return shot(`Staged a Terminal window in ${cwd} for scene "${id}". The desktop will be restored on demo_close.`);
  }
);

server.registerTool(
  "demo_wait_stable",
  {
    title: "Wait for the screen to settle",
    description:
      "Wait until the window stops changing (the program under demo finished its " +
      "work), then screenshot. Records a waitStable step. The measured wait is " +
      "reported — use it to set a realistic minMs/maxMs before saving. " +
      "Desktop/terminal scenes only.",
    inputSchema: {
      minMs: z.number().optional().describe("Never proceed before this, default 1000"),
      maxMs: z.number().optional().describe("Stop waiting after this, default 90000"),
      label: z.string().optional(),
    },
  },
  async ({ minMs, maxMs, label }) => {
    const session = requireSession();
    if (!isDesktop()) {
      return fail("demo_wait_stable watches real pixels, so it only works for desktop/terminal scenes.");
    }
    const step = {
      type: "waitStable",
      ...(minMs != null ? { minMs } : {}),
      ...(maxMs != null ? { maxMs } : {}),
      label: label || "wait for output",
    };
    const before = Date.now();
    try {
      await session.perform(step);
    } catch (e) {
      return fail(`waitStable failed — the step was NOT recorded.\n${e.message}`);
    }
    recordStep(step);
    const waited = Date.now() - before;
    return shot(
      `Screen settled after ${(waited / 1000).toFixed(1)}s; recorded waitStable. ` +
      `If ${waited}ms is far from your minMs/maxMs, adjust the step before saving.`
    );
  }
);

server.registerTool(
  "demo_screenshot",
  {
    title: "Screenshot the stage",
    description: "Current view of the app, with cursor position and page URL.",
    inputSchema: {},
  },
  async () => shot("Current view.")
);

/**
 * The single most useful rehearsal tool: it removes the guesswork from selectors.
 * Reading a selector off a screenshot is guessing; this reports what is actually
 * in the DOM, ranked, so the recorded script replays reliably later.
 */
server.registerTool(
  "demo_inspect",
  {
    title: "List interactive elements and their selectors",
    description:
      "Every visible clickable/typeable element with a ranked selector ladder, its " +
      "text and its position. Use this to choose selectors instead of guessing from " +
      "a screenshot — the ladder is what makes replay survive small DOM changes.",
    inputSchema: {
      filter: z.string().optional().describe("Only elements whose text/selector contains this"),
      limit: z.number().optional().describe("Max elements, default 40"),
    },
  },
  async ({ filter, limit }) => {
    const session = requireSession();
    if (isDesktop()) {
      return fail(
        "demo_inspect reads the DOM, so it only works for web scenes. For a desktop " +
        "app, take a demo_screenshot and click by the coordinates you see."
      );
    }
    const found = await session.page.evaluate(() => {
      const SEL = "a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],[data-testid]";
      const out = [];
      for (const el of document.querySelectorAll(SEL)) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;

        const label = (
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.value ||
          el.innerText ||
          el.getAttribute("title") ||
          ""
        ).trim().replace(/\s+/g, " ").slice(0, 80);

        // Ranked best-to-worst. Test ids survive redesigns; nth-child does not.
        const ladder = [];
        const testid = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-cy");
        if (testid) ladder.push(`[data-testid=${JSON.stringify(testid)}]`);
        if (el.id) ladder.push(`#${CSS.escape(el.id)}`);
        const role = el.getAttribute("role") ||
          ({ A: "link", BUTTON: "button", INPUT: "textbox", SELECT: "combobox", TEXTAREA: "textbox" })[el.tagName];
        if (role && label) ladder.push(`role=${role}[name=${JSON.stringify(label)}]`);
        if (el.name) ladder.push(`${el.tagName.toLowerCase()}[name=${JSON.stringify(el.name)}]`);
        if (el.getAttribute("placeholder")) ladder.push(`[placeholder=${JSON.stringify(el.getAttribute("placeholder"))}]`);
        if (label && label.length < 40 && el.tagName !== "INPUT") ladder.push(`text=${JSON.stringify(label)}`);

        // Last resort structural path, so there is always something.
        const pathParts = [];
        for (let n = el; n && n.nodeType === 1 && pathParts.length < 4; n = n.parentElement) {
          const tag = n.tagName.toLowerCase();
          if (n.id) { pathParts.unshift(`#${CSS.escape(n.id)}`); break; }
          const idx = [...(n.parentElement?.children || [])].filter((c) => c.tagName === n.tagName).indexOf(n) + 1;
          pathParts.unshift(`${tag}:nth-of-type(${idx})`);
        }
        if (pathParts.length) ladder.push(pathParts.join(" > "));

        out.push({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || null,
          label,
          selectors: ladder,
          box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        });
      }
      return out;
    });

    let list = found;
    if (filter) {
      const f = filter.toLowerCase();
      list = list.filter(
        (e) => e.label.toLowerCase().includes(f) || e.selectors.join(" ").toLowerCase().includes(f)
      );
    }
    list = list.slice(0, limit || 40);

    if (!list.length) return text("No matching interactive elements found.");
    const rendered = list
      .map((e, i) =>
        `${String(i + 1).padStart(2)}. <${e.tag}${e.type ? ` type=${e.type}` : ""}> ` +
        `"${e.label}" at (${e.box.x},${e.box.y}) ${e.box.w}x${e.box.h}\n` +
        `    selectors: ${e.selectors.slice(0, 3).join("  |  ")}`
      )
      .join("\n");
    return text(`${list.length} interactive element(s):\n\n${rendered}`);
  }
);

server.registerTool(
  "demo_click",
  {
    title: "Click an element",
    description:
      "Click by selector (preferred — pass the ladder from demo_inspect) or by page " +
      "coordinates. Records the step into the action script.",
    inputSchema: {
      selectors: z.array(z.string()).optional().describe("Web only: selector ladder, tried in order"),
      x: z.number().optional().describe("X read off the last screenshot image"),
      y: z.number().optional().describe("Y read off the last screenshot image"),
      label: z.string().describe("Human description, used for callouts and logs"),
      dwellMs: z.number().optional().describe("Pause after, for the viewer to read the result"),
      double: z.boolean().optional().describe("Double-click"),
    },
  },
  async ({ selectors, x, y, label, dwellMs, double }) => {
    const session = requireSession();

    if (isDesktop()) {
      if (x == null || y == null) {
        return fail("Desktop clicks need x and y, read off the most recent screenshot.");
      }
      if (!state.lastShot) return fail("Take a demo_screenshot first so coordinates can be mapped.");

      // Convert image coordinates -> screen points HERE, so the model never has to
      // reason about Retina scaling. Store the step window-relative so replay works
      // even if the window lands at a different position next time.
      const screen = imageToScreen(state.lastShot, x, y);
      const windowPoint = [
        screen.x - state.lastShot.origin.x,
        screen.y - state.lastShot.origin.y,
      ];
      const step = {
        type: "click",
        windowPoint,
        label,
        ...(double ? { clickCount: 2 } : {}),
        ...(dwellMs != null ? { dwellMs } : {}),
      };
      try {
        await session.perform({ ...step, intrinsicMs: 500, dwellMs: 0 });
      } catch (e) {
        return fail(`Click failed — the step was NOT recorded.\n${e.message}`);
      }
      recordStep(step);
      return shot(`Clicked ${label} at image (${x},${y}) -> screen (${screen.x},${screen.y}).`);
    }

    const step = {
      type: "click",
      ...(selectors?.length ? { selectors } : {}),
      ...(x != null && y != null ? { point: [x, y] } : {}),
      label,
      ...(double ? { clickCount: 2 } : {}),
      ...(dwellMs != null ? { dwellMs } : {}),
    };
    if (!selectors?.length && (x == null || y == null)) {
      return fail("Provide either selectors or both x and y.");
    }
    try {
      await session.perform({ ...step, intrinsicMs: 500, dwellMs: 0 });
    } catch (e) {
      return fail(`Click failed — the step was NOT recorded.\n${e.message}`);
    }
    recordStep(step);
    return shot(`Clicked ${label}.`);
  }
);

server.registerTool(
  "demo_type",
  {
    title: "Type text",
    description: "Focus an element (if given) and type with human cadence. Records the step.",
    inputSchema: {
      text: z.string(),
      selectors: z.array(z.string()).optional().describe("Field to focus first"),
      label: z.string(),
      cps: z.number().optional().describe("Characters per second, default 14"),
    },
  },
  async ({ text: value, selectors, label, cps }) => {
    const session = requireSession();
    // Desktop typing goes to whatever already has focus — there are no selectors,
    // so click the field first.
    const useSelectors = state.target === "web" && selectors?.length;
    const step = { type: "type", text: value, ...(useSelectors ? { selectors } : {}), label, ...(cps ? { cps } : {}) };
    try {
      await session.perform({ ...step, cps: cps || 14, intrinsicMs: 0, dwellMs: 0 });
    } catch (e) {
      return fail(`Typing failed — the step was NOT recorded.\n${e.message}`);
    }
    recordStep(step);
    return shot(`Typed "${value}".`);
  }
);

server.registerTool(
  "demo_key",
  {
    title: "Press a key",
    description: "Press a key or chord, e.g. Enter, Escape, Meta+A. Records the step.",
    inputSchema: { key: z.string(), label: z.string().optional() },
  },
  async ({ key, label }) => {
    const session = requireSession();
    const step = { type: "key", key, label: label || key };
    try {
      await session.perform({ ...step, intrinsicMs: 180, dwellMs: 0 });
    } catch (e) {
      return fail(`Key press failed — the step was NOT recorded.\n${e.message}`);
    }
    recordStep(step);
    return shot(`Pressed ${key}.`);
  }
);

server.registerTool(
  "demo_scroll",
  {
    title: "Scroll the page",
    description: "Smooth eased scroll by dy pixels (negative scrolls up). Records the step.",
    inputSchema: { dy: z.number(), label: z.string().optional() },
  },
  async ({ dy, label }) => {
    const session = requireSession();
    const step = { type: "scroll", dy, label: label || `scroll ${dy}px` };
    await session.perform({ ...step, intrinsicMs: 700, dwellMs: 0 });
    recordStep(step);
    return shot(`Scrolled ${dy}px.`);
  }
);

server.registerTool(
  "demo_highlight",
  {
    title: "Draw an emphasis ring",
    description:
      "Ring an element to draw the viewer's eye. Use for the payoff moment of a " +
      "scene — the thing the narration is talking about. Records the step.",
    inputSchema: {
      selectors: z.array(z.string()),
      label: z.string(),
      ms: z.number().optional().describe("How long to hold the ring, default 1200"),
    },
  },
  async ({ selectors, label, ms }) => {
    const session = requireSession();
    const step = { type: "highlight", selectors, label, ...(ms ? { ms } : {}) };
    try {
      await session.perform({ ...step, intrinsicMs: ms || 1200, dwellMs: 0 });
    } catch (e) {
      return fail(`Highlight failed — the step was NOT recorded.\n${e.message}`);
    }
    recordStep(step);
    return shot(`Highlighted ${label}.`);
  }
);

server.registerTool(
  "demo_undo_step",
  {
    title: "Drop the last recorded step",
    description:
      "Remove the most recent step from the action script without undoing its effect " +
      "on the app. Use when an action worked but does not belong in the final demo.",
    inputSchema: {},
  },
  async () => {
    if (!state.script?.steps.length) return text("Nothing recorded yet.");
    const dropped = state.script.steps.pop();
    return text(`Dropped: ${dropped.type} "${dropped.label || ""}". ${state.script.steps.length} step(s) remain.`);
  }
);

server.registerTool(
  "demo_review_script",
  {
    title: "Show the action script so far",
    description: "The steps recorded so far, as JSON, plus the estimated runtime.",
    inputSchema: {},
  },
  async () => {
    if (!state.script) return text("No session open.");
    const { baseDuration } = await import("../scripts/lib/actions.mjs");
    const est = baseDuration(state.script) / 1000;
    return text(
      `${state.script.steps.length} step(s), roughly ${est.toFixed(1)}s at default pacing ` +
      `(the performance pass will stretch dwell to match the narration).\n\n` +
      JSON.stringify(state.script, null, 2)
    );
  }
);

server.registerTool(
  "demo_save_actions",
  {
    title: "Save the action script",
    description:
      "Write the rehearsed steps to disk. This file is the input to web-perform.mjs, " +
      "which replays it smoothly while recording.",
    inputSchema: { file: z.string().describe("Path to write, e.g. demo/actions/create.json") },
  },
  async ({ file }) => {
    if (!state.script?.steps.length) return fail("No steps recorded — nothing to save.");
    const abs = path.resolve(file);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, `${JSON.stringify(state.script, null, 2)}\n`);
    const runner =
      state.target === "mac" ? "mac-perform" :
      state.target === "cli" ? "cli-perform" : "web-perform";
    const extraFlag =
      state.target === "mac" ? ` --app ${JSON.stringify(state.script.app)}` :
      state.target === "cli" && state.script.cwd ? ` --cwd ${JSON.stringify(state.script.cwd)}` : "";
    return text(
      `Saved ${state.script.steps.length} step(s) to ${abs}\n\n` +
      `Perform it with:\n  node scripts/capture/${runner}.mjs --actions ${abs}` +
      `${extraFlag} --out demo/clips/${state.script.id}.mp4 --target-duration <narration seconds>` +
      (state.target === "cli"
        ? "\n\nThe cli runner records at natural speed and retimes the take to the target duration afterwards."
        : "")
    );
  }
);

server.registerTool(
  "demo_load_actions",
  {
    title: "Load an existing action script",
    description: "Resume editing a previously saved script instead of rehearsing from scratch.",
    inputSchema: { file: z.string() },
  },
  async ({ file }) => {
    const loaded = JSON.parse(await readFile(path.resolve(file), "utf8"));
    state.script = loaded;
    return text(`Loaded ${loaded.steps?.length ?? 0} step(s) from ${file} for scene "${loaded.id}".`);
  }
);

server.registerTool(
  "demo_close",
  {
    title: "Close the session",
    description: "Shut the browser down. Save the action script first if you want to keep it.",
    inputSchema: {},
  },
  async () => {
    if (!state.session) return text("No session open.");
    await state.session.close().catch(() => {});
    state.session = null;
    const n = state.script?.steps.length ?? 0;
    return text(`Session closed. ${n} step(s) were recorded${n ? " — save them with demo_save_actions if you haven't." : "."}`);
  }
);

// ---------------------------------------------------------------------------

// A crashed or cancelled session must not leave an orphaned browser running.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (state.session) await state.session.close().catch(() => {});
    process.exit(0);
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
