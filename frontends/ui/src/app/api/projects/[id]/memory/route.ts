/**
 * Project memory API — list and manually add memory items.
 * Thin handlers; authz and logic live in `@/lib/projects/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { addProjectMemoryItem, getProjectMemory } from '@/lib/projects/service'
import { PROJECT_MEMORY_CONFIDENCES, PROJECT_MEMORY_KINDS } from '@/lib/db/schema'

type Params = { id: string }

const listMemoryQuerySchema = z.object({
  includeArchived: z.string().optional(),
  // Optional: scope to a single conversation (the chat "Grid noted N" chip).
  conversationId: z.string().optional(),
})

const createMemorySchema = z.object({
  kind: z.enum(PROJECT_MEMORY_KINDS),
  content: z.string().trim().min(1).max(2000),
  confidence: z.enum(PROJECT_MEMORY_CONFIDENCES).optional(),
  pinned: z.boolean().optional(),
})

export const GET = apiRoute<Params>(async ({ session, params, request }) => {
  const query = parseQuery(request, listMemoryQuerySchema)
  const items = await getProjectMemory(session, params.id, {
    includeArchived: query.includeArchived === 'true',
    sourceConversationId: query.conversationId || undefined,
  })
  return { items }
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const input = await parseJsonBody(request, createMemorySchema)
    return { item: await addProjectMemoryItem(session, params.id, input) }
  },
  { status: 201 },
)
