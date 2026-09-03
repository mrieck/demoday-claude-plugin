<a name="top"></a>

![DemoDay — Lights, camera, Claude.](docs/demoday_banner.png)

# DemoDay

**Your software deserves a launch video. Let Claude film it.**

DemoDay is a [Claude Code](https://claude.com/claude-code) plugin that turns any
codebase into a finished, narrated demo video. Claude reads your repo, writes the
script with you, **drives your app on screen**, narrates it with an AI voiceover —
and hands you a polished MP4 with intro, captions, transitions and an optional
on-camera presenter. One command, about the cost of a coffee. macOS only.

```
/demoday:create-demo-video
```

## 🎬 See it in action

https://github.com/user-attachments/assets/18bf039d-789f-4685-91fe-96c1b051cb4d

*Sample demo video of Overboard, another Claude Plugin (project dashboard), narrated and
edited entirely by DemoDay, including the sea-captain voiceover using ElevenLabs.*

## 📱 Shorts

The same project can also be cut into a vertical **Short** for YouTube Shorts,
Instagram Reels and TikTok — say *"make a short"* (or "vertical video", "Reel",
"TikTok") and Claude picks one of four named styles with you:

| style | feels like |
|---|---|
| `listicle` | "3 ways it fixes X" — numbered rundown, a cut every ~1.5s, presenter anchored under the demo |
| `cohost` | screenshare with the presenter talking below it throughout |
| `flashcard` | big typographic cards asking, the UI answering — no face |
| `glide` | one immersive screen recording, the camera gliding to each click |

https://github.com/user-attachments/assets/5597a659-5655-4b5e-a2f7-8b77ba55d42a

*Sample listicle Short for [Social Cue](https://trysocialcue.com), a Claude
plugin that finds conversations worth joining. The presenter is an AI avatar
made from a photo of the author, speaking with a designed ElevenLabs voice; the
"it browses for you" beat is a Remotion animation instead of screen capture,
timed to the narration word by word.*

## ✨ What you get

- 🖱️ **Claude drives your app** — it rehearses off camera first, then a
  deterministic runner performs the take with smooth cursor moves and human
  typing. No dead air, no fumbling.
- 🎙️ **AI voiceover with word-timed captions** — narration is generated first,
  so every scene lands exactly on the voice.
- 🧑‍💼 **Optional on-camera presenter** — an AI presenter for the intro, outro
  and cutaways, lip-synced to the same voice as the narration.
- 🧭 **Wide videos in named styles too** — `launch` (classic promo), `anchor`
  (avatar-led), `explainer` (no face), or `tutorial`: a step-by-step walkthrough
  with the full workflow on screen and the presenter riding along as a corner
  bubble — one continuous lip-synced take that stays up through every cut
  (circle or rounded square, any corner; bottom-right by default).
- 🗣️ **Custom character voices** — describe a voice in plain English
  (*"weathered lobster-boat captain, thick coastal accent"*) and the whole demo
  is narrated in it.
- 🎞️ **Real editing, not a screencast** — title cards, transitions,
  zoom-to-click, callouts, b-roll and audio ducking, rendered with
  [Remotion](https://remotion.dev).
- 📱 **Vertical Shorts too** — cut a 15–45s 9:16 Short (YouTube Shorts,
  Reels, TikTok) from the same project in one of four named styles: listicle,
  cohost, flashcard or glide.
- 💻 **Films almost anything on a Mac** — web apps, native macOS apps, and
  CLI/terminal programs (yes, it can demo a Claude Code plugin from inside a
  live `claude` session).
- 🔁 **Cheap to iterate** — change one line of narration and only that line is
  regenerated. A cost estimate is shown *before* anything is spent.

## 🚀 Install

In Claude Code:

```
/plugin marketplace add mrieck/claude-plugins
/plugin install demoday@productive-mark
```

(`productive-mark` is the marketplace, hosted in
[mrieck/claude-plugins](https://github.com/mrieck/claude-plugins); `demoday` is
the plugin — this repo.)

That's it for software — no `npm install`, no manual dependency setup. The first
time you run `/demoday:create-demo-video`, Claude checks your machine and
installs anything missing (Node packages, a capture browser, ffmpeg) before
filming starts.

> **Requirements:** macOS and [Claude Code](https://claude.com/claude-code). The
> only thing Claude can't do for you is the two steps below.

### 1. Add your fal.ai key (required)

All generation — voice, presenter, b-roll — runs through
[fal.ai](https://fal.ai/dashboard/keys). Store the key in your macOS Keychain by
running this **in your own terminal** (not through Claude, so the key never
touches a transcript):

```bash
security add-generic-password -s demoday -a FAL_API_KEY -w
```

It prompts for the key without echoing it. A typical 30-second demo costs
**$1–2 in fal credits**.

Not on Keychain terms? Every other place a key can live is covered in
[HOW_IT_WORKS.md](HOW_IT_WORKS.md#where-api-keys-can-live).

### 2. Grant screen permissions (desktop capture only)

To film a **native Mac app**, give the terminal you run Claude Code from
(Terminal, iTerm, VS Code…) **Screen Recording** and **Accessibility** in System
Settings → Privacy & Security, then restart the terminal. Filming web apps and
CLI demos in a staged terminal window needs no permissions at all — and if
anything's missing, Claude tells you the exact Settings pane during preflight.

### Optional keys

Same Keychain one-liner, different account name:

- **`ELEVENLABS_API_KEY`** — unlocks custom character voices via
  [ElevenLabs Voice Design](https://try.elevenlabs.io/zecjglkbwy6x)
  *(affiliate link)*, and **sound effects**: a per-project pack of cues
  (whoosh, pop, hit, tick, riser) generated from text prompts and fired
  automatically on transitions, insert cards, `#N` stamps, punch-ins and bullet
  reveals — ~$0.02 a take, three takes per cue, pick your favourite. Needs a
  paid ElevenLabs plan (Starter and up): the free tier blocks voice
  creation over the API, and a paid plan also carries the commercial license
  you'd want for a published video anyway.
- **`BRAVE_API_KEY`** — lets b-roll generation search reference images.

## 🔒 What leaves your machine

Screen recordings, rehearsal screenshots and the finished MP4 stay local. Only
what generation needs is uploaded: narration text, narration audio, the
presenter image and b-roll frames go to [fal.ai](https://fal.ai) — and
narration text to [ElevenLabs](https://elevenlabs.io) if you use it. API keys
are only ever read, never written
([details](HOW_IT_WORKS.md#where-api-keys-can-live)).

## 🎥 Make your first video

From the repo of the software you want to show off:

```
/demoday:create-demo-video
```

Claude will read the codebase, pitch you two or three flows worth filming, ask
about goal, audience, length and presenter style, and show you the cost estimate.
Only after you say yes does it generate a single frame. Ten-ish minutes later
there's an MP4 in that video's project folder under `demo/` (each video gets its
own, e.g. `demo/project-overview/`).

## 🔍 Under the hood

The interesting bits — the two-pass rehearse/perform design, narration-first
pacing, the `demo.json` manifest, content-addressed caching, and everything about
API-key resolution — live in [HOW_IT_WORKS.md](HOW_IT_WORKS.md).

Meme-style cold opens (reaction clip + slow-mo cutout + freeze frame + music + push-in) are declared as a `composite` block on a scene and baked by `scripts/edit/composite.mjs`; `scripts/gen/fetch-audio.mjs` pulls a music cue with yt-dlp; `scripts/gen/sfx.mjs` designs the sound-effect pack and `scripts/lib/sfx.mjs` places every cue on the absolute timeline before the render. Every render rewrites `SCRIPT.md` from the manifest so downstream tools (cross-posting) always read the current cut.

## 📄 License notes

Rendering uses Remotion, which is free for individuals and small companies but
needs a paid license above a headcount threshold — see
[remotion.dev/license](https://remotion.dev/license). Voices generated on a paid
ElevenLabs plan include commercial usage rights.

To subscribe to an ElevenLabs plan that allows commercial use,
[click here](https://try.elevenlabs.io/zecjglkbwy6x) *(affiliate link)*.

DemoDay itself is [MIT licensed](LICENSE).
