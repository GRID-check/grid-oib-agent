import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { SHAREABLE_RESOURCE_TYPES, type ShareableResourceType } from './resource-shares'

/**
 * `resource_assignments` — who is professionally on the hook for a resource
 * (ADR-0047). Not access (that is `resource_shares`) and not provenance
 * (`created_by`). Cardinality 0..n; empty is valid; upload writes no row.
 *
 * Same polymorphic key as grants and inbox items so a later consumer
 * (a compliance lane) is a registry entry, not a second table.
 */
export const resourceAssignments = pgTable(
  'resource_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    resourceType: text('resource_type').$type<ShareableResourceType>().notNull(),
    resourceId: text('resource_id').notNull(),
    subjectUserId: text('subject_user_id').notNull(),
    assignedBy: text('assigned_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subjectUniq: uniqueIndex('uniq_resource_assignments_resource_subject').on(
      table.resourceType,
      table.resourceId,
      table.subjectUserId,
    ),
    resourceIdx: index('idx_resource_assignments_resource').on(table.resourceType, table.resourceId),
    orgSubjectIdx: index('idx_resource_assignments_org_subject').on(
      table.organizationId,
      table.subjectUserId,
      table.resourceType,
    ),
  }),
)

export type ResourceAssignment = typeof resourceAssignments.$inferSelect
export type NewResourceAssignment = typeof resourceAssignments.$inferInsert

/** Compile-time reminder that assignment keys the same union as sharing. */
export const ASSIGNMENT_RESOURCE_TYPES = SHAREABLE_RESOURCE_TYPES
