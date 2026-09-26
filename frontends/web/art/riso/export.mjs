#!/usr/bin/env node
/*
 * Export riso works: every job of every work, to the destination its format names.
 *
 *   node art/riso/export.mjs                                  # all works, all jobs
 *   node art/riso/export.mjs --work tafeln                    # one work
 *   node art/riso/export.mjs --work tafeln --only 0,3         # jobs by index (the page's ?t=)
 *   node art/riso/export.mjs --only tafeln/stuetzen/og        # jobs by art id (all densities)
 *   node art/riso/export.mjs --dest site                      # only site assets (or: app, out)
 *   node art/riso/export.mjs --variant page                   # only the on-page files (or: paper)
 *   node art/riso/export.mjs --manifest                       # only rewrite the manifests
 *   node art/riso/export.mjs --engine chromium                # override the engine setup chose
 *
 * Run from frontends/web with its node_modules installed (sharp comes with
 * Astro), after `node art/riso/setup.mjs`.
 *
 * Per job: open the work in the kit's browser harness (tools/lib/browser.mjs,
 * which blocks every non-file request), seek the job, read the canvas backing
 * store as PNG, seek elsewhere and back and require identical bytes (the check
 * still.mjs makes), check the pixel size against the format, then encode:
 * .webp at quality 95 with sharp-YUV, or .png at maximum compression. Nothing
 * is resized. Formats with `separations` also get one grayscale PNG per ink
 * (the page's ?sep=<ink> view) and a JSON sheet naming drums and order.
 * Formats with `onPage` also get `<file>-page.webp`: the same job baked with
 * ?paper=0 (the inks multiplied onto white, so the canvas holds the stack's
 * transmittance T), turned into ink alpha by pageFrom() below.
 *
 * site -> public/art/ (committed; the pre-commit hook refuses files > 1 MB)
 * app  -> ../ui/public/art/ (the product app; committed, same limit)
 * out  -> art/riso/out/<work>/ (gitignored; reproducible from the pin)
 * Always ends by rewriting the manifests from every work's JOBS table:
 * src/data/art.json for the site, ../ui/src/lib/art/art.json for the app, each
 * src versioned with ?v=<sha256 of the file> so a re-export busts caches.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  DESTS, MAX_BYTES, OUT, args, destOf, evaluateWork, kitBrowser, manifestFrom, manifestText, requireKit, selectWorks,
} from './kit.mjs';

const a = args(process.argv.slice(2));
const works = selectWorks(a.work);
const listed = new Map();
for (const w of works) {
  try { listed.set(w.name, evaluateWork(w)); } catch (e) { console.error(`art/riso/${w.name}/index.html: ${e.message}`); process.exit(1); }
}

function writeManifest() {
  // A manifest spans every work, not only the ones exported now: one per destination.
  const all = selectWorks(undefined).map((w) => (listed.get(w.name) || evaluateWork(w)).jobs);
  for (const [dest, d] of Object.entries(DESTS)) {
    const { manifest, missing } = manifestFrom(all, dest);
    if (missing.length) console.warn(`not exported yet, so left out of the ${dest} manifest: ${missing.map((m) => m.file).join(', ')}`);
    const text = manifestText(manifest);
    const before = fs.existsSync(d.manifest) ? fs.readFileSync(d.manifest, 'utf8') : '';
    const empty = !Object.keys(manifest.art).length;
    // A destination no work exports to keeps no manifest file at all.
    if (empty && !before) continue;
    if (text !== before) { fs.mkdirSync(path.dirname(d.manifest), { recursive: true }); fs.writeFileSync(d.manifest, text); }
    console.log(`manifest ${path.relative(process.cwd(), d.manifest)}: ${Object.keys(manifest.art).length} ids${text === before ? ', unchanged' : ', rewritten'}`);
  }
}

if (a.manifest) { writeManifest(); process.exit(0); }

/** Which of a work's jobs to run: --only takes indices, ids, or both. */
function pick(jobs) {
  let sel = jobs.map((j, i) => i);
  if (a.only && a.only !== true) {
    const want = String(a.only).split(',');
    sel = sel.filter((i) => want.includes(String(i)) || want.includes(jobs[i].id));
  }
  if (a.dest) sel = sel.filter((i) => jobs[i].dest === a.dest);
  return sel;
}

const kit = requireKit();
const engine = a.engine || kit.engine;
if (engine !== 'firefox') console.warn(`WARNING: exporting with ${engine}; its pixels differ from the committed Firefox exports.`);
const { launch, openFilm } = await kitBrowser(kit);
const browser = await launch(engine);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
let failures = 0;

/** Native canvas PNG of job t, checked for repeatability exactly as still.mjs checks it. */
async function frame(page, t, duration) {
  const get = () => page.evaluate((time) => {
    window.__riso.seek(time);
    const c = document.querySelector('canvas');
    return { url: c.toDataURL('image/png'), width: c.width, height: c.height };
  }, t);
  const first = await get();
  await page.evaluate((d) => window.__riso.seek(d * 0.713), duration);
  const second = await get();
  if (first.url !== second.url) throw Error(`job ${t} changes after a seek; fix determinism before delivery`);
  return Buffer.from(first.url.split(',')[1], 'base64');
}

