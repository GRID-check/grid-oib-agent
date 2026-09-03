/**
 * The single derivation: every producer → one {@link CitedDocument} list.
 *
 * Four things in a turn can claim to know about a source, and each knows a
 * different part:
 *
 *  | producer                     | knows                                  |
 *  |------------------------------|----------------------------------------|
 *  | structured wire (`sources`)  | identity, title, kind/lane, page, `[N]` |
 *  | written `## Quellen` list    | `[N]` ↔ locator binding, as prose       |
 *  | `## Trace-Lanes` fan-out     | what was RETRIEVED (cited or not)       |
 *  | `legal_basis` cards          | a law name and an excerpt, no locus     |
 *
 * They used to be consumed by three different surfaces with three different
 * matching rules, which is why a document could be complete in one place and
 * degraded in another. Here they are folded into ONE model in a fixed order —
 * richest producer first, so every later contribution can only ADD facts, never
 * replace better ones. What each surface then renders is a projection, and two
 * projections of the same model cannot disagree.
 */

import type { GridCard } from '@/shared/cards/schemas'
import type { ReportSourceEntry } from '@/features/layout/lib/report-citations'
import type { CitationSource } from '../../types'
import type { TraceLaneCard } from '../trace-lanes'
import {
  CitationAccumulator,
  isHttpUrl,
  oibDocumentKey,
  stripOriginToken,
  type CitedDocument,
} from './model'
import { locatorFromPseudoUrl, parseKbLocator } from './locator'

/** Everything a turn can offer about its sources. All parts optional. */
export interface CitationInputs {
  /** Structured wire sources (WS `sources` / SSE citation_source + citation_use). */
  citations?: CitationSource[]
  /** Entries parsed out of the answer's written sources section. */
  entries?: ReportSourceEntry[]
  /** `legal_basis` cards from the shallow-answer path. */
  cards?: (GridCard | undefined)[]
  /** Retrieved-document fan-out from the thinking steps. */
  traceLanes?: TraceLaneCard[]
}

