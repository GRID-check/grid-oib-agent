/**
 * Project member assignment removal API
 *
 * Removes a WorkOS FGA role assignment from a project.
 */

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { getWorkOS } from '@/lib/workos/client'
import { projects } from '@/lib/db/schema'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; assignmentId: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id, assignmentId } = await params

  await requireProjectAccess(session, id, 'project:manage')

  const db = getDb()
  const [project] = await db
    .select({ workosResourceId: projects.workosResourceId })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)

  if (!project?.workosResourceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const workos = getWorkOS()

  try {
    const assignments = await workos.authorization.listRoleAssignmentsForResource({
      resourceId: project.workosResourceId,
    })

    const assignment = assignments.data.find((a) => a.id === assignmentId)

    if (!assignment) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    await workos.authorization.removeRoleAssignment({
      organizationMembershipId: assignment.organizationMembershipId,
      roleAssignmentId: assignment.id,
    })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    console.error('[Projects] Failed to remove project role assignment:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
