/**
 * The vocabulary of the E-Mail-Eingang (ADR-0134, migration 0186), free of
 * drizzle and of zod.
 *
 * Every tuple here is also a CHECK in `drizzle/0186_inbound_mail.sql`: the
 * database refuses a value this file does not list, so a new value is a change
 * to both, in one migration. The drizzle schema (`db/schema/inbound-mail.ts`),
 * the wire module, the jobs and the browser import the tuples from here, so a
 * client component never drags the schema into its bundle (the
 * `projects/memory-vocabulary.ts` arrangement, held by `wire-modules.spec.ts`).
 *
 * Pure: no database, no `server-only`, no service.
 */

import type { ScreeningDetector } from '@/lib/upload-screening/policy'

// ------------------------------------------------------------ people

/**
 * The shape of a WorkOS user id (`user_` and a 26-character ULID). Who decides
 * about a mail, who files a message and who follows a thread is always a
 * person: the database refuses `system:*` actors and every other shape in those
 * columns (`inbound_mail_decisions.decided_by`, RT-S7), so no code path can
 * file mail in the name of a job.
 */
export const PERSON_USER_ID_PATTERN = /^user_[0-9A-Z]{26}$/

/** Whether `value` is a person's user id, as the database checks it. */
export function isPersonUserId(value: string): boolean {
  return PERSON_USER_ID_PATTERN.test(value)
}

// ------------------------------------------------------------ addresses

/** Why an address stopped resolving: replaced by a new one, or the project takes no mail. */
export const INBOUND_MAIL_ADDRESS_REVOKED_REASONS = ['rotated', 'switched_off'] as const
export type InboundMailAddressRevokedReason = (typeof INBOUND_MAIL_ADDRESS_REVOKED_REASONS)[number]

// ------------------------------------------------------------ mails

/**
 * Where one delivery stands.
 *
 * - `receiving`: the row exists and the raw message is being streamed to staging.
 * - `received`: staged whole, the receive job has not read it yet.
 * - `waiting`: a person's turn (only after the whole message was scanned).
 * - `settled`: no part waits or is being filed; the row is scrubbed to ids.
 * - `dropped`: an auto-reply, a delivery report or a loop; counted, never shown.
 */
export const INBOUND_MAIL_STATUSES = ['receiving', 'received', 'waiting', 'settled', 'dropped'] as const
export type InboundMailStatus = (typeof INBOUND_MAIL_STATUSES)[number]

/** Why a mail was accepted and then dropped unseen (`./automatic-mail`, `dropped_reason`). */
export const DROPPED_REASONS = ['auto_reply', 'delivery_report', 'self_loop'] as const
export type DroppedReason = (typeof DROPPED_REASONS)[number]

/**
 * A sender's trust (DECISION D4): an aligned DKIM pass or not, a directory
 * member or not. `not_checked` is an archive entry's (D33): the Outlook
 * import cannot verify anything, so it claims nothing.
 */
export const SENDER_TRUSTS = [
  'member_verified',
  'member_unverified',
  'external_verified',
  'external_unverified',
  'not_checked',
] as const
export type SenderTrust = (typeof SENDER_TRUSTS)[number]

/**
 * Who a mail at the project's address is from, as far as the bytes and DNS can
 * tell (`./sender-auth`, `inbound_mails.sender_trust`). `verified` is an
 * aligned DKIM pass that also meets the hygiene rules; `member` is a From
 * address equal to a directory member's address. DKIM proves a domain, never a
 * person, which is why no label claims more than the domain. Every received
 * mail was checked, so `not_checked` is not among them.
 */
export const INBOUND_SENDER_TRUSTS = [
  'member_verified',
  'member_unverified',
  'external_verified',
  'external_unverified',
] as const satisfies readonly SenderTrust[]
export type InboundSenderTrust = (typeof INBOUND_SENDER_TRUSTS)[number]

/** The trusts that are an aligned DKIM pass. */
export const VERIFIED_SENDER_TRUSTS: readonly SenderTrust[] = ['member_verified', 'external_verified']

/**
 * Why the sender is or is not verified, one code per mail (`sender_reason`).
 * `dkim_pass` is the only verified one (the database holds the pair). The
 * others are ordered as `./sender-auth` ranks them when several signatures
 * disagree: the most specific explanation first.
 */
export const SENDER_REASONS = [
  'dkim_pass',
  // The raw header block (checked before any signature, against parser differentials).
  'header_malformed',
  'header_duplicate',
  'from_count',
  'from_not_ascii',
  'dkim_too_many',
  // An aligned signature that verified but breaks a hygiene rule.
  'dkim_body_length',
  'dkim_testing',
  'dkim_expired',
  'dkim_unsigned_fields',
  'dkim_weak_algorithm',
  'dkim_short_key',
  // An aligned signature that did not verify.
  'dkim_temperror',
  'dkim_fail',
  'dkim_policy',
  'dkim_permerror',
  // No aligned signature at all.
  'dkim_unaligned',
  'dkim_none',
  // The verifier itself.
  'verifier_timeout',
  'verifier_error',
] as const
export type SenderReason = (typeof SENDER_REASONS)[number]

