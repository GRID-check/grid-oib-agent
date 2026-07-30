/**
 * Route-handler factories for the BFF (ADR-0017, ADR-0038).
 *
 * Every `app/api` route MUST be declared through one of these factories so
 * that authentication, authorization, input validation, and error mapping
 * are enforced in exactly one place:
 *
 *   - `apiRoute`          — session-authenticated routes (the default).
 *   - `platformApiRoute`  — platform-owner routes (ADR-0016), in
 *                           `./platform-handler` so that AuthKit stays out
 *                           of the module every route imports.
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
 *
 * ## Why authorization is a REQUIRED argument
 *
 * `authz` is not optional, and that is the point (ADR-0038). The audit that
 * produced this design found four different enforcement styles across 117
 * routes — factory-checked, service-checked, hand-rolled, and a handful with
 * the gate simply absent — and no way to tell them apart without reading each
 * handler. Nothing failed when a route shipped ungated; it just shipped.
 *
 * Making the posture a required, typed argument converts that from a review
 * question into a compile error: a new route cannot be merged without stating
 * how it is authorized, and `authz-coverage.spec.ts` turns the declarations
 * into an inventory the whole endpoint surface can be audited from.
 *
 * Declaring `{ enforcedBy }` or `{ sessionOnly }` is not a loophole — those are
 * real, common postures (per-resource FGA lives in services; some endpoints
 * genuinely need only a session). The requirement is that the choice is
 * WRITTEN DOWN next to the route, by someone who had to think about it.
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

/**
 * How a route is authorized. Exactly one shape per route, and stating it is
 * mandatory — see the module header.
 */
export type RouteAuthz =
  /**
   * The factory checks this claims-tier permission (registry:
   * `@/lib/authz/permissions`) after authentication and before the handler
   * runs. The strongest posture: enforcement cannot be lost by editing the
   * handler, because it never reaches the handler.
   */
  | { readonly permission: KnownPermission }
  /**
   * The handler's service authorizes, because the decision needs the resource
   * in hand — per-project FGA, a per-workflow role, a sharing grant, or a query
   * scoped to the caller. `enforcedBy` names the function that does it so the
   * posture is greppable and can be verified in review.
   */
  | { readonly enforcedBy: string }
  /**
   * Authentication IS the whole requirement: any signed-in member of the active
   * organization may call this, and it exposes nothing scoped below the
   * organization. `why` records the reasoning, because "no further check" is
   * exactly the claim that deserves a sentence.
   */
  | { readonly sessionOnly: true; readonly why: string }

interface RouteOptions {
  /** How this route is authorized. Required — a route may not stay silent. */
  readonly authz: RouteAuthz
  /** Status code for successful non-Response results (default 200). */
  readonly status?: number
}

/** Options for routes whose factory already fixes the authorization posture. */
export interface FixedAuthzRouteOptions {
  readonly status?: number
}

/** Options for the intentionally unauthenticated routes. */
interface PublicRouteOptions extends FixedAuthzRouteOptions {
  /** Why this endpoint is safe to serve without a session. */
  readonly why: string
}

export type NextRouteContext = { params?: Promise<Record<string, string | string[]>> }

export function successResponse(result: unknown, status: number): Response {
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
  return (
    marker === 'NEXT_NOT_FOUND' ||
    marker.startsWith('NEXT_REDIRECT') ||
    marker.startsWith('NEXT_HTTP_ERROR_FALLBACK')
  )
}

export function errorResponse(error: unknown, request: Request): Response {
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

export async function resolveParams(
  context: NextRouteContext | undefined
): Promise<Record<string, string | string[]>> {
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
  options: RouteOptions
) {
  const permission = 'permission' in options.authz ? options.authz.permission : null
  return async (request: Request, context?: NextRouteContext): Promise<Response> => {
    try {
      const session = await requireAuthorizedSession()
      if (permission && !hasPermission(session, permission)) {
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
  options: FixedAuthzRouteOptions = {}
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
 *
 * `why` is required: an endpoint served to the open internet should carry the
 * reason it is safe to, in the file, next to the handler.
 */
export function publicApiRoute<TParams = Record<string, string | string[]>>(
  handler: (ctx: PublicApiContext<TParams>) => Promise<unknown>,
  options: PublicRouteOptions
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
  schema: TSchema
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
export function parseQuery<TSchema extends ZodType>(
  request: Request,
  schema: TSchema
): output<TSchema> {
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
