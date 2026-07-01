// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Project members API
 *
 * Lists project-resource members and assigns project-level roles through WorkOS FGA.
 */

import { NextResponse } from 'next/server'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
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
  roleSlug: z.enum(['project-viewer', 'project-editor', 'project-admin']),
})

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:manage')

  const workos = getWorkOS()

  const [usersResp, ...membershipResponses] = await Promise.all([
    workos.userManagement.listUsers({ organizationId: session.organizationId }),
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

  membershipResponses.forEach((response, index) => {
    const role = PROJECT_ROLE_BY_PERMISSION[index].role
    for (const membership of response.data) {
      projectMemberByUserId.set(membership.userId, {
        organizationMembershipId: membership.id,
        userId: membership.userId,
        role,
      })
    }
  })

  const userById = new Map(usersResp.data.map((user) => [user.id, user]))

  const members = [...projectMemberByUserId.values()].map((membership) => {
    const user = userById.get(membership.userId)
    return {
      organizationMembershipId: membership.organizationMembershipId,
      userId: membership.userId,
      email: user?.email ?? null,
      name:
        user?.name ||
        (user?.firstName
          ? `${user.firstName} ${user.lastName ?? ''}`.trim()
          : user?.lastName || user?.email || membership.userId),
      role: membership.role,
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
  const workos = getWorkOS()

  try {
    await workos.authorization.assignRole({
      organizationMembershipId,
      resourceExternalId: id,
      resourceTypeSlug: 'project',
      roleSlug,
    })

    return new NextResponse(null, { status: 201 })
  } catch (error) {
    console.error('[Projects] Failed to assign project role:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
