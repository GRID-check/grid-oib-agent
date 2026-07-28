/**
 * Map structured backend source payloads (WS `sources` / SSE citation_source)
 * onto the FE CitationSource shape.
 */

import type { CitationSource, WireCitationSource } from '../types'
import { asSourceKind } from './source-kinds'

const trimmed = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

export const normalizeOrigin = (value: unknown): CitationSource['origin'] | undefined => {
  if (typeof value !== 'string') return undefined
  const lower = value.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (lower === 'kb' || lower === 'ris' || lower === 'web') return lower
  return undefined
}

/** Build a stable-ish client id when the server does not send one. */
const wireIdentity = (wire: WireCitationSource): string => {
  if (wire.citation_key?.trim()) return `key:${wire.citation_key.trim().toLowerCase()}`
  if (wire.url?.trim()) return `url:${wire.url.trim().toLowerCase()}`
  if (wire.file_name?.trim()) {
    return `file:${wire.file_name.trim().toLowerCase()}:${wire.page ?? ''}`
  }
  return `content:${(wire.content || wire.title || '').trim().toLowerCase().slice(0, 120)}`
}

export const citationFromWire = (
  wire: WireCitationSource,
  options?: { isCited?: boolean; id?: string; timestamp?: Date }
): CitationSource => {
  const origin = normalizeOrigin(wire.origin)
  const url = typeof wire.url === 'string' && wire.url.trim() ? wire.url.trim() : undefined
  const content =
    (typeof wire.content === 'string' && wire.content.trim() && wire.content) ||
    (wire.citation_key && wire.citation_key.trim()) ||
    (wire.title && wire.title.trim()) ||
    url ||
    ''

  return {
    id: options?.id ?? wireIdentity(wire),
    url,
    content,
    timestamp: options?.timestamp ?? new Date(),
    isCited: options?.isCited,
    origin,
    title: wire.title?.trim() || undefined,
    citationKey: wire.citation_key?.trim() || undefined,
    collection: wire.collection?.trim() || undefined,
    sourceType: wire.source_type?.trim() || undefined,
    tool: wire.tool?.trim() || undefined,
    fileName: wire.file_name?.trim() || undefined,
    page: typeof wire.page === 'number' && Number.isFinite(wire.page) ? wire.page : undefined,
    number:
      typeof wire.number === 'number' && Number.isInteger(wire.number) && wire.number > 0
        ? wire.number
        : undefined,
    kind: asSourceKind(wire.kind),
    lane: trimmed(wire.lane),
    laneLabel: trimmed(wire.lane_label),
    bindingNote: trimmed(wire.binding_note),
  }
}

/**
 * Identity of an already-normalized citation, for deduplication across the two
 * events that can describe the SAME source (`citation_source` on discovery,
 * `citation_use` when the report cites it).
 *
 * Document key first, then URL, then file+page — the same precedence
 * `wireIdentity` uses, but tolerant of the small URL spelling differences
 * between the discovery payload (the tool's URL) and the citation payload (the
 * URL as extracted from the report text).
 */
const citationIdentity = (citation: CitationSource): string => {
  const key = citation.citationKey?.trim().toLowerCase()
  if (key) return `key:${key}`
  const url = citation.url?.trim().toLowerCase().replace(/\/+$/, '')
  if (url) return `url:${url}`
  const file = citation.fileName?.trim().toLowerCase()
  if (file) return `file:${file}:${citation.page ?? ''}`
  return `content:${(citation.content || '').trim().toLowerCase().slice(0, 120)}`
}

/** Whether two normalized citations describe the same source. */
export const sameCitation = (a: CitationSource, b: CitationSource): boolean =>
  citationIdentity(a) === citationIdentity(b)

/**
 * Fold a later payload for the same source into the one already held.
 *
 * Field-wise "prefer the value that exists", so the sparser `citation_use`
 * event can raise `isCited` without erasing the richer discovery payload —
 * and `isCited` is sticky once true.
 */
export const mergeCitation = (
  existing: CitationSource,
  incoming: CitationSource
): CitationSource => ({
  ...existing,
  ...Object.fromEntries(
    Object.entries(incoming).filter(([, value]) => value !== undefined && value !== '')
  ),
  // Identity and first-seen time belong to the entry already in the list.
  id: existing.id,
  timestamp: existing.timestamp,
  isCited: incoming.isCited || existing.isCited,
})

/**
 * Collapse a buffered replay of citation events into the citation list.
 *
 * The SSE replay delivers `citation_source` and `citation_use` for the same
 * source as separate events, exactly as the live stream does; buffering them
 * and mapping 1:1 produced duplicate rows where the live path produced one
 * merged row. Folding them here keeps a replayed run identical to a live one.
 */
export const dedupeBufferedCitations = (
  buffered: ReadonlyArray<{ wire: WireCitationSource; isCited?: boolean }>,
  timestamp: Date
): CitationSource[] => {
  const out: CitationSource[] = []
  for (const { wire, isCited } of buffered) {
    const incoming = citationFromWire(wire, { isCited, timestamp })
    const existing = out.findIndex((candidate) => sameCitation(candidate, incoming))
    if (existing >= 0) out[existing] = mergeCitation(out[existing], incoming)
    else out.push(incoming)
  }
  return out
}

export const citationsFromWireList = (
  sources: unknown[] | undefined | null
): CitationSource[] | undefined => {
  if (!Array.isArray(sources) || sources.length === 0) return undefined
  const out: CitationSource[] = []
  for (const item of sources) {
    if (!item || typeof item !== 'object') continue
    out.push(citationFromWire(item as WireCitationSource))
  }
  return out.length > 0 ? out : undefined
}
