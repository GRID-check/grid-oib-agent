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

/**
 * Sign-up policy for the onboarding UI: whether self-service organization
 * creation is enabled. Safe to expose — it only mirrors a deployment flag.
 */
export const GET = async (): Promise<Response> => {
  return NextResponse.json({
    selfServeDisabled: (process.env.GRID_DISABLE_SELF_SERVE_ORGS ?? '').toLowerCase() === 'true',
  })
}

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

  // Enterprise control (ADR-0016): deployments can turn self-service org
  // creation off, so workspaces only come from the platform owner or via
  // invitations. Fresh users then see guidance instead of an org form.
  if ((process.env.GRID_DISABLE_SELF_SERVE_ORGS ?? '').toLowerCase() === 'true') {
    return NextResponse.json({ error: 'self-serve-disabled' }, { status: 403 })
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
    // Log the full error server-side; never leak provider internals to the
    // client (raw WorkOS messages can reference internal configuration).
    console.error('[Organizations] Failed to create organization:', error)
    return NextResponse.json({ error: 'create-failed' }, { status: 500 })
  }
}
