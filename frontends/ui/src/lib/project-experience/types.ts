/**
 * The wire contract of the closing extraction (docs/design/closed-project-experience.md,
 * „Wire contract"): what the BFF sends the backend's extractor and what it reads
 * back. Camel case on the wire. Every string is bounded: the model's output is
 * untrusted input, and a response outside these bounds is treated as invalid.
 *
 * No `server-only` and no drizzle runtime: the schemas are plain data.
 */

import { z } from 'zod'

const text = (max: number) => z.string().trim().min(1).max(max)

/** At most this many decisions one extraction returns. */
export const EXPERIENCE_MAX_DECISIONS = 12
/** A decision's content, German, naming what was asked, what was done and why. */
export const EXPERIENCE_DECISION_MAX_CHARS = 600
/** How many known decisions the request carries, and how many characters of each. */
export const EXPERIENCE_KNOWN_DECISIONS_MAX = 60
export const EXPERIENCE_KNOWN_DECISION_MAX_CHARS = 300
/** A quote is verbatim from the document, so bounded to a sentence or two. */
export const EXPERIENCE_QUOTE_MAX_CHARS = 300

export const EXPERIENCE_ERRORS = ['no_documents', 'no_model', 'extraction_failed'] as const
export const EXPERIENCE_DECISION_KINDS = ['decision', 'constraint'] as const
export const EXPERIENCE_OUTCOMES = ['accepted', 'auflage', 'rejected', 'unknown'] as const

/** One answer the intake wizard accepts for a key: the stored token and the label a reader sees. */
export const experienceVocabularyEntrySchema = z.object({
  multiple: z.boolean(),
  options: z.array(z.object({ token: text(100), label: text(200) })),
})

export const experienceVocabularySchema = z.object({
  bundesland: experienceVocabularyEntrySchema,
  gebaeudeklasse: experienceVocabularyEntrySchema,
  bauweise: experienceVocabularyEntrySchema,
  nutzungen: experienceVocabularyEntrySchema,
  vorhabensart: experienceVocabularyEntrySchema,
  oib_ausgabe: experienceVocabularyEntrySchema,
})

export const experienceRequestSchema = z.object({
  organizationId: text(200),
  projectId: z.string().uuid(),
  /** The project's main collection: the one the backend reads (a restricted folder has its own). */
  collection: text(300),
  /**
   * The only files of `collection` the backend may read (`extractableFileNames`):
   * open to every member now, past the upload screen, active. What it reads becomes
   * an unrestricted fingerprint and decisions, so the BFF decides, not the backend.
   */
  fileNames: z.array(text(512)).min(1),
  vocabulary: experienceVocabularySchema,
  /** Keys a person already confirmed: the pen is not asked for them. */
  knownFacts: z.array(text(100)),
  /** The project's active decisions and constraints, so the pen drafts only new ones. */
  knownDecisions: z.array(text(EXPERIENCE_KNOWN_DECISION_MAX_CHARS)).max(EXPERIENCE_KNOWN_DECISIONS_MAX),
})

export const experienceEvidenceSchema = z.object({
  fileName: text(512),
  /** The page the quote is on, as the document shows it. */
  page: z.string().trim().max(20),
  quote: text(EXPERIENCE_QUOTE_MAX_CHARS),
})

export const experienceFingerprintSchema = z.object({
  key: text(50),
  /** A token, or a list of tokens when the key is `multiple`. */
  value: z.union([text(100), z.array(text(100)).min(1)]),
  evidence: z.array(experienceEvidenceSchema),
})

export const experienceDecisionSchema = z.object({
  kind: z.enum(EXPERIENCE_DECISION_KINDS),
  content: text(EXPERIENCE_DECISION_MAX_CHARS),
  outcome: z.enum(EXPERIENCE_OUTCOMES),
  evidence: z.array(experienceEvidenceSchema),
})

export const experienceResponseSchema = z.object({
  model: z.string().max(200),
  documentsRead: z.array(text(512)),
  fingerprint: z.array(experienceFingerprintSchema),
  decisions: z.array(experienceDecisionSchema).max(EXPERIENCE_MAX_DECISIONS),
  error: z.enum(EXPERIENCE_ERRORS).nullable(),
})

export type ExperienceVocabulary = z.infer<typeof experienceVocabularySchema>
export type ExperienceVocabularyEntry = z.infer<typeof experienceVocabularyEntrySchema>
export type ExperienceVocabularyKey = keyof ExperienceVocabulary
export type ExperienceRequest = z.infer<typeof experienceRequestSchema>
export type ExperienceEvidence = z.infer<typeof experienceEvidenceSchema>
export type ExperienceFingerprintItem = z.infer<typeof experienceFingerprintSchema>
export type ExperienceDecision = z.infer<typeof experienceDecisionSchema>
export type ExperienceResponse = z.infer<typeof experienceResponseSchema>

/** What the BFF reports back to the close dialog. `backend_unavailable` is the BFF's own: the backend did not answer a valid response. */
export type ProjectExperienceError = (typeof EXPERIENCE_ERRORS)[number] | 'backend_unavailable'

export interface ProjectExperienceResult {
  /** Fingerprint values written as profile assumptions. */
  suggested: number
  /** Decision rows written to project memory. */
  drafted: number
  documentsRead: string[]
  error: ProjectExperienceError | null
}
