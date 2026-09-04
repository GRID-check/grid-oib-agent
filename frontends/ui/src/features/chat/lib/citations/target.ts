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

import type { Shelf } from '../source-kinds'
import { citedLoci, isHttpUrl, type CitationLocus, type CitedDocument } from './model'
import { parseKbLocator, type KbCitationLocator } from './locator'

/**
 * The minimal shape of a STORED document a citation can resolve against — a
 * project upload (`GET /api/documents?projectId=…`), a private chat attachment
 * (`GET /api/session/documents?conversationId=…`) or an org Archiv document
 * (`GET /api/archiv/documents`). All three are DB-backed rows opened through the
 * same scope-aware `/api/documents/{id}/preview`, so they share one list.
 *
 * `shelf` says which of the three a row came from, so a citation that knows its
 * own shelf resolves to the right copy of a name held on several. Ordering is
 * only the tie-break when it does not.
 */
export interface StoredDocumentRef {
  id: string
  filename: string
  contentType?: string | null
  /** The shelf this row was listed from (ADR-0047), when the caller tagged it. */
  shelf?: Shelf
}

/**
 * The shelves a {@link StoredDocumentRef} can ever stand for — the DB-backed
 * lists the caller assembles.
 *
 * `base` is deliberately absent: the base corpus has no `documents` row and is
 * reached through `baseCorpusFiles` instead. Any shelf outside this set is
 * therefore not REPRESENTABLE in `storedDocuments`, and a citation naming one
 * must be resolved against the corpus alone rather than quietly matching a
 * same-named upload (ADR-0047: the shelf is part of a document's identity).
 */
const STORED_SHELVES: ReadonlySet<Shelf> = new Set<Shelf>(['project', 'archiv', 'session'])

/**
 * Where a clicked citation can take the user:
 *  - `url`      — a real outbound link (Web / RIS): keep linking out.
 *  - `document` — an in-app preview of a stored document (project upload or org
 *                 Archiv, presigned via /api/documents/{id}/preview) or a
 *                 base-corpus PDF (/api/knowledge-base/documents/{fileName}).
 *  - `download` — the document EXISTS and the reader may have it, but no viewer
 *                 in this app can render its format. The file is offered, and
 *                 the reason is said out loud.
 *  - `info`     — nothing openable: show title/origin/snippet only, never a
 *                 broken viewer.
 */
export type CitationTarget =
  | { kind: 'url'; url: string }
  | {
      /**
       * A document in the Austrian RIS — read INSIDE Piloti.
       *
       * RIS is the only source the answer grounds on that Piloti fetched, read
       * and then could not show: the citation carries an `ris.bka.gv.at` URL,
       * so the chip opened a browser tab and the Fundstelle rail, the passage
       * mark and the copy-as-Zitat actions all stayed behind (#622). It is kept
       * apart from `url` because the difference is not cosmetic — this one has
       * a reader; a `url` target has only a link.
       *
       * The URL travels with it and is still offered: RIS is the authoritative
       * publication, the in-app text is a reading copy, and a legal citation
       * must always be able to reach the original.
       */
      kind: 'ris'
      title: string
      url: string
      /** Cited passage text when the locus carries one — marked in the reader. */
      snippet?: string
    }
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
  | {
      /**
       * A RESOLVED document with no inline viewer — a Word file, a
       * Kalkulation, a DWG. It used to be indistinguishable from a citation
       * that resolved to nothing: both became `info`, the popover offered no
       * way in and said nothing about why, and the reader was left to conclude
       * the product had lost their file. It had not; it cannot DRAW it.
       *
       * Kept apart from `document` rather than flagged inside it, because the
       * two carry different promises: `document` opens a viewer, this one hands
       * over a file. A boolean on one shape would have every consumer branch
       * anyway, and the one that forgot would open an empty viewer.
       */
      kind: 'download'
      /** Display title — the document's human name, not its filename. */
      title: string
      /** Raw filename of the resolved document. */
      fileName: string
      /** Cited passage text when the locus carries one. */
      snippet?: string
      document: { type: 'stored'; id: string; filename: string; contentType: string | null }
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
  if (doc.fileName?.trim()) return { filename: doc.fileName.trim(), shelf: doc.shelf }
  // A document that reached the model without a filename can still name one in
  // a locus key (legacy messages whose wire carried no structured `file_name`).
  for (const locus of doc.loci) {
    const parsed = locus.citationKey ? parseKbLocator(locus.citationKey) : null
    // The document's own shelf came from the wire; the key's is a legacy parse,
    // so it only fills a gap.
    if (parsed) return { ...parsed, shelf: doc.shelf ?? parsed.shelf }
  }
  return null
}

/**
 * Hosts the in-app RIS reader can serve — mirrors `ALLOWED_DOCUMENT_HOSTS` in
 * `sources/ris_adapter/src/client.py`, which is what actually enforces it.
 *
 * Stated here as well so a chip commits to the reader only for a URL the
 * backend will accept: promising an in-app open and then answering 404 is worse
 * than the outbound link it replaced. The backend list is the authority; this
 * one is the promise, and the two are pinned together by
 * `ris-hosts-contract.spec.ts`.
 */
const RIS_DOCUMENT_HOSTS: ReadonlySet<string> = new Set([
  'www.ris.bka.gv.at',
  'ris.bka.gv.at',
  'data.bka.gv.at',
])

