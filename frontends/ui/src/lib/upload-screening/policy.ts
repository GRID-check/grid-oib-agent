/**
 * What an organization counts as too sensitive to upload (ADR-0079).
 *
 * One policy, two gates. The NAME gate runs in the browser before a byte is
 * sent, and again in the BFF on receipt (`./name-screen`). The CONTENT gate
 * runs inside the ingest job, on text extracted locally, before the first model
 * call (`sources/knowledge_layer/src/llamaindex/screening.py`); the BFF hands it
 * the content half of this policy on every dispatch (`toIngestScreening`).
 *
 * The content half also screens CHAT: the composer masks a message against
 * the content terms and detectors before it leaves the browser, the BFF masks
 * every user message it stores, and the chat socket masks what reaches the
 * agent (`./content-screen`, `toChatScreening`). Name terms never apply to chat.
 *
 * Pure and client-safe: the upload dialog imports it.
 */

import { z } from 'zod'

/** Number-shape detectors the content gate can run. Each validates a checksum, not just a shape. */
export const SCREENING_DETECTORS = ['iban', 'at_svnr', 'credit_card'] as const
export type ScreeningDetector = (typeof SCREENING_DETECTORS)[number]

export interface UploadScreeningPolicy {
  /**
   * Off means neither gate runs. Kept as a switch rather than "empty lists",
   * so an office that pauses screening keeps its lists for when it resumes.
   */
  enabled: boolean
  /** Matched against every segment of the file's path, as a substring, so compounds match. */
  nameTerms: string[]
  /**
   * Words that CONTAIN a name term without being what it means: `Berechnung`
   * contains `rechnung`. An occurrence of a term that lies inside an
   * occurrence of an exception is ignored.
   */
  nameExceptions: string[]
  /** Matched in the extracted text at a word start, so `Honorar` finds `Honorarnote`. */
  contentTerms: string[]
  detectors: ScreeningDetector[]
}

/**
 * Where a new office starts. Piloti proposes it; the office adopts, edits or
 * empties it. Short on purpose: every entry here is something an office would
 * otherwise have to discover by a false negative.
 *
 * Name terms are broad (a whole folder called „Rechnungen" is the case the
 * ticket names). Content terms are narrow phrases, because a building
 * description that mentions „Honorar" once is not a fee agreement.
 */
export const SUGGESTED_SCREENING_POLICY: UploadScreeningPolicy = {
  enabled: true,
  nameTerms: [
    'Rechnung',
    'Honorar',
    'Lohn',
    'Gehalt',
    'Personal',
    'Vertrag',
    'Bewerbung',
    'Krankenstand',
    'Kontoauszug',
    'Buchhaltung',
    'Steuer',
  ],
  nameExceptions: ['Berechnung', 'Bauvertrag'],
  contentTerms: [
    'Gehaltsabrechnung',
    'Lohnzettel',
    'Lohnabrechnung',
    'Honorarvereinbarung',
    'Honorarnote',
    'Dienstvertrag',
    'Arbeitsvertrag',
    'Sozialversicherungsnummer',
    'Krankenstandsbestätigung',
    'Kontoauszug',
  ],
  detectors: ['iban', 'at_svnr', 'credit_card'],
}

const MAX_TERMS = 200
const MAX_TERM_LENGTH = 80

const termList = z
  .array(z.string())
  .max(MAX_TERMS)
  .transform((terms) => normalizeTermList(terms))
  .refine((terms) => terms.every((term) => term.length <= MAX_TERM_LENGTH), {
    message: `A term is at most ${MAX_TERM_LENGTH} characters`,
  })

/** What the admin may save. Unknown keys are refused, not dropped. */
export const uploadScreeningPolicySchema = z
  .object({
    enabled: z.boolean(),
    nameTerms: termList,
    nameExceptions: termList,
    contentTerms: termList,
    detectors: z.array(z.enum(SCREENING_DETECTORS)).max(SCREENING_DETECTORS.length),
  })
  .strict()

/** Trim, drop empties and one-letter terms, and de-duplicate case-insensitively, keeping the first spelling. */
export function normalizeTermList(terms: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of terms) {
    const term = raw.normalize('NFC').trim().replace(/\s+/g, ' ')
    if (term.length < 2) continue
    const key = term.toLocaleLowerCase('de')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
  }
  return out
}

/**
 * The stored value, read. An office that never saved a policy gets the
 * suggested one, so screening is on from the first upload (the same default
 * direction as zero data retention, ADR-0074). A stored value that does not
 * parse is NOT treated as "off": it falls back to the suggestion too, because a
 * privacy control fails closed.
 */
export function resolveUploadScreeningPolicy(stored: unknown): UploadScreeningPolicy {
  if (stored === undefined || stored === null) return SUGGESTED_SCREENING_POLICY
  const parsed = uploadScreeningPolicySchema.safeParse(stored)
  return parsed.success ? parsed.data : SUGGESTED_SCREENING_POLICY
}

/** The `screening` field of `/v1/ingest`, exactly as the Python `ScreeningPolicy` model reads it. */
export interface IngestScreening {
  content_terms: string[]
  detectors: ScreeningDetector[]
}

/**
 * The content half of the policy, for one dispatch, or `null` when the job is
 * not to be screened: the office switched screening off, has no content rules,
 * or a reviewer released this document from quarantine.
 */
export function toIngestScreening(
  policy: UploadScreeningPolicy,
  options: { released: boolean }
): IngestScreening | null {
  if (!policy.enabled || options.released) return null
  if (policy.contentTerms.length === 0 && policy.detectors.length === 0) return null
  return { content_terms: [...policy.contentTerms], detectors: [...policy.detectors] }
}

/**
 * `GET /api/internal/chat-screening`, exactly as `aiq_api.internal_api.chat_screening_from`
 * reads it: the switch, and the content half of the policy. The chat socket
 * masks a message's text with it; `enabled: false` masks nothing.
 */
export interface ChatScreening {
  enabled: boolean
  content_terms: string[]
  detectors: ScreeningDetector[]
}

export function toChatScreening(policy: UploadScreeningPolicy): ChatScreening {
  return { enabled: policy.enabled, content_terms: [...policy.contentTerms], detectors: [...policy.detectors] }
}
