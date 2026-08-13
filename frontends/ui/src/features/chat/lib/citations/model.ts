/**
 * The citation model — TWO levels, named once, read by every surface.
 *
 * A citation is not one thing. It is a **document** (which source) and a
 * **locus** inside it (which page/passage). Every defect this module replaces
 * came from a surface silently picking one level and assuming the other agreed:
 *
 *  - the "Belegt durch" chips deduplicated to the DOCUMENT level, then matched
 *    1:1 against the answer's written source list, which is at the LOCUS level.
 *    One document cited at four pages produced one full chip and three
 *    degraded ones — raw filename, no authority badge, wrong tint — because the
 *    single deduplicated ref was consumed by `[1]` and `[2]`–`[4]` had nothing
 *    left to match;
 *  - the Herleitung fan-out grouped at the DOCUMENT level from a different
 *    input entirely (the `## Trace-Lanes` JSON), so it could show what was
 *    searched but never which document became `[3]`;
 *  - the report bibliography re-parsed the LOCUS level back out of prose.
 *
 * Three parsers, three identities, no shared object. This module is that
 * object. Nothing downstream classifies, labels, or deduplicates a source
 * again — surfaces project {@link CitedDocument}s, they do not derive them.
 *
 * Identity is hierarchical and so is the data:
 *
 *     CitedDocument   ← WHAT   (collection, fileName) | url | canonical OIB key
 *       └─ loci[]     ← WHERE  page / section, its `[N]`, its passage
 *
 * The backend model is already this shape — `SourceRegistry` keys entries on
 * `(collection, filename, page)`, which is exactly (document, locus). It was
 * only ever flattened for the wire.
 */

import type { SourceTint } from '@/features/layout/lib/source-presets'
import type { CitationSource } from '../../types'
import {
  KIND_TO_SIGNAL,
  accentForLane,
  authorityTag,
  asSourceKind,
  kindForLane,
  type Shelf,
  type SourceKind,
} from '../source-kinds'
import { documentDisplayName } from '../document-names'

/** Origin token the backend stamps on a source line (`[KB]` / `[RIS]` / `[Web]`). */
export type CitationOrigin = 'kb' | 'ris' | 'web'

/**
 * WHERE the evidence sits inside a document — one retrieved passage.
 *
 * A locus exists whether or not the answer cited it: the Herleitung must be
 * able to say "read, not used", which is a claim about a locus, not a document.
 */
export interface CitationLocus {
  /** Stable key within the owning document. */
  key: string
  /** 1-based page, when retrieval carried one. */
  page?: number
  /**
   * The `[N]` this locus carries in the answer prose. Present only when the
   * answer actually cited it AND the number is known (backend `verify_citations`
   * owns that binding; the written source list is the fallback carrier).
   */
  number?: number
  /** True when the answer cited this passage, false when it was only retrieved. */
  isCited: boolean
  /** Retrieved passage text, when the wire carried one. */
  snippet?: string
  /** The exact key the backend registry used — drives preview + copy-citation. */
  citationKey?: string
}

/**
 * WHAT was cited — one document, with every place in it this turn touched.
 *
 * All presentation facts (title, tint, authority badge) live here and nowhere
 * else, so two surfaces rendering the same document cannot disagree about how
 * it looks.
 */