/**
 * The on-page file from a ?paper=0 frame. Each pixel of that frame is the ink
 * stack's transmittance T per channel (white where no ink lies). The page
 * shows the file with mix-blend-mode: multiply, which gives
 * B · (1 − α·(1 − C)) over a backdrop B. Asking that to equal B · T in every
 * channel leaves one free choice, the alpha: the least that reaches the
 * darkest channel, α = 1 − min(T), with C = 1 − (1 − T) / α. Multiplied onto
 * the paper this is the print exactly, onto the page canvas it is the print
 * on that canvas, and where no ink lies α = 0. Straight (unpremultiplied)
 * RGBA, as WebP stores it.
 */
async function pageFrom(png) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
    const d = 255 - Math.min(data[i], data[i + 1], data[i + 2]);
    if (!d) continue;
    for (let c = 0; c < 3; c++) px[o + c] = Math.round(255 - (255 - data[i + c]) * 255 / d);
    px[o + 3] = d;
  }
  return sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } });
}

async function encode(input, j, out, { gray = false } = {}) {
  let img = Buffer.isBuffer(input) ? sharp(input) : input;
  const dpi = j.dpi;
  if (gray) img = img.flatten({ background: '#ffffff' }).toColourspace('b-w');
  if (dpi) img = img.withMetadata({ density: dpi });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (!gray && j.encode === 'webp') await img.webp({ quality: 95, smartSubsample: true, effort: 6 }).toFile(out);
  else await img.png({ compressionLevel: 9, effort: 10 }).toFile(out);
  return fs.statSync(out).size;
}

try {
  for (const w of works) {
    const { jobs, formats, ink } = listed.get(w.name);
    const sel = pick(jobs);
    if (!sel.length) { console.log(`${w.name}: no jobs selected`); continue; }
    console.log(`${w.name}: ${sel.length} of ${jobs.length} jobs, ${engine}`);
    const { page, duration, errors } = await openFilm(browser, w.html, { query: 'list' });
    const sepPages = new Map();
    let paperless = null;
    const variants = a.variant && a.variant !== true ? String(a.variant).split(',') : ['paper', 'page'];
    for (const i of sel) {
      const j = { ...jobs[i], dpi: formats[jobs[i].format].dpi };
      const bakes = [];
      if (variants.includes('paper')) bakes.push(['paper', await frame(page, i, duration)]);
      if (j.page && variants.includes('page')) {
        paperless ||= await openFilm(browser, w.html, { query: 'list&paper=0' });
        bakes.push(['page', await frame(paperless.page, i, paperless.duration)]);
      }
      for (const [variant, png] of bakes) {
        const meta = await sharp(png).metadata();
        if (meta.width !== j.w || meta.height !== j.h) throw Error(`${j.file}: canvas is ${meta.width}x${meta.height}, the format wants ${j.w}x${j.h}`);
        const out = destOf(j, variant);
        const size = await encode(variant === 'page' ? await pageFrom(png) : png, j, out);
        const over = j.dest in DESTS && size > MAX_BYTES;
        if (over) failures++;
        console.log(`  ${String(i).padStart(2)}  ${j.id.padEnd(34)} ${String(j.density) + 'x'}  ${`${j.w}x${j.h}`.padEnd(9)} ${kb(size).padStart(7)}  png ${sha(png)}  ${path.relative(process.cwd(), out)}${over ? '  OVER 1 MB: the commit hook will refuse it' : ''}`);
      }
      if (!j.separations || !variants.includes('paper')) continue;
      const stem = j.file.replace(/\.\w+$/, '');
      const sheet = { work: j.work, id: j.id, file: j.file, width: j.w, height: j.h, dpi: j.dpi || null, pitch: j.pitch, inks: [] };
      for (const [n, name] of j.inks.entries()) {
        if (!sepPages.has(name)) sepPages.set(name, await openFilm(browser, w.html, { query: `list&sep=${name}` }));
        const sp = sepPages.get(name);
        const sep = await frame(sp.page, i, sp.duration);
        const file = `${stem}-sep-${n + 1}-${name}.png`;
        const bytes = await encode(sep, j, path.join(OUT, j.work, file), { gray: true });
        sheet.inks.push({ order: n + 1, ink: name, drum: ink.INK_DRUM[name], hex: ink.INK[name], file });
        console.log(`        separation ${n + 1} ${name.padEnd(7)} ${kb(bytes).padStart(7)}  ${file}`);
      }
      fs.writeFileSync(path.join(OUT, j.work, `${stem}-separations.json`), JSON.stringify(sheet, null, 2) + '\n');
    }
    for (const sp of [...sepPages.values(), ...(paperless ? [paperless] : [])]) { if (sp.errors.length) throw Error(sp.errors.join('\n')); await sp.page.close(); }
    if (errors.length) throw Error(errors.join('\n'));
    await page.close();
  }
} finally {
  await browser.close();
}

writeManifest();
if (failures) { console.error(`${failures} site file(s) over 1 MB`); process.exit(1); }
