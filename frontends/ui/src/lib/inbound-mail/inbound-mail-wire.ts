/**
 * The wire of the E-Mail-Eingang (ADR-0134): what the `inbound-mail*` routes
 * take and answer. Pure zod and view types, shared by the routes, the agent
 * operations (`lib/agent-api/catalog/mail.ts`), the browser client
 * (`adapters/api/inbound-mail-client.ts`) and the UI, so each contract is
 * written once (`wire-modules.spec.ts` keeps it pure).
 *
 * Two rules shape every view here:
 *
 * - **No bytes and no text outside `-text-get`.** A held mail is unconfirmed
 *   third-party text. The list and the detail carry metadata only (the subject
 *   masked, names of parts, flags), so Piloti, which is offered them, never
 *   reads what a stranger wrote before a person filed it (D7, D22, RT-S6).
 *   `inbound-mail-text-get` is the one view with the text, and it is masked.
 * - **Candidates are the viewer's.** A thread, a duplicate or an earlier
 *   Fassung the viewer may not read is never named: it is counted as hidden,
 *   or dropped (D9, RT-S13). The rows store ids only.
 */

import { z } from 'zod'
import { DOCUMENT_TYPE_TAGS, type DocumentTypeTag } from '@/lib/documents/tag-vocabulary'
import type { PreselectionBlock } from '@/lib/mail-thread/mail-threading'
import type { ThreadMatchStrength } from '@/lib/mail-thread/mail-thread-vocabulary'
import type { NotStagedReason } from './inbound-mail-vocabulary'
import type { InboundMailSuggestion } from './suggest'
import {
  INBOUND_MAIL_MESSAGE_TEXTS,
  type InboundMailContentFinding,
  type InboundMailFilingFailure,
  type InboundMailPartKind,
  type InboundMailPartScanStatus,
  type InboundMailPartState,
  type InboundSenderTrust,
  type MailParticipant,
  type MalwareScanStatus,
  type PartRiskFlag,
  type SenderFlag,
  type SenderReason,
  type SenderTrust,
} from './inbound-mail-vocabulary'

const uuid = z.string().uuid()

// ------------------------------------------------------------ limits

/** The most mails one decision request covers (D26). */
export const INBOUND_MAIL_DECISION_MAX_MAILS = 20
/** The most parts of one mail a request names: its text and 100 attachments. */
export const INBOUND_MAIL_DECISION_MAX_PARTS = 101
/** Page size of the list, default and most. */
export const INBOUND_MAIL_LIST_LIMIT = 25
export const INBOUND_MAIL_LIST_MAX_LIMIT = 50
/** The longest name a part is filed under, as `inbound_mail_decisions.file_name` holds it. */
export const INBOUND_MAIL_FILE_NAME_MAX = 255
/** The longest folder path a decision may name, as `inbound_mail_decisions.folder_path` holds it. */
export const INBOUND_MAIL_FOLDER_PATH_MAX = 1000

// ------------------------------------------------------------ refusals

/**
 * Why a request about held mail is refused, as `details.reason` carries it. One
 * code per check of DECISION §4 C2, so the UI and an agent can say exactly what
 * to change. The status is 409 unless the code says otherwise in its comment.
 */
