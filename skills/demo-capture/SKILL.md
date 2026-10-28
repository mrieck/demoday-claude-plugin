---
name: demo-capture
description: >-
  Craft and mechanics of capturing software on screen for a demo video —
  rehearsing a flow, staging a window, the action-script format, pacing to
  narration, and macOS permissions and coordinates. Use when recording an app
  or a browser extension, driving a UI for a video, debugging a capture that looks wrong, or when clicks
  land in the wrong place.
---

# Capturing the screen

## Rehearse, then perform

The rehearsal session (`demo_*` MCP tools, or `node scripts/stage.mjs <name>`
from the shell when the tools are not in your tool list) is for figuring things
out. The performance runner replays what you found, smoothly, while recording.

Consequences worth internalising:

- Anything you do during rehearsal is invisible in the final video. Explore freely.
- Only *successful* actions are recorded, so a failed click cannot poison a script.
- The performance replays **exactly** the recorded steps. If the app needs to be in
  a particular state to start, put that in the action script or reset the app
  before performing.

## Writing a flow that films well

- **One idea per scene.** If narration needs "and then", it is two scenes.
- **Start where the user starts.** Not on a page you navigated to off-camera.
- **Type realistic content.** "Acme Demo" reads as a demo. "asdf" reads as a bug.
- **Pause after the payoff.** Add `dwellMs` on the step that produces the result;
  the viewer needs a beat to see what changed.
- **Highlight the moment that matters.** One `demo_highlight` per scene, on the
  thing the narration is naming. More than one and none of them land.
- **Never demo a login.** Use `storageState` or log in before `markStart`.

## Pacing to the narration

`--target-duration` stretches *dwell*, never motion. The clip lands on the
voiceover instead of being cut to fit afterwards.

`pinToWord` goes further: a step fires exactly when a word is spoken.

```json
{ "type": "click", "selectors": ["[data-testid=save]"],
  "label": "Save", "pinToWord": "save" }
```

Use `word#2` for the second occurrence. Requires the scene's `.words.json`, passed
as `--timestamps`.

If the runner warns about overrun, the steps genuinely cannot fit — cut steps or
lengthen the line. It will not silently speed up the cursor.

## Web specifics

- The cursor in the video is **drawn**, because Playwright's real pointer is
  invisible to the recorder. It is animated with the Web Animations API rather
  than requestAnimationFrame, which does not fire reliably under headless capture.
- Prefer `demo_inspect` selectors. The ladder (`data-testid` → id → role+name →
  text → structural path) is tried in order, so replay survives small DOM changes.
- Headless is fine and slightly more reliable; use headed when you want to watch.
- Authenticated sessions: `--storage-state <file>`.

## macOS desktop specifics

### Permissions come first

```bash
node scripts/doctor.mjs --target mac
```

Two permissions are needed, and **both fail silently in different ways**:

| Missing | Symptom |
|---|---|
| Screen Recording | `screencapture` errors; recording is black or absent |
| Accessibility | clicks and keystrokes do nothing; window sizing fails |

Both are granted to the *terminal application*, and it must be restarted
afterwards. `doctor` names the exact panes.

### Coordinates — the thing that silently goes wrong

Three different spaces are in play:

| Space | Used by | Example |
|---|---|---|
| Logical points | `cliclick`, window bounds | 1512 × 982 |
| Physical pixels | `screencapture` output | 3024 × 1964 |
| Downscaled image | what you actually look at | 1400 × 909 |

**Never convert between them yourself.** Give `demo_click` the coordinates you read
off the screenshot; the server converts using that exact screenshot's recorded
mapping. A hand-done 2× conversion lands somewhere plausible but wrong, and you
only find out when you watch the finished video.

### Staging

`demo_open_app` sizes the window exactly, hides the Dock and desktop icons, and
**restores all of it on `demo_close`**, including on Ctrl-C. Some apps clamp their
window size; the achieved size is what gets recorded and is reported back.

