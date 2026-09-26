/*
 * Shared Node helpers for the riso scripts (setup, new, export, check, verify):
 * where things live, the pinned kit, the works and their JOBS tables, and the
 * manifest the site reads. No browser and no sharp here, so check.mjs stays fast.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEB = path.resolve(HERE, '..', '..');
export const PUBLIC_ART = path.join(WEB, 'public', 'art');
export const OUT = path.join(HERE, 'out');
export const MANIFEST = path.join(WEB, 'src', 'data', 'art.json');
/** Folders under art/riso/ that are not works. */
const NOT_WORKS = new Set(['lib', 'out', 'template', 'node_modules']);
/** The repo's pre-commit hook refuses files above this (check-added-large-files --maxkb=1024). */
export const MAX_BYTES = 1024 * 1024;

/** The pin: { repo, commit, engine }. The one place the kit version is written down. */
export const PIN = JSON.parse(fs.readFileSync(path.join(HERE, 'kit.json'), 'utf8'));

/**
 * Where the kit is cloned. Outside the repo by default, keyed by commit, so
 * every worktree shares one clone and a new pin never reuses an old one.
 */
export function kitDir() {
  if (process.env.RISO_KIT_DIR) return path.resolve(process.env.RISO_KIT_DIR);
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cache, 'piloti-riso', `riso-windowseat-${PIN.commit.slice(0, 12)}`);
}
export const STATE_FILE = '.piloti-setup.json';

/** What setup.mjs recorded: { commit, engine, browsersPath, engines }, or null. */
export function kitState(dir = kitDir()) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
    return s.commit === PIN.commit ? s : null;
  } catch { return null; }
}

/** The kit's state, or exit with the command that fixes it. */
export function requireKit() {
  const dir = kitDir(), state = kitState(dir);
  if (!state) {
    console.error(`riso kit not set up at ${dir} for commit ${PIN.commit.slice(0, 8)}.\n  run: node art/riso/setup.mjs   (task art:setup)`);
    process.exit(2);
  }
  return { dir, tools: path.join(dir, 'tools'), ...state };
}

/** Environment for anything that launches the kit's browsers. */
export function kitEnv(state) {
  const env = { ...process.env };
  if (state.browsersPath) env.PLAYWRIGHT_BROWSERS_PATH = state.browsersPath;
  return env;
}

/** The kit's own browser harness (launch, openFilm), so export sees what still.mjs sees. */
export async function kitBrowser(state) {
  if (state.browsersPath) process.env.PLAYWRIGHT_BROWSERS_PATH = state.browsersPath;
  return import(path.join(state.tools, 'lib', 'browser.mjs'));
}

/** Every work: a folder under art/riso/ with an index.html. */
export function listWorks() {
  return fs.readdirSync(HERE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !NOT_WORKS.has(d.name))
    .filter((d) => fs.existsSync(path.join(HERE, d.name, 'index.html')))
    .map((d) => ({ name: d.name, dir: path.join(HERE, d.name), html: path.join(HERE, d.name, 'index.html') }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A no-op object that answers any property with itself: enough of the DOM for a ?list load. */
function inert() {
  const f = function () { return p; };
  const p = new Proxy(f, { get: (_, k) => (k === Symbol.toPrimitive ? () => 0 : p), apply: () => p, construct: () => p, set: () => true });
  return p;
}

/**
 * Evaluate a work's scripts in Node, the way the page would load with ?list:
 * formats, engine, series look, then the work. Nothing is baked, so this is
 * fast and needs no browser. It requires that a work draws only inside draw(),
 * which determinism asks for anyway.
 */
export function evaluateWork(work) {
  const html = fs.readFileSync(work.html, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s+src="([^"]+)")?\s*>([\s\S]*?)<\/script>/g)]
    .map((m) => (m[1] ? { file: path.resolve(work.dir, m[1]) } : { file: work.html, code: m[2] }));
  const errors = [];
  const ctx = {
    console: { log() {}, warn() {}, error: (m) => errors.push(String(m)) },
    location: { search: '?list' },
    URLSearchParams,
    Path2D: class { constructor() { return inert(); } },
    document: { getElementById: () => inert(), createElement: () => inert(), querySelector: () => inert() },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const s of scripts) {
    const code = s.code ?? fs.readFileSync(s.file, 'utf8');
    vm.runInContext(code, ctx, { filename: s.file });
  }
  const riso = ctx.__riso;
  if (!riso) throw Error(`${work.name}: the page never set window.__riso (does it end with Riso.run?)`);
  if (riso.error || errors.length) throw Error(riso.error || errors.join('\n'));
  return { jobs: JSON.parse(JSON.stringify(riso.jobs)), formats: JSON.parse(JSON.stringify(vm.runInContext('FORMATS', ctx))), ink: vm.runInContext('({ INK, INK_DRUM })', ctx) };
}

/** Where a job's file is written. */
export function destOf(job) {
  return job.dest === 'site' ? path.join(PUBLIC_ART, job.file) : path.join(OUT, job.work, job.file);
}

/**
 * The manifest: one entry per site art id, keyed by id, files per density.
 * A pure function of the JOBS tables, so check.mjs can rebuild it and compare.
 */
export function manifestFrom(jobsByWork) {
  const art = {};
  for (const jobs of jobsByWork) {
    for (const j of jobs) {
      if (j.dest !== 'site') continue;
      const e = art[j.id] || (art[j.id] = {
        work: j.work, plate: j.plate, format: j.format,
        numeral: j.number ? roman(j.number) : null,
        width: 0, height: 0,
        alt: j.alt,
        ...(j.caption ? { caption: j.caption } : {}),
        files: [],
      });
      e.files.push({ density: j.density, src: `/art/${j.file}`, width: j.w, height: j.h });
      if (j.density === 1) { e.width = j.w; e.height = j.h; }
    }
  }
  const sorted = Object.fromEntries(Object.keys(art).sort().map((k) => [k, art[k]]));
  return {
    $comment: 'Generated by art/riso/export.mjs from each work\'s JOBS table. Do not edit: change the work, then run node art/riso/export.mjs.',
    art: sorted,
  };
}

export function roman(n) {
  const units = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
  return 'X'.repeat(Math.floor(n / 10)) + units[n % 10];
}

export const manifestText = (m) => JSON.stringify(m, null, 2) + '\n';

/** --flag value, --flag=value, bare --flag; positionals in _. */
export function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

/** Pick works by --work a,b (default: all). */
export function selectWorks(arg) {
  const all = listWorks();
  if (!arg || arg === true) return all;
  const want = String(arg).split(',');
  const missing = want.filter((w) => !all.some((x) => x.name === w));
  if (missing.length) { console.error(`no such work: ${missing.join(', ')} (have: ${all.map((w) => w.name).join(', ')})`); process.exit(2); }
  return all.filter((w) => want.includes(w.name));
}
