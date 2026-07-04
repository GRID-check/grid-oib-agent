import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { isAuthzError } from '@/lib/auth-utils'
import {
  createProjectMemoryItem,
  listOrganizationMemory,
} from '@/lib/projects/memory-service'
import {
  PROJECT_MEMORY_CONFIDENCES,
  PROJECT_MEMORY_KINDS,
} from '@/lib/db/schema'

/**
 * Organization-scoped memory — cross-cutting knowledge shared by every
 * project in the caller's organization. Tenancy comes from the session's
 * organization id; items are never visible across organizations.
 */

const createOrgMemorySchema = z.object({
  kind: z.enum(PROJECT_MEMORY_KINDS),
  content: z.string().trim().min(1).max(2000),
  confidence: z.enum(PROJECT_MEMORY_CONFIDENCES).optional(),
  pinned: z.boolean().optional(),
})

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { searchParams } = new URL(request.url)
    const includeArchived = searchParams.get('includeArchived') === 'true'
    const items = await listOrganizationMemory(session.organizationId, { includeArchived })
    return NextResponse.json({ items })
  } catch (error) {
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('[Org Memory API] GET error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()

    const body = await request.json().catch(() => null)
    const parsed = createOrgMemorySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid memory item.' }, { status: 400 })
    }

    const item = await createProjectMemoryItem({
      scope: 'organization',
      projectId: null,
      organizationId: session.organizationId,
      kind: parsed.data.kind,
      content: parsed.data.content,
      confidence: parsed.data.confidence ?? 'medium',
      pinned: parsed.data.pinned ?? false,
      provenanceType: 'user',
      verification: 'user_confirmed',
      createdBy: session.userId,
    })

    return NextResponse.json({ item }, { status: 201 })
  } catch (error) {
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('[Org Memory API] POST error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