/**
 * Facts about one mail's sender that shape defaults (`sender_flags`, D4, D11,
 * D33). Each one disables pre-selection and following. The first four come
 * from `./sender-auth`; `message_id_reused` and `already_filed` from the
 * receive job's Message-ID lookup.
 *
 * - `not_addressed_to_project`: a verified mail whose signed To and Cc do not
 *   name the project's address: a member's mail to someone else, replayed.
 * - `bcc_own`: set TOGETHER with `not_addressed_to_project` when the mail is
 *   `member_verified` with a signed Date within a day of receipt: the
 *   member's own Bcc copy (the database holds the pairing). The pair errs
 *   safe: whoever forgets the exception asks for one acknowledgement too many
 *   and never offers a follow it should not.
 * - `stale_date`: the signed Date is more than seven days before receipt.
 * - `date_out_of_range`: the Date is missing or outside the clamp window, and
 *   the receipt time stands in for it.
 * - `message_id_reused`: the project already received this Message-ID.
 * - `already_filed`: and its own text is the same, so it is in a Verlauf already.
 */
export const SENDER_FLAGS = [
  'not_addressed_to_project',
  'bcc_own',
  'stale_date',
  'date_out_of_range',
  'message_id_reused',
  'already_filed',
] as const
export type SenderFlag = (typeof SENDER_FLAGS)[number]

/**
 * A malware scan's outcome (ADR-0133, `lib/malware-scan`). Only `clean` lets a
 * part be filed or a file be served; `failed` is scanned again.
 */
export const MALWARE_SCAN_STATUSES = ['pending', 'clean', 'infected', 'failed'] as const
export type MalwareScanStatus = (typeof MALWARE_SCAN_STATUSES)[number]

/**
 * Why a MIME part was not staged as a part a person decides on (`./mime`).
 * Every one of them is still in the original `.eml`; once the mail settles
 * they are counted by reason.
 */
export const NOT_STAGED_REASONS = [
  /** Part of the message's own layout: a `cid:` image, an auto-named pasted image, a tracking pixel. */
  'embedded',
  /** An S/MIME or PGP signature. */
  'signature',
  /** `winmail.dat`: Outlook's own container, not a file anybody sent. */
  'tnef',
  /** S/MIME or PGP encryption: nothing in it is readable here. */
  'encrypted',
  /** A calendar invitation; the Python reader renders it into the text. */
  'calendar',
  /** No bytes. */
  'empty',
  /** An archive the office does not accept as a file; it is never expanded. */
  'archive',
  /** Larger than one part may be. */
  'size',
  /** Past the number of parts one mail may stage, or a forward nested too deep. */
  'limit',
] as const
export type NotStagedReason = (typeof NOT_STAGED_REASONS)[number]

/** One file of the mail that was not staged, while the mail waits (`inbound_mails.not_staged`). */
export interface InboundMailNotStaged {
  filename: string
  reason: NotStagedReason
}

/** What was left out, by reason, with no names (`inbound_mails.ignored`). */
export type InboundMailIgnoredCounts = Partial<Record<NotStagedReason, number>>

/**
 * One address of a mail (`inbound_mails.participants`, `mail_thread_entries.participants`).
 * The project addresses are not participants: the receive job takes them out (B8).
 */
export interface MailParticipant {
  role: 'from' | 'reply_to' | 'to' | 'cc'
  name: string | null
  address: string
}

// ------------------------------------------------------------ parts

/** The mail's own text, or one attached file. */
export const INBOUND_MAIL_PART_KINDS = ['message', 'attachment'] as const
export type InboundMailPartKind = (typeof INBOUND_MAIL_PART_KINDS)[number]

/**
 * Where a part stands.
 *
 * - `waiting`: a person's turn.
 * - `filing`: a person said file; the filing job holds the claim.
 * - `filed`: a document holds it (until somebody deletes that document).
 * - `dismissed`: a person said no; restorable for seven days.
 * - `expired`: nobody decided within the window; restorable for seven days.
 */
export const INBOUND_MAIL_PART_STATES = ['waiting', 'filing', 'filed', 'dismissed', 'expired'] as const
export type InboundMailPartState = (typeof INBOUND_MAIL_PART_STATES)[number]

/** A part's scan: an attachment's outcome, or `not_applicable` for the mail's text (its raw message is scanned whole). */
export const INBOUND_MAIL_PART_SCAN_STATUSES = [...MALWARE_SCAN_STATUSES, 'not_applicable'] as const
export type InboundMailPartScanStatus = (typeof INBOUND_MAIL_PART_SCAN_STATUSES)[number]

