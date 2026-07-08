/**
 * Project member assignment removal API
 *
 * Removes a WorkOS FGA role assignment from a project.
 */

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { getWorkOS } from '@/lib/workos/client'
import { projects } from '@/lib/db/schema'
import { recordAuditEvent } from '@/lib/audit/service'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; assignmentId: string }> },
): Promise<Response> {
  try {
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

      await recordAuditEvent({
        organizationId: session.organizationId,
        actor: { userId: session.userId, email: session.email },
        action: 'project.role.removed',
        targetType: 'project',
        targetId: id,
        metadata: { organizationMembershipId: assignment.organizationMembershipId, roleSlug: 'none' },
        request,
      })
      return new NextResponse(null, { status: 204 })
    } catch (error) {
      console.error('[Projects] Failed to remove project role assignment:', error)
      const message = error instanceof Error ? error.message : 'Unknown error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  } catch (err) {
    const denied = authzErrorResponse(err)
    if (denied) return denied
    throw err
  }
}
