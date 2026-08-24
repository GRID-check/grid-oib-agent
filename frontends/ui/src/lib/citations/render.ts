/**
 * Server-side citation rendering (BFF).
 *
 * citation-js is the established Node implementation of the CSL stack, and it
 * is a NODE library: its core pulls `node-fetch` → `fetch-blob` → `node:fs`,
 * which cannot be bundled for the browser at all. So the formatting runs here,
 * on the server, and the client posts CSL-JSON to `/api/citations/format` and
 * gets text back — no 1.7 MB of citation machinery in the chat bundle, and no
 * Node polyfills.
 *
 * The pure formats (the German Fachtext citation and raw CSL-JSON) never reach
 * this module: the client builds those itself, instantly and offline.
 */

import 'server-only'

/** Bibliographic formats rendered through citation-js. */
export type RenderableCitationFormat = 'apa' | 'bibtex' | 'ris'

/**
 * citation-js, imported once per server process. The plugins register onto the
 * shared core as an import side effect, so they are awaited together.
 */
let citePromise: Promise<typeof import('@citation-js/core').Cite> | null = null

const loadCite = async (): Promise<typeof import('@citation-js/core').Cite> => {
  if (!citePromise) {
    citePromise = (async () => {
      const [{ Cite }] = await Promise.all([
        import('@citation-js/core'),
        import('@citation-js/plugin-csl'),
        import('@citation-js/plugin-bibtex'),
        import('@citation-js/plugin-ris'),
      ])
      return Cite
    })()
  }
  return citePromise
}

/**
 * Render CSL-JSON items in `format`.
 *
 * `items` is CSL-JSON as produced by the chat's `toCslItem` — validated at the
 * route boundary, treated as opaque data here.
 */
export const renderCitations = async (
  items: unknown[],
  format: RenderableCitationFormat
): Promise<string> => {
  if (items.length === 0) return ''
  const Cite = await loadCite()
  const cite = new Cite(items)
  if (format === 'bibtex') return String(cite.format('bibtex')).trim()
  if (format === 'ris') return String(cite.format('ris')).trim()
  return String(
    cite.format('bibliography', { format: 'text', template: 'apa', lang: 'de-DE' })
  ).trim()
}
