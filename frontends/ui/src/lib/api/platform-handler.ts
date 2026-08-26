/**
 * The platform-owner route factory (ADR-0016, ADR-0038).
 *
 * Deliberately a SEPARATE module from `./handler`: it needs `getGridSession`,
 * which pulls in `@workos-inc/authkit-nextjs`, and `handler.ts` is imported by
 * every route in the app. Keeping the two apart means the ~100 non-platform
 * routes (and their specs) never load AuthKit just to get `apiRoute`.
 */

import { NextResponse } from 'next/server'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformPermission } from '@/lib/authz/platform'
import type { PlatformPermission } from '@/lib/authz/permissions'
import { runWithTenantSlot, withPlatformAccess } from '@/lib/db/tenant-context'
import type { GridSession } from '@/lib/auth/types'
import { errorResponse, resolveParams, successResponse, type NextRouteContext } from './handler'

/**
 * How a platform route is authorized. Required, for the same reason `apiRoute`'s
 * `authz` is (ADR-0038): the factory used to ask one binary question —
 * "is this platform staff?" — which cannot express a read-only role. It said yes
 * to `org-platform-support` on eleven mutating routes.
 */
export interface PlatformRouteOptions {
  /**
   * The platform permission this route requires, checked before the handler
   * runs. Reads take a `*:view` permission; anything that writes takes a
   * `*:manage` one, which is what keeps Platform Support read-only.
   */
  readonly permission: PlatformPermission
  /** Status code for successful non-Response results (default 200). */
  readonly status?: number
}

/** Context passed to platform-owner handlers. The session may have no active org. */
export interface PlatformApiContext<TParams = Record<string, never>> {
  request: Request
  /** The platform owner's session. `organizationId` may be any org they browse. */
  session: GridSession
  params: TParams
}

/**
 * Declare a platform-owner route (ADR-0016).
 *
 * Eighteen routes used to open with the same twelve lines: resolve the session,
 * a platform gate, then a bespoke try/catch translating
 * `PlatformAccessDeniedError` into a 403 and delegating everything else to
 * `authzErrorResponse`. Every copy was a chance to get the translation subtly
 * wrong, and none of them went through the shared factory, so none of them
 * benefited from its error mapping.
 *
 * The gate runs BEFORE the handler, so it cannot be lost by editing the body.
 */
export function platformApiRoute<TParams = Record<string, string | string[]>>(
  handler: (ctx: PlatformApiContext<TParams>) => Promise<unknown>,
  options: PlatformRouteOptions
) {
  return async (request: Request, context?: NextRouteContext): Promise<Response> => {
    // Bounded slot per request — see `runWithTenantSlot`. Without it a platform
    // route could inherit a tenant scope from the previous request on this
    // socket and run its handler under that instead of the bypass below.
    return runWithTenantSlot(async () => {
      try {
        const session = await getGridSession()
        await requirePlatformPermission(session, options.permission)
        const params = (await resolveParams(context)) as TParams
        // The platform tier is cross-organization by definition, so its queries
        // run under the audited bypass (ADR-0041) rather than as one tenant. The
        // gate above has already established that the caller holds the platform
        // permission this route requires, which is the authorization this bypass
        // rests on.
        const result = await withPlatformAccess(`platformApiRoute ${request.method}`, () =>
          // requirePlatformPermission throws unless the session is non-null.
          handler({ request, session: session as GridSession, params })
        )
        return successResponse(result, options.status ?? 200)
      } catch (error) {
        if (error instanceof PlatformAccessDeniedError) {
          return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 })
        }
        return errorResponse(error, request)
      }
    })
  }
}
