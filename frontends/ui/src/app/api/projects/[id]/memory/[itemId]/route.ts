/**
 * Project memory item API — edit or delete a single memory item.
 * Thin handlers; authz and logic live in `@/lib/projects/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { editProjectMemoryItem, removeProjectMemoryItem } from '@/lib/projects/service'
import {
  PROJECT_MEMORY_CONFIDENCES,
  PROJECT_MEMORY_KINDS,
  PROJECT_MEMORY_STATUSES,
  PROJECT_MEMORY_VERIFICATIONS,
} from '@/lib/db/schema'

type Params = { id: string; itemId: string }

const patchMemorySchema = z
  .object({
    kind: z.enum(PROJECT_MEMORY_KINDS).optional(),
    content: z.string().trim().min(1).max(2000).optional(),
    status: z.enum(PROJECT_MEMORY_STATUSES).optional(),
    confidence: z.enum(PROJECT_MEMORY_CONFIDENCES).optional(),
    verification: z.enum(PROJECT_MEMORY_VERIFICATIONS).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Empty patch' })

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const patch = await parseJsonBody(request, patchMemorySchema)
    return { item: await editProjectMemoryItem(session, params.id, params.itemId, patch) }
  },
  { authz: { enforcedBy: 'editProjectMemoryItem (requireProjectAccess project:memory:write)' } }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params }) => {
    await removeProjectMemoryItem(session, params.id, params.itemId)
  },
  { authz: { enforcedBy: 'removeProjectMemoryItem (requireProjectAccess project:memory:write)' } }
)
