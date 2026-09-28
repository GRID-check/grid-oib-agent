#!/usr/bin/env node
/*
 * The expensive determinism check: the kit's own tools/verify.mjs on every job
 * of every work, in Chromium and Firefox. Minutes, not seconds, so it is not in
 * `npm run check`; run it after changing a work, the engine or the series look.
 *
 *   node art/riso/verify.mjs                  # every work, every job
 *   node art/riso/verify.mjs --work tafeln    # one work
 *   node art/riso/verify.mjs --times 0,2,5    # some jobs (the page's ?t=)
 *
 * It checks that seek(t) is pure: repeated and reordered seeks, cold jumps and
 * a fresh page drawn in reverse all give identical pixels. It does not judge
 * the art, and cross-engine differences in antialiasing are reported, not
 * failed. Both engines must launch (setup.mjs lists which do).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { args, evaluateWork, kitEnv, requireKit, selectWorks } from './kit.mjs';

const a = args(process.argv.slice(2));
const kit = requireKit();
if (kit.engines && kit.engines.length < 2) {
  console.warn(`WARNING: only ${kit.engines.join(', ')} launches here; the kit's verify runs both engines and will fail on the other.`);
}
let failed = 0;
for (const w of selectWorks(a.work)) {
  const { jobs } = evaluateWork(w);
  const times = a.times && a.times !== true ? String(a.times) : jobs.map((_, i) => i).join(',');
  console.log(`\n── ${w.name}: ${times.split(',').length} of ${jobs.length} jobs ──`);
  const r = spawnSync(process.execPath, ['verify.mjs', w.html, '--times', times], { cwd: kit.tools, env: kitEnv(kit), stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error(`${w.name}: determinism check FAILED (${path.relative(process.cwd(), w.html)})`); }
}
process.exit(failed ? 1 : 0);