Notifications cannot be suppressed programmatically on current macOS. Tell the
user to turn on a Focus mode before recording — a banner sliding into frame ruins
an otherwise finished take.

## CLI / terminal specifics

A `cli` scene records a **real** Terminal window running the **real** program —
when the demo is a Claude Code plugin, that is a live `claude` session, spending
real usage and producing output nobody scripted. Three things make that filmable:

### Staging

`demo_open_cli` opens a fresh Terminal.app window with a dedicated "demoday-demo"
profile (20pt font — the video gets scaled down, so keep it big — dark theme),
`cd`'d into the demo project, sized exactly, Dock and icons hidden. The user's
own terminal profiles are never touched. Everything is restored on `demo_close`.

Before rehearsing or recording a claude demo, **pre-approve the demo project's
permissions** (`.claude/settings.json` allowlist): a permission prompt mid-take
stalls the recording and there is nobody driving the mouse to answer it.

### waitStable — waiting out nondeterministic output

After typing a prompt into `claude`, nobody knows how long the answer takes.
`waitStable` polls window screenshots and proceeds once the screen stops
changing (its pixel-diff tolerance absorbs a blinking cursor; claude's spinner
keeps it from firing early while work is in flight):

```json
{ "type": "waitStable", "minMs": 4000, "maxMs": 120000, "label": "claude finishes" }
```

Rehearse with `demo_wait_stable`, which reports the measured wait — use it to
set a realistic `minMs`/`maxMs` before saving.

### Retiming — how a cli scene lands on the narration

Narration-first still holds, but a cli take cannot be paced to it live (the
program controls the pace). Instead `cli-perform.mjs` records at natural speed
and **retimes the clip in post** to `--target-duration`, clamped to 0.5x–2x, and
scales the event log to match. Write prompts whose output is short and
predictable so the factor stays near 1x. The raw take is kept next to the clip
(`*.raw.mp4`): a narration change only needs `scripts/edit/retime.mjs` on the
raw file, not a new live session.

Other rules that bite: keep hands off the mouse and keyboard during a take (a
focus guard re-activates the demo window before every keystroke, but a wandering
cursor still films); typed text and narration are scanned for secrets by
`qa.mjs`, so never type a real key; end the script with the program exited (or
a `dwell` on the result) so the window can close cleanly.

## Browser window / extension specifics

A `browser` scene records a real browser **window** — toolbar, extension icons
and side panel included — because that is where a browser extension lives. The
web target cannot film one: it records the page only, and an extension's toolbar
icon and side panel sit outside every page.

It is a desktop target wearing a browser. There are no selectors and no
`demo_inspect`: the page, the side panel, the toolbar icon and the browser's own
menus are all driven by sight — `demo_screenshot`, then `demo_click`,
`demo_drag` and `demo_type` with coordinates read off the image. Same
permissions as a desktop scene:

```bash
node scripts/doctor.mjs --target browser
```

### The profile is prepared once, then frozen

`demo_open_browser` launches a dedicated Chrome for Testing — never the user's
own Chrome — with the unpacked extension loaded. Pass the **built** directory,
the one containing `manifest.json` (usually `dist/`), and build it first.

There are two kinds of session, and the difference matters:

- **`setup: true`** — changes to the browser are **kept**. Run it once per
  extension: sign in, pin the extension's toolbar icon (puzzle-piece menu, then
  the pin), drag the side panel to the width you want, `demo_close`. Do not save
  these steps as a scene.
- **default** — the session runs on a **throwaway copy** of that profile, and so
  does every take. Nothing a scene does is kept.

That split is what makes a replay possible. Steps are window coordinates, so a
take only lands if it starts exactly where rehearsal started — and an extension
that saves its state (notes, history, a dismissed onboarding card) would
otherwise carry the rehearsal's leftovers into the take and shift everything.

The profile lives at `~/.demoday/browser-profiles/<extension name>` unless you
pass `profile`. It holds session cookies; keep it out of any repo.

