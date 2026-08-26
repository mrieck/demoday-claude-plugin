#!/usr/bin/env node
/**
 * Tile every rendered cover PNG into one contact sheet — the channel grid,
 * before it is the channel grid.
 *
 *   node scripts/render/cover-sheet.mjs [--dir demo] [--out demo/cover-sheet.png] [--cols 4]
 *
 * Scans <dir>/* /out/*-cover.png (the files render.mjs writes for manifests with
 * a `cover`) and lays them out newest-first, so the next Short's cover can be
 * judged against what is already posted: same layout twice in a row, same
 * accent three times, and the grid reads as one video posted repeatedly.
 */
import path from "node:path";
import { readdir, stat, mkdir } from "node:fs/promises";
import { parseArgs } from "../lib/args.mjs";
import { ffmpeg } from "../lib/ff.mjs";
import { report, info, main } from "../lib/log.mjs";

const TILE_W = 270;
const TILE_H = 480;

async function findCovers(root) {
  const found = [];
  let projects = [];
  try { projects = await readdir(root, { withFileTypes: true }); } catch { return found; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const outDir = path.join(root, p.name, "out");
    let files = [];
    try { files = await readdir(outDir); } catch { continue; }
    for (const f of files) {
      if (!/-cover\.png$/i.test(f)) continue;
      const file = path.join(outDir, f);
      found.push({ file, mtime: (await stat(file)).mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.dir || "demo");
  const cols = Math.max(1, Number(args.cols) || 4);
  const out = path.resolve(args.out || path.join(root, "cover-sheet.png"));

  const covers = await findCovers(root);
  if (!covers.length) throw new Error(`no */out/*-cover.png under ${root} — render a manifest with a \`cover\` first`);
  const rows = Math.ceil(covers.length / cols);

  // Every input is scaled to the same tile (covers may come from different
  // formats), concatenated, then tiled; unused cells in the last row stay dark.
  const inputs = covers.flatMap((c) => ["-i", c.file]);
  const scaled = covers.map((_, i) => `[${i}:v]scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,pad=${TILE_W}:${TILE_H}:-1:-1:color=#0B0D12,setsar=1[t${i}]`);
  const chain = covers.map((_, i) => `[t${i}]`).join("");
  const filter = `${scaled.join(";")};${chain}concat=n=${covers.length}:v=1:a=0,tile=${cols}x${rows}:padding=8:margin=8:color=#1a1d26[sheet]`;

  await mkdir(path.dirname(out), { recursive: true });
  await ffmpeg([...inputs, "-filter_complex", filter, "-map", "[sheet]", "-frames:v", "1", out]);

  for (const c of covers) info(`  ${path.relative(root, c.file)}`);
  report(`  ${covers.length} cover(s) -> ${out} — Read it to eyeball the grid`, {
    ok: true, sheet: out, covers: covers.map((c) => c.file), cols, rows,
  });
});