export const INBOUND_MAIL_REFUSALS = [
  /** The mail changed since `ifMatch` was read: someone else decided, or a part was filed. */
  'stale',
  /** A part is not waiting (filed, dismissed, being filed): read the mail again. */
  'part_not_waiting',
  /** A part named is not this mail's, or a kind in the wrong slot (the text in `parts`). */
  'part_unknown',
  /** An attachment's scan is not clean (pending, failed or infected). */
  'scan_not_clean',
  /** The office does not accept this file type (the part's, or the new name's). */
  'type_not_accepted',
  /** The name check stopped the name; file it with `screeningRelease: 'name'` to override. */
  'name_stop',
  /** A `macro`, `type_mismatch` or `unverified_thread` part is filed without its id in `acknowledgeRisk`. */
  'risk_not_acknowledged',
  /** The sender is unconfirmed in a way the person must accept (`acknowledgeSender`). */
  'sender_not_acknowledged',
  /** An acknowledgement in a request about more than one mail: each is a single mail's decision. */
  'acknowledgement_in_bulk',
  /** A Piloti card carries an acknowledgement or a release; only the person gives those. */
  'card_carries_acknowledgement',
  /** A document of this name is already in the project; file it as its next Fassung (`revisionOf`) or rename it. */
  'name_taken',
  /** `revisionOf` or the thread names nothing this person may write into. */
  'target_unknown',
  /** The thread is at its entry or size cap; file the message as a new thread. */
  'thread_full',
  /** The text could not be read, so it cannot be filed (its original still can be downloaded). */
  'unreadable',
  /** `text: 'masked'` on a text the content check found nothing in. */
  'nothing_to_mask',
  /** A dismissed or expired part is past its seven days, or nothing is left to restore. */
  'not_restorable',
  /** The bytes are not there to serve (erased after filing or dismissal). */
  'gone',
  /** The original is not clean: infected, or the scan on this request failed (try again). */
  'original_not_clean',
  /** This deployment receives no mail (no inbound domain is configured), so no address can be made. */
  'mail_not_received_here',
] as const
export type InboundMailRefusal = (typeof INBOUND_MAIL_REFUSALS)[number]

// ------------------------------------------------------------ the address

/**
 * Where a project's address stands. `none`: the project has no address yet
 * (create one); `active`: it receives mail; `unavailable`: this deployment
 * receives no mail at all (no inbound domain configured).
 */
export const INBOUND_MAIL_ADDRESS_STATES = ['active', 'none', 'unavailable'] as const
export type InboundMailAddressState = (typeof INBOUND_MAIL_ADDRESS_STATES)[number]

/** A project's address as `inbound-mail-address-get` answers it. Reading it never mints one. */
export interface InboundMailAddressView {
  state: InboundMailAddressState
  /** `<slug>.<token>@<domain>`, only while `active`. */
  address: string | null
  /** Whether the reader may create, replace or switch off the address (`project:manage`). */
  canManage: boolean
  /** When the project last received a mail, dropped ones included. */
  lastReceivedAt: string | null
  /** Auto-replies, delivery reports and loops dropped in the last 30 days. */
  droppedLast30Days: number
  /**
   * Of the mail the office's own members sent to any project in the last 30
   * days, the share their domain signed (0..1); null when there was none. The
   * address dialog says how often the office's own mail is „Domain bestätigt“
   * (RT-X6), derived from rows, never from a DNS probe.
   */
  ownDomainVerifiedShare: number | null
}

// ------------------------------------------------------------ the list

/** The two lists of the E-Mail-Eingang: what waits for a person, and what was handled. */
export const INBOUND_MAIL_LIST_STATUSES = ['waiting', 'handled'] as const
export type InboundMailListStatus = (typeof INBOUND_MAIL_LIST_STATUSES)[number]

/** What became of a handled mail's parts, as the handled list's facets. */
export const INBOUND_MAIL_OUTCOMES = ['filed', 'dismissed', 'expired'] as const
export type InboundMailOutcome = (typeof INBOUND_MAIL_OUTCOMES)[number]

