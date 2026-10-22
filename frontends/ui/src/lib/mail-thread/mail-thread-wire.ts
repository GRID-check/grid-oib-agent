/**
 * The wire of the E-Mail-Verlauf (ADR-0134): what the `mail-thread-*` routes
 * take and answer, and the shapes of the JSON a filed message carries on its
 * `mail_thread_entries` row. Pure zod, shared by the routes, the agent
 * operations (`lib/agent-api/catalog/mail.ts`), the filing job, the archive
 * import and the „E-Mails“ tab, so each contract is written once.
 *
 * The entry's JSON columns are parsed through these schemas wherever they are
 * read, because the renderer (`./render.ts`) writes what they hold into a
 * document Piloti reads: a row that does not parse is a bug to surface, not
 * text to print.
 */

import { z } from 'zod'
import { SCREENING_DETECTORS } from '@/lib/upload-screening/policy'
import type { SenderTrust } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import type { MailOriginView } from '@/lib/inbound-mail/inbound-mail-wire'
import {
  THREAD_MATCH_HEADERS,
  THREAD_MATCH_STRENGTHS,
  type MailThreadAttachmentDisposition,
  type MailThreadAttachmentNotFiledReason,
  type MailThreadCalendarEvent,
  type MailThreadEntrySource,
  type MailThreadFiledVia,
  type MailThreadMaskedSpan,
  type MailThreadParticipant,
  type MailThreadQuote,
  type ThreadMatch,
} from './mail-thread-vocabulary'

const uuid = z.string().uuid()
const isoDateTime = z.string().datetime({ offset: true })

// The tuples, bounds and JSON shapes the `mail_thread*` tables CHECK and type
// are the vocabulary's (migration 0186); the schemas below parse that JSON.
export {
  MAIL_THREAD_ATTACHMENT_DISPOSITIONS,
  MAIL_THREAD_ATTACHMENT_NOT_FILED_REASONS,
  MAIL_THREAD_ENTRY_SOURCES,
  MAIL_THREAD_FILED_VIA,
  MAIL_THREAD_FOLLOW_END_REASONS,
  MAIL_THREAD_FOLLOW_DEFAULT_DAYS,
  MAIL_THREAD_FOLLOW_MAX_DAYS,
  MAIL_THREAD_MAX_ENTRIES,
  MAIL_THREAD_MAX_RENDERED_BYTES,
  type MailThreadAttachmentDisposition,
  type MailThreadAttachmentNotFiledReason,
  type MailThreadCalendarEvent,
  type MailThreadEntrySource,
  type MailThreadFiledVia,
  type MailThreadFollowEndReason,
  type MailThreadMaskedSpan,
  type MailThreadParticipant,
  type MailThreadQuote,
  type MailThreadSectionAttachment,
} from './mail-thread-vocabulary'
import { MAIL_THREAD_FOLLOW_DEFAULT_DAYS, MAIL_THREAD_FOLLOW_MAX_DAYS } from './mail-thread-vocabulary'

export const MAIL_THREAD_LIST_LIMIT = 50

// ------------------------------------------------------------ entry columns

/**
 * One address of a filed message (`participants`). The renderer prints the name
 * and the domain, never the address. The project addresses are not
 * participants: the receive job takes them out (B8) before anything is stored.
 */
export const mailThreadParticipantSchema = z.object({
  role: z.enum(['from', 'reply_to', 'to', 'cc']),
  name: z.string().max(300).nullable(),
  address: z.string().min(1).max(320),
})
mailThreadParticipantSchema satisfies z.ZodType<MailThreadParticipant>

/**
 * A span of the own text masked when the person chose „Unkenntlich ablegen“
 * (D13): offsets into `own_text` in UTF-16 code units, as `findSpans` gives
 * them, and the kind whose placeholder replaces it.
 */
