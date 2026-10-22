import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type {
  DroppedReason,
  InboundMailAddressRevokedReason,
  InboundMailContentFinding,
  InboundMailDecisionAction,
  InboundMailDecisionVia,
  InboundMailFilingFailure,
  InboundMailIgnoredCounts,
  InboundMailMessageText,
  InboundMailNotStaged,
  InboundMailPartKind,
  InboundMailPartScanStatus,
  InboundMailPartState,
  InboundMailStatus,
  InboundMailThreadAction,
  InboundSenderTrust,
  MailParticipant,
  MalwareScanStatus,
  PartRiskFlag,
  SenderFlag,
  SenderReason,
} from '@/lib/inbound-mail/inbound-mail-vocabulary'
import type { ThreadMatch } from '@/lib/mail-thread/mail-thread-vocabulary'
import { projects } from './projects'

/**
 * The E-Mail-Eingang (ADR-0134, migration 0186): a project's mail address, the
 * mail that reached it, its parts, and what a person decided about each part.
 * Nothing that arrives is a document; a part becomes one only when a person
 * files it, and the mail's text becomes a section of its E-Mail-Verlauf
 * (`./mail-thread.ts`).
 *
 * Storage only. The migration holds every rule, and says why each exists: a
 * part is filed only on a person's `file` decision about it, only when its scan
 * was clean; a decision is append-only and names a person; a settled mail keeps
 * no third party's data; every object key a row names is the row's own. Several
 * composite keys use a column-subset `ON DELETE SET NULL`, which drizzle cannot
 * express; they live in the migration alone (the `mail_threads` arrangement).
 */

