/**
 * Piloti's suggestion for a held mail (ADR-0134, DECISION D21): where each
 * attachment belongs and as which Dokumentart, and, for a mail that matched no
 * E-Mail-Verlauf, the folder its text would start one in. The rules, pure; the
 * job that asks the model and stores the answer is `./suggest-job`.
 *
 * ## What the model reads
 *
 * Metadata a person already sees, and nothing else:
 *
 * - the names of the attachments that passed the name check (a part the
 *   Namensprüfung stopped, a type the office does not accept, an infected file
 *   is not placed, and its name is not sent);
 * - the subject, masked by the office's content check the way every reader sees
 *   it;
 * - the sender's domain;
 * - the folders every member of the project reads (a folder under its own
 *   access list is never named, ADR-0087), and the office's conventions.
 *
 * Never the text and never the bytes: {@link mailFilingInput} has no way to
 * take them, `/v1/filing-fit` refuses a mail request that carries anything read
 * from content, and `suggest.spec.ts` builds the input from a mail whose text
 * is known and asserts none of it is in the request. The privacy text names
 * exactly these inputs (RT-S6).
 *
 * ## Who is asked about
 *
 * A mail whose sender's domain was confirmed, and that is no list or bulk
 * mail: an unconfirmed sender's mail and automatic mail get no model call
 * ({@link suggestionSkipReason}). A suggestion never files anything; a person
 * files, and may take it with one tap („Wie vorgeschlagen ablegen“).
 *
 * ## Whether it was followed
 *
 * When the person decides, each suggested part is scored (`piloti-decision`,
 * subject `inbound_mail_suggestion`) and the mail's decision says how much of
 * the suggestion was taken (PostHog `suggestion_followed`). Both read
 * {@link suggestionOutcome}.
 *
 * No `server-only`: the wire types the stored suggestion with
 * {@link InboundMailSuggestion}, and the specs read the rules without a database.
 */

import { z } from 'zod'
import type { InboundMailPartRow, InboundMailRow } from '@/lib/db/schema'
import { DOCUMENT_TYPE_TAGS, type DocumentTypeTag } from '@/lib/documents/tag-vocabulary'
import type {
  FilingConventionInput,
  FilingFolderInput,
  MailFilingInput,
  MailPlacement,
} from '@/lib/filing/types'
import { MAX_JUDGED_DOCUMENTS } from '@/lib/filing/types'
import { folderPathKey } from '@/lib/projects/folders'
import type { InboundMailDecision } from './inbound-mail-wire'

// ---------------------------------------------------------------------------
// The stored suggestion
// ---------------------------------------------------------------------------

/**
 * One part's suggestion as `inbound_mail_parts.suggestion` holds it and the
 * mail views answer it. A folder is named by id when the project has it, and
 * by path always, so a renamed folder still reads; `newFolder` is a convention
 * the project does not have yet, which filing there creates.
 */
export const inboundMailSuggestionSchema = z
  .object({
    folderId: z.string().uuid().nullable(),
    folderPath: z.string().min(1).max(1000),
    newFolder: z.boolean(),
    /** The Dokumentart for an attachment; null when the model named none, and always for the text. */
    documentType: z.enum(DOCUMENT_TYPE_TAGS).nullable(),
    /** One line a person reads, in German. */
    reason: z.string().min(1).max(300),
  })
  .strict()
export type InboundMailSuggestion = z.infer<typeof inboundMailSuggestionSchema>

