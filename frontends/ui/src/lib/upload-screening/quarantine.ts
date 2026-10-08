/**
 * Why a document is in quarantine, read back from its stored error (ADR-0085).
 *
 * The content gate in the ingest job ends a matching file with
 * `quarantined:{"reasons":[…],"checked":"full"|"partial"}`
 * (`sources/knowledge_layer/src/llamaindex/screening.py`, `quarantine_error`),
 * and status reconciliation stores that string on the row. Detector samples are
 * already masked by the job; nothing here ever sees a full IBAN.
 *
 * Pure and client-safe: the review list and the upload summary both render it.
 */

import { z } from 'zod'
import type { Translator } from '@/i18n/translate'
import type { NameMatch } from './name-screen'

export const QUARANTINED_PREFIX = 'quarantined:'

const reasonSchema = z.object({
  kind: z.enum(['term', 'iban', 'at_svnr', 'credit_card']),
  term: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
  pages: z.array(z.number().int()).optional(),
  sample: z.string().optional(),
})

const verdictSchema = z.object({
  reasons: z.array(reasonSchema),
  checked: z.enum(['full', 'partial']).optional(),
})

export type QuarantineReason = z.infer<typeof reasonSchema>
export type QuarantineVerdict = z.infer<typeof verdictSchema>

/** The verdict stored on a quarantined row, or `null` for any other message (or a malformed one). */
export function parseQuarantine(errorMessage: string | null | undefined): QuarantineVerdict | null {
  if (!errorMessage?.startsWith(QUARANTINED_PREFIX)) return null
  try {
    const parsed = verdictSchema.safeParse(JSON.parse(errorMessage.slice(QUARANTINED_PREFIX.length)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** One reason, as a short phrase in the reader's language: `„Lohnzettel“ im Text · Seite 2`. */
export function describeQuarantineReason(reason: QuarantineReason, t: Translator): string {
  const head =
    reason.kind === 'term'
      ? t('screening.reasonTerm', { term: reason.term ?? '' })
      : reason.kind === 'iban'
        ? t('screening.reasonIban', { sample: reason.sample ?? '' })
        : reason.kind === 'at_svnr'
          ? t('screening.reasonSvnr', { sample: reason.sample ?? '' })
          : t('screening.reasonCard', { sample: reason.sample ?? '' })
  const pages = reason.pages ?? []
  if (pages.length === 0) return head.trim()
  return `${head.trim()} · ${t('screening.reasonPages', { count: pages.length, pages: pages.join(', ') })}`
}

/** A name-gate match, as a short phrase: `Ordner „Personalunterlagen“ enthält „Personal“`. */
export function describeNameMatch(match: NameMatch, t: Translator): string {
  return match.kind === 'file'
    ? t('screening.nameInFile', { term: match.term })
    : t('screening.nameInFolder', { term: match.term, segment: match.segment })
}

/**
 * What a browser upload held back by the name gate, as one sentence naming the
 * first three files and why (`files.errors.screenedOut`). `t` is the `files`
 * translator. Null when nothing was held back.
 */
export function describeScreenedOut(
  screenedOut: ReadonlyArray<{ file: { name: string }; matches: readonly NameMatch[] }>,
  t: Translator
): string | null {
  if (screenedOut.length === 0) return null
  return t('errors.screenedOut', {
    count: String(screenedOut.length),
    files: screenedOut
      .slice(0, 3)
      .map(({ file, matches }) =>
        t('errors.screenedOutFile', {
          name: file.name,
          reason: matches.map((match) => describeNameMatch(match, t)).join(', '),
        })
      )
      .join(', '),
  })
}
