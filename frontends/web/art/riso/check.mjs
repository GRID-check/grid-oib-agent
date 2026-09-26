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
 *   - a site or app job's file is not exported (public/art/<file> missing in
 *     frontends/web or frontends/ui)
 *   - a manifest (src/data/art.json for the site, ../ui/src/lib/art/art.json
 *     for the app) differs from what the JOBS tables and the files on disk give
 *     (stale alt text, a re-export whose ?v= hash was not written, a hand
 *     edit): run node art/riso/export.mjs --manifest, or a full export
 *   - a manifest file is missing, has other pixel dimensions than declared, or
 *     is over 1 MB (the pre-commit hook's limit)
 *   - an on-page file (formats with `onPage`) is missing, differs in size
 *     or densities from its paper twin, has no alpha, or does not reproduce
 *     the paper file when multiplied onto the paper colour (onPageParity)
 *   - alt text or a caption is missing in a locale, or still says TODO
 *   - a file in either public/art/ is in no manifest entry (an orphan)
 *   - the site's or the app's src/ names an art id not in its own manifest, or
 *     a /art/ file path at all: the site reaches art by id through
 *     src/lib/art.ts, the app through ../ui/src/lib/art/
 *
 * The expensive determinism check is separate: node art/riso/verify.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  DESTS, HERE, MAX_BYTES, WEB, evaluateWork, listWorks, manifestFrom, manifestText, srcPath,
} from './kit.mjs';

const problems = [];
const fail = (m) => problems.push(m);
const rel = (p) => path.relative(WEB, p);

// ── works and their paperwork ────────────────────────────────────────────────
if (!fs.existsSync(path.join(HERE, 'LICENSE-NOTICE.md'))) fail('art/riso/LICENSE-NOTICE.md is missing (the kit is MIT: its notice must ship with adapted code)');
const works = listWorks();
const jobsByWork = [];
const paperOf = new Map();
for (const w of works) {
  if (!fs.existsSync(path.join(w.dir, 'PRINT.md'))) fail(`${rel(w.dir)}/PRINT.md is missing: every work records its design, inspection and weaknesses`);
  try {
    const { jobs, paper } = evaluateWork(w);
    jobsByWork.push(jobs);
    paperOf.set(w.name, [1, 3, 5].map((i) => parseInt(paper.slice(i, i + 2), 16)));
  } catch (e) { fail(`${rel(w.html)}: ${e.message}`); }
}

/**
 * Does the on-page file hold the paper file's inks, in register? Multiply it
 * onto the flat paper colour and compare with the paper file pixel by pixel.
 * The paper's mottling and both files' WebP error keep every pixel within 40
 * levels (measured: at most 0.03 % beyond it); the same file one pixel out of
 * register puts 3–19 % beyond it, another plate's inks more. The share of
 * pixels beyond 40 levels, as a fraction.
 */
async function onPageParity(paperFile, pageFile, paper) {
  const { data: p, info } = await sharp(paperFile).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const g = await sharp(pageFile).ensureAlpha().raw().toBuffer();
  let bad = 0;
  for (let i = 0, o = 0; i < p.length; i += 3, o += 4) {
    const a = g[o + 3] / 255;
    let d = 0;
    for (let c = 0; c < 3; c++) d += Math.abs(p[i + c] - paper[c] * (1 - a * (1 - g[o + c] / 255)));
    if (d > 120) bad++;
  }
  return bad / (info.width * info.height);
}

