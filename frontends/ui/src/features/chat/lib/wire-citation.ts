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
    kind: asSourceKind(wire.kind),
    lane: trimmed(wire.lane),
    laneLabel: trimmed(wire.lane_label),
    bindingNote: trimmed(wire.binding_note),
  }
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
