// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Organization creation API
 *
 * Creates a new WorkOS organization for the authenticated user, makes the user
 * an admin member, then refreshes the AuthKit session so the access token
 * contains the new org_id claim.
 */

import { NextResponse } from 'next/server'
import { refreshSession } from '@workos-inc/authkit-nextjs'
import { getWorkOS } from '@/lib/workos/client'
import { z } from 'zod'

const createOrganizationSchema = z.object({
  name: z.string().min(1).max(100).trim(),
})

export const POST = async (request: Request): Promise<Response> => {
  const body = await request.json().catch(() => null)
  const parsed = createOrganizationSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Organization name is required and must be 1-100 characters.' },
      { status: 400 }
    )
  }

  const { name } = parsed.data

  let session
  try {
    session = await refreshSession({ ensureSignedIn: true })
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!session.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workos = getWorkOS()

  try {
    const organization = await workos.organizations.createOrganization({ name })

    await workos.userManagement.createOrganizationMembership({
      userId: session.user.id,
      organizationId: organization.id,
      roleSlug: 'admin',
    })

    await refreshSession({ organizationId: organization.id, ensureSignedIn: true })

    return NextResponse.json({ organizationId: organization.id })
  } catch (error) {
    console.error('[Organizations] Failed to create organization:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