// ── each destination: its manifest, its files, its orphans, its references ──
// site is frontends/web, app is frontends/ui (kit.mjs DESTS). Both are held to
// the same JOBS tables, so every riso file has one source: a work under art/riso/.
const workNames = works.map((w) => w.name).join('|');
const idRe = new RegExp(`['"\`]((?:${workNames || '\\u0000'})/[a-z0-9-]+/[a-z0-9-]+)['"\`]`, 'g');
const pathRe = /['"`(]\/art\/[^'"`)\s]*/g;
function* files(dir, skip) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (d.name !== 'node_modules') yield* files(p, skip); }
    else if (/\.(astro|ts|tsx|js|mjs|md|mdx|mdoc|yaml|json)$/.test(d.name) && p !== skip) yield p;
  }
}
let totalIds = 0, totalFiles = 0;
for (const [dest, d] of Object.entries(DESTS)) {
  const { manifest: expected, missing } = manifestFrom(jobsByWork, dest);
  const declared = Object.keys(expected.art).length + missing.length > 0;
  // The app is a sibling folder; a checkout without it (web's own build context) skips it.
  if (!fs.existsSync(d.root)) { if (declared) fail(`${dest}: ${rel(d.root)} does not exist, but works export to it`); continue; }
  for (const m of missing) fail(`${rel(path.join(d.art, m.file))} is not exported: node art/riso/export.mjs --only ${m.id}`);
  const committed = fs.existsSync(d.manifest) ? fs.readFileSync(d.manifest, 'utf8') : '';
  if (!declared && !committed) {
    if (fs.existsSync(d.art) && fs.readdirSync(d.art).length) fail(`${rel(d.art)} holds files but no work exports to ${dest}`);
    continue;
  }
  if (committed !== manifestText(expected)) {
    fail(`${rel(d.manifest)} is stale against the JOBS tables or the files in ${rel(d.art)}/: node art/riso/export.mjs --manifest`);
  }
  let manifest = { art: {} };
  try { manifest = JSON.parse(committed); } catch { fail(`${rel(d.manifest)} is not JSON`); }

  const listed = new Set();
  for (const [id, e] of Object.entries(manifest.art || {})) {
    for (const l of ['de', 'en']) if (!e.alt || !String(e.alt[l] || '').trim()) fail(`${id}: alt text missing in ${l}`);
    if (e.caption) for (const l of ['de', 'en']) if (!String(e.caption[l] || '').trim()) fail(`${id}: caption missing in ${l}`);
    if (/TODO/.test(JSON.stringify([e.alt, e.caption]))) fail(`${id}: alt text or caption still says TODO`);
    for (const f of e.files || []) {
      if (!/\?v=[0-9a-f]{8}$/.test(f.src)) fail(`${id}: ${f.src} carries no ?v=<hash>; art is cached under stable names, so every URL must change with its bytes`);
      const file = path.join(d.root, 'public', srcPath(f.src));
      listed.add(path.basename(file));
      if (!fs.existsSync(file)) { fail(`${id}: ${rel(file)} does not exist`); continue; }
      const bytes = fs.statSync(file).size;
      if (bytes > MAX_BYTES) fail(`${id}: ${rel(file)} is ${(bytes / 1024).toFixed(0)} KB, over the 1 MB commit limit`);
      const m = await sharp(file).metadata();
      if (m.width !== f.width || m.height !== f.height) fail(`${id}: ${rel(file)} is ${m.width}x${m.height}, the manifest says ${f.width}x${f.height}`);
    }
    // the on-page twins: same densities and sizes as the paper files, alpha, the same inks
    if (!e.page) continue;
    const twins = (e.files || []).map((f) => `${f.density}:${f.width}x${f.height}`).join(' ');
    if (e.page.map((f) => `${f.density}:${f.width}x${f.height}`).join(' ') !== twins) fail(`${id}: its on-page files are not at the paper files' densities and sizes (${twins})`);
    for (const f of e.page) {
      if (!/\?v=[0-9a-f]{8}$/.test(f.src)) fail(`${id}: ${f.src} carries no ?v=<hash>`);
      const file = path.join(d.root, 'public', srcPath(f.src));
      listed.add(path.basename(file));
      if (!fs.existsSync(file)) { fail(`${id}: ${rel(file)} does not exist`); continue; }
      const bytes = fs.statSync(file).size;
      if (bytes > MAX_BYTES) fail(`${id}: ${rel(file)} is ${(bytes / 1024).toFixed(0)} KB, over the 1 MB commit limit`);
      const m = await sharp(file).metadata();
      if (m.width !== f.width || m.height !== f.height) fail(`${id}: ${rel(file)} is ${m.width}x${m.height}, the manifest says ${f.width}x${f.height}`);
      if (!m.hasAlpha) { fail(`${id}: ${rel(file)} has no alpha; an on-page file is the inks alone`); continue; }
      const twin = e.files.find((p) => p.density === f.density);
      const paperFile = twin && path.join(d.root, 'public', srcPath(twin.src));
      if (!paperFile || !fs.existsSync(paperFile) || m.width !== f.width) continue;
      const off = await onPageParity(paperFile, file, paperOf.get(e.work) || [0xf4, 0xf2, 0xe8]);
      if (off > 0.005) fail(`${id}: ${rel(file)} multiplied onto the paper misses ${rel(paperFile)} in ${(off * 100).toFixed(1)} % of its pixels (out of register, or another bake): re-export both, node art/riso/export.mjs --only ${id}`);
    }
  }

  // orphans in this destination's public/art/
  if (fs.existsSync(d.art)) {
    for (const f of fs.readdirSync(d.art)) {
      if (!listed.has(f)) fail(`${rel(path.join(d.art, f))} is in no manifest entry: delete it, or declare it in a work's JOBS`);
    }
  }

  // references from this destination's source tree: by id, and only ids it has
  const ids = new Set(Object.keys(manifest.art || {}));
  for (const file of files(d.src, d.manifest)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(idRe)) if (!ids.has(m[1])) fail(`${rel(file)}: art id "${m[1]}" is not in the ${dest} manifest`);
    for (const m of text.matchAll(pathRe)) fail(`${rel(file)}: names the file ${m[0].slice(1)}; reference art by id`);
  }
  totalIds += ids.size; totalFiles += listed.size;
}

if (problems.length) {
  console.error(`riso check: ${problems.length} problem(s)\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`riso check: ${works.length} work(s), ${totalIds} art ids, ${totalFiles} files in ${Object.keys(DESTS).join(' + ')} ok`);