export const inboundMailListQuerySchema = z
  .object({
    status: z
      .enum(INBOUND_MAIL_LIST_STATUSES)
      .default('waiting')
      .describe('"waiting": a part waits for a person. "handled": none does.'),
    outcome: z
      .enum(INBOUND_MAIL_OUTCOMES)
      .optional()
      .describe('With "handled": mails with a part that ended so.'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(INBOUND_MAIL_LIST_MAX_LIMIT)
      .default(INBOUND_MAIL_LIST_LIMIT)
      .describe(`Default ${INBOUND_MAIL_LIST_LIMIT}, max ${INBOUND_MAIL_LIST_MAX_LIMIT}.`),
    cursor: z.string().min(1).max(200).optional().describe('The previous page’s `nextCursor`.'),
  })
export type InboundMailListQuery = z.infer<typeof inboundMailListQuerySchema>

/** The sender of a mail as a person reads it: a label for the domain, never a claim about the person. */
export interface InboundMailSenderView {
  name: string | null
  address: string
  domain: string | null
  /** The domain whose DKIM signature verified, when one did. */
  signerDomain: string | null
  trust: InboundSenderTrust
  reason: SenderReason
  flags: SenderFlag[]
}

/** A thread the mail may belong to, as this viewer may see it (D9, D11). */
export interface InboundMailThreadCandidateView {
  threadId: string
  /** The thread's document and its name, which the viewer may read. */
  documentId: string
  name: string
  folderPath: string | null
  /** The Fassung the message would become: „wird Fassung N“. */
  nextVersion: number
  strength: ThreadMatchStrength
  /** Offered checked; otherwise offered unchecked for `blocks`, and an append needs the risk acknowledgement. */
  preselected: boolean
  blocks: PreselectionBlock[]
  /** At its entry or size cap: a message can only continue it as a new thread. */
  full: boolean
}

/** One mail in a list. Metadata only (D22): no text, no bytes. */
export interface InboundMailSummaryView {
  id: string
  projectId: string
  status: InboundMailListStatus
  /** Masked by the content check; null once the mail is settled (scrubbed to ids). */
  subject: string | null
  senderName: string | null
  senderDomain: string | null
  senderTrust: InboundSenderTrust | null
  senderFlags: SenderFlag[]
  automatic: boolean
  receivedAt: string
  expiresAt: string
  attachments: number
  waitingParts: number
  outcomes: Record<InboundMailOutcome, number>
  /** Until when a dismissed or expired part can be restored; null when none can. */
  restorableUntil: string | null
  /** The strongest thread candidate the viewer may read, for the row's chip; null when there is none. */
  thread: Pick<InboundMailThreadCandidateView, 'threadId' | 'name' | 'nextVersion' | 'preselected'> | null
  updatedAt: string
}

export interface InboundMailListView {
  items: InboundMailSummaryView[]
  nextCursor: string | null
}

// ------------------------------------------------------------ one mail

/** A document a part matched (identical bytes, or the same name), as this viewer may see it. */
export interface InboundMailDocumentRefView {
  documentId: string
  name: string
  folderPath: string | null
}

/** One part of a held mail: the mail's text, or one attachment. Names and flags, never bytes. */
export interface InboundMailPartView {
  id: string
  kind: InboundMailPartKind
  position: number
  /** The attachment's name while its bytes are there; null for the text and for a nameless file. */
  filename: string | null
  contentType: string
  sizeBytes: number
  state: InboundMailPartState
  /** `not_applicable` for the text: its raw message is scanned whole. */
  scan: InboundMailPartScanStatus
  scannedAt: string | null
  riskFlags: PartRiskFlag[]
  /** The office's terms the name matched (`name_stop`). */
  nameStopTerms: string[]
  /** For the text: the kinds the content check found (D13), never the matches. */
  contentFindings: InboundMailContentFinding[]
  /** Whether the office files this type at all; a part it does not is only in the original. */
  offered: boolean
  lastFailure: InboundMailFilingFailure | null
  /** The filed document, when the viewer may read it. */
  documentId: string | null
  duplicateOf: InboundMailDocumentRefView | null
  /** The document this would become the next Fassung of („wird Fassung N davon“). */
  revisionCandidate: (InboundMailDocumentRefView & { nextVersion: number }) | null
  /** A possible earlier Fassung exists in a folder the viewer does not see („1 mögliche Fassung …“). */
  revisionCandidateHidden: boolean
  /** Piloti's suggestion (D21): folder, Dokumentart and a one-line reason; null while there is none. */
  suggestion: InboundMailSuggestion | null
  /** Until when a dismissed or expired part can be restored. */
  restorableUntil: string | null
}

/** One held mail (`inbound-mail-get`): headers, labels and parts. Its text is `inbound-mail-text-get`'s. */
export interface InboundMailView {
  id: string
  projectId: string
  status: InboundMailListStatus
  /** The project is closed: nothing can be filed until it is reopened; dismissing still works. */
  projectClosed: boolean
  /** The value to send back as `ifMatch` with a decision; it changes whenever the mail or a part does. */
  ifMatch: string
  /** Masked; null once settled. */
  subject: string | null
  /** Null once settled. */
  sender: InboundMailSenderView | null
  /** From, Reply-To, To and Cc; the project addresses are not among them. Empty once settled. */
  participants: MailParticipant[]
  sentAt: string | null
  receivedAt: string
  expiresAt: string
  automatic: boolean
  /** The whole raw message's scan: its original can be downloaded once this is clean. */
  rawScan: MalwareScanStatus
  /** Whether the original `.eml` is still held (until it is filed with the text, or erased). */
  originalHeld: boolean
  /** Files of the mail no part was made of, with why (they are in the original). */
  notStaged: Array<{ filename: string; reason: NotStagedReason }>
  parts: InboundMailPartView[]
  threadCandidates: InboundMailThreadCandidateView[]
  /** Candidates in threads the viewer may not read: counted, never named. */
  hiddenThreadCandidates: number
  /** Whose follow appended this mail's text, when one did (D31). */
  followedBy: string | null
  updatedAt: string
}

/** The text of a held mail, masked for every reader (`inbound-mail-text-get`, D7). */
export interface InboundMailTextView {
  /** The sender's own text, signature removed, every finding of the content check masked. */
  ownText: string
  ownTextTruncated: boolean
  /** Quoted earlier messages, each with the line that introduced it, masked the same way. */
  quoted: Array<{ header: string; text: string }>
  calendar: Array<{
    summary: string | null
    start: string | null
    end: string | null
    allDay: boolean
    location: string | null
    status: string | null
  }>
  /** Whether anything was masked. */
  masked: boolean
  /** The reader could not read the body; the original still holds it. */
  unreadable: boolean
}

// ------------------------------------------------------------ decisions

const partDecisionSchema = z
  .object({
    partId: uuid.describe('From inbound-mail-get `parts`.'),
    folderId: uuid
      .nullable()
      .describe('null: root or `newFolderPath`.'),
    newFolderPath: z
      .string()
      .min(1)
      .max(INBOUND_MAIL_FOLDER_PATH_MAX)
      .nullable()
      .describe('Created if missing, e.g. "Permits/Fire".'),
    name: z
      .string()
      .min(1)
      .max(INBOUND_MAIL_FILE_NAME_MAX)
      .describe('The file name; name-screened.'),
    documentType: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => (DOCUMENT_TYPE_TAGS as readonly string[]).includes(value), 'Not a document type of the vocabulary')
      .optional()
      .describe('A document type tag.'),
    revisionOf: uuid
      .optional()
      .describe('File as the next version of this document.'),
    screeningRelease: z
      .literal('name')
      .optional()
      .describe('The person overrides the name check.'),
  })
  .strict()
  .refine((part) => part.folderId === null || part.newFolderPath === null, {
    message: 'Name either folderId or newFolderPath, not both',
    path: ['newFolderPath'],
  })
