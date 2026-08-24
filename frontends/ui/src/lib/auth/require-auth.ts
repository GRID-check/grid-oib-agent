/**
 * Authorization guards for server components and route handlers.
 */

import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { isAuthzError } from '@/lib/auth-utils'
import { runWithTenantSlot } from '@/lib/db/tenant-context'
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
 * Run a server component or server action with a session AND a tenant scope.
 *
 * This is the page-tier equivalent of what the route factories in
 * `lib/api/handler.ts` do for all 125 route handlers, and it exists because
 * nothing was doing it for pages. `getGridSession()` publishes the tenant into
 * a slot opened by the caller; with no slot it falls back to
 * `storage.enterWith`, which has no scope end and does not survive the way this
 * Next version renders a component. Every query on the page's call path then
 * ran with no context and failed closed under row-level security -- issues
 * #342 and #344, the same bug twice.
 *
 * `runWithTenantSlot` opens the slot FIRST and resolves the session inside it,
 * so the publish lands in an object bound to this callback's async execution
 * rather than in an ambient binding that React can drop. That ordering is the
 * whole fix, which is why the two are welded together here instead of being
 * left as two calls a page could get the wrong way round.
 *
 * ```tsx
 * export default async function Page(): Promise<JSX.Element> {
 *   return withPageSession(async (session) => {
 *     const data = await getSomeService(session)
 *     return <View data={data} />
 *   })
 * }
 * ```
 *
 * `redirect()` and `notFound()` throw, and the scope unwinds with them exactly
 * as it does in a route handler.
 */
export function withPageSession<T>(fn: (session: AuthorizedSession) => Promise<T> | T): Promise<T> {
  return runWithTenantSlot(async () => fn(await requireAuthorizedPageSession()))
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