export interface CitedDocument {
  /** Canonical identity — see {@link documentIdentity}. Stable render key. */
  id: string
  /** Human display name. Never a raw corpus filename when a title is derivable. */
  title: string
  /** Raw filename behind `title`, for the tooltip and preview resolution. */
  fileName?: string
  /** Retrieval collection — the other half of a document's true identity. */
  collection?: string
  /**
   * The SHELF the document sits on — `archiv | project | session | base`
   * (ADR-0047), a different axis from `kind` above.
   *
   * It ARRIVES AS DATA on the citation payload; it is never derived from the
   * collection id, and the German label a surface renders is derived FROM it
   * (`shelfLabel`), not the other way round. A legacy key's `(Büroarchiv)`
   * qualifier is the only fallback, for messages persisted before the wire
   * carried the field.
   *
   * Undefined means UNKNOWN — the document renders unattributed. It is never
   * defaulted to `base`: an unknown document claiming to be authoritative base
   * law is the fail-open defect ADR-0047 removes.
   */
  shelf?: Shelf
  /** Outbound link, for web/RIS sources. */
  url?: string
  /** Coarse kind (ADR-0026) — the provenance/trust family. */
  kind: SourceKind
  /** Fine lane stratum-key (`baurecht_oib`, `baurecht_ris`, …). */
  lane?: string
  /** Human lane label ("OIB-Richtlinie") for the popover. */
  laneLabel?: string
  /** `--source-*` family this document paints with (kind, refined by lane). */
  tint: SourceTint
  /** Compact authority badge (OIB / RIS / ÖNORM), when the lane names a tier. */
  authority?: string
  /** Bindingness note from the norm registry, for the popover. */
  bindingNote?: string
  /** Backend origin token, when one was stamped. */
  origin?: CitationOrigin
  /** Tool that produced the hit. */
  tool?: string
  /**
   * Card-authored excerpt (`legal_basis.original_text`). Only set for documents
   * that came from a card rather than from retrieval, which have no loci.
   */
  snippet?: string
  /** Every place in this document the turn read or cited. Never empty except for cards. */
  loci: CitationLocus[]
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Canonical identity for an OIB base-corpus document, from either its filename
 * (`oib-rl_2_ausgabe_mai_2023.pdf`) or a human label (`OIB-Richtlinie 2`).
 *
 * The shared key that collapses the two provenance streams — a KB citation and
 * a `legal_basis` card naming the SAME Richtlinie — onto one document. It
 * ignores edition and section deliberately: neither changes WHICH document is
 * cited. Returns null for anything not recognisably OIB, so every other source
 * keeps its own (collection, filename) / URL identity untouched.
 *
 * Mirrors the backend filename convention (`norm_registry.oib_doc_class`), but
 * only needs to produce a stable key, not a name.
 */
const OIB_NUMBER_RE = /(?:oib[\s._-]*(?:rl|richtlinie)?|richtlinie)[\s._-]*(\d+(?:\.\d+)?)/i

export const oibDocumentKey = (nameOrLabel: string | undefined | null): string | null => {
  const raw = (nameOrLabel ?? '').trim().toLowerCase()
  if (!raw || !/(oib|richtlinie)/.test(raw)) return null

  const role = /erl[aä]uterung|erlaeuterung/.test(raw)
    ? 'erl'
    : /[äa]nderung|aenderung/.test(raw)
      ? 'aen'
      : ''
  const leitfaden = /leitfaden/.test(raw) ? 'lf' : ''

  let subject: string | null = null
  if (/begriffsbestimmung/.test(raw)) subject = 'begriffe'
  else if (/zitierte/.test(raw) && /normen/.test(raw)) subject = 'zitnormen'
  else subject = OIB_NUMBER_RE.exec(raw)?.[1] ?? null

  if (!subject) return null
  return ['oib', role, subject, leitfaden].filter(Boolean).join(':')
}

/** URL reduced to a comparison form (scheme/host lowercased, trailing slash dropped). */
export const normalizeUrl = (url: string): string =>
  url.trim().toLowerCase().replace(/\/+$/, '')

/** Minimal facts needed to identify a document, from any producer. */
export interface DocumentIdentityInput {
  /**
   * The backend's own document identity (`document_id` on the wire). When
   * present it wins outright — it is computed from the same
   * `(collection, filename)` the registry groups on, so honouring it is how
   * the two ends stop deriving identity independently.
   */
  documentId?: string
  fileName?: string
  collection?: string
  url?: string
  /** Any human label — a card's law name, a chip label, a citation key. */
  label?: string
}

/**
 * The key a document is unique under, most specific first:
 *
 *  1. the canonical OIB key — collapses corpus filename and human law label,
 *     which is the ONLY way a `legal_basis` card and a KB citation naming the
 *     same Richtlinie can become one document;
 *  2. `(collection, fileName)` — the true primary key, and the only pair that
 *     is actually unique: one search fans out across the base corpus, the
 *     session collection and the project collections at once, so two different
 *     `Plan.pdf`s can arrive together;
 *  3. bare `fileName` — when the collection is unknown (written source entries
 *     and legacy persisted messages carry no collection);
 *  4. normalized URL;
 *  5. the label, as a last resort so a source is never silently dropped.
 */
export const documentIdentity = (input: DocumentIdentityInput): string => {
  // The canonical OIB key still wins over the backend's: it is the only key
  // that can collapse a corpus filename and a `legal_basis` card's human law
  // name onto one document, and the card has no `document_id` to offer.
  const oib = oibDocumentKey(input.fileName || input.label)
  if (oib) return `oib:${oib}`
  const supplied = input.documentId?.trim()
  if (supplied) return supplied
  const fileName = input.fileName?.trim().toLowerCase()
  if (fileName) {
    const collection = input.collection?.trim().toLowerCase()
    return collection ? `doc:${collection}:${fileName}` : `doc:${fileName}`
  }
  const url = input.url?.trim()
  if (url) return `url:${normalizeUrl(url)}`
  const label = (input.label ?? '').trim().toLowerCase().slice(0, 120)
  // Empty rather than `label:` — an observation that names no document, no
  // link and no label identifies NOTHING, and must not be able to occupy a
  // chip or a Herleitung card. See `CitationAccumulator.add`.
  return label ? `label:${label}` : ''
}

/**
 * Whether two identities describe the same document when one of them was
 * derived WITHOUT a collection.
 *
 * A written source entry says `oib-rl_2.pdf, p.3` and nothing more, while the
 * structured wire for the same hit says `(oib_knowledge, oib-rl_2.pdf, p.3)`.
 * Both are the same document, but rule 2 and rule 3 above give them different
 * keys. Rather than weaken the primary key — which exists precisely so two
 * projects' `Plan.pdf` never merge — collection-less keys are matched
 * permissively and collection-bearing keys strictly.
 */
export const identityMatches = (a: string, b: string): boolean => {
  if (a === b) return true
  const bare = (key: string): string | null => {
    const parts = key.split(':')
    return parts[0] === 'doc' && parts.length === 3 ? `doc:${parts[2]}` : null
  }
  return bare(a) === b || bare(b) === a
}

// ---------------------------------------------------------------------------
// Locus identity
// ---------------------------------------------------------------------------

/**
 * The key a locus is unique under inside its document.
 *
 * Page first: two chunks from the same document at different pages are distinct
 * evidence and must both survive (the backend registry keys on page for the
 * same reason). A document-level hit with no page collapses onto one `whole`
 * locus, so a source retrieved five times without page numbers does not render
 * as five identical rows.
 */
export const locusKey = (page: number | undefined, citationKey?: string): string => {
  if (typeof page === 'number' && Number.isFinite(page)) return `p:${page}`
  const key = citationKey?.trim().toLowerCase()
  return key ? `k:${key}` : 'whole'
}

// ---------------------------------------------------------------------------
// Presentation — derived once, here
// ---------------------------------------------------------------------------

const ORIGIN_TOKEN_RE = /^\s*\[(KB|Web|RIS)\]\s*/i

/** Strip a leading `[KB]`/`[RIS]`/`[Web]` token from display text. */
export const stripOriginToken = (text: string): string => text.replace(ORIGIN_TOKEN_RE, '').trim()

export const isHttpUrl = (url: string | undefined | null): boolean =>
  !!url && /^https?:\/\//i.test(url)

export const hostnameOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return null
  }
}

