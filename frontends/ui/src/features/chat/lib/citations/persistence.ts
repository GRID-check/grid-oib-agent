/**
 * Citations that survive the message.
 *
 * An answer's grounding is not decoration — it is the claim the answer makes
 * about itself, and it has to outlive the browser tab that produced it. Before
 * this module the server-persisted message carried no citations at all: a chat
 * reloaded from the database (quota cleanup, a new device, cleared site data)
 * came back with the answer intact and its entire provenance row gone. The
 * answer still asserted "OIB-Richtlinie 2.1, S. 18" in its prose; nothing could
 * show the reader where that came from.
 *
 * ## What is persisted, and why that level
 *
 * The WIRE sources — one entry per (document, page) — not the derived
 * {@link CitedDocument} model. The model is a pure function of the wire
 * (`buildCitationModel`), so persisting it would freeze today's derivation into
 * every stored message: improve the grouping, the titles or the tinting, and
 * old messages would keep rendering the old answer forever. Storing the
 * evidence and deriving on read means a fix reaches history too.
 *
 * ## Versioning
 *
 * The payload carries an explicit `v`. A decoder that has to guess a shape from
 * its contents is a decoder that silently mis-reads the first row someone
 * writes differently, and citations are the last place in this product where a
 * silent mis-read is acceptable. Unknown or malformed input decodes to nothing
 * rather than to a half-populated citation — an answer with no provenance row
 * is visibly ungrounded, which is honest; an answer with a corrupted one is a
 * false claim.
 */

import { z } from 'zod'
import type { CitationSource, WireCitationSource } from '../../types'
import { citationFromWire } from '../wire-citation'

/** Current payload version. Bump only for a shape change a decoder must branch on. */
export const CITATIONS_PAYLOAD_VERSION = 1

/**
 * One persisted source, in wire spelling.
 *
 * Deliberately the same field names the backend sends: the stored blob IS the
 * wire, so there is no third naming convention to keep in step, and a message
 * read back from the database goes through exactly the normalizer a live
 * stream does.
 */
const wireSourceSchema = z
  .object({
    content: z.string().optional(),
    url: z.string().nullish(),
    title: z.string().nullish(),
    citation_key: z.string().nullish(),
    document_id: z.string().nullish(),
    collection: z.string().nullish(),
    source_type: z.string().nullish(),
    tool: z.string().nullish(),
    origin: z.string().nullish(),
    number: z.number().int().positive().nullish(),
    file_name: z.string().nullish(),
    page: z.number().int().positive().nullish(),
    kind: z.string().nullish(),
    lane: z.string().nullish(),
    lane_label: z.string().nullish(),
    binding_note: z.string().nullish(),
    /** Whether the answer cited this source, as opposed to merely retrieving it. */
    is_cited: z.boolean().nullish(),
  })
  .passthrough()

const payloadSchema = z.object({
  v: z.literal(CITATIONS_PAYLOAD_VERSION),
  sources: z.array(wireSourceSchema),
})

export type PersistedCitations = z.infer<typeof payloadSchema>

/** Longest `content` kept per source — chips need the locator, not the passage. */
const MAX_CONTENT = 400

/**
 * Encode a turn's citations for storage.
 *
 * Returns `undefined` for an empty list so a message with no provenance stores
 * no key at all, rather than an empty array that reads as "we checked and there
 * were none" on a surface that cannot tell the two apart.
 */
export const encodeCitations = (
  citations: CitationSource[] | undefined
): PersistedCitations | undefined => {
  if (!citations?.length) return undefined
  return {
    v: CITATIONS_PAYLOAD_VERSION,
    sources: citations.map((citation) => ({
      content: citation.content.slice(0, MAX_CONTENT),
      url: citation.url,
      title: citation.title,
      citation_key: citation.citationKey,
      document_id: citation.documentId,
      collection: citation.collection,
      source_type: citation.sourceType,
      tool: citation.tool,
      origin: citation.origin,
      number: citation.number,
      file_name: citation.fileName,
      page: citation.page,
      kind: citation.kind,
      lane: citation.lane,
      lane_label: citation.laneLabel,
      binding_note: citation.bindingNote,
      is_cited: citation.isCited,
    })),
  }
}

/**
 * Decode a stored payload back into citations.
 *
 * Accepts the versioned envelope and, as back-compat, a bare array of wire
 * sources — the shape localStorage held before the envelope existed. Anything
 * else yields `undefined`.
 *
 * `timestamp` is passed in rather than read from the clock so the decode stays
 * pure; the caller supplies the message's own time, which is the only honest
 * value for a citation restored from history.
 */
export const decodeCitations = (
  value: unknown,
  timestamp: Date
): CitationSource[] | undefined => {
  const sources = readSources(value)
  if (!sources?.length) return undefined

  const citations = sources.map((wire, index) =>
    citationFromWire(wire as WireCitationSource, {
      // `is_cited` is not part of the live wire (the live stream carries it as a
      // separate event), so it is read here rather than in the normalizer.
      isCited: typeof wire.is_cited === 'boolean' ? wire.is_cited : undefined,
      // Stable across reloads: a restored citation must keep its identity, or
      // React would remount every chip on each history load.
      id: `stored-${index}`,
      timestamp,
    })
  )
  return citations.length > 0 ? citations : undefined
}

/** The source array inside either supported shape, or null. */
const readSources = (value: unknown): Array<z.infer<typeof wireSourceSchema>> | null => {
  const versioned = payloadSchema.safeParse(value)
  if (versioned.success) return versioned.data.sources

  // Pre-envelope localStorage wrote the client-shaped array directly. Parse it
  // leniently and map the few fields whose names differ, so provenance already
  // on disk is not lost the day the envelope ships.
  const legacy = z.array(z.record(z.unknown())).safeParse(value)
  if (!legacy.success) return null
  const mapped = legacy.data.map((row) => ({
    ...row,
    citation_key: pickString(row.citation_key ?? row.citationKey),
    document_id: pickString(row.document_id ?? row.documentId),
    file_name: pickString(row.file_name ?? row.fileName),
    lane_label: pickString(row.lane_label ?? row.laneLabel),
    binding_note: pickString(row.binding_note ?? row.bindingNote),
    source_type: pickString(row.source_type ?? row.sourceType),
    is_cited: typeof row.isCited === 'boolean' ? row.isCited : undefined,
    content: pickString(row.content) ?? '',
  }))
  // The rename map above only normalizes the fields whose NAMES differ; the
  // rest are spread through untouched and could still be any JSON type. This is
  // untrusted storage — a hand-edited localStorage entry or a row written by an
  // older build — and `citationFromWire` calls `.trim()` on them, so an
  // unvalidated number where a title belongs takes down the whole history
  // restore. Validate the mapped shape before anything downstream trusts it.
  const validated = z.array(wireSourceSchema).safeParse(mapped)
  return validated.success ? validated.data : null
}

const pickString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined
