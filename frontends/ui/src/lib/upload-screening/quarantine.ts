/**
 * Why a document is in quarantine, as data (ADR-0086, ADR-0113).
 *
 * The content gate in the ingest job records its verdict on the file's status
 * as a typed object, `quarantine`: `{"reasons":[…],"checked":"full"|"partial"}`,
 * plus `"omitted":N` when the job left N reasons out
 * (`sources/knowledge_layer/src/llamaindex/screening.py`, `to_model`). Status
 * reconciliation stores it in `documents.quarantine`, and every reader takes it
 * through {@link quarantineVerdictOf}. Detector samples are already masked by
 * the job; nothing here ever sees a full IBAN.
 *
 * The job still writes the same verdict as `error_message` `quarantined:{json}`
 * for one release, and a row from before migration 0148 whose message did not
 * parse holds only that. {@link quarantineVerdictOf} reads the string only when
 * the typed verdict is absent; nothing else in the app parses it, which is why
 * neither the parser nor the prefix is exported.
 *
 * Pure and client-safe: the review list and the upload summary both render it.
 */

import { z } from 'zod'
import type { Translator } from '@/i18n/translate'
import type { NameMatch } from './name-screen'

/** What the legacy `error_message` of a held file starts with; read only by {@link quarantineVerdictOf}. */
const QUARANTINED_PREFIX = 'quarantined:'

/**
 * `details.reason` of the 409 a re-upload onto a quarantined file answers
 * (`assertMayReplaceHeld`, `./quarantine-reviewers`). Here, beside the verdict,
 * because the browser reads it too: the upload row it refuses is not retried,
 * since a retry meets the same 409 until somebody deletes or releases the file.
 */
export const QUARANTINED_REPLACE_REASON = 'quarantined'

/** The error envelope of that 409 (`{ error, code, details: { reason } }`). */
export function isQuarantinedReplaceBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const details = (body as { details?: unknown }).details
  return !!details && typeof details === 'object' && (details as { reason?: unknown }).reason === QUARANTINED_REPLACE_REASON
}

const reasonSchema = z.object({
  /**
   * A kind this build does not know (a detector added to the job first) becomes
   * `other` rather than failing the parse: one new reason must not blank the
   * ones that can be read.
   */
  kind: z.enum(['term', 'iban', 'at_svnr', 'credit_card']).or(z.string().transform((): 'other' => 'other')),
  term: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
  pages: z.array(z.number().int()).optional(),
  /**
   * `pages` is not every page the reason was found on: the job lists up to 50
   * and cuts the widest reasons first to keep the stored verdict whole
   * (`screening.py`, `quarantine_error`). Absent on a verdict that lists all.
   */
  pages_truncated: z.boolean().optional(),
  sample: z.string().optional(),
})

/**
 * The verdict as this build reads it. Exported for the boundaries that parse a
 * job's or a response's `quarantine` field; the contract it holds to is
 * `tests/fixtures/quarantine_verdict_cases.json` (`quarantine-verdict-contract.spec.ts`).
 */
export const verdictSchema = z.object({
  reasons: z.array(reasonSchema),
  checked: z.enum(['full', 'partial']).optional(),
  /** How many reasons the job found and did not list (more than ten, or too long to store whole). */
  omitted: z.number().int().positive().optional(),
  /**
   * The match was in the vision model's transcript of scanned pages: that model
   * saw those pages, no later model call saw anything of the file. Absent: false.
   */
  after_transcription: z.boolean().optional(),
})

/**
 * The verdict as `documents.quarantine` stores it: the same shape with every
 * `kind` kept as the job wrote it, so a later build that knows a new detector
 * reads it by name. Derived from {@link verdictSchema}, never written beside it.
 */
const storedVerdictSchema = verdictSchema.extend({
  reasons: z.array(reasonSchema.extend({ kind: z.string().min(1) })),
})

export type QuarantineReason = z.infer<typeof reasonSchema>
export type QuarantineVerdict = z.infer<typeof verdictSchema>
/** What `documents.quarantine` holds (migration 0148). Read it through {@link quarantineVerdictOf}. */
export type StoredQuarantineVerdict = z.infer<typeof storedVerdictSchema>

/**
 * Where a verdict can come from: a typed `quarantine` (the job's field, the
 * row's column, a response's field) and the legacy message. A row and a job
 * file spell the message differently, so both spellings are taken.
 */
export interface QuarantineSource {
  quarantine?: unknown
  errorMessage?: string | null
  error_message?: string | null
}