export const mailThreadMaskedSpanSchema = z
  .object({
    kind: z.enum([...SCREENING_DETECTORS, 'term']),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((span) => span.end > span.start, { message: 'A masked span ends after it starts' })
mailThreadMaskedSpanSchema satisfies z.ZodType<MailThreadMaskedSpan>

/** One quoted block the reader split off the own text (`quoted`), in the order it appeared. */
export const mailThreadQuoteSchema = z.object({ text: z.string().max(524_288) })
mailThreadQuoteSchema satisfies z.ZodType<MailThreadQuote>

/** One calendar invitation the message carried (`calendar`), as the Python reader gives it, in UTC. */
export const mailThreadCalendarEventSchema = z.object({
  method: z.string().max(40).nullable(),
  summary: z.string().max(500).nullable(),
  start: isoDateTime.nullable(),
  end: isoDateTime.nullable(),
  allDay: z.boolean(),
  location: z.string().max(500).nullable(),
  status: z.string().max(40).nullable(),
})
mailThreadCalendarEventSchema satisfies z.ZodType<MailThreadCalendarEvent>

/** One thread a held mail matched (`inbound_mails.thread_match`): ids and strengths, never names (D9). */
export const threadMatchSchema = z.object({
  threadId: uuid,
  strength: z.enum(THREAD_MATCH_STRENGTHS),
  headers: z.array(z.enum(THREAD_MATCH_HEADERS)).max(THREAD_MATCH_HEADERS.length),
})
threadMatchSchema satisfies z.ZodType<ThreadMatch>
export const threadMatchListSchema = z.array(threadMatchSchema).max(50)

// ------------------------------------------------------------ requests

export const mailThreadListQuerySchema = z.object({
  documentId: uuid.optional().describe('Finds this document’s thread.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAIL_THREAD_LIST_LIMIT)
    .default(MAIL_THREAD_LIST_LIMIT)
    .describe(`Default and max ${MAIL_THREAD_LIST_LIMIT}.`),
  cursor: z.string().min(1).max(200).optional().describe('The previous `nextCursor`.'),
})
export type MailThreadListQuery = z.infer<typeof mailThreadListQuerySchema>

export const mailThreadFollowBodySchema = z
  .object({
    days: z
      .number()
      .int()
      .min(1)
      .max(MAIL_THREAD_FOLLOW_MAX_DAYS)
      .optional()
      .describe(
        `How long the follow holds, in days (default ${MAIL_THREAD_FOLLOW_DEFAULT_DAYS}). Calling again renews it. ` +
          'While it holds, a later reply from a verified domain already in the thread has its text appended as you; ' +
          'attachments always wait for review.'
      ),
  })
  .strict()
export type MailThreadFollowBody = z.infer<typeof mailThreadFollowBodySchema>

export const mailThreadUnfollowQuerySchema = z.object({
  userId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Whose follow to end; your own when omitted. Ending someone else's needs project:manage."),
})
export type MailThreadUnfollowQuery = z.infer<typeof mailThreadUnfollowQuerySchema>

const detachTargetSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('append'), mailThreadId: uuid.describe('From mail-thread-list.') }).strict(),
  z
    .object({
      action: z.literal('create'),
      folderId: uuid.optional(),
      newFolderPath: z.string().min(1).max(1000).optional(),
      name: z.string().min(1).max(240),
      screeningRelease: z.literal('name').optional(),
    })
    .strict(),
])

/**
 * Why a write on a thread was refused (`details.reason` of a 409): the message
 * is the thread's only one (`last_entry`: delete the document instead),
 * another filing is writing the thread now (`busy`: try again), the target is
 * nothing you may write (`target_unknown`) or full (`thread_full`), the new
 * thread's name was stopped (`name_stop`) or taken (`name_taken`), the upload
 * path refused a Fassung (`upload_refused`, its rule in `details.failure`), or
 * an original is not there or not clean (`gone`, `original_not_clean`).
 */
