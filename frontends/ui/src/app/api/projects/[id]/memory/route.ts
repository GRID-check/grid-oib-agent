import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { isAuthzError } from '@/lib/auth-utils'
import {
  createProjectMemoryItem,
  listProjectMemory,
} from '@/lib/projects/memory-service'
import {
  PROJECT_MEMORY_CONFIDENCES,
  PROJECT_MEMORY_KINDS,
} from '@/lib/db/schema'

const createMemorySchema = z.object({
  kind: z.enum(PROJECT_MEMORY_KINDS),
  content: z.string().trim().min(1).max(2000),
  confidence: z.enum(PROJECT_MEMORY_CONFIDENCES).optional(),
  pinned: z.boolean().optional(),
})

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params

    await requireProjectAccess(session, id, 'project:view')

    const { searchParams } = new URL(request.url)
    const includeArchived = searchParams.get('includeArchived') === 'true'
    // Includes the org-wide items that apply to every project in the org.
    const items = await listProjectMemory(id, { includeArchived, organizationId: session.organizationId })
    return NextResponse.json({ items })
  } catch (error) {
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('[Project Memory API] GET error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params

    await requireProjectAccess(session, id, 'project:edit')

    const body = await request.json().catch(() => null)
    const parsed = createMemorySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid memory item.' }, { status: 400 })
    }

    const item = await createProjectMemoryItem({
      scope: 'project',
      projectId: id,
      organizationId: session.organizationId,
      kind: parsed.data.kind,
      content: parsed.data.content,
      confidence: parsed.data.confidence ?? 'medium',
      pinned: parsed.data.pinned ?? false,
      // Manually-added items are user-authored and user-confirmed by definition.
      provenanceType: 'user',
      verification: 'user_confirmed',
      createdBy: session.userId,
    })

    return NextResponse.json({ item }, { status: 201 })
  } catch (error) {
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('[Project Memory API] POST error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