export type InboundMailPartDecision = z.infer<typeof partDecisionSchema>

const threadTargetSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('append'),
      mailThreadId: uuid.describe('From `threadCandidates` or mail-thread-list.'),
    })
    .strict(),
  z
    .object({
      action: z.literal('create'),
      folderId: uuid.nullable().describe('null: root or `newFolderPath`.'),
      newFolderPath: z.string().min(1).max(INBOUND_MAIL_FOLDER_PATH_MAX).nullable().describe('Created if missing.'),
      name: z
        .string()
        .min(1)
        .max(INBOUND_MAIL_FILE_NAME_MAX)
        .describe('The thread document’s name; name-screened.'),
      screeningRelease: z.literal('name').optional().describe('The person overrides the name check.'),
    })
    .strict(),
])
export type InboundMailThreadTarget = z.infer<typeof threadTargetSchema>

const messageDecisionSchema = z
  .object({
    partId: uuid.describe('The part of kind "message".'),
    text: z
      .enum(INBOUND_MAIL_MESSAGE_TEXTS)
      .describe('"masked" only with `contentFindings`.'),
    thread: threadTargetSchema,
  })
  .strict()
  .refine((message) => message.thread.action === 'append' || message.thread.folderId === null || message.thread.newFolderPath === null, {
    message: 'Name either folderId or newFolderPath, not both',
    path: ['thread', 'newFolderPath'],
  })