/** A markdown link, e.g. "[OIB RL 4](https://…)". */
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/i
/** A bare URL anywhere in the entry text. */
const BARE_URL_RE = /(https?:\/\/[^\s)>\]]+)/i
/** Trailing " — url" / " - url" separator before a bare URL. */
const URL_SEPARATOR_RE = /[\s]*[-–—:]?[\s]*$/
/** Markdown emphasis/code markers a written entry may carry. */
const MD_MARKERS_RE = /[*`]/g

/** Written source-entry origin token → the wire origin. */
const ENTRY_KIND_TO_ORIGIN = { kb: 'kb', web: 'web', ris: 'ris' } as const

/**
 * Build the turn's citation model.
 *
 * Producer order is deliberate and is the whole reason this reads as one
 * document instead of several: the structured wire goes first because it is the
 * only producer that carries the backend's own classification and display
 * title, so everything after it merges INTO a complete document rather than
 * creating a bare one. The written list contributes `[N]` bindings the wire may
 * not have; the trace contributes retrieved-but-uncited loci; cards contribute
 * law names with no locus at all.
 */
export const buildCitationModel = (inputs: CitationInputs): CitedDocument[] => {
  const accumulator = new CitationAccumulator()

  addWireCitations(accumulator, inputs.citations)
  addWrittenEntries(accumulator, inputs.entries)
  addTraceLanes(accumulator, inputs.traceLanes)
  addLegalBasisCards(accumulator, inputs.cards)

  return accumulator.build()
}

/**
 * The structured wire — the authoritative producer.
 *
 * One wire source is one LOCUS, not one document: the backend registry keys
 * entries on `(collection, filename, page)`, so a document read at four pages
 * arrives as four sources. Folding them onto one document here is what stops
 * the same Richtlinie rendering as four separate chips.
 */
const addWireCitations = (
  accumulator: CitationAccumulator,
  citations: CitationSource[] | undefined
): void => {
  if (!citations?.length) return

  for (const citation of citations) {
    // `fileName` is the structured truth; fall back to parsing the key or the
    // content line only when the wire did not carry one (legacy messages).
    const parsed =
      (citation.citationKey ? parseKbLocator(citation.citationKey) : null) ??
      (citation.content ? parseKbLocator(citation.content) : null) ??
      (citation.url && !isHttpUrl(citation.url) ? locatorFromPseudoUrl(citation.url) : null)
    const fileName = citation.fileName?.trim() || parsed?.filename
    const page = typeof citation.page === 'number' ? citation.page : parsed?.page
    const label = citation.title || citation.citationKey || stripOriginToken(citation.content ?? '')

    accumulator.add({
      identity: {
        documentId: citation.documentId,
        fileName,
        collection: citation.collection,
        url: isHttpUrl(citation.url) ? citation.url : undefined,
        label,
      },
      title: citation.title,
      fileName,
      collection: citation.collection,
      // The payload's own field is the EXPLICIT shelf (ADR-0047); a legacy key's
      // German qualifier is a separate, weaker channel — for messages persisted
      // before the wire carried the field. They are handed over as two fields,
      // never collapsed with `??`: one document is assembled from many wire
      // sources, and collapsing here made whichever arrived first the winner, so
      // a qualifier on source #1 could beat the real shelf on source #2.
      shelf: citation.shelf,
      shelfFallback: parsed?.shelf,
      url: isHttpUrl(citation.url) ? citation.url : undefined,
      kind: citation.kind,
      lane: citation.lane,
      laneLabel: citation.laneLabel,
      bindingNote: citation.bindingNote,
      bindingStatus: citation.bindingStatus,
      origin: citation.origin,
      tool: citation.tool,
      locus: {
        page,
        punkt: citation.punkt,
        score: citation.score,
        number: citation.number,
        // A wire source with no explicit flag is a source the backend chose to
        // send for THIS answer, so it counts as used; `isCited === false` is
        // only ever set deliberately (discovery events on the deep path).
        isCited: citation.isCited !== false,
        snippet: citationSnippet(citation),
        citationKey: citation.citationKey,
      },
    })
  }
}

/**
 * The answer's written sources section.
 *
 * Its one irreplaceable fact is the `[N]` ↔ locator binding: on the shallow
 * path the model writes the list and the backend's number map can be sparse.
 * Everything else it says (a filename, maybe a URL) the wire already said
 * better, so a written entry adds a numbered LOCUS to an existing document and
 * only creates a document when nothing structured matched — which is now a
 * complete document rather than a degraded chip, because the title, kind and
 * tint come from the same resolution every other producer uses.
 */
const addWrittenEntries = (
  accumulator: CitationAccumulator,
  entries: ReportSourceEntry[] | undefined
): void => {
  if (!entries?.length) return

  for (const entry of entries) {
    const text = entry.markdown.replace(MD_MARKERS_RE, '').trim()

    let title = text
    let url: string | undefined
    const linkMatch = MARKDOWN_LINK_RE.exec(text)
    if (linkMatch) {
      url = linkMatch[2]
      title = text.replace(MARKDOWN_LINK_RE, linkMatch[1]).trim()
    } else {
      const urlMatch = BARE_URL_RE.exec(text)
      if (urlMatch) {
        url = urlMatch[1]
        title = text.slice(0, urlMatch.index).replace(URL_SEPARATOR_RE, '').trim()
      }
    }

    const locator = parseKbLocator(title || text)
    const origin = entry.sourceKind ? ENTRY_KIND_TO_ORIGIN[entry.sourceKind] : undefined

    accumulator.add({
      identity: {
        fileName: locator?.filename,
        url: isHttpUrl(url) ? url : undefined,
        // A pure locator ("plan.pdf, p.4") is a reference, not a title — the
        // filename is the identity and the page travels as the locus.
        label: locator ? locator.filename : title || url || text,
      },
      // Never pass the locator line as a title: `resolveTitle` would keep the
      // raw filename, which is the exact regression this list used to cause.
      title: locator ? undefined : title || undefined,
      fileName: locator?.filename,
      // A written entry is prose the model wrote, so it can never STATE a shelf:
      // the only one it carries is a legacy qualifier inside the locator it
      // quotes, which is an inference and travels as the fallback. Passing it as
      // explicit would let a sentence overrule the wire.
      shelfFallback: locator?.shelf,
      url: isHttpUrl(url) ? url : undefined,
      origin,
      locus: {
        page: locator?.page,
        number: entry.number,
        isCited: true,
      },
    })
  }
}

/**
 * The Herleitung fan-out — what retrieval actually returned.
 *
 * These loci are RETRIEVED, not cited: a lane hit only becomes cited if a wire
 * source or a written entry says so, and the accumulator's sticky `isCited`
 * means contributing them can never downgrade a document. This is what finally
 * lets one surface answer both "what did you read?" and "what did you use?" —
 * the two questions that used to live in two disconnected pipelines.
 */
const addTraceLanes = (
  accumulator: CitationAccumulator,
  lanes: TraceLaneCard[] | undefined
): void => {
  if (!lanes?.length) return

  for (const lane of lanes) {
    for (const source of lane.sources) {
      const name = source.name?.trim()
      if (!name) continue
      // `detail` is either a page marker ("p.12") or the source URL.
      const detail = source.detail?.trim()
      const isUrl = isHttpUrl(detail)
      const page = !isUrl && detail ? Number(/p\.?\s*(\d+)/i.exec(detail)?.[1]) : NaN
      const looksLikeFile = /\.\w{2,5}$/.test(name)

      accumulator.add({
        identity: {
          fileName: looksLikeFile ? name : undefined,
          url: isUrl ? detail : undefined,
          label: source.title || name,
        },
        title: source.title,
        fileName: looksLikeFile ? name : undefined,
        url: isUrl ? detail : undefined,
        // Stated by the backend for this hit (ADR-0047): the only channel a
        // document the answer never cited has for its shelf.
        shelf: source.shelf,
        kind: lane.kind,
        lane: lane.key,
        laneLabel: lane.label,
        locus: {
          page: Number.isFinite(page) ? page : undefined,
          isCited: false,
        },
      })
    }
  }
}

/**
 * `legal_basis` cards — a law name and an excerpt, authored by the model.
 *
 * They carry no document identity (see the citation-system audit: threading one
 * is a card-contract redesign), so they can only ever merge onto an existing
 * document via the canonical OIB key, or stand alone as a locus-less document.
 * Deliberately last: a card must never be the producer that names a document
 * the structured wire already named better.
 */
const addLegalBasisCards = (
  accumulator: CitationAccumulator,
  cards: (GridCard | undefined)[] | undefined
): void => {
  if (!cards?.length) return

  for (const card of cards) {
    // Holes are cards validation rejected (`validateGridCards` keeps wire
    // positions): they name no law.
    if (!card || card.type !== 'legal_basis') continue
    const label = [card.law, card.section ?? card.article ?? undefined].filter(Boolean).join(' ')
    if (!label) continue
    const isOib = !!oibDocumentKey(card.law)

    accumulator.add({
      identity: { label },
      title: label,
      // An OIB card names a corpus document (merged by the canonical key); any
      // other legal basis is a RIS-tier source. Both are Baurecht.
      kind: 'baurecht',
      lane: isOib ? 'baurecht_oib' : 'baurecht_ris',
      origin: isOib ? 'kb' : 'ris',
      snippet: card.original_text ?? card.summary ?? undefined,
    })
  }
}

/** Longest snippet shown in a preview surface. */
const MAX_SNIPPET_LENGTH = 600

/**
 * Cited-passage text carried by a citation, if any.
 *
 * The deep-research SSE events set `content` to the URL itself and KB locators
 * are pure "file, p.N" references — neither is a passage, so both yield
 * undefined rather than putting a reference where a quote belongs.
 */
export const citationSnippet = (
  citation: Pick<CitationSource, 'url' | 'content'>
): string | undefined => {
  const text = stripOriginToken(citation.content ?? '')
  const url = citation.url?.trim() ?? ''
  if (!text || (url && text === url)) return undefined
  const lines = text.split('\n')
  const firstLine = lines[0]?.trim() ?? ''
  // A leading locator line ("file.pdf, p.3") is a reference, not a passage.
  const body = parseKbLocator(firstLine) ? lines.slice(1).join('\n').trim() : text
  if (!body) return undefined
  return body.length > MAX_SNIPPET_LENGTH ? `${body.slice(0, MAX_SNIPPET_LENGTH - 1)}…` : body
}
