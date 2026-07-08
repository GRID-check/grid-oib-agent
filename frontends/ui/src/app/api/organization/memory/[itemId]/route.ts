/**
 * Organization memory item — update or delete a single org-scoped item.
 * Tenancy comes from the session's organization id (the service scopes the
 * write in SQL). Thin handlers; logic lives in
 * `@/lib/projects/memory-service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { NotFoundError } from '@/lib/api/errors'
import {
  deleteProjectMemoryItem,
  updateProjectMemoryItem,
} from '@/lib/projects/memory-service'
import {
  PROJECT_MEMORY_CONFIDENCES,
  PROJECT_MEMORY_KINDS,
  PROJECT_MEMORY_STATUSES,
  PROJECT_MEMORY_VERIFICATIONS,
} from '@/lib/db/schema'

type Params = { itemId: string }

const patchOrgMemorySchema = z
  .object({
    kind: z.enum(PROJECT_MEMORY_KINDS).optional(),
    content: z.string().trim().min(1).max(2000).optional(),
    status: z.enum(PROJECT_MEMORY_STATUSES).optional(),
    confidence: z.enum(PROJECT_MEMORY_CONFIDENCES).optional(),
    verification: z.enum(PROJECT_MEMORY_VERIFICATIONS).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Empty patch' })

export const PATCH = apiRoute<Params>(async ({ session, params, request }) => {
  const patch = await parseJsonBody(request, patchOrgMemorySchema)
  const item = await updateProjectMemoryItem({ organizationId: session.organizationId }, params.itemId, patch)
  if (!item) throw new NotFoundError()
  return { item }
})

export const DELETE = apiRoute<Params>(async ({ session, params }) => {
  const deleted = await deleteProjectMemoryItem({ organizationId: session.organizationId }, params.itemId)
  if (!deleted) throw new NotFoundError()
  // No body — apiRoute serializes this as a 204.
})