/**
 * Coarse kind for a source, canonical wire value first.
 *
 * `kind` is what the backend classified (ADR-0026) and is always preferred.
 * The fallbacks exist for messages persisted before the wire carried it and
 * for card-derived documents: lane → kind uses the same shared table the
 * backend applies, and the origin/URL heuristics are last.
 */
export const resolveKind = (source: {
  kind?: string | null
  lane?: string | null
  origin?: string | null
  url?: string | null
}): SourceKind => {
  const canonical = asSourceKind(source.kind)
  if (canonical) return canonical
  if (source.lane?.trim()) return kindForLane(source.lane)
  if (source.origin === 'ris') return 'baurecht'
  if (source.origin === 'kb') return 'baurecht'
  if (source.url && /ris\.bka\.gv\.at/i.test(source.url)) return 'baurecht'
  if (isHttpUrl(source.url)) return 'web'
  return 'baurecht'
}

/**
 * The `--source-*` family a document paints with: its coarse kind, refined by
 * the fine lane so an OIB document is the OIB accent rather than generic law.
 */
export const resolveTint = (kind: SourceKind, lane?: string | null): SourceTint =>
  accentForLane(lane, KIND_TO_SIGNAL[kind])

/**
 * The user-facing name of a document.
 *
 * `documentDisplayName` is the single derivation: the backend's stored/derived
 * display title wins, then the deterministic OIB filename mirror, then a
 * humanized filename. Applying it HERE — once, in the model — is what stops a
 * source from rendering as `oib-rl_2.1_ausgabe_mai_2023.pdf` on one surface and
 * "OIB-Richtlinie 2.1, Ausgabe Mai 2023" on another.
 */
