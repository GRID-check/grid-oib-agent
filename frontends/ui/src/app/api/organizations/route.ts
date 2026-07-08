/**
 * Organization creation API
 *
 * Creates a new WorkOS organization for the authenticated user, makes the user
 * an admin member, then refreshes the AuthKit session so the access token
 * contains the new org_id claim.
 *
 * Declared through `publicApiRoute` because neither handler can use the
 * standard session guard: GET is an intentionally public deployment-policy
 * probe, and POST authenticates via `refreshSession` — brand-new users have
 * no organization yet, so `requireAuthorizedSession` would reject exactly
 * the callers this endpoint exists for.
 */

import { NextResponse } from 'next/server'
import { refreshSession } from '@workos-inc/authkit-nextjs'
import { z } from 'zod'
import { publicApiRoute } from '@/lib/api/handler'
import { BadRequestError, UnauthorizedError } from '@/lib/api/errors'
import { getWorkOS } from '@/lib/workos/client'
import { recordAuditEvent } from '@/lib/audit/service'

const createOrganizationSchema = z.object({
  name: z.string().min(1).max(100).trim(),
})

/**
 * Sign-up policy for the onboarding UI: whether self-service organization
 * creation is enabled. Safe to expose — it only mirrors a deployment flag.
 */
export const GET = publicApiRoute(async () => ({
  selfServeDisabled: (process.env.GRID_DISABLE_SELF_SERVE_ORGS ?? '').toLowerCase() === 'true',
}))

export const POST = publicApiRoute(async ({ request }) => {
  const body = await request.json().catch(() => null)
  const parsed = createOrganizationSchema.safeParse(body)

  if (!parsed.success) {
    throw new BadRequestError('Organization name is required and must be 1-100 characters.')
  }

  const { name } = parsed.data

  let session
  try {
    session = await refreshSession({ ensureSignedIn: true })
  } catch {
    throw new UnauthorizedError()
  }

  if (!session.user) {
    throw new UnauthorizedError()
  }

  // Enterprise control (ADR-0016): deployments can turn self-service org
  // creation off, so workspaces only come from the platform owner or via
  // invitations. Fresh users then see guidance instead of an org form.
  // Stable error code consumed by the onboarding UI — shape kept as-is.
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

    await recordAuditEvent({
      organizationId: organization.id,
      actor: { userId: session.user.id, email: session.user.email },
      action: 'org.created',
      targetType: 'organization',
      targetId: organization.id,
      metadata: { name },
      request,
    })
    return { organizationId: organization.id }
  } catch (error) {
    // Log the full error server-side; never leak provider internals to the
    // client (raw WorkOS messages can reference internal configuration).
    // Stable error code consumed by the onboarding UI — shape kept as-is.
    console.error('[Organizations] Failed to create organization:', error)
    return NextResponse.json({ error: 'create-failed' }, { status: 500 })
  }
})