export const MAIL_THREAD_REFUSALS = [
  'last_entry',
  'busy',
  'target_unknown',
  'thread_full',
  'name_stop',
  'name_taken',
  'upload_refused',
  'gone',
  'original_not_clean',
] as const
export type MailThreadRefusal = (typeof MAIL_THREAD_REFUSALS)[number]

/**
 * Where a detached message goes (D34): an existing thread (`append`) or a new
 * one in a folder, under a path to create, or at the root (`create`). The
 * thread it leaves gets a new Fassung without it; earlier Fassungen keep it.
 */
export const mailThreadEntryDetachBodySchema = z
  .object({ target: detachTargetSchema })
  .strict()
export type MailThreadEntryDetachBody = z.infer<typeof mailThreadEntryDetachBodySchema>

// ------------------------------------------------------------ views

/** A follow as the thread view shows it. */
export interface MailThreadFollowView {
  id: string
  userId: string
  createdAt: string
  expiresAt: string
  renewedAt: string | null
  dailyCap: number
}

/**
 * One attachment of an entry, as the viewer may see it (D36). Every attachment
 * of the message is listed, by its position in the mail; a document in a
 * folder the viewer may not read is listed without its name and ids
 * (`visible: false`), so the section's count stays true and nothing restricted
 * is named. `documentVersionId` is the Fassung the mail brought.
 */
export interface MailThreadAttachmentView {
  position: number
  /** The name as it arrived; null when hidden from this viewer or the file came without one. */
  filename: string | null
  disposition: MailThreadAttachmentDisposition
  notFiledReason?: MailThreadAttachmentNotFiledReason
  documentId?: string
  documentVersionId?: string
  visible: boolean
}

/** One filed message. */
export interface MailThreadEntryView {
  id: string
  /** The section heading, as the thread document cites it; never changes. */
  heading: string
  source: MailThreadEntrySource
  senderName: string | null
  senderDomain: string | null
  signerDomain: string | null
  senderTrust: SenderTrust
  sentAt: string
  receivedAt: string
  /** The Fassung the message first appeared in. */
  firstVersion: { id: string; number: number } | null
  /** Whether a kept original exists (inbound entries), and whether it may be downloaded now. */
  original: { scanStatus: 'pending' | 'clean' | 'infected' | 'failed' } | null
  attachments: MailThreadAttachmentView[]
  filedBy: string
  filedVia: MailThreadFiledVia
  filedAt: string
}

/** What a detach did (`mail-thread-entry-detach`): each thread's new Fassung, and the follows it ended. */
export interface MailThreadEntryDetachResultView {
  entryId: string
  from: { threadId: string; documentId: string; versionId: string | null }
  to: { threadId: string; documentId: string; versionId: string | null }
  /** Follows of the thread the message left: a person followed the conversation as it was. */
  followsEnded: number
}

/** A thread in a list. */
export interface MailThreadSummaryView {
  id: string
  documentId: string
  name: string
  entryCount: number
  lastEntryAt: string | null
  /** Whether the viewer follows it. */
  followed: boolean
}

/** One thread with its messages (`mail-thread-get`). */
export interface MailThreadView extends MailThreadSummaryView {
  participantDomains: string[]
  continuesThreadId: string | null
  entries: MailThreadEntryView[]
  follows: MailThreadFollowView[]
  /** Mails waiting in the E-Mail-Eingang that matched this thread; null unless the viewer may file. */
  waitingCount: number | null
}

export interface MailThreadListView {
  items: MailThreadSummaryView[]
  nextCursor: string | null
}

/**
 * A mail that brought a Fassung of a document, as `document-get` lists them
 * (`mailOrigins`, D36): the Verlauf's message and the Fassung it brought
 * (null once that Fassung is gone). `document-version-list` carries the same
 * per version, without `documentVersionId`.
 */
export interface DocumentMailOriginView extends MailOriginView {
  documentVersionId: string | null
}
