#!/usr/bin/env node
/*
 * The fast riso gate, part of `npm run check`. No browser: it evaluates each
 * work's JOBS table in Node (kit.mjs) and reads image headers with sharp.
 *
 *   node art/riso/check.mjs
 *
 * Fails when:
 *   - a work has no PRINT.md, or art/riso/LICENSE-NOTICE.md is missing
 *   - a work's JOBS table does not evaluate (bad format, plate, alt text ...)
 *   - a site job's file is not exported (public/art/<file> missing)
 *   - src/data/art.json differs from what the JOBS tables and the files on disk
 *     give (stale alt text, a re-export whose ?v= hash was not written, a hand
 *     edit): run node art/riso/export.mjs --manifest, or a full export
 *   - a manifest file is missing, has other pixel dimensions than declared, or
 *     is over 1 MB (the pre-commit hook's limit)
 *   - a file in public/art/ is in no manifest entry (an orphan)
 *   - src/ names an art id that is not in the manifest, or a /art/ file path
 *     at all: pages reach art by id through src/lib/art.ts
 *
 * The expensive determinism check is separate: node art/riso/verify.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  HERE, MANIFEST, MAX_BYTES, PUBLIC_ART, WEB, evaluateWork, listWorks, manifestFrom, manifestText, srcPath,
} from './kit.mjs';

const problems = [];
const fail = (m) => problems.push(m);
const rel = (p) => path.relative(WEB, p);

// ── works and their paperwork ────────────────────────────────────────────────
if (!fs.existsSync(path.join(HERE, 'LICENSE-NOTICE.md'))) fail('art/riso/LICENSE-NOTICE.md is missing (the kit is MIT: its notice must ship with adapted code)');
const works = listWorks();
const jobsByWork = [];
for (const w of works) {
  if (!fs.existsSync(path.join(w.dir, 'PRINT.md'))) fail(`${rel(w.dir)}/PRINT.md is missing: every work records its design, inspection and weaknesses`);
  try { jobsByWork.push(evaluateWork(w).jobs); } catch (e) { fail(`${rel(w.html)}: ${e.message}`); }
}

// ── the manifest against the JOBS tables and the bytes on disk ──────────────
const { manifest: expected, missing } = manifestFrom(jobsByWork);
for (const f of missing) fail(`public/art/${f} is not exported: node art/riso/export.mjs --only <its id>`);
const committed = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, 'utf8') : '';
if (committed !== manifestText(expected)) {
  fail(`${rel(MANIFEST)} is stale against the JOBS tables or the files in public/art/: node art/riso/export.mjs --manifest`);
}
let manifest = { art: {} };
try { manifest = JSON.parse(committed); } catch { fail(`${rel(MANIFEST)} is not JSON`); }

const listed = new Set();
for (const [id, e] of Object.entries(manifest.art || {})) {
  for (const l of ['de', 'en']) if (!e.alt || !String(e.alt[l] || '').trim()) fail(`${id}: alt text missing in ${l}`);
  if (e.caption) for (const l of ['de', 'en']) if (!String(e.caption[l] || '').trim()) fail(`${id}: caption missing in ${l}`);
  for (const f of e.files || []) {
    if (!/\?v=[0-9a-f]{8}$/.test(f.src)) fail(`${id}: ${f.src} carries no ?v=<hash>; /art/ is cached for a week, so every URL must change with its bytes`);
    const file = path.join(WEB, 'public', srcPath(f.src));
    listed.add(path.basename(file));
    if (!fs.existsSync(file)) { fail(`${id}: ${f.src} does not exist`); continue; }
    const bytes = fs.statSync(file).size;
    if (bytes > MAX_BYTES) fail(`${id}: ${f.src} is ${(bytes / 1024).toFixed(0)} KB, over the 1 MB commit limit`);
    const m = await sharp(file).metadata();
    if (m.width !== f.width || m.height !== f.height) fail(`${id}: ${f.src} is ${m.width}x${m.height}, the manifest says ${f.width}x${f.height}`);
  }
}

// ── orphans in public/art/ ───────────────────────────────────────────────────
if (fs.existsSync(PUBLIC_ART)) {
  for (const f of fs.readdirSync(PUBLIC_ART)) {
    if (!listed.has(f)) fail(`public/art/${f} is in no manifest entry: delete it, or declare it in a work's JOBS`);
  }
}

// ── references from src/ ─────────────────────────────────────────────────────
const ids = new Set(Object.keys(manifest.art || {}));
const workNames = works.map((w) => w.name).join('|');
const idRe = new RegExp(`['"\`]((?:${workNames || '\\u0000'})/[a-z0-9-]+/[a-z0-9-]+)['"\`]`, 'g');
const pathRe = /['"`(]\/art\/[^'"`)\s]*/g;
function* files(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) yield* files(p);
    else if (/\.(astro|ts|tsx|js|mjs|md|mdx|mdoc|yaml|json)$/.test(d.name) && p !== MANIFEST) yield p;
  }
}
for (const file of files(path.join(WEB, 'src'))) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(idRe)) if (!ids.has(m[1])) fail(`${rel(file)}: art id "${m[1]}" is not in the manifest`);
  for (const m of text.matchAll(pathRe)) fail(`${rel(file)}: names the file ${m[0].slice(1)}; reference art by id (src/lib/art.ts)`);
}

if (problems.length) {
  console.error(`riso check: ${problems.length} problem(s)\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`riso check: ${works.length} work(s), ${ids.size} art ids, ${listed.size} files in public/art/ ok`);
