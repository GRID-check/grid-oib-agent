/**
 * Authorization guards for server components and route handlers.
 */

import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { isAuthzError } from '@/lib/auth-utils'
import { requireGridSession } from './session'
import type { AuthorizedSession } from './types'

/**
 * Error thrown when a signed-in session has not selected a WorkOS organization.
 *
 * API route handlers can map this to a 403 response; page/server-action code
 * should use {@link requireAuthorizedPageSession} to redirect instead.
 */
export class NoOrganizationError extends Error {
  readonly code = 'NO_ORGANIZATION'
  readonly status = 403

  constructor() {
    super('Forbidden: no organization selected')
    this.name = 'NoOrganizationError'
  }
}

/**
 * Require a signed-in Grid session that has selected a WorkOS organization.
 *
 * API-safe guard: throws {@link NoOrganizationError} (never redirects) when no
 * organization is selected, so route handlers can translate it into a 403.
 * Pages and server actions should call {@link requireAuthorizedPageSession},
 * which redirects to the organization onboarding flow instead.
 *
 * @throws {NoOrganizationError} when the session has no organization.
 */
export async function requireAuthorizedSession(): Promise<AuthorizedSession> {
  const session = await requireGridSession()

  if (!session.organizationId) {
    throw new NoOrganizationError()
  }

  return session as AuthorizedSession
}

/**
 * Page/server-action variant of {@link requireAuthorizedSession}.
 *
 * Users without an organization are redirected to the organization onboarding
 * flow so the BFF can resolve org-scoped roles and permissions. Any other
 * error (e.g. missing session) is rethrown unchanged.
 */
export async function requireAuthorizedPageSession(): Promise<AuthorizedSession> {
  try {
    return await requireAuthorizedSession()
  } catch (error) {
    if (error instanceof NoOrganizationError) {
      redirect('/app/onboarding/organization')
    }
    throw error
  }
}

/**
 * Map a caught error to a 403 JSON response when it is an authorization
 * failure (no organization selected, forbidden, unauthorized, not-found);
 * otherwise return null so the caller falls through to its own handling
 * (typically rethrow → Next.js 500). Lets API route handlers apply the
 * no-organization → 403 contract uniformly instead of letting
 * {@link NoOrganizationError} escape as an opaque 500:
 *
 * ```ts
 * } catch (error) {
 *   const denied = authzErrorResponse(error)
 *   if (denied) return denied
 *   throw error
 * }
 * ```
 */
export function authzErrorResponse(error: unknown): NextResponse | null {
  if (isAuthzError(error)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}
