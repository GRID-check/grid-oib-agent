/**
 * The vocabulary of the E-Mail-Verlauf (ADR-0134, migration 0186), free of
 * drizzle and of zod: the tuples the `mail_thread*` tables CHECK, their bounds,
 * and the shapes of the JSON a filed message carries.
 *
 * `db/schema/mail-thread.ts` types its columns from here, and
 * `./mail-thread-wire.ts` holds the zod schemas that parse the same JSON where
 * it is read, so the database, the renderer and the routes name one shape.
 * A value added here is a CHECK changed in a migration.
 *
 * Pure: no database, no `server-only`, no service (`wire-modules.spec.ts`).
 */

import type { Locale } from '@/i18n/config'
import type { ScreeningDetector } from '@/lib/upload-screening/policy'
import type { MailParticipant } from '@/lib/inbound-mail/inbound-mail-vocabulary'

// ------------------------------------------------------------ threads

/**
 * The locales a thread renders in. A thread is rendered in one locale for its
 * whole life (`mail_threads.locale`, fixed at creation): Fassung N+1 repeats
 * every section of Fassung N byte for byte, which a second locale would break.
 */
export const MAIL_THREAD_LOCALES = ['de', 'en'] as const satisfies readonly Locale[]
export type MailThreadLocale = (typeof MAIL_THREAD_LOCALES)[number]

/** A thread's bounds (D11): past either, the next message is offered as „Als Fortsetzung ablegen“. */
export const MAIL_THREAD_MAX_ENTRIES = 200
export const MAIL_THREAD_MAX_RENDERED_BYTES = 2 * 1024 * 1024

// ------------------------------------------------------------ matching

/**
 * How strongly a mail matched a thread, strongest first (D11; the ladder and
 * what each rung means are `./mail-threading.ts`).
 */
export const THREAD_MATCH_STRENGTHS = ['reference', 'thread_index', 'reference_subject_changed', 'subject'] as const
export type ThreadMatchStrength = (typeof THREAD_MATCH_STRENGTHS)[number]

/** The headers a match can rest on, lower-case as mailauth lists signed headers. */
export const THREAD_MATCH_HEADERS = ['in-reply-to', 'references', 'thread-index', 'subject'] as const
export type ThreadMatchHeader = (typeof THREAD_MATCH_HEADERS)[number]

/** One thread a held mail matched (`inbound_mails.thread_match`): ids and strengths, never names (D9). */
export interface ThreadMatch {
  threadId: string
  strength: ThreadMatchStrength
  headers: ThreadMatchHeader[]
}

/**
 * Whether a thread received a Message-ID (an entry of it is that message) or
 * only knows it as a reference one of its entries named
 * (`mail_thread_message_ids.state`).
 */
export const MAIL_THREAD_MESSAGE_ID_STATES = ['received', 'referenced'] as const
export type MailThreadMessageIdState = (typeof MAIL_THREAD_MESSAGE_ID_STATES)[number]

// ------------------------------------------------------------ entries

/** Where a filed message came from: the project's address, or a person's Outlook archive (D33). */
export const MAIL_THREAD_ENTRY_SOURCES = ['inbound', 'archive'] as const
export type MailThreadEntrySource = (typeof MAIL_THREAD_ENTRY_SOURCES)[number]

/**
 * How a message was filed: decided in the app, by an outside agent as the
 * person, through a Piloti card, by a follow, or by the person's archive import.
 * An archive entry is always `archive_import`, and only an archive entry is.
 */
export const MAIL_THREAD_FILED_VIA = ['app', 'agent', 'piloti_proposal', 'follow', 'archive_import'] as const
export type MailThreadFiledVia = (typeof MAIL_THREAD_FILED_VIA)[number]

/** One address of a filed message (`mail_thread_entries.participants`); the renderer prints name and domain only. */
export type MailThreadParticipant = MailParticipant

/**
 * A span of the own text masked when the person chose „Unkenntlich ablegen“
 * (D13): UTF-16 offsets into `own_text`, as `findSpans` gives them, and the
 * kind whose placeholder replaces it.
 */
export interface MailThreadMaskedSpan {
  kind: ScreeningDetector | 'term'
  start: number
  end: number
}

