import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  createProjectMemoryItem,
  createProjectMemoryItemForProject,
} from '@/lib/projects/memory-service'
import {
  PROJECT_MEMORY_CONFIDENCES,
  PROJECT_MEMORY_KINDS,
} from '@/lib/db/schema'

/**
 * INTERNAL service endpoint — the write path for the backend agent's
 * `remember` tool. Keeps grid_app single-writer: the Python backend never
 * touches the database; it calls this route over the compose network,
 * authenticated by a shared service token (GRID_INTERNAL_API_TOKEN on both
 * services). Not user-facing; requests without the token are rejected, and
 * the route fails closed when the token is unconfigured.
 */

const INTERNAL_TOKEN_HEADER = 'x-grid-internal-token'

const internalMemorySchema = z
  .object({
    scope: z.enum(['project', 'organization']).default('project'),
    projectId: z.string().uuid().optional(),
    organizationId: z.string().min(1).optional(),
    kind: z.enum(PROJECT_MEMORY_KINDS),
    content: z.string().trim().min(1).max(2000),
    confidence: z.enum(PROJECT_MEMORY_CONFIDENCES).default('medium'),
    sourceConversationId: z.string().max(255).optional(),
  })
  .refine((v) => (v.scope === 'project' ? !!v.projectId : !!v.organizationId), {
    message: 'project scope requires projectId; organization scope requires organizationId',
  })

export async function POST(request: Request): Promise<Response> {
  const expectedToken = process.env.GRID_INTERNAL_API_TOKEN
  if (!expectedToken) {
    console.error('[Internal Memory API] GRID_INTERNAL_API_TOKEN is not configured — rejecting')
    return NextResponse.json({ error: 'Internal API disabled' }, { status: 503 })
  }
  if (request.headers.get(INTERNAL_TOKEN_HEADER) !== expectedToken) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const body = await request.json().catch(() => null)
    const parsed = internalMemorySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid memory payload.' }, { status: 400 })
    }

    const { scope, projectId, organizationId, kind, content, confidence, sourceConversationId } = parsed.data

    const item =
      scope === 'project'
        ? await createProjectMemoryItemForProject(projectId as string, {
            kind,
            content,
            confidence,
            sourceConversationId: sourceConversationId ?? null,
            provenanceType: 'agent',
          })
        : await createProjectMemoryItem({
            scope: 'organization',
            projectId: null,
            organizationId: organizationId as string,
            kind,
            content,
            confidence,
            sourceConversationId: sourceConversationId ?? null,
            provenanceType: 'agent',
          })

    if (!item) {
      return NextResponse.json({ error: 'Unknown project' }, { status: 404 })
    }

    return NextResponse.json({ item }, { status: 201 })
  } catch (error) {
    console.error('[Internal Memory API] Error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
