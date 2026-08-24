/**
 * Organization-scoped memory — cross-cutting knowledge shared by every
 * project in the caller's organization. Tenancy comes from the session's
 * organization id; items are never visible across organizations. Any member
 * may read and write org memory (deliberately not admin-gated).
 *
 * Thin handlers; all logic lives in `@/lib/projects/memory-service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { createProjectMemoryItem, listOrganizationMemory } from '@/lib/projects/memory-service'
import { PROJECT_MEMORY_CONFIDENCES, PROJECT_MEMORY_KINDS } from '@/lib/db/schema'

const createOrgMemorySchema = z.object({
  kind: z.enum(PROJECT_MEMORY_KINDS),
  content: z.string().trim().min(1).max(2000),
  confidence: z.enum(PROJECT_MEMORY_CONFIDENCES).optional(),
  pinned: z.boolean().optional(),
})

export const GET = apiRoute(
  async ({ session, request }) => {
    const includeArchived = new URL(request.url).searchParams.get('includeArchived') === 'true'
    return { items: await listOrganizationMemory(session.organizationId, { includeArchived }) }
  },
  {
    authz: {
      sessionOnly: true,
      why: 'org-wide memory is shared by every project in the tenant and scoped by session.organizationId; deliberately not admin-gated',
    },
  }
)

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, createOrgMemorySchema)
    const item = await createProjectMemoryItem({
      scope: 'organization',
      projectId: null,
      organizationId: session.organizationId,
      kind: input.kind,
      content: input.content,
      confidence: input.confidence ?? 'medium',
      pinned: input.pinned ?? false,
      provenanceType: 'user',
      verification: 'user_confirmed',
      createdBy: session.userId,
    })
    return { item }
  },
  {
    status: 201,
    authz: {
      sessionOnly: true,
      why: 'org-wide memory is shared by every project in the tenant and scoped by session.organizationId; deliberately not admin-gated',
    },
  }
)
