import { NextResponse } from 'next/server'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getProjectOverviewData } from '@/lib/projects/overview-query'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')

    const data = await getProjectOverviewData(id, session.organizationId)

    if (!data) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    return NextResponse.json(data)
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    console.error('GET /api/projects/[id]/overview error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