export const resolveTitle = (input: {
  title?: string | null
  fileName?: string | null
  url?: string | null
  label?: string | null
}): string => {
  const explicit = input.title?.trim()
  const fileName = input.fileName?.trim()
  if (explicit || fileName) return documentDisplayName(fileName ?? '', explicit)
  if (isHttpUrl(input.url)) {
    const host = hostnameOf(input.url!)
    if (host) return host
  }
  const label = stripOriginToken(input.label ?? '')
  if (label) return documentDisplayName(label)
  return input.url?.trim() ?? ''
}

/**
 * A reference TO a citation: a document, optionally narrowed to one locus.
 *
 * This is the unit every citation-shaped affordance works in — a chip, a
 * bibliography row, a copyable citation, a preview click. Making the locus
 * optional is what lets the same component render "OIB-Richtlinie 2.1" (the
 * document the answer leans on) and "OIB-Richtlinie 2.1, S. 18" (the passage
 * `[3]` points at) without two code paths.
 */
export interface CitationRef {
  document: CitedDocument
  /** Undefined for a document-level reference. */
  locus?: CitationLocus
}

// ---------------------------------------------------------------------------
// Queries — the vocabulary surfaces use instead of re-deriving
// ---------------------------------------------------------------------------

/** The loci the answer actually cited, in citation order. */
export const citedLoci = (doc: CitedDocument): CitationLocus[] =>
  doc.loci
    .filter((locus) => locus.isCited)
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity))

/** True when the answer cited this document anywhere. */
export const isCited = (doc: CitedDocument): boolean => doc.loci.some((locus) => locus.isCited)

/** The `[N]` markers this document carries in the prose, ascending. */
export const citationNumbers = (doc: CitedDocument): number[] =>
  Array.from(
    new Set(
      doc.loci
        .map((locus) => locus.number)
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    )
  ).sort((a, b) => a - b)

/** The pages this document was read at, ascending. Empty for whole-document hits. */
export const citedPages = (doc: CitedDocument): number[] =>
  Array.from(
    new Set(
      doc.loci
        .map((locus) => locus.page)
        .filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
    )
  ).sort((a, b) => a - b)

/** Total evidence count for a document — what "N Treffer" means. */
export const hitCount = (doc: CitedDocument): number => Math.max(doc.loci.length, 1)

/** The `[N]` a reference carries: the locus's, or the document's first. */
export const refNumber = (ref: CitationRef): number | undefined =>
  ref.locus?.number ?? citationNumbers(ref.document)[0]

/**
 * The page a reference names.
 *
 * A document-level reference has one only when the document was read at exactly
 * one page — otherwise naming a single page would be a claim the reference does
 * not make, and "S. 5" on a chip that stands for pages 5, 12 and 18 is exactly
 * the kind of quiet inaccuracy the flat shape used to produce.
 */
