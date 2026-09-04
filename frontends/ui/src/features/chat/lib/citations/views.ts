/**
 * Surface projections.
 *
 * Every surface answers a different question about the SAME
 * {@link CitedDocument} list, so each is a filter or a flatten — never a
 * re-derivation. Nothing here classifies, labels or re-identifies a source;
 * if a projection needed to, that would be a fact missing from the model.
 */

import type { SourceSignal } from '@/features/layout/lib/source-presets'
import { KIND_TO_SIGNAL, shelfLabel } from '../source-kinds'
import { splitReportSources, type ReportSourceEntry } from '@/features/layout/lib/report-citations'
import {
  citationNumbers,
  citedLoci,
  isCited,
  type CitationLocus,
  type CitedDocument,
} from './model'

/**
 * `[N]` → the reference that marker stands for.
 *
 * A projection rather than a scan per marker: an answer can hold a lot of
 * markers and they all resolve on one render.
 *
 * ONE `[N]` CAN BE CARRIED BY TWO LOCI OF THE SAME DOCUMENT, and they are not
 * equally good answers. The retrieval payload states the page the passage was
 * read at; the answer's written source list states the same `[N]` and often
 * names no page — so the document ends up with a located locus and a page-less
 * one, both numbered. Taking whichever came last handed the marker the
 * page-less one, and clicking a citation that knew it was page 18 opened the
 * viewer at page 1 (#621).
 *
 * So a locus that names a page wins, and among two that do the first stands
 * (loci arrive ordered by `[N]`, then by page). A document whose number is
 * known only at the document level still resolves — to the document as a whole.
 */
export const referencesByNumber = (
  docs: CitedDocument[]
): Map<number, { document: CitedDocument; locus?: CitationLocus }> => {
  const byNumber = new Map<number, { document: CitedDocument; locus?: CitationLocus }>()
  for (const document of docs) {
    for (const locus of document.loci) {
      if (typeof locus.number !== 'number') continue
      const held = byNumber.get(locus.number)
      // WITHIN one document, prefer the locus that names a page. ACROSS two
      // documents that both claim the same `[N]`, do not: the first one stands,
      // because swapping which DOCUMENT a marker points at is a different and
      // much larger claim than choosing between two places in one.
      if (held && (held.document !== document || held.locus?.page != null || locus.page == null)) {
        continue
      }
      byNumber.set(locus.number, { document, locus })
    }
    for (const number of citationNumbers(document)) {
      if (!byNumber.has(number)) byNumber.set(number, { document })
    }
  }
  return byNumber
}

/** DOM id prefix for a numbered source row under an answer. */
export const ANSWER_SOURCE_ANCHOR_PREFIX = 'answer-source-'

/**
 * Per-message anchor prefix. Several answers share one scroll container and
 * each numbers its sources from 1, so the message id has to be part of the DOM
 * id or an inline `[1]` in the newest answer would scroll to the oldest one's
 * source.
 */
export const answerSourceAnchorPrefix = (messageId: string): string =>
  `${ANSWER_SOURCE_ANCHOR_PREFIX}${messageId}-`

/**
 * What the answer's provenance row shows: the documents the answer actually
 * used.
 *
 * Falls back to the full list when nothing is flagged — messages persisted
 * before `isCited` existed, and turns whose backend never resolved a `[N]`
 * binding. Showing everything that was retrieved is a weaker claim than
 * "these are the sources", but it is an honest one; showing nothing would
 * hide grounding that exists.
 */
export const answerDocuments = (docs: CitedDocument[]): CitedDocument[] => {
  // A document with NO loci is not "uncited" — it has no retrieved evidence for
  // `isCited` to be a statement about. That is what a `legal_basis` card is: the
  // model naming a law it leaned on, with no passage behind it. Filtering on
  // `isCited` alone dropped every such card the moment the turn also had one
  // real citation, which is exactly the mixed answer where it matters most.
  const claimed = docs.filter((doc) => isCited(doc) || doc.loci.length === 0)
  return claimed.length > 0 ? claimed : docs
}

/**
 * Documents the turn retrieved but the answer never cited.
 *
 * The Herleitung's honest half: "retrieved, not cited" is a real research outcome and
 * the surface that claims to show the derivation has to be able to say it.
 * Before the model existed this set was not expressible at all — the trace and
 * the answer were separate pipelines with no shared identity to subtract.
 *
 * The same rule {@link answerDocuments} applies, read the other way: "read, not
 * used" is a claim about a LOCUS, so a locus-less card document is not a member
 * — it was never retrieved. Without that clause the two projections would both
 * claim it, and the Herleitung would report a law the answer leaned on as one it
 * discarded.
 */