/** A project's mail address, and every address it had (rotation history). Only `token` resolves. */
export const inboundMailAddresses = pgTable(
  'inbound_mail_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    /** 12 characters of lowercase base32, unique across every organization, revoked rows included. */
    token: text('token').notNull(),
    /** Frozen at mint time; `''` when the project name latinizes to nothing. */
    slug: text('slug').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    revokedReason: text('revoked_reason').$type<InboundMailAddressRevokedReason>(),
  },
  (table) => ({
    projectFk: foreignKey({
      name: 'inbound_mail_addresses_project_fkey',
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete('cascade'),
    idProjectOrgKey: unique('inbound_mail_addresses_id_project_org_key').on(
      table.id,
      table.projectId,
      table.organizationId,
    ),
    tokenKey: uniqueIndex('uniq_inbound_mail_addresses_token').on(table.token),
    activeProjectKey: uniqueIndex('uniq_inbound_mail_addresses_active_project')
      .on(table.projectId)
      .where(sql`${table.revokedAt} IS NULL`),
    projectCreatedIdx: index('inbound_mail_addresses_project_created_idx').on(table.projectId, table.createdAt),
  }),
)

/** One delivery to an address, held until a person files or dismisses its parts. */
export const inboundMails = pgTable(
  'inbound_mails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    addressId: uuid('address_id').notNull(),
    status: text('status').$type<InboundMailStatus>().notNull().default('receiving'),
    /** sha256 hex of the raw message; NULL only while `receiving`. */
    deliveryKey: text('delivery_key'),
    /** The SMTP MAIL FROM; `''` is a bounce's null sender. */
    envelopeFrom: text('envelope_from'),
    rawSizeBytes: bigint('raw_size_bytes', { mode: 'number' }),
    /** ADR-0043: recorded before any object is written; the purger reads it. */
    stagingBucket: text('staging_bucket').notNull(),
    /** Exactly `inboundMailStagingKey(…, 'raw.eml')` of this row, or NULL. */
    rawStorageKey: text('raw_storage_key'),
    /** Exactly `inboundMailStagingKey(…, 'read.json')` of this row, or NULL. */
    readStorageKey: text('read_storage_key'),
    rawScanStatus: text('raw_scan_status').$type<MalwareScanStatus>().notNull().default('pending'),
    rawScanEngine: text('raw_scan_engine'),
    rawScanSignature: text('raw_scan_signature'),
    rawScannedAt: timestamp('raw_scanned_at', { withTimezone: true }),
    rawScanAttempts: smallint('raw_scan_attempts').notNull().default(0),
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to').array().notNull().default(sql`'{}'::text[]`),
    referenceIds: text('reference_ids').array().notNull().default(sql`'{}'::text[]`),
    threadIndexGuid: uuid('thread_index_guid'),
    baseSubject: text('base_subject'),
    /** Ids and strengths only; candidates are computed for the viewer (D9). */
    threadMatch: jsonb('thread_match').$type<ThreadMatch[]>().notNull().default([]),
    senderAddress: text('sender_address'),
    senderName: text('sender_name'),
    subject: text('subject'),
    participants: jsonb('participants').$type<MailParticipant[]>().notNull().default([]),
    participantDomains: text('participant_domains').array().notNull().default(sql`'{}'::text[]`),
    recipientCount: integer('recipient_count').notNull().default(0),
    /** NULL until the receive job read the mail; never NULL once a person can see it. */
    senderTrust: text('sender_trust').$type<InboundSenderTrust>(),
    /** The member the From address belongs to; read only under D9's notice rules. */
    senderUserId: text('sender_user_id'),
    /** Why the sender is or is not verified; `dkim_pass` exactly when the trust is verified. */
    senderReason: text('sender_reason').$type<SenderReason>(),
    signerDomain: text('signer_domain'),
    /** Lower-case header names inside the aligned passing DKIM signature. */
    signedHeaders: text('signed_headers').array().notNull().default(sql`'{}'::text[]`),
    senderFlags: text('sender_flags').array().$type<SenderFlag[]>().notNull().default(sql`'{}'::text[]`),
    /** Our own line from DKIM and DMARC only; the database refuses one carrying `spf=`. */
    authenticationResults: text('authentication_results'),
    automatic: boolean('automatic').notNull().default(false),
    droppedReason: text('dropped_reason').$type<DroppedReason>(),
    /** The clamped Date (D11); `sentAtHeader` is the sender's claim. */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentAtHeader: timestamp('sent_at_header', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    expiringNotifiedAt: timestamp('expiring_notified_at', { withTimezone: true }),
    notStaged: jsonb('not_staged').$type<InboundMailNotStaged[]>().notNull().default([]),
    ignored: jsonb('ignored').$type<InboundMailIgnoredCounts>().notNull().default({}),
    erasureDeferredAt: timestamp('erasure_deferred_at', { withTimezone: true }),
    originalMovePendingAt: timestamp('original_move_pending_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectFk: foreignKey({
      name: 'inbound_mails_project_fkey',
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete('cascade'),
    /** NO ACTION: an address is revoked, never deleted, while a mail names it. */
    addressFk: foreignKey({
      name: 'inbound_mails_address_fkey',
      columns: [table.addressId, table.projectId, table.organizationId],
      foreignColumns: [inboundMailAddresses.id, inboundMailAddresses.projectId, inboundMailAddresses.organizationId],
    }),
    idProjectOrgKey: unique('inbound_mails_id_project_org_key').on(table.id, table.projectId, table.organizationId),
    deliveryKey: uniqueIndex('uniq_inbound_mails_address_delivery').on(table.addressId, table.deliveryKey),
    waitingIdx: index('inbound_mails_waiting_idx')
      .on(table.organizationId, table.projectId, table.receivedAt)
      .where(sql`${table.status} = 'waiting'`),
    expiryIdx: index('inbound_mails_expiry_idx').on(table.expiresAt).where(sql`${table.status} = 'waiting'`),
    receivingIdx: index('inbound_mails_receiving_idx')
      .on(table.updatedAt)
      .where(sql`${table.status} IN ('receiving', 'received')`),
    settledIdx: index('inbound_mails_settled_idx').on(table.settledAt).where(sql`${table.status} = 'settled'`),
    droppedIdx: index('inbound_mails_dropped_idx').on(table.receivedAt).where(sql`${table.status} = 'dropped'`),
    messageIdIdx: index('inbound_mails_message_id_idx')
      .on(table.projectId, table.messageId)
      .where(sql`${table.messageId} IS NOT NULL`),
    erasureDeferredIdx: index('inbound_mails_erasure_deferred_idx')
      .on(table.erasureDeferredAt)
      .where(sql`${table.erasureDeferredAt} IS NOT NULL`),
    originalMoveIdx: index('inbound_mails_original_move_idx')
      .on(table.originalMovePendingAt)
      .where(sql`${table.originalMovePendingAt} IS NOT NULL`),
  }),
)

/**
 * The mail's own text, or one attachment, and where it stands. NOTE: the
 * composite keys to `documents`, `document_versions` and `mail_thread_entries`
 * set only their own column NULL, and the key to the part's decision is added
 * after both tables exist; all four live in migration 0186 alone.
 */
export const inboundMailParts = pgTable(
  'inbound_mail_parts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    mailId: uuid('mail_id').notNull(),
    position: integer('position').notNull(),
    kind: text('kind').$type<InboundMailPartKind>().notNull(),
    /** An attachment's name, only while its bytes are there (NULL for a nameless file); the text has none. */
    filename: text('filename'),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    /** Exactly `inboundMailStagingKey(…, { position })` of this part, or NULL. */
    storageKey: text('storage_key'),
    state: text('state').$type<InboundMailPartState>().notNull().default('waiting'),
    scanStatus: text('scan_status').$type<InboundMailPartScanStatus>().notNull(),
    scanEngine: text('scan_engine'),
    scanSignature: text('scan_signature'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    scanAttempts: smallint('scan_attempts').notNull().default(0),
    riskFlags: text('risk_flags').array().$type<PartRiskFlag[]>().notNull().default(sql`'{}'::text[]`),
    nameStopTerms: text('name_stop_terms').array().notNull().default(sql`'{}'::text[]`),
    contentFindings: text('content_findings')
      .array()
      .$type<InboundMailContentFinding[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    duplicateOfDocumentId: uuid('duplicate_of_document_id'),
    revisionCandidateDocumentId: uuid('revision_candidate_document_id'),
    /** The person's `file` decision about THIS part; set exactly while `filing` or `filed`. */
    decisionId: uuid('decision_id'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    lastFailure: text('last_failure').$type<InboundMailFilingFailure>(),
    documentId: uuid('document_id'),
    documentVersionId: uuid('document_version_id'),
    mailThreadEntryId: uuid('mail_thread_entry_id'),
    filedAt: timestamp('filed_at', { withTimezone: true }),
    /** When it was dismissed or expired: restorable for `INBOUND_MAIL_RESTORE_DAYS` from here. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    erasureDeferredAt: timestamp('erasure_deferred_at', { withTimezone: true }),
    /** Piloti's suggestion (D21), shaped by `lib/inbound-mail/suggest.ts`; gone with the bytes. */
    suggestion: jsonb('suggestion').$type<Record<string, unknown>>(),
    suggestionTraceId: text('suggestion_trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    mailFk: foreignKey({
      name: 'inbound_mail_parts_mail_fkey',
      columns: [table.mailId, table.projectId, table.organizationId],
      foreignColumns: [inboundMails.id, inboundMails.projectId, inboundMails.organizationId],
    }).onDelete('cascade'),
    idMailProjectOrgKey: unique('inbound_mail_parts_id_mail_project_org_key').on(
      table.id,
      table.mailId,
      table.projectId,
      table.organizationId,
    ),
    mailPositionKey: unique('inbound_mail_parts_mail_position_key').on(table.mailId, table.position),
    documentIdx: index('inbound_mail_parts_document_idx')
      .on(table.documentId)
      .where(sql`${table.documentId} IS NOT NULL`),
    claimIdx: index('inbound_mail_parts_claim_idx').on(table.claimExpiresAt).where(sql`${table.state} = 'filing'`),
    endedBytesIdx: index('inbound_mail_parts_ended_bytes_idx')
      .on(table.endedAt)
      .where(sql`${table.storageKey} IS NOT NULL AND ${table.state} IN ('dismissed', 'expired')`),
    scanFailedIdx: index('inbound_mail_parts_scan_failed_idx')
      .on(table.scannedAt)
      .where(sql`${table.scanStatus} = 'failed'`),
  }),
)

/**
 * Append-only: every act of a person on a part. The filing job reads what to do
 * from here and nowhere else, and the audit trail is sent from here
 * (`auditedAt`). Only `auditedAt` ever changes, once. NOTE: the composite key
 * that makes a follow decision the follower's own references
 * `mail_thread_follows`, declared in `./mail-thread.ts`; it lives in migration
 * 0186 alone so this file does not import that one.
 */
export const inboundMailDecisions = pgTable(
  'inbound_mail_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    mailId: uuid('mail_id').notNull(),
    partId: uuid('part_id').notNull(),
    action: text('action').$type<InboundMailDecisionAction>().notNull(),
    /** A person's WorkOS user id (`PERSON_USER_ID_PATTERN`); the database refuses any other. */
    decidedBy: text('decided_by').notNull(),
    via: text('via').$type<InboundMailDecisionVia>().notNull().default('app'),
    proposalId: uuid('proposal_id'),
    followId: uuid('follow_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    folderId: uuid('folder_id'),
    /** The destination as it was; `''` is the project root. */
    folderPath: text('folder_path'),
    fileName: text('file_name'),
    /** `revisionOf`: file as the next Fassung of this document. */
    targetDocumentId: uuid('target_document_id'),
    documentType: text('document_type'),
    threadAction: text('thread_action').$type<InboundMailThreadAction>(),
    mailThreadId: uuid('mail_thread_id'),
    messageText: text('message_text').$type<InboundMailMessageText>(),
    screeningRelease: boolean('screening_release').notNull().default(false),
    acknowledgedSender: boolean('acknowledged_sender').notNull().default(false),
    acknowledgedRisk: boolean('acknowledged_risk').notNull().default(false),
    auditedAt: timestamp('audited_at', { withTimezone: true }),
  },
  (table) => ({
    partFk: foreignKey({
      name: 'inbound_mail_decisions_part_fkey',
      columns: [table.partId, table.mailId, table.projectId, table.organizationId],
      foreignColumns: [
        inboundMailParts.id,
        inboundMailParts.mailId,
        inboundMailParts.projectId,
        inboundMailParts.organizationId,
      ],
    }).onDelete('cascade'),
    idPartKey: unique('inbound_mail_decisions_id_part_key').on(table.id, table.partId),
    partIdx: index('inbound_mail_decisions_part_idx').on(table.partId, table.decidedAt),
    mailIdx: index('inbound_mail_decisions_mail_idx').on(table.mailId),
    followIdx: index('inbound_mail_decisions_follow_idx')
      .on(table.followId, table.decidedAt)
      .where(sql`${table.followId} IS NOT NULL`),
    dueIdx: index('inbound_mail_decisions_due_idx').on(table.decidedAt).where(sql`${table.auditedAt} IS NULL`),
  }),
)

export type InboundMailAddressRow = typeof inboundMailAddresses.$inferSelect
export type InboundMailRow = typeof inboundMails.$inferSelect
export type NewInboundMailRow = typeof inboundMails.$inferInsert
export type InboundMailPartRow = typeof inboundMailParts.$inferSelect
export type NewInboundMailPartRow = typeof inboundMailParts.$inferInsert
export type InboundMailDecisionRow = typeof inboundMailDecisions.$inferSelect
export type NewInboundMailDecisionRow = typeof inboundMailDecisions.$inferInsert
