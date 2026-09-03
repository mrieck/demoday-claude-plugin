#!/usr/bin/env node
/**
 * Write SCRIPT.md for a project from its manifest — the human/agent-readable
 * record of what the rendered video actually says and shows. Other tools
 * (the cross-posting agent) read this file to write captions and titles, so
 * it must describe the CURRENT cut only: every narration line in order,
 * scenes with no narration called out, and nothing from earlier drafts.
 *
 *   node scripts/script-md.mjs --project demo/<slug> [--manifest shorts.json] [--out SCRIPT.md]
 *
 * render.mjs calls this after every successful render. The generated block
 * sits between `<!-- demoday:script -->` … `<!-- /demoday:script -->`
 * markers; anything outside the markers (build notes, capture notes, a
 * "removed from earlier drafts" list) is preserved verbatim, so hand-written
 * context survives re-renders while the narration never goes stale.
 */
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "./lib/args.mjs";
import * as manifest from "./lib/manifest.mjs";
import { report, main, fmtDuration } from "./lib/log.mjs";

const OPEN = "<!-- demoday:script -->";
const CLOSE = "<!-- /demoday:script -->";

function describeVisual(s) {
  const bits = [];
  if (s.kind === "card") bits.push("card");
  else if (s.kind === "presenter") bits.push("presenter on camera");
  else if (s.kind === "broll") bits.push(`b-roll${s.prompt ? `: ${s.prompt}` : ""}`);
  else {
    if (s.composite) bits.push(`composite (${(s.composite.layers ?? []).length} layers${s.composite.zoom ? ", push-in" : ""}${s.composite.music ? ", music" : ""})`);
    if (s.beatLayout === "anchored") bits.push(`anchored split, ${s.bottom?.kind ?? "captions"} below`);
    else if (s.framing) bits.push(`framing ${s.framing}`);
    const titles = (s.beats ?? []).filter((b) => b.shot === "insert" && b.title).map((b) => `"${b.title}"`);
    if (titles.length) bits.push(`inserts ${titles.join(", ")}`);
    const faces = (s.beats ?? []).filter((b) => b.shot === "face").length;
    if (faces) bits.push(`${faces} face punch-in${faces > 1 ? "s" : ""}`);
    if (s.muteSource === false) bits.push("clip audio audible");
  }
  return bits.join("; ");
}

export function renderScript(m, { rendered } = {}) {
  const total = manifest.totalDuration(m);
  const fmt = m.format ?? {};
  const lines = [];
  lines.push(OPEN);
  lines.push(`# ${m.product?.name ?? m.slug}${m.style ? ` — ${m.style} Short` : ""}`);
  lines.push("");
  const meta = [
    `Output: \`out/${m.slug}.mp4\` ${fmtDuration(total)} ${fmt.width}x${fmt.height}`,
    rendered ? `rendered ${rendered}` : null,
    m.product?.tagline ? `Tagline: ${m.product.tagline}` : null,
    m.presenter?.mode && m.presenter.mode !== "none" ? `Presenter: ${m.presenter.description ?? "on camera"}` : null,
    m.voice?.voiceName ? `Voice: ${m.voice.voiceName}` : null,
    m.watermark?.text ? `Watermark: ${m.watermark.text}` : null,
    m.cover ? `Cover: ${m.cover.kind === "frame" ? `frozen frame from ${m.cover.scene ?? "timeline"} @${m.cover.atSec}s` : `hook card "${m.cover.hook}"`}` : "Cover: none (frame 0 is the real open)",
  ].filter(Boolean);
  lines.push(meta.join(". ") + ".");
  lines.push("");
  lines.push("## Narration — complete and in order (nothing else is spoken)");
  lines.push("");
  let t = 0;
  for (const s of m.timeline) {
    const d = s.durationSec ?? 0;
    const at = `${fmtDuration(t)}`;
    if (s.narration) lines.push(`- **${s.id}** (${at}, ${d.toFixed(1)}s): ${s.narration}`);
    else if (s.kind === "card") lines.push(`- **${s.id}** (${at}, ${d.toFixed(1)}s, card, no narration): ${[s.title, s.subtitle, s.cta ? `[${s.cta}]` : null].filter(Boolean).map((x) => `"${x}"`).join(" / ")}`);
    else lines.push(`- **${s.id}** (${at}, ${d.toFixed(1)}s, no narration${s.muteSource === false ? ", clip audio plays" : ""}): ${s.note ?? s.describe ?? "visual only"}`);
    t += d;
  }
  lines.push("");
  lines.push("## Visuals");
  lines.push("");
  for (const s of m.timeline) {
    const v = describeVisual(s);
    lines.push(`- ${s.id}: ${v || s.kind}${s.note && s.narration ? ` — ${s.note}` : ""}`);
  }
  if (m.product?.valueProps?.length) {
    lines.push("");
    lines.push("## Key points");
    lines.push("");
    for (const p of m.product.valueProps) lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push("Anything not listed above is NOT in the video — do not describe earlier drafts.");
  lines.push(CLOSE);
  return lines.join("\n") + "\n";
}

export async function writeScript(projectDir, m, { name = "SCRIPT.md", rendered } = {}) {
  const file = path.join(projectDir, name);
  const block = renderScript(m, { rendered });
  let existing = existsSync(file) ? await readFile(file, "utf8") : "";
  let next;
  const i = existing.indexOf(OPEN);
  const j = existing.indexOf(CLOSE);
  if (i !== -1 && j !== -1) {
    next = existing.slice(0, i) + block + existing.slice(j + CLOSE.length + 1);
  } else if (existing.trim()) {
    // First run on a hand-written file: keep it below as notes, generated block on top.
    next = `${block}\n## Notes (hand-written; verify against the narration above)\n\n${existing.replace(/^# /m, "### ")}`;
  } else {
    next = block;
  }
  await writeFile(file, next);
  return file;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(async () => {
    const args = parseArgs(process.argv.slice(2));
    const projectDir = manifest.resolveProjectDir(args.project);
    const name = args.manifest || manifest.MANIFEST_NAME;
    const m = await manifest.load(projectDir, { name });
    const file = await writeScript(projectDir, m, { name: args.out || "SCRIPT.md" });
    report(`  wrote ${path.relative(projectDir, file)}`, { ok: true, path: file });
  });
}
