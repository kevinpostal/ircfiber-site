#!/usr/bin/env node
// Packs TheDraw colour fonts into src/lib/tdf-fonts.bin for the compose
// style dialog.
//
//   git clone --depth 1 https://github.com/tat3r/tdfiglet /tmp/tdfiglet
//   node scripts/pack-tdf.mjs /tmp/tdfiglet/fonts [--all]
//
// Default packs the first record of every file (what tdfiglet renders);
// `--all` also packs the recolour variants that follow it in multi-font
// files (~3× the bytes for the same glyph shapes).
//
// Pack layout: u32 LE header length H, H bytes of UTF-8 JSON
// `{ v: 1, fonts: TdfFontMeta[] }`, then the raw font records back to back.
// `TdfFontMeta.off` is relative to the data start (4 + H). A record is the
// TheDraw layout minus the 20-byte file magic; see src/lib/tdf.ts.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('\x13TheDraw FONTS file\x1a', 'latin1');
const RECORD_HEADER = 213;
const NUM_CHARS = 94;

const args = process.argv.slice(2);
const all = args.includes('--all');
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) {
  console.error('usage: pack-tdf.mjs <fonts dir> [--all]');
  process.exit(2);
}
const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'tdf-fonts.bin');

/** Max glyph height over defined glyphs of one record. */
function recordHeight(rec) {
  let height = 0;
  for (let i = 0; i < NUM_CHARS; i++) {
    const off = rec[25 + i * 2] | (rec[26 + i * 2] << 8);
    if (off === 0xffff) continue;
    const p = RECORD_HEADER + off + 1;
    if (p < rec.length && rec[p] > height) height = rec[p];
  }
  return height;
}

const fonts = [];
const chunks = [];
const seenNames = new Map();
let offset = 0;
let skippedFiles = 0;
let skippedRecords = 0;

const files = readdirSync(dir)
  .filter((f) => /\.tdf$/i.test(f) && statSync(join(dir, f)).isFile())
  .sort((a, b) => a.localeCompare(b));

for (const file of files) {
  const buf = readFileSync(join(dir, file));
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    console.error(`skip ${file}: bad magic`);
    skippedFiles++;
    continue;
  }
  let r = MAGIC.length;
  let first = true;
  while (r + RECORD_HEADER <= buf.length) {
    const blockSize = buf[r + 23] | (buf[r + 24] << 8);
    const rec = buf.subarray(r, r + RECORD_HEADER + blockSize);
    r += RECORD_HEADER + blockSize;
    const type = rec[21];
    if (type !== 2 || (!first && !all)) {
      skippedRecords++;
      first = false;
      continue;
    }
    first = false;
    const nameLen = rec[4];
    let name = rec.subarray(5, 5 + Math.min(nameLen, 16)).toString('latin1').replace(/\0+$/, '').trim();
    if (!name) name = basename(file, '.tdf');
    const stem = basename(file, '.tdf');
    if (seenNames.has(name)) name = `${name} (${stem})`;
    seenNames.set(name, true);
    fonts.push({ name, file: stem, off: offset, len: rec.length, spacing: rec[22], height: recordHeight(rec) });
    chunks.push(rec);
    offset += rec.length;
  }
}

const header = Buffer.from(JSON.stringify({ v: 1, fonts }), 'utf8');
const len = Buffer.alloc(4);
len.writeUInt32LE(header.length, 0);
const out = Buffer.concat([len, header, ...chunks]);
writeFileSync(outPath, out);
console.log(`packed ${fonts.length} colour fonts from ${files.length} files → ${outPath} (${(out.length / 1e6).toFixed(2)} MB)`);
if (skippedFiles || skippedRecords) console.log(`skipped ${skippedFiles} files, ${skippedRecords} records`);
