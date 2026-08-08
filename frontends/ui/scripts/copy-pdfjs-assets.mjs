#!/usr/bin/env node
/**
 * Stage pdf.js's runtime assets into `public/pdfjs/`.
 *
 * pdf.js needs three things it cannot get from the bundle:
 *
 *   - the WORKER, which parses and rasterises off the main thread. Rendering a
 *     30-page Bescheid on the main thread janks the whole dialog, so this is not
 *     optional.
 *   - the STANDARD FONTS. A PDF may reference the base-14 fonts (Helvetica,
 *     Times) without embedding them, which Austrian building-authority documents
 *     do constantly. Without this data those pages render with the wrong metrics
 *     or no glyphs at all — and a page whose text is misplaced is a page whose
 *     passage highlight is misplaced with it.
 *   - the CMAPS, which map CID-keyed font encodings back to Unicode. Missing
 *     them, `getTextContent` returns mojibake for those pages, so the passage
 *     never matches even though the page looks fine.
 *
 * The worker comes from the LEGACY build to match the legacy API the app
 * imports (see `pdfjs-runtime.ts` for why that build): pairing a legacy API
 * with a modern worker is unsupported and fails at render time.
 *
 * They are COPIED rather than imported because a bundler cannot follow a runtime
 * `workerSrc` URL or a directory of binary font data. `public/pdfjs/` is
 * generated and gitignored, exactly like `public/mockServiceWorker.js`.
 *
 * Wired into `dev` and `build` rather than a postinstall hook: the Docker build
 * installs with `--ignore-scripts` (see `deploy/Dockerfile`), so a postinstall
 * would silently not run and the deployed viewer would fail to start its worker.
 */

import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const UI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(UI_ROOT, 'public', 'pdfjs')

const require = createRequire(import.meta.url)

/** Resolve pdfjs-dist through node so a hoisted install is found either way. */
const packageRoot = dirname(require.resolve('pdfjs-dist/package.json'))

/** `from` is relative to the pdfjs-dist package root; `to` to `public/pdfjs/`. */
const ASSETS = [
  { from: 'legacy/build/pdf.worker.min.mjs', to: 'pdf.worker.min.mjs' },
  { from: 'cmaps', to: 'cmaps' },
  { from: 'standard_fonts', to: 'standard_fonts' },
]

const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  for (const asset of ASSETS) {
    const source = join(packageRoot, asset.from)
    if (!(await exists(source))) {
      throw new Error(`pdfjs-dist is missing ${asset.from} — expected at ${source}`)
    }
  }

  // A stale copy is worse than none: after a version bump the worker and the
  // bundled API must agree, and pdf.js refuses to run when they do not.
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  for (const asset of ASSETS) {
    await cp(join(packageRoot, asset.from), join(OUT_DIR, asset.to), { recursive: true })
  }

  const { version } = require('pdfjs-dist/package.json')
  process.stdout.write(`✔ pdf.js ${version} assets staged in public/pdfjs\n`)
}

main().catch((error) => {
  process.stderr.write(`✖ failed to stage pdf.js assets: ${error.message}\n`)
  process.exit(1)
})
