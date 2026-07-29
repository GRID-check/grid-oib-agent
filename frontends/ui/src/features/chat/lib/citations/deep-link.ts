/**
 * A citation you can send someone.
 *
 * "See OIB-Richtlinie 2.1, S. 18" is the sentence an architect writes to a
 * colleague, and until now the only way to act on it was: open the app, find
 * the conversation, find the answer, find the chip, click, scroll. The evidence
 * was reachable but not *addressable*.
 *
 * A citation is addressable because the model gave it a stable identity: the
 * document key the backend already groups on, plus the locus key within it. So
 * the link is not a new concept — it is the existing identity, in a URL.
 *
 *     ?cite=doc%3Aoib_knowledge%3Aoib-rl_2.1.pdf,p%3A18
 *            └─ document ─────────────────────┘ └locus┘
 *
 * The locus half is optional: a link to a document alone is a legitimate thing
 * to send ("this Richtlinie backs the answer"), and one to a specific page is a
 * stronger claim ("this passage does").
 */

import type { CitationRef, CitedDocument } from './model'

/** Query parameter carrying a citation reference. */
export const CITATION_PARAM = 'cite'

/**
 * Separates the document half of the reference from the locus half.
 *
 * A comma, specifically: `encodeURIComponent` escapes it (`%2C`) but leaves
 * `~`, `-`, `_`, `.`, `!`, `*`, `'`, `(` and `)` untouched. A separator drawn
 * from that untouched set would survive encoding inside a filename and split
 * the link in the wrong place — `Plan~Rev~2.pdf` really does happen.
 */
const SEPARATOR = ','

/** A citation reference as it travels in a URL. */
export interface CitationLink {
  documentId: string
  /** Absent for a link to the document as a whole. */
  locusKey?: string
}

/**
 * The `?cite=` value for a reference.
 *
 * Both halves are percent-encoded independently: a document id contains `:`
 * and a filename, either of which can legitimately contain the separator.
 */
export const encodeCitationLink = (ref: CitationRef): string => {
  const document = encodeURIComponent(ref.document.id)
  if (!ref.locus) return document
  return `${document}${SEPARATOR}${encodeURIComponent(ref.locus.key)}`
}

/** Parse a `?cite=` value. Returns null for anything unusable. */
export const parseCitationLink = (value: string | null | undefined): CitationLink | null => {
  const raw = (value ?? '').trim()
  if (!raw) return null
  // Split once: the locus key may itself contain the separator only in escaped
  // form, but splitting on the first occurrence is the unambiguous reading.
  const separatorAt = raw.indexOf(SEPARATOR)
  const documentPart = separatorAt === -1 ? raw : raw.slice(0, separatorAt)
  const locusPart = separatorAt === -1 ? undefined : raw.slice(separatorAt + 1)
  const decode = (part: string | undefined): string | undefined => {
    if (!part) return undefined
    try {
      return decodeURIComponent(part) || undefined
    } catch {
      // A malformed escape sequence is a link someone mangled in transit, not
      // something to throw over — the page should still render.
      return undefined
    }
  }
  const documentId = decode(documentPart)
  if (!documentId) return null
  return { documentId, locusKey: decode(locusPart) }
}

/**
 * Resolve a parsed link against the documents actually on screen.
 *
 * Returns the reference to open, or null when this turn does not hold the
 * linked document — which is the normal case for every message except the one
 * the link points into, so callers treat null as "not mine" rather than as an
 * error.
 */
export const resolveCitationLink = (
  link: CitationLink | null,
  documents: CitedDocument[]
): CitationRef | null => {
  if (!link) return null
  const document = documents.find((candidate) => candidate.id === link.documentId)
  if (!document) return null
  if (!link.locusKey) return { document }
  const locus = document.loci.find((candidate) => candidate.key === link.locusKey)
  // A locus the document no longer has (re-retrieved at different pages since
  // the link was shared) still opens the right DOCUMENT rather than nothing.
  return locus ? { document, locus } : { document }
}

/**
 * The absolute URL for a reference, given the page it is being shared from.
 *
 * `origin` and `pathname` are passed in rather than read from `window` so this
 * stays pure and testable; the caller supplies the real location.
 */
export const citationShareUrl = (
  ref: CitationRef,
  location: { origin: string; pathname: string; search?: string }
): string => {
  const params = new URLSearchParams(location.search ?? '')
  params.set(CITATION_PARAM, encodeCitationLink(ref))
  return `${location.origin}${location.pathname}?${params.toString()}`
}
