import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { projects } from './projects'

/**
 * The project mail inbox (migration 0101, ADR-0074).
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
     * project. Partial, so it lives only in migration 0101, the same
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

export const INBOUND_MAIL_MESSAGE_STATUSES = ['processing', 'filed', 'failed'] as const
export type InboundMailMessageStatus = (typeof INBOUND_MAIL_MESSAGE_STATUSES)[number]

/** One delivery to an address, for idempotency. Hashes, ids, counts — no content. */
export const inboundMailMessages = pgTable(
  'inbound_mail_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    addressId: uuid('address_id').notNull(),
    /** sha256 hex of the Message-ID header, or of the raw bytes without one. */
    messageIdHash: text('message_id_hash').notNull(),
    senderUserId: text('sender_user_id'),
    status: text('status').$type<InboundMailMessageStatus>().notNull().default('processing'),
    filedCount: integer('filed_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    attempts: integer('attempts').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Keyed by ADDRESS: one mail to two projects is two deliveries. */
    addressHashKey: uniqueIndex('uniq_inbound_mail_messages_address_hash').on(
      table.addressId,
      table.messageIdHash
    ),
    projectCreatedIdx: index('inbound_mail_messages_project_created_idx').on(
      table.projectId,
      table.createdAt
    ),
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
      sql`${table.status} IN ('processing', 'filed', 'failed')`
    ),
    hashShape: check('inbound_mail_messages_hash_shape', sql`${table.messageIdHash} ~ '^[0-9a-f]{64}$'`),
    countsNonNegative: check(
      'inbound_mail_messages_counts_non_negative',
      sql`${table.filedCount} >= 0 AND ${table.skippedCount} >= 0 AND ${table.attempts} >= 1`
    ),
    filedAttributed: check(
      'inbound_mail_messages_filed_attributed',
      sql`${table.status} <> 'filed' OR ${table.senderUserId} IS NOT NULL`
    ),
  })
)

export type InboundMailAddressRow = typeof inboundMailAddresses.$inferSelect
export type InboundMailMessageRow = typeof inboundMailMessages.$inferSelect
