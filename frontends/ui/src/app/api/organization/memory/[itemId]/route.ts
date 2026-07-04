import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { isAuthzError } from '@/lib/auth-utils'
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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { itemId } = await params

    const body = await request.json().catch(() => null)
    const parsed = patchOrgMemorySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid memory patch.' }, { status: 400 })
    }

    const item = await updateProjectMemoryItem({ organizationId: session.organizationId }, itemId, parsed.data)
    if (!item) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json({ item })
  } catch (error) {
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('[Org Memory API] PATCH error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { itemId } = await params

    const deleted = await deleteProjectMemoryItem({ organizationId: session.organizationId }, itemId)
    if (!deleted) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return new Response(null, { status: 204 })
  } catch (error) {
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('[Org Memory API] DELETE error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