/** One quoted block the reader split off the own text, in the order it appeared. */
export interface MailThreadQuote {
  text: string
}

/** One calendar invitation the message carried, as the Python reader gives it, times in ISO 8601 UTC. */
export interface MailThreadCalendarEvent {
  method: string | null
  summary: string | null
  start: string | null
  end: string | null
  allDay: boolean
  location: string | null
  status: string | null
}

/**
 * What became of one attachment of a filed message (D36,
 * `mail_thread_entry_attachments.disposition`): filed as a document
 * (`filed`), already in the project as these bytes (`already_present`), or
 * not filed (`not_filed`, with why; its bytes then live only in the original).
 */
export const MAIL_THREAD_ATTACHMENT_DISPOSITIONS = ['filed', 'already_present', 'not_filed'] as const
export type MailThreadAttachmentDisposition = (typeof MAIL_THREAD_ATTACHMENT_DISPOSITIONS)[number]

/**
 * Why an attachment of a filed message is no document
 * (`mail_thread_entry_attachments.not_filed_reason`).
 *
 * - `pending`: it still waits in the E-Mail-Eingang (undecided, or its filing
 *   failed and it waits again). The one reason a row leaves: a later decision
 *   files it, or ends it with another reason (the migration's guard).
 * - `dismissed`, `expired`: a person said no, or nobody decided in time.
 * - `infected`, `scan_failed`: the malware scan never said clean.
 * - `type_not_accepted`: the office does not file this type.
 * - `encrypted`, `archive`, `size`, `limit`, `empty`: never staged
 *   (`NOT_STAGED_REASONS`); a layout image, a signature, a TNEF container or a
 *   calendar invitation is no attachment anybody sent, and has no row.
 * - `screened`, `access`, `name_taken`, `unreadable`: the archive import's
 *   skips (ADR-0085).
 */
export const MAIL_THREAD_ATTACHMENT_NOT_FILED_REASONS = [
  'pending',
  'dismissed',
  'expired',
  'infected',
  'scan_failed',
  'type_not_accepted',
  'encrypted',
  'archive',
  'size',
  'limit',
  'empty',
  'screened',
  'access',
  'name_taken',
  'unreadable',
] as const
export type MailThreadAttachmentNotFiledReason = (typeof MAIL_THREAD_ATTACHMENT_NOT_FILED_REASONS)[number]

/**
 * What a thread's section prints for one attachment of its message
 * (`section_name`, `section_folder_path`), **frozen when the entry is
 * inserted**: the section that names it may never change afterwards (the
 * superset invariant), so a later rename of the document, a later filing of an
 * attachment that still waited, or a deleted document does not rewrite the
 * conversation. `name` null is counted, never named (RT-S13): see
 * `sectionAttachment` in `./render.ts` for when an attachment is named.
 */
export interface MailThreadSectionAttachment {
  name: string | null
  folderPath: string | null
}

/** The most own text one entry keeps, in UTF-8 bytes; the rest is in the original. */
export const MAIL_THREAD_ENTRY_MAX_TEXT_BYTES = 512 * 1024

// ------------------------------------------------------------ follows

/** Why a follow ended (`mail_thread_follows.ended_reason`, D31). */
export const MAIL_THREAD_FOLLOW_END_REASONS = [
  'unfollowed',
  'expired',
  'access_lost',
  'address_rotated',
  'detached',
  'document_gone',
  'revoked_by_manager',
] as const
export type MailThreadFollowEndReason = (typeof MAIL_THREAD_FOLLOW_END_REASONS)[number]

/** The reasons a person gives by acting; every other reason is the system noticing. */
export const MAIL_THREAD_FOLLOW_PERSON_END_REASONS = [
  'unfollowed',
  'revoked_by_manager',
] as const satisfies readonly MailThreadFollowEndReason[]

/** A follow's length unless the person asks for another, and the most it may run from its start (D31). */
export const MAIL_THREAD_FOLLOW_DEFAULT_DAYS = 60
export const MAIL_THREAD_FOLLOW_MAX_DAYS = 180

/** Appends one follow makes per day by default, and the most a follow may allow. */
export const MAIL_THREAD_FOLLOW_DEFAULT_DAILY_CAP = 20
export const MAIL_THREAD_FOLLOW_MAX_DAILY_CAP = 50
