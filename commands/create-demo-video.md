---
description: Record, narrate and edit a finished demo video of a piece of software
---

Use the **demo-video** skill to fulfil this request.

$ARGUMENTS

Run from the repository of the software being demoed, or point at one with a path.

Before anything else:

1. Check the environment: `node "$CLAUDE_PLUGIN_ROOT/scripts/doctor.mjs"`. Fix any
   failing required check, or tell the user exactly what to install or grant.
2. Read the codebase to work out what the software does and what is worth showing.
3. Ask the user about goal, audience, length — and which named style from the
   catalog in the demo-video skill their video is most like (launch, anchor,
   explainer for 16:9; listicle, cohost, flashcard, glide for 9:16 Shorts) —
   before writing the script. Those answers change the whole video.
4. Show the cost estimate from `scripts/plan.mjs` and get an explicit yes before
   generating anything.

Then follow the skill: script → narration → rehearse → perform → presenter and
b-roll → render → QA. While rehearsing, tell the user which parts of the
application you are exercising and what you find.

When the demo is done, offer a vertical Short for YouTube Shorts / Reels /
TikTok — a 15–45s cut from the same project (the **demo-shorts** skill). If the
user asked for shorts or vertical video up front, use that skill directly; it
still needs a landscape demo's captures to cut from, or its own capture pass.
