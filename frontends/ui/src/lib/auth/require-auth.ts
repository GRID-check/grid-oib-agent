/**
 * Authorization guards for server components and route handlers.
 */

import { redirect } from 'next/navigation'
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
