import { NextRequest, NextResponse } from 'next/server'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { listProjectFolders, createProjectFolder } from '@/lib/projects/folder-service'
import { z } from 'zod'

const createFolderSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().nullable().optional(),
})

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')

    const folders = await listProjectFolders(id)
    return NextResponse.json({ folders })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    console.error('GET /api/projects/[id]/folders error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params
    await requireProjectAccess(session, id, 'project:edit')

    const body = await request.json()
    const parsed = createFolderSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const result = await createProjectFolder({
      projectId: id,
      name: parsed.data.name,
      parentId: parsed.data.parentId ?? null,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json({ folder: result.folder }, { status: 201 })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    console.error('POST /api/projects/[id]/folders error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