export type InboundMailMessageDecision = z.infer<typeof messageDecisionSchema>

const mailDecisionSchema = z
  .object({
    mailId: uuid,
    ifMatch: z.string().min(1).max(100).describe('From inbound-mail-get.'),
    parts: z
      .array(partDecisionSchema)
      .max(INBOUND_MAIL_DECISION_MAX_PARTS - 1)
      .describe('To file; the others are dismissed.'),
    message: messageDecisionSchema
      .nullable()
      .describe('null dismisses the text.'),
    acknowledgeSender: z
      .literal(true)
      .optional()
      .describe('The person accepts an unconfirmed sender; one mail only.'),
    acknowledgeRisk: z
      .array(uuid)
      .max(INBOUND_MAIL_DECISION_MAX_PARTS)
      .optional()
      .describe('Parts whose risk the person accepts; one mail only.'),
  })
  .strict()
  .refine((mail) => new Set(mail.parts.map((part) => part.partId)).size === mail.parts.length, {
    message: 'A part is named twice',
    path: ['parts'],
  })
  .refine((mail) => !mail.message || !mail.parts.some((part) => part.partId === mail.message?.partId), {
    message: 'The text part is decided in `message`, not in `parts`',
    path: ['message', 'partId'],
  })
export type InboundMailDecision = z.infer<typeof mailDecisionSchema>

/**
 * `inbound-mail-file` (D26): file the named parts of up to 20 mails; every
 * other waiting part of each mail is dismissed. Acknowledgements are a single
 * mail's decision: a bulk request carries none (RT-S5).
 */
export const fileInboundMailsBodySchema = z
  .object({
    mails: z
      .array(mailDecisionSchema)
      .min(1)
      .max(INBOUND_MAIL_DECISION_MAX_MAILS),
  })
  .strict()
  .refine((body) => new Set(body.mails.map((mail) => mail.mailId)).size === body.mails.length, {
    message: 'A mail is named twice',
    path: ['mails'],
  })
export type FileInboundMailsBody = z.infer<typeof fileInboundMailsBodySchema>

/** `inbound-mail-dismiss`: every waiting part of these mails, restorable for seven days. */
export const dismissInboundMailsBodySchema = z
  .object({
    mailIds: z
      .array(uuid)
      .min(1)
      .max(INBOUND_MAIL_DECISION_MAX_MAILS)
      .describe('From inbound-mail-list.'),
  })
  .strict()
  .refine((body) => new Set(body.mailIds).size === body.mailIds.length, { message: 'A mail is named twice', path: ['mailIds'] })
export type DismissInboundMailsBody = z.infer<typeof dismissInboundMailsBodySchema>

/** What a decision request answers (202): each mail as it stands now, its parts claimed for filing. */
export interface InboundMailDecisionResultView {
  mails: InboundMailView[]
  /** The filing job, when anything is filed; follow the mails with inbound-mail-get. */
  filingJobId: string | null
}

/** The type a part is filed as, when the person chose one. */
export type InboundMailDocumentType = DocumentTypeTag

// ------------------------------------------------------------ where a Fassung came from

/**
 * The mail a Fassung of a document came with (D36): `document-get` and
 * `document-version-list` carry these per Fassung, and only where the reader
 * may read the mail thread, so an attachment leads back to the mail that
 * brought it and the thread's section of it. Archive mail says `not_checked`.
 * Declared here for the document routes to attach (`mailOrigins`); filled from
 * `mail_thread_entry_attachments`.
 */
export interface MailOriginView {
  threadId: string
  entryId: string
  sentAt: string
  receivedAt: string
  fromName: string | null
  signerDomain: string | null
  senderTrust: SenderTrust
}
