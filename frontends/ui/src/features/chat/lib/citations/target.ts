/**
 * Where a clicked citation takes the user.
 *
 * Resolution is a question about a DOCUMENT (which file, on which shelf) with
 * the LOCUS as a parameter (which page to open at) — so it takes a
 * {@link CitedDocument} and an optional {@link CitationLocus} rather than a
 * flat citation. That split is what makes "open OIB-Richtlinie 2.1 at p.18"
 * expressible at all; the flat shape could only ever open a document at
 * whichever page happened to be attached to the chip.
 *
 * Pure: every index it consults is passed in. Without them (lists not loaded,
 * or the caller cannot fetch) resolution honestly degrades to `info` rather
 * than opening a viewer that cannot render.
 */

import type { CollectionScope } from '../source-kinds'
import { citedLoci, isHttpUrl, type CitationLocus, type CitedDocument } from './model'
import { parseKbLocator, type KbCitationLocator } from './locator'

/**
 * The minimal shape of a STORED document a citation can resolve against — a
 * project upload (`GET /api/documents?projectId=…`) or an org Archiv document
 * (`GET /api/archiv/documents`). Both are DB-backed rows opened through the
 * same scope-aware `/api/documents/{id}/preview`, so they share one list.
 *
 * `scope` says which of the two a row came from, so a citation that knows its
 * own shelf resolves to the right copy of a name held on both. Ordering is only
 * the tie-break when it does not.
 */
export interface StoredDocumentRef {
  id: string
  filename: string
  contentType?: string | null
  scope?: CollectionScope
}

/**
 * Where a clicked citation can take the user:
 *  - `url`      — a real outbound link (Web / RIS): keep linking out.
 *  - `document` — an in-app preview of a stored document (project upload or org
 *                 Archiv, presigned via /api/documents/{id}/preview) or a
 *                 base-corpus PDF (/api/knowledge-base/documents/{fileName}).
 *  - `info`     — nothing openable: show title/origin/snippet only, never a
 *                 broken viewer.
 */
export type CitationTarget =
  | { kind: 'url'; url: string }
  | {
      kind: 'document'
      /** Display title — the document's human name, not its filename. */
      title: string
      /** Raw filename of the resolved document. */
      fileName: string
      /** 1-based page to open at, from the locus. */
      page?: number
      /** Cited passage text when the locus carries one. */
      snippet?: string
      document:
        | { type: 'stored'; id: string; filename: string; contentType: string | null }
        | { type: 'base'; fileName: string }
    }
  | { kind: 'info'; title: string; snippet?: string }

/**
 * Content types the existing preview machinery can render inline (mirrors
 * PREVIEW_TYPES in the Files preview pane — PDF iframe + browser image types).
 */
const PREVIEWABLE_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
])

const isPreviewableContentType = (contentType: string | null | undefined): boolean =>
  contentType != null && PREVIEWABLE_CONTENT_TYPES.has(contentType.toLowerCase())

/** The document's filename + shelf, however it can be recovered. */
const documentLocator = (doc: CitedDocument): KbCitationLocator | null => {
  if (doc.fileName?.trim()) return { filename: doc.fileName.trim(), scope: doc.scope }
  // A document that reached the model without a filename can still name one in
  // a locus key (legacy messages whose wire carried no structured `file_name`).
  for (const locus of doc.loci) {
    const parsed = locus.citationKey ? parseKbLocator(locus.citationKey) : null
    if (parsed) return { ...parsed, scope: parsed.scope ?? doc.scope }
  }
  return null
}

/** The locus a click should open at: the one given, else the first cited one. */
const openAt = (doc: CitedDocument, locus?: CitationLocus): CitationLocus | undefined =>
  locus ?? citedLoci(doc)[0] ?? doc.loci[0]

/**
 * Resolve a document (optionally at a specific locus) to its preview target.
 *
 *  1. A real http(s) URL always links out (Web stays web, RIS keeps hitting the
 *     real RIS).
 *  2. Otherwise the filename is matched case-insensitively against the stored
 *     documents — project uploads AND the org Archiv — then the base corpus.
 *     Stored matches must be inline-previewable (PDF/image); anything else
 *     degrades to `info`.
 *  3. Anything unresolvable becomes an `info` target.
 */
export const resolveCitationTarget = (
  doc: CitedDocument,
  options?: {
    locus?: CitationLocus
    storedDocuments?: StoredDocumentRef[]
    baseCorpusFiles?: string[]
  }
): CitationTarget => {
  if (isHttpUrl(doc.url)) {
    return { kind: 'url', url: doc.url! }
  }

  const locus = openAt(doc, options?.locus)
  const snippet = locus?.snippet ?? doc.snippet
  const locator = documentLocator(doc)

  if (locator) {
    const wanted = locator.filename.toLowerCase()
    const named =
      options?.storedDocuments?.filter((row) => row.filename.toLowerCase() === wanted) ?? []
    const baseFile = options?.baseCorpusFiles?.find((name) => name.toLowerCase() === wanted)
    // Narrow to the shelf the citation names — the same document identity the
    // backend registry keys on. FAIL-OPEN: a scope that matches nothing falls
    // back to the plain filename match, so nothing that opens today stops
    // opening because a scope was missing, stale, or wrong.
    const scoped = locator.scope ? named.filter((row) => row.scope === locator.scope) : []
    // `Basiswissen` names the base corpus, which `storedDocuments` cannot hold
    // (it is project + Archiv rows only). Without this the base-corpus shelf
    // would be the one scope that resolves to the WRONG document whenever a
    // project upload shares the filename.
    const storedDoc = locator.scope === 'baurecht' && baseFile ? undefined : (scoped[0] ?? named[0])

    if (storedDoc && isPreviewableContentType(storedDoc.contentType)) {
      return {
        kind: 'document',
        title: doc.title,
        fileName: storedDoc.filename,
        page: locus?.page,
        snippet,
        document: {
          type: 'stored',
          id: storedDoc.id,
          filename: storedDoc.filename,
          contentType: storedDoc.contentType ?? null,
        },
      }
    }
    if (baseFile) {
      return {
        kind: 'document',
        title: doc.title,
        fileName: baseFile,
        page: locus?.page,
        snippet,
        document: { type: 'base', fileName: baseFile },
      }
    }
  }

  return { kind: 'info', title: doc.title, snippet }
}
