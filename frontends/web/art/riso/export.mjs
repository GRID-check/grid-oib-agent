#!/usr/bin/env node
/*
 * Export the riso plates into frontends/web/public/art/.
 *
 *   node art/riso/export.mjs --kit <riso-windowseat>/tools [--only 0,3] [--engine firefox]
 *
 * Each JOB in tafeln/index.html is one integer time and one file at its exact
 * display size. For every job this runs the kit's own still.mjs (which checks
 * that the frame repeats after another seek), checks the pixel size, and
 * encodes the file named in the job: .webp at quality 95 with sharp-YUV, or a
 * max-compression .png. Nothing is ever resized: resampling a halftone screen
 * makes moiré.
 *
 * Run from frontends/web with its node_modules installed (sharp comes with Astro).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? a.concat([[v.slice(2), all[i + 1]]]) : a), []));
const kit = args.kit || process.env.RISO_KIT;
if (!kit || !fs.existsSync(path.join(kit, 'still.mjs'))) {
  console.error('usage: node art/riso/export.mjs --kit <riso-windowseat>/tools [--only 0,3]');
  process.exit(1);
}
const html = path.join(here, 'tafeln', 'index.html');
const outDir = path.resolve(here, '..', '..', 'public', 'art');
const src = fs.readFileSync(html, 'utf8');
const jobs = [...src.matchAll(/\{ plate: (\d+), fmt: '(\w+)',\s+w: (\d+),\s+h: (\d+),\s+pitch: [\d.]+, file: '([^']+)' \}/g)]
  .map((m) => ({ plate: +m[1], fmt: m[2], w: +m[3], h: +m[4], file: m[5] }));
if (!jobs.length) throw Error('no JOBS found in ' + html);
const only = args.only ? args.only.split(',').map(Number) : jobs.map((_, i) => i);
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riso-'));

for (const i of only) {
  const j = jobs[i];
  const png = path.join(tmp, `job-${i}.png`);
  execFileSync('node', ['still.mjs', html, '--at', String(i), '--out', png, '--engine', args.engine || 'firefox'], { cwd: kit, stdio: 'inherit' });
  const meta = await sharp(png).metadata();
  if (meta.width !== j.w || meta.height !== j.h) throw Error(`${j.file}: got ${meta.width}x${meta.height}, want ${j.w}x${j.h}`);
  const out = path.join(outDir, j.file);
  const img = sharp(png);
  if (j.file.endsWith('.webp')) await img.webp({ quality: 95, smartSubsample: true, effort: 6 }).toFile(out);
  else await img.png({ compressionLevel: 9, effort: 10 }).toFile(out);
  console.log(`${String(i).padStart(2)}  ${j.file}  ${j.w}x${j.h}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}
fs.rmSync(tmp, { recursive: true, force: true });
