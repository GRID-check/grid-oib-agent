/**
 * Norm-registry schemas (ADR-0016 companion) — the curated catalog of
 * Austrian building-law pointers the agent cites.
 *
 * Hand-written to MIRROR the FIXED backend contract:
 *   GET  /v1/admin/norms         → { version, registry: NormsFile }
 *   PUT  /v1/admin/norms         ← { version, registry: NormsFile }
 *   POST /v1/admin/norms/verify  ← VerifyNormRequest → VerifyNormResponse
 *
 * `version` (outer) is the optimistic-concurrency counter; `registry.version`
 * is the on-disk file-format version (currently the literal 1). The two are
 * unrelated numbers and must not be conflated.
 */

import { z } from 'zod'

/**
 * Legal rank of a pointer. The first three are RIS-backed law ranks (federal
 * act, state act, ordinance); the last two are NON-RIS ranks — authority
 * information (e.g. MA-37 Merkblätter) and external norms (ÖNORM/TRVB) that may
 * have no accessible full text.
 */
export const NORM_RANKS = [
  'bundesgesetz',
  'landesgesetz',
  'verordnung',
  'behoerdliche_info',
  'norm_extern',
] as const
export const normRankSchema = z.enum(NORM_RANKS)
export type NormRank = (typeof NORM_RANKS)[number]

/** The RIS-backed law ranks — application + document_number are required for these. */
export const LAW_RANKS = ['bundesgesetz', 'landesgesetz', 'verordnung'] as const
export type LawRank = (typeof LAW_RANKS)[number]

/** True when the rank is one of the three RIS-backed law ranks. */
export function isLawRank(rank: NormRank): rank is LawRank {
  return (LAW_RANKS as readonly string[]).includes(rank)
}

/**
 * Verification seed carried on an entry: the RIS query the admin curated, plus
 * optional disambiguators. `application`/`bundesland` are NOT stored here — the
 * verify call derives them from the entry itself.
 */
export const normVerifySeedSchema = z.object({
  title_query: z.string().default(''),
  expect: z.string().optional(),
  exclude: z.array(z.string()).default([]),
  gesetzesnummer: z.string().optional(),
})
export type NormVerifySeed = z.infer<typeof normVerifySeedSchema>

/** One curated law pointer. Optional fields default so a minimal entry parses. */
export const normEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  short: z.string().min(1),
  rank: normRankSchema,
  /** Canonical Bundesland name ('Wien'), or '' for federal law. */
  bundesland: z.string().default(''),
  topics: z.array(z.string()).default([]),
  relevance: z.string().default(''),
  /**
   * RIS consolidation application, e.g. 'LrKons' / 'BrKons'. Optional in the
   * schema but REQUIRED by the backend (400) for the three law ranks.
   */
  application: z.string().default(''),
  document_number: z.string().default(''),
  /** Plain web link for non-RIS sources (e.g. MA-37 Merkblätter). */
  source_url: z.string().default(''),
  citation_url: z.string().default(''),
  full_law_url: z.string().default(''),
  aliases: z.array(z.string()).default([]),
  /** Legal hint shown to the agent as part of the prompt. */
  binding_note: z.string().optional(),
  /** Internal review task — never surfaced in the prompt. */
  review_note: z.string().optional(),
  verify: normVerifySeedSchema.optional(),
  verified_at: z.string().default(''),
})
export type NormEntry = z.infer<typeof normEntrySchema>

/** The persisted registry file. `version` is the file-format literal. */
export const normsFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(normEntrySchema),
})
export type NormsFile = z.infer<typeof normsFileSchema>

/** GET response and PUT request share the { version, registry } envelope. */
export const normRegistryEnvelopeSchema = z.object({
  version: z.number(),
  registry: normsFileSchema,
})
export type NormRegistryEnvelope = z.infer<typeof normRegistryEnvelopeSchema>

export const putNormRegistryBodySchema = normRegistryEnvelopeSchema
export type PutNormRegistryBody = z.infer<typeof putNormRegistryBodySchema>

/** Verify request — application is required; the rest disambiguate the query. */
export const verifyNormRequestSchema = z.object({
  title_query: z.string().min(1),
  application: z.string().min(1),
  bundesland: z.string().optional(),
  expect: z.string().optional(),
  exclude: z.array(z.string()).optional(),
  gesetzesnummer: z.string().optional(),
})
export type VerifyNormRequest = z.infer<typeof verifyNormRequestSchema>

export const verifyCandidateSchema = z.object({
  title: z.string(),
  document_number: z.string(),
  citation_url: z.string(),
  full_law_url: z.string(),
})
export type VerifyCandidate = z.infer<typeof verifyCandidateSchema>

export const verifyNormResponseSchema = z.object({
  candidates: z.array(verifyCandidateSchema),
  verified_at: z.string(),
})
export type VerifyNormResponse = z.infer<typeof verifyNormResponseSchema>
