import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { projects } from './projects'

/**
 * The project mail inbox (migration 0109, ADR-0075).
 *
 * Storage only: address minting and parsing live in `lib/inbound-mail/address`,
 * the lifecycle in `lib/inbound-mail/service`. Neither table holds content.
 */

/** One project's mail address. Only `token` resolves; `slug` is decoration. */
export const inboundMailAddresses = pgTable(
  'inbound_mail_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    /** 12 chars of lowercase base32. Unique across ALL organizations. */
    token: text('token').notNull(),
    /** Frozen at mint time; `''` when the project name latinizes to nothing. */
    slug: text('slug').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set by rotation. A revoked token is the same as an unknown one. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
  },
  (table) => ({
    tokenKey: uniqueIndex('uniq_inbound_mail_addresses_token').on(table.token),
    /**
     * NOTE: the database also has `uniq_inbound_mail_addresses_active_project`,
     * UNIQUE (project_id) WHERE revoked_at IS NULL — one active address per
     * project. Partial, so it lives only in migration 0109, the same
     * arrangement as `documents_conversation_idx`.
     */
    idProjectOrgKey: unique('inbound_mail_addresses_id_project_org_key').on(
      table.id,
      table.projectId,
      table.organizationId
    ),
    /** The project reference carries the organization (the `document_roles` pattern). */
    projectOrgFk: foreignKey({
      name: 'inbound_mail_addresses_project_id_organization_id_fkey',
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete('cascade'),
    tokenShape: check('inbound_mail_addresses_token_shape', sql`${table.token} ~ '^[a-z2-7]{12}$'`),
    slugShape: check('inbound_mail_addresses_slug_shape', sql`${table.slug} ~ '^[a-z0-9-]{0,30}$'`),
    revocationAttributed: check(
      'inbound_mail_addresses_revocation_attributed',
      sql`(${table.revokedAt} IS NULL) = (${table.revokedBy} IS NULL)`
    ),
  })
)

export const INBOUND_MAIL_MESSAGE_STATUSES = ['queued', 'filed', 'failed'] as const
export type InboundMailMessageStatus = (typeof INBOUND_MAIL_MESSAGE_STATUSES)[number]

/** One staged attachment: an object under the project's `inbound-mail/` prefix. */
export interface StagedAttachment {
  key: string
  filename: string
  contentType: string
  /** Hex sha256 of the bytes, as selected from the mail. */
  sha256: string
  size: number
}

/** A part that was not filed. `filename` is dropped once the row is terminal. */
export interface SkippedAttachment {
  filename?: string
  reason: string
}

/**
 * One delivery to an address: what the `inbound_mail` job files from, the
 * fence its jobs check, and the idempotency record. Never the mail; see
 * migration 0109 for what it holds and for how long.
 */
export const inboundMailMessages = pgTable(
  'inbound_mail_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    addressId: uuid('address_id').notNull(),
    /** sha256 hex of the Message-ID and the sorted attachment digests. */
    deliveryKey: text('delivery_key').notNull(),
    senderUserId: text('sender_user_id').notNull(),
    status: text('status').$type<InboundMailMessageStatus>().notNull().default('queued'),
    /** The leaf under `E-Mail-Eingang/`, fixed at acceptance. */
    folderName: text('folder_name').notNull(),
    /**
     * NOTE: the database FK is COMPOSITE — `(folder_id, project_id)` ->
     * `project_folders (id, project_id)` with `ON DELETE SET NULL
     * ("folder_id")`. Drizzle cannot express a column-subset SET NULL, so it
     * lives only in migration 0109, the arrangement `task_runs.definition_id`
     * has in 0086.
     */
    folderId: uuid('folder_id'),
    subject: text('subject'),
    stagingBucket: text('staging_bucket'),
    staged: jsonb('staged').$type<StagedAttachment[]>().notNull().default([]),
    skipped: jsonb('skipped').$type<SkippedAttachment[]>().notNull().default([]),
    filedCount: integer('filed_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    /** Failed filing attempts so far; the give-up counts these. */
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Keyed by ADDRESS: one mail to two projects is two deliveries. */
    addressDeliveryKey: uniqueIndex('uniq_inbound_mail_messages_address_delivery').on(
      table.addressId,
      table.deliveryKey
    ),
    projectCreatedIdx: index('inbound_mail_messages_project_created_idx').on(
      table.projectId,
      table.createdAt
    ),
    receivedIdx: index('inbound_mail_messages_received_idx').on(table.receivedAt),
    // NOTE: `inbound_mail_messages_queued_idx` (updated_at WHERE queued), the
    // sweep's, is a PARTIAL index; it lives only in migration 0109.
    projectOrgFk: foreignKey({
      name: 'inbound_mail_messages_project_id_organization_id_fkey',
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete('cascade'),
    /** The address in the same project AND organization, by construction. */
    addressFk: foreignKey({
      name: 'inbound_mail_messages_address_fkey',
      columns: [table.addressId, table.projectId, table.organizationId],
      foreignColumns: [
        inboundMailAddresses.id,
        inboundMailAddresses.projectId,
        inboundMailAddresses.organizationId,
      ],
    }).onDelete('cascade'),
    statusKnown: check(
      'inbound_mail_messages_status_known',
      sql`${table.status} IN ('queued', 'filed', 'failed')`
    ),
    deliveryKeyShape: check(
      'inbound_mail_messages_delivery_key_shape',
      sql`${table.deliveryKey} ~ '^[0-9a-f]{64}$'`
    ),
    countsNonNegative: check(
      'inbound_mail_messages_counts_non_negative',
      sql`${table.filedCount} >= 0 AND ${table.skippedCount} >= 0 AND ${table.attempts} >= 0`
    ),
    stagedIsArray: check(
      'inbound_mail_messages_staged_is_array',
      sql`jsonb_typeof(${table.staged}) = 'array' AND jsonb_typeof(${table.skipped}) = 'array'`
    ),
    stagingBucketKnown: check(
      'inbound_mail_messages_staging_bucket_known',
      sql`${table.staged} = '[]'::jsonb OR ${table.stagingBucket} IS NOT NULL`
    ),
  })
)

export type InboundMailAddressRow = typeof inboundMailAddresses.$inferSelect
export type InboundMailMessageRow = typeof inboundMailMessages.$inferSelect
