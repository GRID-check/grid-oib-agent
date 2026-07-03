// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import type { ProjectProfile, ProjectProfileDisplay } from '../../project-profile/types'

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  createdBy: text('created_by').notNull(),
  collectionName: text('collection_name').notNull(),
  workosResourceId: text('workos_resource_id').unique(),
  profile: jsonb('profile').$type<ProjectProfile>().notNull().default({}),
  profileVersion: integer('profile_version').notNull().default(1),
  profilePromptView: text('profile_prompt_view'),
  profileDisplay: jsonb('profile_display').$type<ProjectProfileDisplay>(),
  profileUpdatedAt: timestamp('profile_updated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
