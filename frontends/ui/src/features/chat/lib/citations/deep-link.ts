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
 *     ?cite=ZG9jJTNBb2liX2tub3dsZWRnZSUzQW9pYi1ybF8yLjEucGRmLHAlM0ExOA
 *           └─ base64url of `<document>,<locus>` ─────────────────────┘
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

/**
 * The link value is base64url, so a URL parser cannot reach inside it.
 *
 * Percent-encoding the two halves is what keeps the split unambiguous, but it
 * only holds while nothing decodes the value again on the way in — and reading
 * a query parameter does exactly that. `searchParams.get('cite')` turns the
 * `%2C` of a document named `Plan,Rev.pdf` back into a comma, and the parser
 * then splits at a separator that was never one. Wrapping the whole thing in an
 * alphabet of `A-Za-z0-9-_` leaves nothing for a decoder to change, so the
 * value survives being pasted, re-encoded, or read straight off a URL.
 */
const toBase64Url = (text: string): string => {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string): string | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
  } catch {
    return null
  }
}

/** A citation reference as it travels in a URL. */
export interface CitationLink {
  documentId: string
  /** Absent for a link to the document as a whole. */
  locusKey?: string
}

/**
 * The `?cite=` value for a reference.
 *
 * Both halves are percent-encoded independently — a document id contains `:`
 * and a filename, either of which can legitimately contain the separator — and
 * the pair is then wrapped in base64url so no decoder downstream can reach the
 * separator again.
 */
export const encodeCitationLink = (ref: CitationRef): string => {
  const document = encodeURIComponent(ref.document.id)
  const locus = ref.locus ? `${SEPARATOR}${encodeURIComponent(ref.locus.key)}` : ''
  return toBase64Url(`${document}${locus}`)
}

/** Parse a `?cite=` value. Returns null for anything unusable. */
export const parseCitationLink = (value: string | null | undefined): CitationLink | null => {
  const raw = fromBase64Url((value ?? '').trim())
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