/**
 * Facts about one attachment (`risk_flags`, D10, D11, D17). `./mime` sets
 * `macro`, `type_mismatch`, `encrypted`, `forwarded_inner` and
 * `type_not_accepted`; the receive job and the decision set the rest.
 * `macro`, `type_mismatch` and `unverified_thread` need the part in
 * `acknowledgeRisk`; `name_stop` needs `screeningRelease: 'name'`.
 */
export const PART_RISK_FLAGS = [
  'macro',
  'type_mismatch',
  'encrypted',
  'name_stop',
  'duplicate_of',
  'forwarded_inner',
  'unreadable',
  'unverified_thread',
  'type_not_accepted',
] as const
export type PartRiskFlag = (typeof PART_RISK_FLAGS)[number]

/** Why the last filing attempt made no document; the part waits again and the person is told. */
export const INBOUND_MAIL_FILING_FAILURES = [
  'screened',
  'type',
  'size',
  'quota',
  'access',
  'name_taken',
  'unreadable',
  'digest_mismatch',
  'unavailable',
  'thread_document_gone',
  'scan_not_clean',
  'project_closed',
  'type_not_accepted',
] as const
export type InboundMailFilingFailure = (typeof INBOUND_MAIL_FILING_FAILURES)[number]

/** The content-check findings in the mail's own text, by kind (D13). */
export type InboundMailContentFinding = ScreeningDetector | 'term'

// ------------------------------------------------------------ decisions

/** What a person decided about a part. */
export const INBOUND_MAIL_DECISION_ACTIONS = ['file', 'dismiss', 'restore'] as const
export type InboundMailDecisionAction = (typeof INBOUND_MAIL_DECISION_ACTIONS)[number]

/**
 * How the decision reached us: in the app, from an outside agent acting as the
 * person, through a Piloti operation card the person confirmed, or as the
 * person's standing decision to follow a thread (D31). The decider is a person
 * in every case.
 */
export const INBOUND_MAIL_DECISION_VIAS = ['app', 'agent', 'piloti_proposal', 'follow'] as const
export type InboundMailDecisionVia = (typeof INBOUND_MAIL_DECISION_VIAS)[number]

/** Where a filed message goes: into an existing thread as its next Fassung, or a new thread. */
export const INBOUND_MAIL_THREAD_ACTIONS = ['append', 'create'] as const
export type InboundMailThreadAction = (typeof INBOUND_MAIL_THREAD_ACTIONS)[number]

/** Whether a filed message's text is masked where the content check found something (D13). */
export const INBOUND_MAIL_MESSAGE_TEXTS = ['masked', 'full'] as const
export type InboundMailMessageText = (typeof INBOUND_MAIL_MESSAGE_TEXTS)[number]

// ------------------------------------------------------------ windows

/** How long a mail waits for a person (D8). Fixed on the row at receipt. */
export const INBOUND_MAIL_WAIT_DAYS = 30
/** How long a dismissed or expired part can be restored (D8). */
export const INBOUND_MAIL_RESTORE_DAYS = 7

// ------------------------------------------------------------ object keys

/**
 * The reserved project-prefix segment a mail is staged under, and the one a
 * filed message's original is kept under (D6). `lib/s3.ts` reserves both, so
 * no person's folder can take them, and the migration's CHECKs hold every key
 * a row names to exactly the shapes below.
 */
export const INBOUND_MAIL_STAGING_SEGMENT = '_inbound-mail'
export const MAIL_ORIGINALS_SEGMENT = '_mail-originals'

interface ProjectObjectOwner {
  organizationId: string
  projectId: string
}

/** The staging prefix of one mail: `org/<org>/project/<project>/_inbound-mail/<mailId>/`. */
export function inboundMailStagingPrefix(owner: ProjectObjectOwner, mailId: string): string {
  return `org/${owner.organizationId}/project/${owner.projectId}/${INBOUND_MAIL_STAGING_SEGMENT}/${mailId}/`
}

/**
 * The key of one staged object of a mail: the raw message, what the reader
 * made of it, or an attachment part by its position.
 */
export function inboundMailStagingKey(
  owner: ProjectObjectOwner,
  mailId: string,
  object: 'raw.eml' | 'read.json' | { position: number }
): string {
  const name = typeof object === 'string' ? object : String(object.position)
  return `${inboundMailStagingPrefix(owner, mailId)}${name}`
}

/** The key a filed message's original is kept under: `org/<org>/project/<project>/_mail-originals/<entryId>.eml`. */
export function mailOriginalStorageKey(owner: ProjectObjectOwner, entryId: string): string {
  return `org/${owner.organizationId}/project/${owner.projectId}/${MAIL_ORIGINALS_SEGMENT}/${entryId}.eml`
}
