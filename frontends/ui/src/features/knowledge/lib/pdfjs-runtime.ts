/**
 * The one place pdf.js is loaded and configured.
 *
 * The import is DYNAMIC and cached: pdf.js is a megabyte of parser that only
 * matters once someone opens a source document, so it must not sit in the chat
 * bundle every session pays for. Everything it needs at runtime is served from
 * `public/pdfjs/`, staged by `scripts/copy-pdfjs-assets.mjs` — see that file for
 * why the worker, the cmaps and the standard fonts are all load-bearing.
 *
 * It is the LEGACY build, and that is not a hedge. pdf.js's modern build calls
 * `Map.prototype.getOrInsertComputed`, a stage-3 proposal that lands only in
 * very recent V8 — every page render throws `getOrInsertComputed is not a
 * function` on anything older, including the Chromium this repo screenshots
 * with. The people reading these Bescheide are on managed corporate browsers;
 * shipping a viewer that needs a bleeding-edge engine would fail for exactly
 * them, and fail silently, as a blank page. The legacy build carries its own
 * polyfills and costs a few hundred kilobytes on a chunk that only loads when a
 * document is actually opened. The worker MUST come from the same build — a
 * legacy API against a modern worker is an unsupported pairing.
 */

import type * as PdfjsModule from 'pdfjs-dist'

export type Pdfjs = typeof PdfjsModule

/** Where `copy-pdfjs-assets.mjs` stages the runtime assets. */
const ASSET_BASE = '/pdfjs/'

let runtime: Promise<Pdfjs> | null = null

/**
 * Load pdf.js and point it at its worker. Repeat calls share one import and one
 * worker configuration — pdf.js keys its worker off a module-global, so setting
 * `workerSrc` per viewer would be both wasteful and racy.
 */
export const loadPdfjs = (): Promise<Pdfjs> => {
  runtime ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs: Pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = `${ASSET_BASE}pdf.worker.min.mjs`
    return pdfjs
  })
  return runtime
}

/**
 * Parameters for opening one document.
 *
 * `cMapUrl` and `standardFontDataUrl` are not optional niceties here: without
 * them a PDF that uses CID fonts extracts as mojibake and one that relies on
 * the non-embedded base-14 fonts renders with the wrong metrics — in both cases
 * the text layer stops lining up with the page, and a passage highlight
 * computed from it lands in the wrong place. Cookies ride along on the
 * same-origin corpus route by default; presigned object-store URLs carry their
 * own authorization in the query string and must NOT be sent credentials.
 */
export const documentParameters = (url: string) => ({
  url,
  cMapUrl: `${ASSET_BASE}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
})
