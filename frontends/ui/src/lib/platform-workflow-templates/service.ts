/**
 * Platform workflow templates service (ADR-0017) — the CRUD + mapping layer the
 * BFF routes call. Owns row⇆DTO mapping and PATCH merge semantics; leaves
 * SQL to the repository and authorization to the routes.
 *
 * Product notes:
 *  - `dataSources` is stored exactly as authored (the ADDITIONAL sources, or
 *    null = all). The always-on `knowledge_layer` is NOT injected here — it is
 *    added only when a user actually saves an adopted workflow into their
 *    project (see src/lib/workflows/service.ts), matching the built-in
 *    templates, which likewise declare only their additional sources.
 *  - These rows are global; nothing here is tenant-scoped.
 */

import 'server-only'
import {
  deletePlatformTemplateRow,
  getPlatformTemplateById,
  insertPlatformTemplate,
  listAllPlatformTemplates,
  listPublishedPlatformTemplates,
  updatePlatformTemplateRow,
} from './repository'
import {
  DEFAULT_TEMPLATE_AGENT_TYPE,
  type CreatePlatformTemplateInput,
  type PlatformTemplateContent,
  type PlatformTemplateDto,
  type TemplateProvenance,
  type UpdatePlatformTemplateInput,
} from './types'
import type { NewPlatformWorkflowTemplate, PlatformWorkflowTemplate } from '@/lib/db/schema'

/** The lean, tenant-safe projection the org gallery consumes (no author PII). */
export interface GalleryTemplateDto {
  id: string
  provenance: TemplateProvenance
  dataSources: string[] | null
  scheduleCron: string | null
  scheduleTimezone: string
  content: PlatformTemplateContent
}

/** Actor recorded as the template's author on create. */
export interface TemplateActor {
  userId: string
  email: string | null
}

/** Full DTO (platform-owner view). */
export function toTemplateDto(row: PlatformWorkflowTemplate): PlatformTemplateDto {
  return {
    id: row.id,
    provenance: row.provenance,
    dataSources: row.dataSources ?? null,
    agentType: row.agentType,
    scheduleCron: row.scheduleCron ?? null,
    scheduleTimezone: row.scheduleTimezone,
    content: row.content,
    published: row.published,
    sortOrder: row.sortOrder,
    createdByEmail: row.createdByEmail ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Lean gallery projection — published templates for a cross-tenant audience. */
function toGalleryDto(row: PlatformWorkflowTemplate): GalleryTemplateDto {
  return {
    id: row.id,
    provenance: row.provenance,
    dataSources: row.dataSources ?? null,
    scheduleCron: row.scheduleCron ?? null,
    scheduleTimezone: row.scheduleTimezone,
    content: row.content,
  }
}

/** Every template (drafts included) — platform-owner listing. */
export async function listPlatformTemplates(): Promise<PlatformTemplateDto[]> {
  const rows = await listAllPlatformTemplates()
  return rows.map(toTemplateDto)
}

/** Published templates for the org-facing gallery. */
export async function listGalleryTemplates(): Promise<GalleryTemplateDto[]> {
  const rows = await listPublishedPlatformTemplates()
  return rows.map(toGalleryDto)
}

export async function createPlatformTemplate(
  input: CreatePlatformTemplateInput,
  actor: TemplateActor,
): Promise<PlatformTemplateDto> {
  const values: NewPlatformWorkflowTemplate = {
    provenance: input.provenance,
    dataSources: input.dataSources ?? null,
    agentType: input.agentType ?? DEFAULT_TEMPLATE_AGENT_TYPE,
    scheduleCron: input.scheduleCron ?? null,
    scheduleTimezone: input.scheduleTimezone ?? 'UTC',
    content: input.content,
    published: input.published ?? false,
    sortOrder: input.sortOrder ?? 0,
    createdBy: actor.userId,
    createdByEmail: actor.email,
  }
  const row = await insertPlatformTemplate(values)
  return toTemplateDto(row)
}

/**
 * Apply a partial update. A field is written only when the caller supplied it:
 * `undefined` leaves it unchanged; an explicit `null` on `dataSources`/
 * `scheduleCron` clears it (all-sources / manual-only). Returns null on unknown id.
 */
export async function updatePlatformTemplate(
  id: string,
  input: UpdatePlatformTemplateInput,
): Promise<PlatformTemplateDto | null> {
  const patch: Partial<NewPlatformWorkflowTemplate> = { updatedAt: new Date() }
  if (input.provenance !== undefined) patch.provenance = input.provenance
  if (input.dataSources !== undefined) patch.dataSources = input.dataSources ?? null
  if (input.agentType !== undefined) patch.agentType = input.agentType
  if (input.scheduleCron !== undefined) patch.scheduleCron = input.scheduleCron ?? null
  if (input.scheduleTimezone !== undefined) patch.scheduleTimezone = input.scheduleTimezone
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder
  if (input.published !== undefined) patch.published = input.published
  if (input.content !== undefined) patch.content = input.content

  const row = await updatePlatformTemplateRow(id, patch)
  return row ? toTemplateDto(row) : null
}

export async function getPlatformTemplate(id: string): Promise<PlatformTemplateDto | null> {
  const row = await getPlatformTemplateById(id)
  return row ? toTemplateDto(row) : null
}

export async function deletePlatformTemplate(id: string): Promise<boolean> {
  return deletePlatformTemplateRow(id)
}