/** The legacy message's JSON, or `undefined` for any other message (or one that is not JSON). */
function legacyVerdictJson(errorMessage: string | null | undefined): unknown {
  if (!errorMessage?.startsWith(QUARANTINED_PREFIX)) return undefined
  try {
    return JSON.parse(errorMessage.slice(QUARANTINED_PREFIX.length))
  } catch {
    return undefined
  }
}

/**
 * The raw verdict a source carries: the typed one whenever it is there, the
 * legacy message's only when it is not (a job from before the field, a row the
 * migration could not convert). A typed verdict that does not parse is not
 * replaced by the message: the field is the answer, and a broken one says so.
 */
function rawVerdictOf(source: QuarantineSource): unknown {
  if (source.quarantine !== undefined && source.quarantine !== null) return source.quarantine
  return legacyVerdictJson(source.errorMessage ?? source.error_message)
}

/**
 * Whether a backend file reports that the gate held it: it carries a typed
 * verdict, or (a job from before the field) a `quarantined:` message. A report
 * whose verdict does not parse is still a quarantine; it is shown without
 * reasons rather than as an ordinary failure that would be retried.
 */
export function reportsQuarantine(source: QuarantineSource): boolean {
  if (source.quarantine !== undefined && source.quarantine !== null) return true
  return (source.errorMessage ?? source.error_message)?.startsWith(QUARANTINED_PREFIX) ?? false
}

