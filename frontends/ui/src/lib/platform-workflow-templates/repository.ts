/**
 * Platform workflow templates repository — the only module that queries the
 * `platform_workflow_templates` table (ADR-0017 repository rules: drizzle only,
 * no HTTP/auth/WorkOS).
 *
 * These rows are GLOBAL (platform-owned), so — unlike the tenant-scoped
 * `workflows` repository — no query takes or filters by `organization_id`.
 * Authorization (platform-owner for writes; any signed-in user for the
 * published read) is enforced one layer up, in the service/route.
 */

import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  platformWorkflowTemplates,
  type NewPlatformWorkflowTemplate,
  type PlatformWorkflowTemplate,
} from '@/lib/db/schema'

/** Hard cap on how many templates a listing returns (drafts + published). */
export const PLATFORM_TEMPLATE_LIST_LIMIT = 500

export async function insertPlatformTemplate(
  values: NewPlatformWorkflowTemplate,
): Promise<PlatformWorkflowTemplate> {
  const db = getDb()
  const [row] = await db.insert(platformWorkflowTemplates).values(values).returning()
  return row
}

/** Every template (drafts included), display order — platform-owner view. */
export async function listAllPlatformTemplates(): Promise<PlatformWorkflowTemplate[]> {
  const db = getDb()
  return db
    .select()
    .from(platformWorkflowTemplates)
    .orderBy(asc(platformWorkflowTemplates.sortOrder), asc(platformWorkflowTemplates.createdAt))
    .limit(PLATFORM_TEMPLATE_LIST_LIMIT)
}

/** Published templates only, display order — the org-facing gallery read. */
export async function listPublishedPlatformTemplates(): Promise<PlatformWorkflowTemplate[]> {
  const db = getDb()
  return db
    .select()
    .from(platformWorkflowTemplates)
    .where(eq(platformWorkflowTemplates.published, true))
    .orderBy(asc(platformWorkflowTemplates.sortOrder), asc(platformWorkflowTemplates.createdAt))
    .limit(PLATFORM_TEMPLATE_LIST_LIMIT)
}

export async function getPlatformTemplateById(id: string): Promise<PlatformWorkflowTemplate | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(platformWorkflowTemplates)
    .where(eq(platformWorkflowTemplates.id, id))
    .limit(1)
  return row ?? null
}

/** Patch a template. Returns the updated row, or null when the id is unknown. */
export async function updatePlatformTemplateRow(
  id: string,
  patch: Partial<NewPlatformWorkflowTemplate>,
): Promise<PlatformWorkflowTemplate | null> {
  const db = getDb()
  const [row] = await db
    .update(platformWorkflowTemplates)
    .set(patch)
    .where(eq(platformWorkflowTemplates.id, id))
    .returning()
  return row ?? null
}

/** Delete a template. Returns true when a row was removed. */
export async function deletePlatformTemplateRow(id: string): Promise<boolean> {
  const db = getDb()
  const rows = await db
    .delete(platformWorkflowTemplates)
    .where(eq(platformWorkflowTemplates.id, id))
    .returning({ id: platformWorkflowTemplates.id })
  return rows.length > 0
}