/** A stored suggestion, or null when there is none or it is not the shape this code writes. */
export function readSuggestion(stored: unknown): InboundMailSuggestion | null {
  if (stored === null || stored === undefined) return null
  const parsed = inboundMailSuggestionSchema.safeParse(stored)
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// What is asked about
// ---------------------------------------------------------------------------

/** Why a mail gets no suggestion; null when it is asked about. */
export type SuggestionSkipReason =
  | 'not_waiting'
  | 'external_unverified'
  | 'automatic'
  | 'project_closed'
  | 'switched_off'
  | 'budget'
  | 'nothing_to_place'

/** The reasons that need no lookup: the mail's own state and labels. */
export function suggestionSkipReason(
  mail: Pick<InboundMailRow, 'status' | 'senderTrust' | 'automatic'>,
): SuggestionSkipReason | null {
  if (mail.status !== 'waiting' || !mail.senderTrust) return 'not_waiting'
  if (mail.senderTrust === 'external_unverified') return 'external_unverified'
  if (mail.automatic) return 'automatic'
  return null
}

type PartFacts = Pick<
  InboundMailPartRow,
  'id' | 'kind' | 'position' | 'state' | 'filename' | 'storageKey' | 'scanStatus' | 'riskFlags' | 'nameStopTerms'
>

/**
 * The attachments a suggestion places, in position order, at most
 * {@link MAX_JUDGED_DOCUMENTS}: waiting, with bytes and a name, a type the
 * office files, a name the Namensprüfung did not stop, not infected.
 */
export function attachmentsToPlace<T extends PartFacts>(parts: readonly T[]): Array<T & { filename: string }> {
  return parts
    .filter(
      (part): part is T & { filename: string } =>
        part.kind === 'attachment' &&
        part.state === 'waiting' &&
        part.storageKey !== null &&
        part.filename !== null &&
        part.filename.trim().length > 0 &&
        part.scanStatus !== 'infected' &&
        part.nameStopTerms.length === 0 &&
        !part.riskFlags.includes('name_stop') &&
        !part.riskFlags.includes('type_not_accepted'),
    )
    .sort((a, b) => a.position - b.position)
    .slice(0, MAX_JUDGED_DOCUMENTS)
}

/**
 * The text part whose folder is suggested: only when the mail matched no
 * Verlauf, since a match is its own suggestion (the thread candidate), and only
 * while it waits.
 */
export function textToPlace<T extends PartFacts>(
  mail: Pick<InboundMailRow, 'threadMatch'>,
  parts: readonly T[],
): T | null {
  if (mail.threadMatch.length > 0) return null
  return parts.find((part) => part.kind === 'message' && part.state === 'waiting') ?? null
}

/** Whether the mail has a part to place at all, before anything is loaded or spent. */
export function hasSomethingToPlace(mail: Pick<InboundMailRow, 'threadMatch'>, parts: readonly PartFacts[]): boolean {
  return attachmentsToPlace(parts).length > 0 || textToPlace(mail, parts) !== null
}

/** What the suggest job loaded, beyond the mail and its parts. */
export interface SuggestionContext {
  /** The subject as every reader sees it: masked by the office's content check. */
  maskedSubject: string | null
  folders: FilingFolderInput[]
  conventions: FilingConventionInput[]
  locale: string
}

/**
 * The judgement's input for one mail, or null when there is nothing to place.
 * Built from the row's labels and the parts' names only; it takes no text, so
 * none can reach the model.
 */
export function mailFilingInput(
  mail: Pick<InboundMailRow, 'id' | 'projectId' | 'threadMatch' | 'senderAddress' | 'signerDomain'>,
  parts: readonly PartFacts[],
  context: SuggestionContext,
): MailFilingInput | null {
  if (!hasSomethingToPlace(mail, parts)) return null
  const attachments = attachmentsToPlace(parts).map((part) => ({ id: part.id, file: part.filename }))
  const text = textToPlace(mail, parts)
  return {
    locale: context.locale,
    folders: context.folders,
    conventions: context.conventions,
    attachments,
    mail: { subject: context.maskedSubject, senderDomain: senderDomainOf(mail), textId: text?.id ?? null },
    trace: { mailId: mail.id, projectId: mail.projectId },
  }
}

/** The sender's domain: the From address's, else the domain whose signature verified. Lower-case. */
export function senderDomainOf(mail: Pick<InboundMailRow, 'senderAddress' | 'signerDomain'>): string | null {
  const at = mail.senderAddress?.lastIndexOf('@') ?? -1
  const domain = at >= 0 ? mail.senderAddress?.slice(at + 1) : mail.signerDomain
  return domain?.trim().toLowerCase() || null
}

/**
 * The placements as stored suggestions, keyed by part id. A folder the
 * project has is named by its id too; a convention is a new folder.
 */
export function suggestionsFrom(
  placements: readonly MailPlacement[],
  folders: ReadonlyArray<{ id: string; path: string }>,
): Map<string, InboundMailSuggestion> {
  const byKey = new Map(folders.map((folder) => [folderPathKey(folder.path), folder]))
  const stored = new Map<string, InboundMailSuggestion>()
  for (const placement of placements) {
    const folder = placement.newFolder ? undefined : byKey.get(folderPathKey(placement.folder))
    if (!placement.newFolder && !folder) continue
    stored.set(placement.partId, {
      folderId: folder?.id ?? null,
      folderPath: folder?.path ?? placement.folder,
      newFolder: placement.newFolder !== null,
      documentType: placement.documentType,
      reason: placement.reason,
    })
  }
  return stored
}

// ---------------------------------------------------------------------------
// Whether a decision followed it
// ---------------------------------------------------------------------------

/** Where a person put one part: a folder path (`''` the root) and a type, or appended to a Verlauf. */
export interface DecidedPlacement {
  /** The folder path the part was filed into; null when the text was appended to an existing Verlauf. */
  folderPath: string | null
  documentType: DocumentTypeTag | string | null
}

/**
 * Where a person's decision puts each part of one mail, by part id. A part not
 * in the map is dismissed. `folderPathOf` resolves a folder id the decision
 * named (null when unknown). The text started as a new Verlauf lands in a
 * folder as correspondence; appended, it lands in no folder of its own.
 */
export function decidedPlacements(
  decision: Pick<InboundMailDecision, 'parts' | 'message'> | null,
  folderPathOf: (folderId: string) => string | null,
): Map<string, DecidedPlacement> {
  const placed = new Map<string, DecidedPlacement>()
  if (!decision) return placed
  const pathOf = (folderId: string | null, newFolderPath: string | null): string =>
    newFolderPath ?? (folderId ? (folderPathOf(folderId) ?? '') : '')
  for (const part of decision.parts) {
    placed.set(part.partId, { folderPath: pathOf(part.folderId, part.newFolderPath), documentType: part.documentType ?? null })
  }
  const message = decision.message
  if (message) {
    placed.set(message.partId, {
      folderPath: message.thread.action === 'create' ? pathOf(message.thread.folderId, message.thread.newFolderPath) : null,
      documentType: 'correspondence',
    })
  }
  return placed
}

/** What a person did with one suggested part, as the score and the event read it. */
export interface SuggestionOutcome {
  /** `accepted` when filed in the suggested folder with the suggested Dokumentart (or none was suggested). */
  decision: 'accepted' | 'dismissed'
  folder: 'same' | 'other' | 'not_filed'
  type: 'same' | 'other' | 'none'
}

/** Compare a suggestion with where the person filed the part (null: not filed). Pure. */
export function suggestionOutcome(suggestion: InboundMailSuggestion, placed: DecidedPlacement | null): SuggestionOutcome {
  if (!placed) return { decision: 'dismissed', folder: 'not_filed', type: suggestion.documentType ? 'other' : 'none' }
  const folder =
    placed.folderPath !== null && folderPathKey(placed.folderPath) === folderPathKey(suggestion.folderPath) ? 'same' : 'other'
  const type = !suggestion.documentType ? 'none' : placed.documentType === suggestion.documentType ? 'same' : 'other'
  return { decision: folder === 'same' && type !== 'other' ? 'accepted' : 'dismissed', folder, type }
}

/** How much of a mail's suggestion its decision took, for PostHog's `suggestion_followed`. */
export type SuggestionFollowed = 'all' | 'partly' | 'none' | 'no_suggestion'

export function suggestionFollowed(outcomes: readonly SuggestionOutcome[]): SuggestionFollowed {
  if (outcomes.length === 0) return 'no_suggestion'
  const accepted = outcomes.filter((outcome) => outcome.decision === 'accepted').length
  if (accepted === outcomes.length) return 'all'
  return accepted === 0 ? 'none' : 'partly'
}

/** One suggested part of a decided mail, with its outcome and the trace it was made on. */
export interface DecidedSuggestion {
  partId: string
  traceId: string | null
  outcome: SuggestionOutcome
}

/**
 * The outcome of every suggested part of one mail under a decision (null: the
 * whole mail dismissed). Parts that were not waiting are not decided by it and
 * are left out, as are parts without a readable suggestion.
 */
export function decidedSuggestions(
  parts: ReadonlyArray<Pick<InboundMailPartRow, 'id' | 'state' | 'suggestion' | 'suggestionTraceId'>>,
  decision: Pick<InboundMailDecision, 'parts' | 'message'> | null,
  folderPathOf: (folderId: string) => string | null,
): DecidedSuggestion[] {
  const placed = decidedPlacements(decision, folderPathOf)
  return parts.flatMap((part) => {
    const suggestion = part.state === 'waiting' ? readSuggestion(part.suggestion) : null
    if (!suggestion) return []
    return [{ partId: part.id, traceId: part.suggestionTraceId, outcome: suggestionOutcome(suggestion, placed.get(part.id) ?? null) }]
  })
}