/** Whether this URL names a RIS document the in-app reader can fetch. */
export const isRisUrl = (url: string | undefined | null): boolean => {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && RIS_DOCUMENT_HOSTS.has(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

/** A locus that names a page — the only kind the viewer can act on. */
const isLocated = (locus: CitationLocus | undefined): locus is CitationLocus =>
  locus != null && typeof locus.page === 'number' && Number.isFinite(locus.page)

/**
 * The locus a click should open at: the one given, else the first cited one —
 * but never a page-less one while the same document knows a page.
 *
 * A locus without a page is not a lesser Fundstelle, it is NO Fundstelle: the
 * viewer opens at page 1 and the reader is left doing the search the citation
 * exists to spare them. And a page-less locus is routine, because the `[N]` in
 * the prose is bound from the answer's WRITTEN source list, which names the
 * document and frequently not the page, while the retrieval payload for the
 * same document carries the page exactly. One document, two loci, and the click
 * used to land on whichever one carried the number.
 *
 * So a located locus on the same document supersedes a page-less one — a cited
 * one first, then any. Only a document that was genuinely read nowhere in
 * particular still opens at its start, which is the honest answer there.
 */
const openAt = (doc: CitedDocument, locus?: CitationLocus): CitationLocus | undefined => {
  const asked = locus ?? citedLoci(doc)[0] ?? doc.loci[0]
  if (isLocated(asked)) return asked
  return citedLoci(doc).find(isLocated) ?? doc.loci.find(isLocated) ?? asked
}

/**
 * Where a reference opens, resolved to a locus — the same rule the target uses,
 * for the surfaces that track an ACTIVE locus rather than a resolved target.
 *
 * Exported so the dialog's active-Fundstelle state cannot drift from the page
 * the target resolved to: the two disagreeing is how a header said "S. 18" over
 * a document showing page 1.
 */
export const openAtLocus = (
  doc: CitedDocument,
  locus?: CitationLocus
): CitationLocus | undefined => openAt(doc, locus)

/**
 * Resolve a document (optionally at a specific locus) to its preview target.
 *
 *  1. A real http(s) URL always links out (Web stays web, RIS keeps hitting the
 *     real RIS).
 *  2. Otherwise the filename is matched case-insensitively against the stored
 *     documents — project uploads, private chat attachments AND the org Archiv —
 *     then the base corpus, NARROWED to the shelf the citation names. Stored
 *     matches must be inline-previewable (PDF/image); anything else degrades to
 *     `info`.
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
    const url = doc.url!
    if (isRisUrl(url)) {
      const risLocus = openAt(doc, options?.locus)
      return { kind: 'ris', title: doc.title, url, snippet: risLocus?.snippet ?? doc.snippet }
    }
    return { kind: 'url', url }
  }

  const locus = openAt(doc, options?.locus)
  const snippet = locus?.snippet ?? doc.snippet
  const locator = documentLocator(doc)

  if (locator) {
    const wanted = locator.filename.toLowerCase()
    const named =
      options?.storedDocuments?.filter((row) => row.filename.toLowerCase() === wanted) ?? []
    const baseFile = options?.baseCorpusFiles?.find((name) => name.toLowerCase() === wanted)
    const shelf = locator.shelf
    // A shelf `storedDocuments` cannot represent — today only `base`, the corpus
    // — is resolved against `baseCorpusFiles` and nothing else.
    const isStoredShelf = shelf !== undefined && STORED_SHELVES.has(shelf)

    // Narrow to the shelf the citation names. The shelf is PART OF THE DOCUMENT'S
    // IDENTITY (ADR-0047), the same identity the backend registry keys on, so it
    // is never traded away: a `session` or `base` citation whose shelf holds no
    // such document is UNAVAILABLE, not an excuse to open an unrelated project
    // file that merely shares the name. The plain filename match survives only
    // for a citation whose shelf is UNKNOWN, where there is no identity to
    // contradict — that is the one case ordering is allowed to decide.
    //
    // A row the caller left untagged states no shelf of its own, so it
    // contradicts none and stays eligible; it is not evidence of a DIFFERENT
    // shelf, which is what this narrowing exists to reject.
    const candidates =
      shelf === undefined
        ? named
        : isStoredShelf
          ? named.filter((row) => row.shelf === undefined || row.shelf === shelf)
          : []
    const storedDoc = candidates[0]

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
    // The corpus is only the right answer for a citation that names the `base`
    // shelf or names none at all — a `project`/`session`/`archiv` citation must
    // not slide onto a corpus file of the same name either.
    if (baseFile && !isStoredShelf) {
      return {
        kind: 'document',
        title: doc.title,
        fileName: baseFile,
        page: locus?.page,
        snippet,
        document: { type: 'base', fileName: baseFile },
      }
    }
    // The document is there and the reader is entitled to it — this app simply
    // has no viewer for its format. That is a different answer from `info`, and
    // the difference is the whole of what an architect asked for when a cited
    // Raumprogramm.docx offered no way in and no reason.
    if (storedDoc) {
      return {
        kind: 'download',
        title: doc.title,
        fileName: storedDoc.filename,
        snippet,
        document: {
          type: 'stored',
          id: storedDoc.id,
          filename: storedDoc.filename,
          contentType: storedDoc.contentType ?? null,
        },
      }
    }
  }

  return { kind: 'info', title: doc.title, snippet }
}
