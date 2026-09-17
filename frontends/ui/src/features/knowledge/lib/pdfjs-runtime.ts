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
import type { PDFPageProxy } from 'pdfjs-dist'

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
  runtime ??= import('pdfjs-dist/legacy/build/pdf.mjs')
    .then((pdfjs: Pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${ASSET_BASE}pdf.worker.min.mjs`
      return pdfjs
    })
    .catch((error: unknown) => {
      // Drop the cache before rethrowing. A chunk fetch fails for reasons that
      // pass — a deploy rolling over mid-session, a moment offline — and a
      // cached REJECTED promise turns that moment into a permanent one: every
      // later citation click in the session resolves instantly to the failure
      // and lands on the fallback frame, with no way back short of a reload.
      runtime = null
      throw error
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

/**
 * A rendered text layer, reduced to what the viewer still has to do to it.
 *
 * Handing back a handle rather than the pdf.js object keeps the component free
 * of the runtime's types and gives the fake in `@/test-utils/pdfjs-fake` one
 * small shape to stand in for.
 */
export interface TextLayerHandle {
  /** Stop an in-flight render and empty the container. */
  destroy: () => void
}

/**
 * Lay the page's own text over its bitmap, as transparent, positioned runs.
 *
 * This is what makes a rendered page BEHAVE like a document: select a sentence,
 * copy it into a mail to the Sachverständige, let the browser's own find pick it
 * up. A canvas alone is a picture of a page — everything the reader tries to do
 * with the text silently does nothing, which in a product whose whole promise is
 * "check this yourself" is the wrong answer at exactly the moment they took us
 * up on it.
 *
 * The viewport is deliberately taken at scale 1: every run pdf.js emits is
 * positioned as a PERCENTAGE of the page box and sized from `--font-height`
 * times `--total-scale-factor`, so the DOM it builds is scale-free and the
 * viewer re-zooms it by writing one CSS variable rather than by re-reading the
 * page. The only scale-sensitive part is the per-run horizontal stretch, and
 * that is a ratio of two measurements at the same size, so it is scale-free too.
 */
export const renderTextLayer = async (
  page: PDFPageProxy,
  container: HTMLElement,
): Promise<TextLayerHandle> => {
  const pdfjs = await loadPdfjs()
  const layer = new pdfjs.TextLayer({
    textContentSource: page.streamTextContent(),
    container,
    viewport: page.getViewport({ scale: 1 }),
  })
  // Deliberately not awaited. The handle has to exist while the runs are still
  // streaming in, or a page the reader scrolls straight past cannot be
  // cancelled — the caller would hold nothing to cancel WITH until the render it
  // no longer wants had finished. A cancelled render rejects; that is the
  // teardown path, not a failure.
  void layer.render().catch(() => {})
  return {
    destroy: () => {
      layer.cancel()
      container.replaceChildren()
    },
  }
}
