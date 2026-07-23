/**
 * Platform workflow templates API client (ADR-0027).
 *
 * Two audiences, one module:
 *  - The PLATFORM manager (`/api/platform/workflow-templates…`) — owner-only
 *    CRUD + publish toggle; the create payload doubles as the JSON import shape.
 *  - The org GALLERY read (`/api/workflow-templates`) — the published,
 *    both-locale projection every org's Workflows page merges with the built-in
 *    templates.
 *
 * Same-origin BFF routes returning the camelCase envelope; style mirrors
 * `workflows-client.ts`.
 */

import { ApiRequestError } from './api-error'
import type { WorkflowDefinition } from './workflows-client'

export type { WorkflowDefinition }

/** Presentational provenance tint for the gallery card icon tile. */
export type TemplateProvenance = 'law' | 'project' | 'office' | 'auto'

/** The two locales a platform template must supply. */
export type TemplateLocale = 'de' | 'en'

/** One locale's author-written content. */
export interface LocalizedTemplateContent {
  name: string
  description: string
  category: string
  definition: WorkflowDefinition
}

export type PlatformTemplateContent = Record<TemplateLocale, LocalizedTemplateContent>

/** Full record returned to the platform owner (drafts included). */
export interface PlatformTemplate {
  id: string
  provenance: TemplateProvenance
  dataSources: string[] | null
  agentType: string
  scheduleCron: string | null
  scheduleTimezone: string
  content: PlatformTemplateContent
  published: boolean
  sortOrder: number
  createdByEmail: string | null
  createdAt: string
  updatedAt: string
}

/** Lean published projection the org gallery consumes (no author PII). */
export interface GalleryTemplate {
  id: string
  provenance: TemplateProvenance
  dataSources: string[] | null
  scheduleCron: string | null
  scheduleTimezone: string
  content: PlatformTemplateContent
}

/** Create/import payload (matches the BFF create schema). */
export interface CreatePlatformTemplateInput {
  provenance?: TemplateProvenance
  dataSources?: string[] | null
  agentType?: string
  scheduleCron?: string | null
  scheduleTimezone?: string
  sortOrder?: number
  published?: boolean
  content: PlatformTemplateContent
}

/** Partial update payload. */
export type UpdatePlatformTemplateInput = Partial<CreatePlatformTemplateInput>

/** Carries the BFF error `code` + status so callers can branch structurally. */
export class PlatformTemplateApiError extends ApiRequestError {
  readonly code: string | null
  readonly serverMessage: string | null
  readonly details: unknown

  constructor(message: string, status: number, code: string | null, serverMessage: string | null, details: unknown) {
    super(message, status)
    this.name = 'PlatformTemplateApiError'
    this.code = code
    this.serverMessage = serverMessage
    this.details = details
  }
}

const jsonHeaders: HeadersInit = { 'Content-Type': 'application/json' }
const PLATFORM_BASE = '/api/platform/workflow-templates'
const GALLERY_BASE = '/api/workflow-templates'

async function throwApiError(response: Response, context: string): Promise<never> {
  const text = await response.text().catch(() => '')
  let message: string | null = null
  let code: string | null = null
  let details: unknown = undefined
  if (text) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown; code?: unknown; details?: unknown }
      if (typeof parsed.error === 'string') message = parsed.error
      if (typeof parsed.code === 'string') code = parsed.code
      details = parsed.details
    } catch {
      message = text
    }
  }
  throw new PlatformTemplateApiError(
    `${context}: ${response.status}${message ? ` - ${message}` : ''}`,
    response.status,
    code,
    message,
    details,
  )
}

// ── Platform owner CRUD ──────────────────────────────────────────────────────

export async function listPlatformTemplates(): Promise<PlatformTemplate[]> {
  const response = await fetch(PLATFORM_BASE, { headers: jsonHeaders })
  if (!response.ok) await throwApiError(response, 'Failed to list templates')
  const data = (await response.json()) as { templates?: PlatformTemplate[] }
  return data.templates ?? []
}

export async function createPlatformTemplate(input: CreatePlatformTemplateInput): Promise<PlatformTemplate> {
  const response = await fetch(PLATFORM_BASE, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) await throwApiError(response, 'Failed to create template')
  return (await response.json()) as PlatformTemplate
}

export async function updatePlatformTemplate(
  id: string,
  input: UpdatePlatformTemplateInput,
): Promise<PlatformTemplate> {
  const response = await fetch(`${PLATFORM_BASE}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) await throwApiError(response, 'Failed to update template')
  return (await response.json()) as PlatformTemplate
}

export async function deletePlatformTemplate(id: string): Promise<void> {
  const response = await fetch(`${PLATFORM_BASE}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: jsonHeaders,
  })
  if (!response.ok) await throwApiError(response, 'Failed to delete template')
}

// ── Org gallery read ─────────────────────────────────────────────────────────

export async function listGalleryTemplates(): Promise<GalleryTemplate[]> {
  const response = await fetch(GALLERY_BASE, { headers: jsonHeaders })
  if (!response.ok) await throwApiError(response, 'Failed to load workflow templates')
  const data = (await response.json()) as { templates?: GalleryTemplate[] }
  return data.templates ?? []
}
