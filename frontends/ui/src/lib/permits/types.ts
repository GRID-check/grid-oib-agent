/**
 * The write contract of permitting memory (docs/design/permitting-memory.md,
 * „Write"): what the ingest pipeline sends after a model has read a Bescheid.
 * The one description, in zod, shared by the route and the specs. Every string
 * is bounded: the model's output is untrusted input.
 *
 * No `server-only` and no drizzle runtime: the tuples are plain data.
 */

import { z } from 'zod'
import { isoDay } from '@/lib/cross-project/types'
import { PERMIT_RECORD_KINDS, PERMIT_REQUIREMENT_KINDS, PERMIT_REQUIREMENT_MAX_CHARS } from '@/lib/db/schema/permit-records'

/** How many requirements one document's record holds at most. */
export const PERMIT_MAX_REQUIREMENTS = 60

const text = (max: number) => z.string().trim().min(1).max(max)

export const permitRequirementSchema = z.object({
  kind: z.enum(PERMIT_REQUIREMENT_KINDS),
  content: text(PERMIT_REQUIREMENT_MAX_CHARS),
  evidence: text(PERMIT_REQUIREMENT_MAX_CHARS).nullable(),
  legalBasis: text(300).nullable(),
  page: z.number().int().min(1).max(100_000).nullable(),
})

export const permitRecordSchema = z.object({
  kind: z.enum(PERMIT_RECORD_KINDS),
  authority: text(300),
  municipality: text(200).nullable(),
  bundesland: text(50).nullable(),
  issuedOn: isoDay.nullable(),
  reference: text(200).nullable(),
  requirements: z.array(permitRequirementSchema).max(PERMIT_MAX_REQUIREMENTS),
})

export const storePermitRecordRequestSchema = z.object({
  organizationId: z.string().min(1).max(200),
  /** Absent: the document is found by `collection` and `fileName` (the backfill knows no id). */
  documentId: z.string().uuid().optional(),
  collection: z.string().min(1).max(300),
  fileName: text(512),
  /** The model that extracted it. */
  model: text(200),
  /** Null: the document is no longer a Bescheid, or nothing was extracted. Its record goes. */
  record: permitRecordSchema.nullable(),
})

export type PermitRecordBody = z.infer<typeof permitRecordSchema>
export type StorePermitRecordRequest = z.infer<typeof storePermitRecordRequestSchema>

export interface StorePermitRecordResponse {
  /** A record is stored for the document. False: the document is unknown, or the record was deleted. */
  stored: boolean
  /** How many requirements the stored record holds. */
  requirements: number
}
