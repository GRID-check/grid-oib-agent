/**
 * Organization member directory (for admin pickers — e.g. per-member budget
 * limits). Org admins only; returns id + email + display name per active
 * member, straight from WorkOS (the identity source of truth, ADR-0007).
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { isOrgAdmin } from '@/lib/authz/organizations'
import { listOrganizationMembers } from '@/lib/organizations/service'

export async function GET(): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    if (!isOrgAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const members = await listOrganizationMembers(session.organizationId)
    return NextResponse.json({ members })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