### Rules that keep a coordinate replay honest

- **Screenshot after anything that moves the layout.** Opening the side panel
  narrows the page and slides the toolbar icons left; coordinates read before it
  opened are wrong after.
- **`waitStable` before a click that follows async work**, with `minMs` past the
  longest quiet gap. Two model results arriving two seconds apart look "stable"
  in between.
- **Variable content moves whatever comes after it.** A real model returns a
  different length each run. Keep later clicks on things above or beside the
  variable content, or rehearse and record against deterministic data.
- **Select text with `demo_drag`**: press just before the first character,
  release just after the last, on the text's vertical centre. Check the
  screenshot — if a character is clipped, `demo_undo_step` and redo it.
- Only one Chrome for Testing window may be running; the session refuses to
  start otherwise, because it could not tell which one to record.

Perform with `browser-perform.mjs`. The script carries its own `url`,
`extension` and `profile`, so the command is just the script, the output and the
narration length:

```bash
node scripts/capture/browser-perform.mjs \
  --actions demo/<slug>/actions/feature-1.json \
  --out demo/<slug>/clips/feature-1.mp4 \
  --target-duration 14.0
```

Keep hands off the mouse and keyboard during a take, as with any desktop scene.

## Action script format

```json
{
  "version": 1,
  "id": "create-project",
  "target": "web",
  "url": "http://localhost:3000",
  "viewport": { "width": 1920, "height": 1080 },
  "steps": [
    { "type": "type", "selectors": ["#name"], "text": "Acme Demo", "label": "name it" },
    { "type": "click", "selectors": ["[data-testid=create]"], "label": "Create", "weight": 2 },
    { "type": "highlight", "selectors": [".card"], "ms": 1200, "label": "the new project" }
  ]
}
```

Steps: `goto` `click` `hover` `type` `key` `scroll` `wait` `highlight` `dwell`
`waitStable` `drag`.

A cli script carries `target: "cli"` and a `cwd` instead of a `url`, and is
performed by `cli-perform.mjs`:

```json
{ "version": 1, "id": "plugin-demo", "target": "cli", "cwd": "/path/to/demo-project",
  "steps": [
    { "type": "type", "text": "claude\n", "label": "launch claude" },
    { "type": "waitStable", "minMs": 3000, "maxMs": 20000, "label": "claude ready" },
    { "type": "type", "text": "/my-plugin:do-thing\n", "label": "the prompt" },
    { "type": "waitStable", "minMs": 4000, "maxMs": 120000, "label": "claude finishes" },
    { "type": "dwell", "ms": 2000, "label": "hold the result" } ] }
```

Useful fields: `label` (used for callouts and logs), `weight` (share of stretched
dwell — raise it on the payoff step), `dwellMs`, `cps`, `pinToWord`. Desktop steps
use `windowPoint: [x, y]` relative to the window instead of selectors; a `drag`
adds `toWindowPoint`.

A browser script carries `target: "browser"` plus the `extension` and `profile`
it was rehearsed with, and is performed by `browser-perform.mjs`:

```json
{ "version": 1, "id": "add-note", "target": "browser", "url": "http://localhost:5199/",
  "extension": "/path/to/extension/dist", "profile": "/Users/me/.demoday/browser-profiles/my-extension",
  "viewport": { "width": 1600, "height": 900 },
  "steps": [
    { "type": "click", "windowPoint": [1450, 63], "label": "toolbar icon" },
    { "type": "drag", "windowPoint": [763, 483], "toWindowPoint": [993, 483], "label": "select the phrase" },
    { "type": "click", "windowPoint": [865, 515], "label": "+ Note" },
    { "type": "waitStable", "minMs": 5000, "maxMs": 30000, "label": "results arrive" } ] }
```

## The event log

Each performance writes `<clip>.events.json` — every click, with a timestamp and
position. The renderer uses it to zoom toward clicks and anchor callouts. A demo
scene without an event log renders flat, so always record it in `demo.json`.
