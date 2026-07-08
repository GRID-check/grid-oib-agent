/**
 * Route-handler factories for the BFF (ADR: repository/service architecture).
 *
 * Every `app/api` route MUST be declared through one of these factories so
 * that authentication, authorization, input validation, and error mapping
 * are enforced in exactly one place:
 *
 *   - `apiRoute`          — session-authenticated routes (the default).
 *   - `internalApiRoute`  — service-to-service routes guarded by
 *                           `GRID_INTERNAL_API_TOKEN`.
 *   - `publicApiRoute`    — the rare intentionally unauthenticated route
 *                           (health checks). Using it is an explicit,
 *                           grep-able decision.
 *
 * Handlers receive a typed context and return plain data (serialized as
 * JSON) or a `Response` for special cases (streams, redirects). They signal
 * failures by throwing `ApiError`s from `@/lib/api/errors` — never by
 * hand-rolling `NextResponse.json({ error })`.
 */

import { NextResponse } from 'next/server'
import { ZodError, type ZodType, type output } from 'zod'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { isAuthzError } from '@/lib/auth-utils'
import { hasPermission, type KnownPermission } from '@/lib/authz/permissions'
import { requireInternalToken } from '@/lib/internal-auth'
import type { AuthorizedSession } from '@/lib/auth/types'
import { ApiError, BadRequestError, ForbiddenError } from './errors'

/** Context passed to session-authenticated handlers. */
export interface ApiContext<TParams = Record<string, never>> {
  request: Request
  session: AuthorizedSession
  /** Resolved dynamic segment params (`[id]`, `[...path]`). */
  params: TParams
}

/** Context passed to internal (token-guarded) handlers — no user session. */
export interface InternalApiContext<TParams = Record<string, never>> {
  request: Request
  params: TParams
}

export interface PublicApiContext<TParams = Record<string, never>> {
  request: Request
  params: TParams
}

interface RouteOptions {
  /**
   * Require an org-tier or platform-tier permission (registry:
   * `@/lib/authz/permissions`). Checked after authentication, before the
   * handler runs. Finer-grained checks (per-project FGA) belong in services.
   */
  permission?: KnownPermission
  /** Status code for successful non-Response results (default 200). */
  status?: number
}

type NextRouteContext = { params?: Promise<Record<string, string | string[]>> }

function successResponse(result: unknown, status: number): Response {
  if (result instanceof Response) return result
  if (result === undefined || result === null) {
    return new NextResponse(null, { status: status === 200 ? 204 : status })
  }
  return NextResponse.json(result, { status })
}

/**
 * Next.js control-flow errors (redirect(), notFound()) must propagate to the
 * framework — converting them to a JSON 500 would break auth redirects.
 */
function isNextControlFlowError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const digest = (error as { digest?: unknown }).digest
  const marker = typeof digest === 'string' ? digest : error.message
  return marker === 'NEXT_NOT_FOUND' || marker.startsWith('NEXT_REDIRECT') || marker.startsWith('NEXT_HTTP_ERROR_FALLBACK')
}

function errorResponse(error: unknown, request: Request): Response {
  if (isNextControlFlowError(error)) throw error
  if (error instanceof ApiError) {
    const body: Record<string, unknown> = { error: error.message, code: error.code }
    if (error.details !== undefined) body.details = error.details
    return NextResponse.json(body, { status: error.status })
  }
  // Legacy guards (requireGridSession, requireProjectAccess, WorkOS client
  // wrappers) throw plain Errors classified by message. Map them exactly as
  // authzErrorResponse() did so behavior stays stable while they migrate.
  if (isAuthzError(error)) {
    return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 })
  }
  const url = new URL(request.url)
  console.error(`[api] Unhandled error in ${request.method} ${url.pathname}:`, error)
  return NextResponse.json({ error: 'Internal server error', code: 'INTERNAL' }, { status: 500 })
}

async function resolveParams(context: NextRouteContext | undefined): Promise<Record<string, string | string[]>> {
  return context?.params ? await context.params : {}
}

/**
 * Declare a session-authenticated route handler.
 *
 * ```ts
 * export const GET = apiRoute(async ({ session }) => listProjects(session))
 * export const POST = apiRoute(
 *   async ({ session, request }) => createProject(session, await parseJsonBody(request, schema)),
 *   { status: 201 },
 * )
 * ```
 */
export function apiRoute<TParams = Record<string, string | string[]>>(
  handler: (ctx: ApiContext<TParams>) => Promise<unknown>,
  options: RouteOptions = {},
) {
  return async (request: Request, context?: NextRouteContext): Promise<Response> => {
    try {
      const session = await requireAuthorizedSession()
      if (options.permission && !hasPermission(session, options.permission)) {
        throw new ForbiddenError()
      }
      const params = (await resolveParams(context)) as TParams
      const result = await handler({ request, session, params })
      return successResponse(result, options.status ?? 200)
    } catch (error) {
      return errorResponse(error, request)
    }
  }
}

/**
 * Declare an internal service-to-service route guarded by
 * `GRID_INTERNAL_API_TOKEN` (fail-closed; see `@/lib/internal-auth`).
 */
export function internalApiRoute<TParams = Record<string, string | string[]>>(
  label: string,
  handler: (ctx: InternalApiContext<TParams>) => Promise<unknown>,
  options: Omit<RouteOptions, 'permission'> = {},
) {
  return async (request: Request, context?: NextRouteContext): Promise<Response> => {
    const denied = requireInternalToken(request, label)
    if (denied) return denied
    try {
      const params = (await resolveParams(context)) as TParams
      const result = await handler({ request, params })
      return successResponse(result, options.status ?? 200)
    } catch (error) {
      return errorResponse(error, request)
    }
  }
}

/**
 * Declare an intentionally unauthenticated route (health/liveness only).
 * Any other use requires an ADR-documented decision.
 */
export function publicApiRoute<TParams = Record<string, string | string[]>>(
  handler: (ctx: PublicApiContext<TParams>) => Promise<unknown>,
  options: Omit<RouteOptions, 'permission'> = {},
) {
  return async (request: Request, context?: NextRouteContext): Promise<Response> => {
    try {
      const params = (await resolveParams(context)) as TParams
      const result = await handler({ request, params })
      return successResponse(result, options.status ?? 200)
    } catch (error) {
      return errorResponse(error, request)
    }
  }
}

/**
 * Parse and validate a JSON request body against a zod schema.
 * Malformed JSON and schema violations both surface as 400s with issues.
 */
export async function parseJsonBody<TSchema extends ZodType>(
  request: Request,
  schema: TSchema,
): Promise<output<TSchema>> {
  const raw = await request.json().catch(() => {
    throw new BadRequestError('Invalid JSON body')
  })
  try {
    return schema.parse(raw)
  } catch (error) {
    if (error instanceof ZodError) {
      throw new BadRequestError('Invalid request body', error.issues)
    }
    throw error
  }
}

/** Parse and validate URL query params against a zod schema (400 on failure). */
export function parseQuery<TSchema extends ZodType>(request: Request, schema: TSchema): output<TSchema> {
  const url = new URL(request.url)
  const query = Object.fromEntries(url.searchParams.entries())
  try {
    return schema.parse(query)
  } catch (error) {
    if (error instanceof ZodError) {
      throw new BadRequestError('Invalid query parameters', error.issues)
    }
    throw error
  }
}
