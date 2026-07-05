/**
 * Project members API
 *
 * Lists project-resource members and assigns project-level roles through WorkOS FGA.
 */

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { getWorkOS } from '@/lib/workos/client'
import { z } from 'zod'

type ProjectRole = 'project-viewer' | 'project-editor' | 'project-admin'

const PROJECT_ROLE_BY_PERMISSION: Array<{
  permissionSlug: 'project:view' | 'project:edit' | 'project:manage'
  role: ProjectRole
}> = [
  { permissionSlug: 'project:view', role: 'project-viewer' },
  { permissionSlug: 'project:edit', role: 'project-editor' },
  { permissionSlug: 'project:manage', role: 'project-admin' },
]

const addMemberSchema = z.object({
  organizationMembershipId: z.string().min(1),
  roleSlug: z.union([
    z.enum(['project-viewer', 'project-editor', 'project-admin']),
    z.literal(''),
  ]),
})

type RoleAssignment = {
  id: string
  organizationMembershipId?: string
  roleSlug?: string
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:manage')

  const workos = getWorkOS()

  const [usersResp, orgMembershipsResp, ...membershipResponses] = await Promise.all([
    workos.userManagement.listUsers({ organizationId: session.organizationId }),
    workos.userManagement.listOrganizationMemberships({ organizationId: session.organizationId }),
    ...PROJECT_ROLE_BY_PERMISSION.map(({ permissionSlug }) =>
      workos.authorization.listMembershipsForResourceByExternalId({
        organizationId: session.organizationId,
        resourceTypeSlug: 'project',
        externalId: id,
        permissionSlug,
        assignment: 'indirect',
      })
    ),
  ])

  const projectMemberByUserId = new Map<
    string,
    { organizationMembershipId: string; userId: string; role: ProjectRole }
  >()

  const organizationMembersByUserId = new Map(
    orgMembershipsResp.data.map((membership) => [membership.userId, membership])
  )

  membershipResponses.forEach((response, index) => {
    const role = PROJECT_ROLE_BY_PERMISSION[index].role
    for (const membership of response.data) {
      const organizationMembership = organizationMembersByUserId.get(membership.userId)
      projectMemberByUserId.set(membership.userId, {
        organizationMembershipId: organizationMembership?.id ?? membership.id,
        userId: membership.userId,
        role,
      })
    }
  })

  const userById = new Map(usersResp.data.map((user) => [user.id, user]))

  const members = orgMembershipsResp.data.map((organizationMembership) => {
    const user = userById.get(organizationMembership.userId)
    const projectMembership = projectMemberByUserId.get(organizationMembership.userId)
    return {
      organizationMembershipId: organizationMembership.id,
      userId: organizationMembership.userId,
      email: user?.email ?? null,
      name:
        user?.name ||
        (user?.firstName
          ? `${user.firstName} ${user.lastName ?? ''}`.trim()
          : user?.lastName || user?.email || organizationMembership.userId),
      role: projectMembership?.role ?? null,
    }
  })

  return NextResponse.json({ members })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:manage')

  const body = await request.json().catch(() => null)
  const parsed = addMemberSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'organizationMembershipId and a valid roleSlug are required.' },
      { status: 400 },
    )
  }

  const { organizationMembershipId, roleSlug } = parsed.data
  const db = getDb()
  const workos = getWorkOS()

  try {
    const [project] = await db
      .select({ workosResourceId: projects.workosResourceId })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)

    if (!project?.workosResourceId) {
      return NextResponse.json({ error: 'Project resource not found.' }, { status: 404 })
    }

    const assignments = await workos.authorization.listRoleAssignmentsForResource({
      resourceId: project.workosResourceId,
    })

    await Promise.all(
      (assignments.data as RoleAssignment[])
        .filter((assignment) => assignment.organizationMembershipId === organizationMembershipId)
        .map((assignment) =>
          workos.authorization.removeRoleAssignment({
            organizationMembershipId,
            roleAssignmentId: assignment.id,
          })
        )
    )

    if (roleSlug) {
      await workos.authorization.assignRole({
        organizationMembershipId,
        resourceExternalId: id,
        resourceTypeSlug: 'project',
        roleSlug,
      })
    }

    return new NextResponse(null, { status: 201 })
  } catch (error) {
    console.error('[Projects] Failed to assign project role:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