/** A `quarantine` field as this build reads it, or `null` when it is absent or malformed. */
export function readQuarantineVerdict(value: unknown): QuarantineVerdict | null {
  if (value === undefined || value === null) return null
  const parsed = verdictSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * Why a held document is held, for every reader (ADR-0113): the typed verdict,
 * or, for a legacy row or job, the one its `quarantined:` message carries.
 * `null` when neither says anything readable.
 */
export function quarantineVerdictOf(source: QuarantineSource): QuarantineVerdict | null {
  return readQuarantineVerdict(rawVerdictOf(source))
}

/**
 * The `files` sentence that explains a file held back by the content check,
 * for every surface that says one (`QuarantineFindings`, the composer's chip).
 * It claims no model saw the file only when that is true: a match in a scanned
 * page's transcript was found after the vision model read the page
 * (`after_transcription`). A verdict with nothing to list claims nothing.
 */
export function heldSentenceKey(
  verdict: QuarantineVerdict | null | undefined
): 'ingestFailure.quarantined' | 'ingestFailure.quarantinedAfterTranscription' | 'ingestFailure.quarantinedUnreadable' {
  if (!verdict || (verdict.reasons.length === 0 && !verdict.omitted)) return 'ingestFailure.quarantinedUnreadable'
  return verdict.after_transcription ? 'ingestFailure.quarantinedAfterTranscription' : 'ingestFailure.quarantined'
}

/** The kinds of reason an inbox notice words on its own (`collaboration.inbox.types.*.variants`). */
export type QuarantineNoticeVariant = 'term' | 'iban' | 'at_svnr' | 'credit_card' | 'transcript'

/**
 * Which wording a reviewer's notice about a held file reads: `transcript` when
 * the vision model saw the pages the match was found in (so the notice claims
 * no unread file), else the kind of the first reason. `null` when the verdict
 * says nothing a notice can name, and the notice reads its general sentence.
 */
export function quarantineNoticeVariant(verdict: QuarantineVerdict | null): QuarantineNoticeVariant | null {
  if (!verdict) return null
  if (verdict.after_transcription) return 'transcript'
  const kind = verdict.reasons[0]?.kind
  return kind === undefined || kind === 'other' ? null : kind
}

/**
 * What a reviewer's inbox notice about a held file carries: its name, which
 * the reviewer may open in the queue anyway, and its kind of reason. Never a
 * matched value or a sample.
 *
 * `variant` is always written, `null` when the verdict names no kind: a
 * collapsed row merges payloads key by key (jsonb `||`), so a key left out
 * would keep the previous file's reason under this file's name.
 */
export function quarantineNoticePayload(
  doc: QuarantineSource & { filename: string }
): { subject: string; variant: QuarantineNoticeVariant | null } {
  return { subject: doc.filename, variant: quarantineNoticeVariant(quarantineVerdictOf(doc)) }
}

/**
 * The verdict to store in `documents.quarantine`, from what a job reported:
 * validated, unknown keys dropped, every kind kept. `null` when there is none
 * or it does not parse.
 */
export function storedQuarantineVerdictOf(source: QuarantineSource): StoredQuarantineVerdict | null {
  const raw = rawVerdictOf(source)
  if (raw === undefined || raw === null) return null
  const parsed = storedVerdictSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** How long one audited value may be, inside WorkOS's metadata value limit. */
export const AUDITED_REASONS_MAX_CHARS = 200
/** Ends an audited reason list that was cut to {@link AUDITED_REASONS_MAX_CHARS}. */
export const AUDITED_REASONS_CUT_MARK = ',…'

/**
 * The reasons as the audit trail records them: kinds and terms only
 * (`term:Lohnzettel,iban`), never a detector's masked sample or page text.
 * Takes the stored verdict too, so a kind this build does not know is recorded
 * by its name. Cut at {@link AUDITED_REASONS_MAX_CHARS} characters, and a list
 * that was cut ends in {@link AUDITED_REASONS_CUT_MARK}, so the trail never
 * reads a short list as the whole one.
 */
export function auditedQuarantineReasons(
  verdict: { reasons: ReadonlyArray<{ kind: string; term?: string }> } | null
): string {
  const listed = (verdict?.reasons ?? [])
    .map((reason) => (reason.kind === 'term' ? `term:${reason.term ?? ''}` : reason.kind))
    .join(',')
  if (listed.length <= AUDITED_REASONS_MAX_CHARS) return listed
  return listed.slice(0, AUDITED_REASONS_MAX_CHARS - AUDITED_REASONS_CUT_MARK.length) + AUDITED_REASONS_CUT_MARK
}

/** One reason without its pages, in the reader's language: `„Lohnzettel“ im Text`. */
export function quarantineReasonHead(reason: QuarantineReason, t: Translator): string {
  const head =
    reason.kind === 'term'
      ? t('screening.reasonTerm', { term: reason.term ?? '' })
      : reason.kind === 'iban'
        ? t('screening.reasonIban', { sample: reason.sample ?? '' })
        : reason.kind === 'at_svnr'
          ? t('screening.reasonSvnr', { sample: reason.sample ?? '' })
          : reason.kind === 'credit_card'
            ? t('screening.reasonCard', { sample: reason.sample ?? '' })
            : t('screening.reasonOther')
  return head.trim()
}

/**
 * How the content check came to hold the file for one reason: who set the rule,
 * and for a number what "found" means. A term is the office's own word; a
 * number is held only when its checksum holds, so a reader can tell a real
 * account number from an order number that merely looks like one.
 */
export function explainQuarantineReason(reason: QuarantineReason, t: Translator): string {
  switch (reason.kind) {
    case 'term':
      return t('screening.basisTerm')
    case 'iban':
      return t('screening.basisIban')
    case 'at_svnr':
      return t('screening.basisSvnr')
    case 'credit_card':
      return t('screening.basisCard')
    default:
      return t('screening.basisOther')
  }
}

/** Said after the last listed page of a reason whose list is cut (`pages_truncated`). */
export const MORE_PAGES_MARK = '…'

/**
 * One reason, as a short phrase in the reader's language: `„Lohnzettel“ im Text · Seite 2`,
 * and `· Seiten 1, 2, …` when the job listed only some of its pages.
 */
export function describeQuarantineReason(reason: QuarantineReason, t: Translator): string {
  const head = quarantineReasonHead(reason, t)
  const pages = reason.pages ?? []
  if (pages.length === 0) return `${head} · ${t('screening.reasonNoPages')}`
  const listed = reason.pages_truncated ? [...pages, MORE_PAGES_MARK] : pages
  return `${head} · ${t('screening.reasonPages', { count: pages.length, pages: listed.join(', ') })}`
}

/**
 * Where a finding is, as a citation points into a document: the page, and the
 * words to mark on it.
 *
 * Only a term has words to mark. The office wrote it, so it is in the page's
 * text as written (the viewer's matcher folds case and spacing, and looks a page
 * either side). A detector's finding carries a masked sample, `AT61 •••• 1234`,
 * which is in no page's text: it opens at the page and marks nothing, because
 * the value itself is never stored (ADR-0086).
 */
export interface QuarantineFinding {
  page: number
  highlight: string | null
}

/** Every page a reason was found on, each as a finding to open. */
export function findingsOf(reason: QuarantineReason): QuarantineFinding[] {
  const highlight = reason.kind === 'term' && reason.term ? reason.term : null
  return (reason.pages ?? []).filter((page) => page >= 1).map((page) => ({ page, highlight }))
}

/** The finding a held document opens at: the first page of its first reason that has one. */
export function firstFinding(verdict: QuarantineVerdict | null): QuarantineFinding | null {
  for (const reason of verdict?.reasons ?? []) {
    const [first] = findingsOf(reason)
    if (first) return first
  }
  return null
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