export const unusedDocuments = (docs: CitedDocument[]): CitedDocument[] =>
  docs.filter((doc) => doc.loci.length > 0 && !isCited(doc))

/** One row of the report bibliography: a `[N]`, and where it points. */
export interface BibliographyRow {
  number: number
  document: CitedDocument
  locus: CitationLocus
}

/**
 * The report's numbered bibliography — one row per `[N]` in the prose.
 *
 * This is the LOCUS-level projection: a document cited at four pages is four
 * rows, because the inline markers are four and every marker must lead
 * somewhere. The answer's chip row is the DOCUMENT-level projection of the same
 * data. Both levels are now explicit, so neither has to guess the other.
 */
export const bibliographyRows = (docs: CitedDocument[]): BibliographyRow[] => {
  const rows: BibliographyRow[] = []
  for (const doc of docs) {
    for (const locus of citedLoci(doc)) {
      if (typeof locus.number === 'number')
        rows.push({ number: locus.number, document: doc, locus })
    }
  }
  return rows.sort((a, b) => a.number - b.number)
}

/** Every `[N]` the answer's prose can legitimately link to. */
export const anchoredNumbers = (docs: CitedDocument[]): Set<number> => {
  const numbers = new Set<number>()
  for (const doc of docs) for (const n of citationNumbers(doc)) numbers.add(n)
  return numbers
}

/**
 * Total evidence read across the turn — the "N Treffer" tally the Herleitung
 * states as its proof of work.
 */
export const totalHits = (docs: CitedDocument[]): number =>
  docs.reduce((sum, doc) => sum + doc.loci.length, 0)

export interface AnswerBodySplit {
  /** The answer markdown without its written sources section. */
  body: string
  /** Parsed entries of that section (empty when the answer had none). */
  entries: ReportSourceEntry[]
  /** The `[N]` markers the prose may link to — one per parsed entry. */
  numbers: ReadonlySet<number>
}

/**
 * Split the answer's written sources section off its body.
 *
 * The written list is lifted out because it is a DATA CHANNEL, not display: it
 * carries the `[N]` ↔ locator binding into `buildCitationModel`, and rendering
 * it as well would state the answer's sources twice, each statement holding
 * half the truth. Returns the answer unchanged when it carries no recognizable
 * section, so answers without one (and meta turns) render exactly as before.
 *
 * The `numbers` it reports are what the section licenses the prose to link to;
 * `remarkCitationMarkers` does the linking, on the parsed body.
 */
export const splitAnswerBody = (markdown: string): AnswerBodySplit => {
  const split = splitReportSources(markdown)
  if (split.entries.length === 0) return { body: markdown, entries: [], numbers: EMPTY_NUMBERS }
  return {
    body: split.body,
    entries: split.entries,
    numbers: new Set(split.entries.map((entry) => entry.number)),
  }
}

const EMPTY_NUMBERS: ReadonlySet<number> = new Set()

/**
 * Product-stratum tab label, used when a document carries no fine lane label of
 * its own (a card-derived source, or a document the wire classified only to the
 * coarse kind).
 */
const COARSE_TAB: Record<SourceSignal, string> = {
  law: 'Baurecht',
  project: 'Projektwissen',
  office: 'Büroarchiv',
  auto: 'Web',
  model: 'Modellmessung',
}

/**
 * The German label for the shelf a document sits on, or undefined when the wire
 * carried no shelf.
 *
 * Rendering only, and a pure function of the shelf (ADR-0047 §5) — the string is
 * never read back to recover the shelf. Undefined means UNATTRIBUTED: a document
 * whose shelf is unknown says nothing about where it is filed rather than
 * guessing, which is what the deleted prefix table used to do.
 */
export const documentShelfLabel = (doc: CitedDocument): string | undefined =>
  doc.shelf ? shelfLabel(doc.shelf) : undefined

/**
 * The provenance tab a document's Herleitung card is filed under: its fine lane
 * label ("OIB-Richtlinie", "Bundesrecht") when the backend classified one, then
 * the SHELF the wire stated, and only then the coarse display stratum.
 *
 * The shelf outranks the coarse stratum because the two answer different
 * questions and only one of them is a fact about this document's filing: a file
 * the user attached privately to the chat is `projekt`-KIND (it is project-ish
 * material, and paints in that family) but sits on the `session` SHELF — and
 * labelling it "Projektwissen" told the reader it was project knowledge the
 * office had filed, which was never true.
 */
export const documentTabLabel = (doc: CitedDocument): string =>
  doc.laneLabel?.trim() || documentShelfLabel(doc) || COARSE_TAB[KIND_TO_SIGNAL[doc.kind]]
