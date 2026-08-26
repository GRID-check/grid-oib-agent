import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { SHAREABLE_RESOURCE_TYPES } from './resource-shares'

/**
 * `inbox_items` — every user's per-organization "what needs me?" list (ADR-0035).
 *
 * ONE fixed frame plus a typed `payload`, so a new notification kind costs a
 * registry entry (`@/lib/inbox/registry`) and two translations — never a schema
 * change and never a new component. That extensibility is the requirement the
 * table shape exists to satisfy.
 *
 * Three properties come from ONE constraint. The unique index on
 * `(recipient_user_id, group_key)` combined with an incrementing upsert gives:
 *   - **grouping** — twenty new messages in a thread become one row, count 20;
 *   - **deduplication** — a repeated cause within the group collapses;
 *   - **idempotency** — a retried emission is a no-op, not a duplicate.
 * Choose `group_key` per type accordingly: include the anchor (e.g. a message
 * id) when each occurrence deserves its own row, omit it to collapse.
 *
 * An item is a POINTER, never a copy. `payload` may carry a snippet for display,
 * but access is re-derived when the item is read, and revocation/deletion marks
 * items inert — so the inbox can never become a loophole for revoked access.
 *
 * Items are derivative: they are purged on a per-type retention schedule and
 * destroyed with their target through the existing deletion pipeline.
 */

/**
 * Item types. Exhaustive over the registry (`@/lib/inbox/registry`), which
 * fails to type-check if a type here has no entry.
 *
 * Phase 1 deliberately ships four — one actionable and three informational —
 * so the generic frame is proven by more than a single case.
 */
export const INBOX_ITEM_TYPES = [
  /** Actionable: someone tagged you and the agent is holding for your answer. */
  'mention.requested',
  /** Informational: a request you made was answered. */
  'mention.answered',
  /** Informational: you were given access to a resource. */
  'conversation.shared_with_you',
  /** Informational, grouped: new messages in a thread you participate in. */
  'conversation.activity',
  /**
   * Operational: the organization's stored bytes crossed a share of its quota
   * (ADR-0042). Not a collaboration event — it is addressed to whoever can act
   * on it, and it must reach them whether or not the tenant has collaboration
   * (see `gate` in `@/lib/inbox/registry`).
   */
  'storage.quota_warning',
  /** Informational: you were named responsible for a resource (ADR-0047). */
  'document.assigned_to_you',
] as const
export type InboxItemType = (typeof INBOX_ITEM_TYPES)[number]

/**
 * What an inbox item may POINT AT.
 *
 * A superset of `ShareableResourceType`, and that is the point. The column used
 * to be typed as the shareable union, which silently assumed every notification
 * concerns something one person can be granted access to. Operational items are
 * not like that: "this organization is nearly out of storage" is about the
 * TENANT, and `organization` is not — and must not become — shareable, because
 * adding it to `SHAREABLE_RESOURCE_TYPES` would make an org a thing you can hand
 * someone a grant on.
 *
 * Every member of this union needs a descriptor in `@/lib/inbox/targets`, which
 * is exhaustive over it, so a new target kind cannot ship without a deep link
 * and an access resolver. That registry — not a cast, and not a branch inside
 * the read path — is what lets an org-scoped item exist.
 */
export const INBOX_TARGET_TYPES = [...SHAREABLE_RESOURCE_TYPES, 'organization'] as const
export type InboxTargetType = (typeof INBOX_TARGET_TYPES)[number]

export const inboxItems = pgTable(
  'inbox_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Tenant scope. A user in two orgs has two inboxes; counts never mix. */
    organizationId: text('organization_id').notNull(),
    /** WorkOS user id this item is FOR. */
    recipientUserId: text('recipient_user_id').notNull(),
    type: text('type').$type<InboxItemType>().notNull(),
    /** What the item points AT — resolved through `@/lib/inbox/targets`. */
    resourceType: text('resource_type').$type<InboxTargetType>().notNull(),
    resourceId: text('resource_id').notNull(),
    /**
     * Opaque id of the exact spot inside the resource (a message id, for a
     * chat), so a deep link can land on it. NULL when the item concerns the
     * resource as a whole.
     */
    anchorId: text('anchor_id'),
    /** WorkOS user id of whoever caused it; NULL for system-generated items. */
    actorUserId: text('actor_user_id'),
    /**
     * Grouping / dedup / idempotency key — see the module doc. Unique per
     * recipient.
     */
    groupKey: text('group_key').notNull(),
    /**
     * Denormalized from the registry so the badge count is a plain indexed
     * query instead of an `IN (…)` over the actionable type set. If a type ever
     * changed kind, existing rows would need a backfill (accepted, ADR-0035).
     */
    actionable: boolean('actionable').notNull(),
    /**
     * How many occurrences this row has absorbed since it was last read.
     * Reset to `0` by the mark-read paths, so it always counts what is NEW.
     */
    count: integer('count').notNull().default(1),
    /** Type-specific display data. Never authoritative, never a source of access. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last activity — the list orders by this, and grouping touches it. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
    /** Actionable items only: the underlying request was settled. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /** Target became unreachable (unshared / deleted): render redacted, never linked. */
    inertAt: timestamp('inert_at', { withTimezone: true }),
  },
  (table) => ({
    /** Grouping + dedup + idempotency, all three (see module doc). */
    groupUniq: uniqueIndex('uniq_inbox_items_recipient_group').on(
      table.recipientUserId,
      table.groupKey
    ),
    /** The inbox list: one recipient, one org, newest activity first. */
    listIdx: index('idx_inbox_items_recipient_org_updated').on(
      table.recipientUserId,
      table.organizationId,
      table.updatedAt
    ),
    /** Inert-marking and cascade cleanup by target. */
    targetIdx: index('idx_inbox_items_target').on(table.resourceType, table.resourceId),
    /** Retention prune orders/filters by age alone. */
    createdIdx: index('idx_inbox_items_created_at').on(table.createdAt),
    // NOTE: the badge's partial index — on (recipient_user_id, organization_id)
    // WHERE archived_at IS NULL AND inert_at IS NULL AND (read_at IS NULL OR
    // (actionable AND resolved_at IS NULL)) — is a PARTIAL index the drizzle
    // builder cannot express, so it lives in migration 0027_collaboration.sql.
    // It backs the count rendered on every page.
  })
)

export type InboxItem = typeof inboxItems.$inferSelect
export type NewInboxItem = typeof inboxItems.$inferInsert
