#!/usr/bin/env node
/*
 * Scaffold a new riso work from art/riso/template/.
 *
 *   node art/riso/new.mjs <work> [--title "Karten"]
 *
 * Writes art/riso/<work>/index.html (a working starter plate on the shared
 * kit, one `plate` job with TODO alt text) and PRINT.md (the headings every
 * work fills in). Refuses to overwrite. Next: open index.html?t=0, draw,
 * then node art/riso/export.mjs --work <work> and node art/riso/check.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HERE, args } from './kit.mjs';

const a = args(process.argv.slice(2));
const work = a._[0];
if (!work || !/^[a-z0-9][a-z0-9-]*$/.test(work)) {
  console.error('usage: node art/riso/new.mjs <work> [--title "Title"]   (work: lowercase letters, digits, hyphens)');
  process.exit(2);
}
if (['lib', 'out', 'template'].includes(work)) { console.error(`"${work}" is reserved`); process.exit(2); }
const dir = path.join(HERE, work);
if (fs.existsSync(dir)) { console.error(`art/riso/${work} exists; pick another name`); process.exit(1); }

const title = typeof a.title === 'string' ? a.title : work.charAt(0).toUpperCase() + work.slice(1);
const fill = (s) => s.replaceAll('__WORK__', work).replaceAll('__TITLE__', title).replaceAll('__DATE__', new Date().toISOString().slice(0, 10));
fs.mkdirSync(dir);
for (const f of ['index.html', 'PRINT.md']) {
  fs.writeFileSync(path.join(dir, f), fill(fs.readFileSync(path.join(HERE, 'template', f), 'utf8')));
}
console.log(`art/riso/${work}/index.html and PRINT.md written.
  look:    open art/riso/${work}/index.html?t=0 in Firefox (or export and open the file)
  export:  node art/riso/export.mjs --work ${work}
  check:   node art/riso/check.mjs   (fails until the TODO alt text is written)`);
