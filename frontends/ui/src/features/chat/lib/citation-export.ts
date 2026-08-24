/**
 * Turning an answer's sources into the citation formats external systems read.
 *
 * `source-citation.ts` builds the CSL-JSON items; this module gets them
 * rendered:
 *
 *  - **Fachtext** and **CSL-JSON** are produced locally — pure string work, so
 *    they are instant and work offline.
 *  - **APA / BibTeX / RIS (.ris)** go through **citation-js** (the established
 *    Node implementation of the CSL stack) on the BFF, via
 *    `POST /api/citations/format`. It runs server-side because citation-js is a
 *    Node library — its core pulls `node-fetch` → `node:fs`, which cannot be
 *    bundled for the browser — and because the chat bundle should not carry
 *    1.7 MB of citation machinery for a button most turns never press. The
 *    request contains only CSL-JSON the client already has.
 *
 * Any failure (offline, route error) degrades to the local Fachtext
 * bibliography: a plainer citation still beats no citation.
 *
 * Format note — two different things are called "RIS" here: the Austrian
 * Rechtsinformationssystem (our legal source) and the RIS tagged file format
 * (`.ris`, the EndNote/Zotero/Mendeley interchange). The UI labels the latter
 * "EndNote/Zotero (.ris)" so nobody has to guess which one they are copying.
 */

import type { CitationRef } from './citations'
import { toCslItem, toCslJson, toFachtextList, toQuoteList } from './source-citation'

/** The formats the source block can hand out. */
export type CitationFormat = 'quotes' | 'fachtext' | 'apa' | 'bibtex' | 'ris' | 'csl-json'

/** Formats offered in the copy menu, in the order they are shown. */
export const CITATION_FORMATS: readonly CitationFormat[] = [
  'quotes',
  'fachtext',
  'apa',
  'bibtex',
  'ris',
  'csl-json',
] as const

/** File extension per format, for a future "download" affordance. */
export const CITATION_FILE_EXTENSION: Record<CitationFormat, string> = {
  quotes: 'txt',
  fachtext: 'txt',
  apa: 'txt',
  bibtex: 'bib',
  ris: 'ris',
  'csl-json': 'json',
}

/** Formats rendered by citation-js on the BFF. */
const SERVER_RENDERED = new Set<CitationFormat>(['apa', 'bibtex', 'ris'])

/**
 * Render the answer's sources in `format`. Falls back to the local Fachtext
 * bibliography whenever the server-rendered formats are unavailable.
 */
export const renderCitations = async (
  refs: CitationRef[],
  format: CitationFormat,
  now: Date
): Promise<string> => {
  if (refs.length === 0) return ''
  if (format === 'quotes') return toQuoteList(refs, now)
  if (format === 'csl-json') return toCslJson(refs, now)
  if (!SERVER_RENDERED.has(format)) return toFachtextList(refs, now)

  try {
    const response = await fetch('/api/citations/format', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format,
        items: refs.map((ref) => toCslItem(ref, now)),
      }),
    })
    if (!response.ok) return toFachtextList(refs, now)
    const data = (await response.json()) as { text?: unknown }
    return typeof data.text === 'string' && data.text.trim()
      ? data.text
      : toFachtextList(refs, now)
  } catch {
    return toFachtextList(refs, now)
  }
}
