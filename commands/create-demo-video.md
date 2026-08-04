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
3. Ask the user about goal, audience, length and presenter style before writing
   the script — those answers change the whole video.
4. Show the cost estimate from `scripts/plan.mjs` and get an explicit yes before
   generating anything.

Then follow the skill: script → narration → rehearse → perform → presenter and
b-roll → render → QA. While rehearsing, tell the user which parts of the
application you are exercising and what you find.
