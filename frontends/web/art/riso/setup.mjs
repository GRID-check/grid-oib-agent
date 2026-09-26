#!/usr/bin/env node
/*
 * Set up the pinned riso-windowseat kit that export.mjs and verify.mjs drive.
 *
 *   node art/riso/setup.mjs            # idempotent; a second run only re-checks
 *   node art/riso/setup.mjs --force    # clone and install again
 *   RISO_KIT_DIR=/some/dir node art/riso/setup.mjs
 *
 * 1. Clones kit.json's repo at exactly kit.json's commit into kitDir()
 *    (default ~/.cache/piloti-riso/riso-windowseat-<commit>, shared by worktrees).
 * 2. npm ci in its tools/ with --ignore-scripts: stills need playwright-core
 *    only, not the ffmpeg binary the kit's film tools download.
 * 3. Finds a browser: Firefox (the kit's primary engine, and the one the
 *    committed exports were made with) as installed, else installs it, else
 *    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers. Chromium is the last resort and
 *    is reported loudly: its antialiasing differs, so a Chromium export does not
 *    reproduce the committed files.
 * 4. Records what it found in <kit>/.piloti-setup.json; the other scripts read it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PIN, STATE_FILE, args, kitDir, kitState } from './kit.mjs';

const a = args(process.argv.slice(2));
const dir = kitDir();
const tools = path.join(dir, 'tools');
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...opts });
const git = (...argv) => execFileSync('git', argv, { cwd: dir, encoding: 'utf8' }).trim();

function headOf(d) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/** Clone at the pinned commit. A shallow fetch of one SHA first, a full clone if the host refuses. */
function cloneKit() {
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const g = (...argv) => execFileSync('git', argv, { cwd: tmp, stdio: 'inherit' });
  g('init', '-q');
  g('remote', 'add', 'origin', PIN.repo);
  try {
    g('fetch', '-q', '--depth', '1', 'origin', PIN.commit);
  } catch {
    console.log('shallow fetch of the pinned commit refused; fetching full history');
    g('fetch', '-q', 'origin');
  }
  g('-c', 'advice.detachedHead=false', 'checkout', '-q', PIN.commit);
  // Another process may have finished first; theirs is as good as ours.
  if (headOf(dir) === PIN.commit) { fs.rmSync(tmp, { recursive: true, force: true }); return; }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
}

/** Launch and close one engine in a child process with the given env; true if it works. */
function probe(engine, env) {
  const code = `import('playwright-core').then(async (pw) => { const b = await pw.${engine}.launch(); await b.close(); })` +
    `.catch((e) => { console.error(String(e.message).split('\\n')[0]); process.exit(1); })`;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: tools, env, encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0 && a.verbose) console.log(`  ${engine}: ${(r.stderr || '').trim()}`);
  return r.status === 0;
}

function findBrowser() {
  const base = { ...process.env };
  const tries = [];
  const attempt = (engine, browsersPath, how) => {
    const env = { ...base };
    if (browsersPath) env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
    const ok = probe(engine, env);
    tries.push(`${engine} (${how}): ${ok ? 'ok' : 'unavailable'}`);
    return ok ? { engine, browsersPath: browsersPath || process.env.PLAYWRIGHT_BROWSERS_PATH || null } : null;
  };
  const engines = (bp) => ['chromium', 'firefox'].filter((e) => probe(e, bp ? { ...base, PLAYWRIGHT_BROWSERS_PATH: bp } : base));

  let found = attempt(PIN.engine, null, process.env.PLAYWRIGHT_BROWSERS_PATH ? `PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}` : 'default path');
  if (!found) {
    console.log(`installing ${PIN.engine} and chromium for playwright-core ...`);
    const r = spawnSync(process.execPath, [path.join('node_modules', 'playwright-core', 'cli.js'), 'install', PIN.engine, 'chromium', 'chromium-headless-shell'], { cwd: tools, stdio: 'inherit' });
    if (r.status === 0) found = attempt(PIN.engine, null, 'after install');
  }
  if (!found && fs.existsSync('/opt/pw-browsers') && process.env.PLAYWRIGHT_BROWSERS_PATH !== '/opt/pw-browsers') {
    found = attempt(PIN.engine, '/opt/pw-browsers', 'PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers');
  }
  if (!found) {
    for (const bp of [null, fs.existsSync('/opt/pw-browsers') ? '/opt/pw-browsers' : null]) {
      found = attempt('chromium', bp, bp ? `PLAYWRIGHT_BROWSERS_PATH=${bp}` : 'default path');
      if (found) break;
    }
  }
  for (const t of tries) console.log(`  ${t}`);
  if (!found) throw Error('no browser playwright-core can launch; see the lines above');
  return { ...found, engines: engines(found.browsersPath) };
}

// ── main ─────────────────────────────────────────────────────────────────────

if (!a.force && kitState(dir) && headOf(dir) === PIN.commit && fs.existsSync(path.join(tools, 'node_modules', 'playwright-core'))) {
  const s = kitState(dir);
  const env = { ...process.env, ...(s.browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: s.browsersPath } : {}) };
  if (probe(s.engine, env)) {
    console.log(`riso kit ready: ${dir}\n  commit ${PIN.commit.slice(0, 8)}, engine ${s.engine}${s.browsersPath ? `, PLAYWRIGHT_BROWSERS_PATH=${s.browsersPath}` : ''}`);
    process.exit(0);
  }
  console.log(`recorded engine ${s.engine} no longer launches; checking browsers again`);
}

fs.mkdirSync(path.dirname(dir), { recursive: true });
if (a.force || headOf(dir) !== PIN.commit) {
  console.log(`cloning ${PIN.repo} at ${PIN.commit.slice(0, 8)} into ${dir}`);
  cloneKit();
}
if (git('rev-parse', 'HEAD') !== PIN.commit) throw Error(`kit at ${dir} is not at ${PIN.commit}`);
if (git('status', '--porcelain', '--untracked-files=no')) throw Error(`kit at ${dir} has local edits; remove it or pass --force`);

console.log('installing the kit tools (npm ci --ignore-scripts) ...');
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: tools });

const b = findBrowser();
const state = { commit: PIN.commit, engine: b.engine, browsersPath: b.browsersPath, engines: b.engines, at: new Date().toISOString() };
fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n');

console.log(`\nriso kit ready: ${dir}`);
console.log(`  commit ${PIN.commit.slice(0, 8)}, export engine ${b.engine}${b.browsersPath ? `, PLAYWRIGHT_BROWSERS_PATH=${b.browsersPath}` : ''}`);
console.log(`  engines that launch: ${b.engines.join(', ') || 'none'} (verify.mjs wants both)`);
if (b.engine !== PIN.engine) {
  console.log(`\n  WARNING: ${PIN.engine} is unavailable, so exports will use ${b.engine}.`);
  console.log(`  Its antialiasing differs: re-exported files will NOT match the committed ones.`);
  console.log(`  Fine for proofs; do not commit site exports made this way.`);
}