export const refPage = (ref: CitationRef): number | undefined => {
  if (ref.locus) return ref.locus.page
  const pages = citedPages(ref.document)
  return pages.length === 1 ? pages[0] : undefined
}

/** Every page a reference covers — for the "S. 5, 12, 18" meta line. */
export const refPages = (ref: CitationRef): number[] =>
  ref.locus?.page != null ? [ref.locus.page] : citedPages(ref.document)

/** Host of a reference's outbound link, when it has one. */
export const refHost = (ref: CitationRef): string | undefined =>
  ref.document.url && isHttpUrl(ref.document.url)
    ? (hostnameOf(ref.document.url) ?? undefined)
    : undefined

/** Stable render key for a reference. */
export const refKey = (ref: CitationRef): string =>
  ref.locus ? `${ref.document.id}#${ref.locus.key}` : ref.document.id

/**
 * Stable presentation order: by provenance family (Baurecht first — it is the
 * strongest claim and the one an architect checks first), then by the lowest
 * `[N]` the document carries, then by title. Documents the prose numbered
 * always precede unnumbered ones within their family.
 */
const KIND_ORDER: Record<SourceKind, number> = { baurecht: 0, buero: 1, projekt: 2, web: 3 }

export const compareDocuments = (a: CitedDocument, b: CitedDocument): number => {
  const numbersA = citationNumbers(a)
  const numbersB = citationNumbers(b)
  const firstA = numbersA[0] ?? Infinity
  const firstB = numbersB[0] ?? Infinity
  if (firstA !== firstB) return firstA - firstB
  const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  if (kind !== 0) return kind
  return a.title.localeCompare(b.title, 'de')
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

/**
 * Builds {@link CitedDocument}s by folding in one observation at a time.
 *
 * Producers (structured wire, written source entries, trace lanes, cards) each
 * contribute what they know; the accumulator merges on identity and keeps the
 * more specific value field by field. Order of contribution does not change the
 * result, which is what lets a late `citation_use` event raise a locus to cited
 * without erasing the richer discovery payload that arrived first.
 */
export class CitationAccumulator {
  private readonly docs = new Map<string, CitedDocument>()
  /**
   * Which documents have been told their shelf EXPLICITLY.
   *
   * `doc.shelf` alone cannot answer that — a shelf a citation key's German
   * qualifier merely implied looks identical once it is stored. Without the
   * distinction the two competed on ARRIVAL ORDER, so a guess that landed first
   * permanently outranked the wire's own statement.
   */
  private readonly explicitShelves = new WeakMap<CitedDocument, Shelf>()

  /**
   * Fold one observation into the model.
   *
   * Returns `null` for an observation that identifies nothing — no filename, no
   * URL, no label. Such a thing cannot be cited, previewed or copied, so
   * rendering it would put a nameless card on the surface whose whole job is to
   * say where an answer came from. Dropping it is the honest outcome.
   */
  add(observation: {
    identity: DocumentIdentityInput
    title?: string | null
    fileName?: string | null
    collection?: string | null
    /**
     * The shelf as DATA — stated by the producer itself (the citation payload's
     * own field). An explicit shelf always wins, whenever it arrives.
     */
    shelf?: Shelf
    /**
     * The shelf as INFERENCE — derived from a legacy citation key's German
     * qualifier, or quoted inside prose the model wrote. It fills a gap only:
     * it can never displace, or be displaced by arriving before, an explicit
     * one.
     */
    shelfFallback?: Shelf
    url?: string | null
    kind?: string | null
    lane?: string | null
    laneLabel?: string | null
    bindingNote?: string | null
    origin?: string | null
    tool?: string | null
    snippet?: string | null
    locus?: {
      page?: number
      number?: number
      isCited?: boolean
      snippet?: string
      citationKey?: string
    }
  }): CitedDocument | null {
    const id = documentIdentity(observation.identity)
    if (!id) return null
    // What this observation will be called — computed up front so `find` can
    // match it against a document identified by nothing but its name.
    const incomingTitle = resolveTitle({
      title: observation.title,
      fileName: observation.fileName,
      url: observation.url,
      label: observation.identity.label,
    })
    const existing = this.find(id, incomingTitle)
    // A document whose identity resolved to the canonical OIB key IS an OIB
    // corpus document — the key is only ever produced for one. Inferring the
    // lane from it is what lets a source known ONLY from the answer's written
    // list ("oib-rl_2.1_….pdf, p.9", no wire, no lane) still render with the
    // OIB accent and the OIB badge, instead of sitting next to an identical
    // structured citation in a different colour with no badge at all.
    const laneFromIdentity = id.startsWith('oib:') ? 'baurecht_oib' : undefined
    const kind = resolveKind({
      kind: observation.kind,
      lane: observation.lane ?? laneFromIdentity,
      origin: observation.origin,
      url: observation.url,
    })
    const lane = observation.lane?.trim() || existing?.lane || laneFromIdentity
    const resolvedKind = existing && !asSourceKind(observation.kind) ? existing.kind : kind

    const doc: CitedDocument = existing ?? {
      id,
      title: '',
      kind: resolvedKind,
      tint: resolveTint(resolvedKind, lane),
      loci: [],
    }

    // Field-wise "the first NON-EMPTY value wins". `||`, never `??`: a trimmed
    // whitespace-only value is `''`, which is not nullish — so `??` would both
    // accept it AND make every later observation carrying a real value lose to
    // it, permanently.
    doc.fileName = doc.fileName || observation.fileName?.trim() || undefined
    doc.collection = doc.collection || observation.collection?.trim() || undefined
    // The shelf is taken, never guessed, and the two ways of taking it are kept
    // APART. An explicit shelf (the payload's own field) always wins, no matter
    // which observation carried it or when it arrived; a shelf inferred from a
    // legacy key's German qualifier only ever fills a gap, first non-empty.
    // Collapsing the two made the winner a function of arrival order, so a guess
    // could outrank the wire. The collection id is still never consulted — that
    // prefix match is what filed a private session attachment under
    // "Projektwissen" and an unknown collection under base law (ADR-0047).
    const explicitShelf = this.explicitShelves.get(doc) ?? observation.shelf
    if (explicitShelf) {
      this.explicitShelves.set(doc, explicitShelf)
      doc.shelf = explicitShelf
    } else {
      doc.shelf = doc.shelf ?? observation.shelfFallback
    }
    doc.url = doc.url ?? (observation.url?.trim() || undefined)
    doc.tool = doc.tool ?? (observation.tool?.trim() || undefined)
    doc.bindingNote = doc.bindingNote ?? (observation.bindingNote?.trim() || undefined)
    doc.snippet = doc.snippet ?? (observation.snippet?.trim() || undefined)
    doc.laneLabel = doc.laneLabel ?? (observation.laneLabel?.trim() || undefined)
    const origin = observation.origin?.trim().toLowerCase()
    if (!doc.origin && (origin === 'kb' || origin === 'ris' || origin === 'web')) {
      doc.origin = origin
    }
    // A canonical kind from the wire always upgrades a heuristic one.
    if (asSourceKind(observation.kind)) doc.kind = asSourceKind(observation.kind)!
    if (lane) doc.lane = lane
    doc.tint = resolveTint(doc.kind, doc.lane)
    doc.authority = authorityTag(doc.lane) ?? doc.authority ?? undefined

    // A later observation may carry the authoritative backend display title the
    // first one lacked, so the title is re-resolved against the MERGED document
    // (which by now may know a filename the incoming observation did not).
    const title =
      resolveTitle({
        title: observation.title,
        fileName: doc.fileName,
        url: doc.url,
        label: observation.identity.label,
      }) || incomingTitle
    if (title && (!doc.title || looksLikeFilename(doc.title))) doc.title = title

    if (observation.locus) this.mergeLocus(doc, observation.locus)

    this.docs.set(doc.id, doc)
    return doc
  }

  /** Merge one locus into a document, keeping the richer of the two. */
  private mergeLocus(
    doc: CitedDocument,
    locus: {
      page?: number
      number?: number
      isCited?: boolean
      snippet?: string
      citationKey?: string
    }
  ): void {
    const page =
      typeof locus.page === 'number' && Number.isFinite(locus.page) ? locus.page : undefined
    const key = locusKey(page, locus.citationKey)
    const existing = doc.loci.find((candidate) => candidate.key === key)
    if (existing) {
      // `isCited` is sticky once true, and a number never un-sets: a sparser
      // later event must be able to RAISE a locus without erasing anything.
      existing.isCited = existing.isCited || !!locus.isCited
      existing.number = existing.number ?? locus.number
      // `||` for the same reason as the document fields above.
      existing.snippet = existing.snippet || locus.snippet?.trim() || undefined
      existing.citationKey = existing.citationKey || locus.citationKey?.trim() || undefined
      return
    }
    doc.loci.push({
      key,
      page,
      number: locus.number,
      isCited: !!locus.isCited,
      snippet: locus.snippet?.trim() || undefined,
      citationKey: locus.citationKey?.trim() || undefined,
    })
  }

  /**
   * Look up a document by identity, honouring the two cases where equal keys
   * are not the only way two observations describe the same document:
   *
   *  - a collection-less key against a collection-bearing one
   *    ({@link identityMatches});
   *  - a LABEL-only key against a document with that name. A source with no
   *    filename and no URL is identified by its name and nothing else, which is
   *    what a `## Trace-Lanes` hit for a RIS norm looks like ("Bauordnung für
   *    Wien"); the answer's citation of the same norm arrives with a real RIS
   *    URL. Same document, two identities — and without this it rendered twice
   *    in the fan-out, once cited and once "gelesen, nicht verwendet".
   */
  private find(id: string, title: string): CitedDocument | undefined {
    const exact = this.docs.get(id)
    if (exact) return exact
    for (const doc of this.docs.values()) {
      if (identityMatches(doc.id, id)) return doc
    }
    // Label matching, both directions: the label-only observation may arrive
    // before or after the one that knows the document's real identity.
    const incomingLabel = labelOf(id)
    const name = title.trim().toLowerCase()
    for (const doc of this.docs.values()) {
      if (incomingLabel && doc.title.trim().toLowerCase() === incomingLabel) return doc
      if (name && labelOf(doc.id) === name) return doc
    }
    return undefined
  }

  /** The accumulated documents, in stable presentation order. */
  build(): CitedDocument[] {
    const docs = Array.from(this.docs.values())
    for (const doc of docs) {
      doc.loci.sort(locusOrder)
      if (!doc.title) doc.title = doc.fileName ?? doc.url ?? doc.id
    }
    return docs.sort(compareDocuments)
  }
}

/** Loci order: cited-and-numbered first (by `[N]`), then by page. */
const locusOrder = (a: CitationLocus, b: CitationLocus): number => {
  const numberDelta = (a.number ?? Infinity) - (b.number ?? Infinity)
  if (numberDelta !== 0) return numberDelta
  return (a.page ?? Infinity) - (b.page ?? Infinity)
}

/** The human label a `label:`-scheme identity carries, or null. */
const labelOf = (id: string): string | null =>
  id.startsWith('label:') ? id.slice('label:'.length) : null

/** A title that is still a raw filename, so a better one may replace it. */
const FILENAME_LIKE_RE = /^\S*\.\w{2,5}$/
const looksLikeFilename = (value: string): boolean => FILENAME_LIKE_RE.test(value.trim())

/** A locus of a `CitationSource`, for producers that need the same rule. */
export const locusOf = (citation: CitationSource): CitationLocus => ({
  key: locusKey(citation.page, citation.citationKey),
  page: typeof citation.page === 'number' ? citation.page : undefined,
  number: citation.number,
  isCited: !!citation.isCited,
  citationKey: citation.citationKey?.trim() || undefined,
})
