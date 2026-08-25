import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

import type { ProjectProfile, ProjectProfileDisplay } from '../../project-profile/types'

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    name: text('name').notNull(),
    createdBy: text('created_by').notNull(),
    collectionName: text('collection_name').notNull(),
    workosResourceId: text('workos_resource_id').unique(),
    profile: jsonb('profile')
      .$type<ProjectProfile>()
      .notNull()
      .default({} as ProjectProfile),
    profileVersion: integer('profile_version').notNull().default(1),
    profilePromptView: text('profile_prompt_view'),
    profileDisplay: jsonb('profile_display').$type<ProjectProfileDisplay>(),
    profileUpdatedAt: timestamp('profile_updated_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('projects_org_deleted_created_idx').on(
      table.organizationId,
      table.deletedAt,
      table.createdAt
    ),
    // Referenceable so a child table can tie its denormalised `organization_id`
    // to the project it names (see `document_roles`). `id` is already the primary
    // key, so this adds no new restriction — it exists to be a foreign-key target.
    idOrgKey: unique('projects_id_organization_id_key').on(table.id, table.organizationId),
  })
)

export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
