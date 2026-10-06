/**
 * The Papierkorb client (ADR-0081): a project's deleted folders, restoring one,
 * purging one now, and the organization's setting for content derived from
 * deleted folders.
 */

import { z } from 'zod'
import { ApiRequestError } from './api-error'

const BinEntrySchema = z.object({
  folderId: z.string(),
  name: z.string(),
  path: z.string(),
  deletedAt: z.string(),
  deletedBy: z.object({ userId: z.string().nullable(), name: z.string().nullable() }),
  purgeAfter: z.string(),
  status: z.string(),
  documents: z.number(),
  folders: z.number(),
  canRestore: z.boolean(),
})

export type FolderBinEntry = z.infer<typeof BinEntrySchema>

const BinListingSchema = z.object({
  entries: z.array(BinEntrySchema),
  canPurge: z.boolean(),
})

export type FolderBinListing = z.infer<typeof BinListingSchema>

const RestoreSchema = z.object({
  restoredTo: z.enum(['original', 'root']),
  folders: z.number(),
  documents: z.number(),
})

export type RestoreFolderResult = z.infer<typeof RestoreSchema>

const CountsSchema = z.object({
  documents: z.number(),
  folders: z.number(),
  memoryNotes: z.number(),
  answers: z.number(),
  conversations: z.number(),
  reports: z.number(),
  tracesErased: z.number(),
})

const PurgeSchema = z.object({ status: z.string(), counts: CountsSchema })

export const DELETED_FOLDER_CONTENT_POLICIES = ['unchanged', 'project', 'admins', 'remove'] as const
export type DeletedFolderContentPolicy = (typeof DELETED_FOLDER_CONTENT_POLICIES)[number]

const PolicySchema = z.object({ policy: z.enum(DELETED_FOLDER_CONTENT_POLICIES) })

/** A refusal, with the machine-readable reason when the server gave one. */
export class FolderBinRequestError extends ApiRequestError {
  constructor(
    message: string,
    status: number,
    readonly reason: string | null
  ) {
    super(message, status)
  }
}

async function request<T>(url: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const record = (body ?? {}) as { error?: unknown; details?: { reason?: unknown } }
    const message = typeof record.error === 'string' ? record.error : `Request failed: ${response.status}`
    const reason = typeof record.details?.reason === 'string' ? record.details.reason : null
    throw new FolderBinRequestError(message, response.status, reason)
  }
  return schema.parse(await response.json())
}

const project = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}`

export function listFolderBin(projectId: string): Promise<FolderBinListing> {
  return request(`${project(projectId)}/bin`, { method: 'GET' }, BinListingSchema)
}

export function restoreFolder(projectId: string, folderId: string): Promise<RestoreFolderResult> {
  return request(`${project(projectId)}/bin/${encodeURIComponent(folderId)}/restore`, { method: 'POST' }, RestoreSchema)
}

export function purgeFolderNow(projectId: string, folderId: string): Promise<z.infer<typeof PurgeSchema>> {
  return request(`${project(projectId)}/bin/${encodeURIComponent(folderId)}`, { method: 'DELETE' }, PurgeSchema)
}

export async function getDeletedFolderContentPolicy(): Promise<DeletedFolderContentPolicy> {
  return (await request('/api/organization/deleted-folder-content', { method: 'GET' }, PolicySchema)).policy
}

export async function saveDeletedFolderContentPolicy(policy: DeletedFolderContentPolicy): Promise<DeletedFolderContentPolicy> {
  return (
    await request(
      '/api/organization/deleted-folder-content',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy }) },
      PolicySchema
    )
  ).policy
}
