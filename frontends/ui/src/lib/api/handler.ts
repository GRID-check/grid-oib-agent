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
 *
 * ## Why rate limiting is NOT a required argument
 *
 * `limits` is optional, and that asymmetry is deliberate (ADR-0040). An
 * ungated route is a security hole with no safe default; an unlimited route is
 * a cost risk that DOES have one. So the factory charges every mutating method
 * against `DEFAULT_MUTATION_LIMIT` unless the route says otherwise, and a new
 * endpoint is bounded the day it ships rather than the day someone remembers.
 * Declaring `limits` is for the two cases where that default is wrong: an
 * expensive endpoint that needs a tighter budget, and the handful that must not
 * be limited at all (which must say why).
 */

import { NextResponse } from 'next/server'
import { ZodError, type ZodType, type output } from 'zod'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { isAuthzError } from '@/lib/auth-utils'
import { hasPermission, type KnownPermission } from '@/lib/authz/permissions'
import { requireInternalToken } from '@/lib/internal-auth'
import { runWithTenantSlot, withPlatformAccess } from '@/lib/db/tenant-context'
import type { AuthorizedSession } from '@/lib/auth/types'
import { DEFAULT_MUTATION_LIMIT } from '@/lib/limits/catalog'
import { enforceLimit, rateLimitHeaders } from '@/lib/limits/enforce'
import { memberSubject } from '@/lib/limits/subject'
import type { LimitRule } from '@/lib/limits/types'
import {
  ApiError,
  BadRequestError,
  ForbiddenError,
  PayloadTooLargeError,
  TooManyRequestsError,
} from './errors'
import { requestBodyLimitBytes } from '@/shared/config/request-body-limit'

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

/**
 * How a route is rate limited (ADR-0040 L2).
 *
 * Unlike `authz`, this is optional — and the asymmetry is deliberate. An
 * unauthorized route is a security hole, so ADR-0038 made the declaration a
 * compile error. An unlimited route is a cost risk, and the safe default for
 * one actually exists: the factory applies `DEFAULT_MUTATION_LIMIT` to every
 * mutating method unless told otherwise, so a new endpoint is bounded on the day
 * it ships. Requiring 117 existing routes to restate that default would have
 * bought a large diff and no safety.
 *
 * The declaration is for the routes where the default is wrong in either
 * direction: an expensive endpoint that needs a tighter budget, and the handful
 * that must not be limited at all.
 */
export type RouteLimits =
  /**
   * Spend one unit of this rule per call, keyed by `memberSubject` (the member
   * within their active organization). Use for endpoints whose cost or blast
   * radius makes the shared default wrong.
   */
  | { readonly rule: LimitRule }
  /**
   * Exempt. `why` is required for the same reason `sessionOnly` needs one: "no
   * limit" is exactly the claim that deserves a sentence next to the route.
   */
  | { readonly none: true; readonly why: string }

interface RouteOptions {
  /** How this route is authorized. Required — a route may not stay silent. */
  readonly authz: RouteAuthz
  /**
   * How this route is rate limited. Optional; mutating methods otherwise get
   * `DEFAULT_MUTATION_LIMIT` and reads are left to the edge's per-IP budget.
   */
  readonly limits?: RouteLimits
  /** Status code for successful non-Response results (default 200). */
  readonly status?: number
}

/** Methods that change something, and so carry a default budget. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * The rule to charge for this call, or null when the route is exempt or is a
 * read with no declaration.
 */
function resolveLimitRule(options: RouteOptions, method: string): LimitRule | null {
  if (options.limits) {
    return 'none' in options.limits ? null : options.limits.rule
  }
  return MUTATING_METHODS.has(method.toUpperCase()) ? DEFAULT_MUTATION_LIMIT : null
}

/** Options for routes whose factory already fixes the authorization posture. */
export interface FixedAuthzRouteOptions {
  readonly status?: number
}

/**
 * How an internal route reaches the tenant boundary (ADR-0041).
 *
 * Internal routes carry no session, so the database has no organization to
 * answer as unless the route says where one comes from. Stating it is required
 * for the same reason `authz` is: the alternative is a route that silently
 * works today because nothing it touches happens to be tenant data, and
 * silently reads across tenants the day that changes.
 */
export type InternalTenancy =
  /**
   * The organization arrives in the request, so the HANDLER opens the scope
   * with `withTenant` once it has parsed it. The string names where it comes
   * from (`'body.organizationId'`, `'?organizationId'`) so a reviewer can check
   * the claim against the schema. Queries outside that scope throw.
   */
  | { readonly fromPayload: string }
  /**
   * The route genuinely serves no single tenant — cross-organization
   * maintenance, or platform configuration. The factory runs it under the
   * audited bypass and `crossTenant` records why.
   */
  | { readonly crossTenant: string }

export interface InternalRouteOptions extends FixedAuthzRouteOptions {
  readonly tenancy: InternalTenancy
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
    // A 429 is the one error whose headers matter as much as its body: a client
    // that cannot see `Retry-After` has to guess, and guessing produces exactly
    // the retry storm the limit exists to stop (ADR-0040).
    const headers =
      error instanceof TooManyRequestsError ? rateLimitHeaders(error.decision) : undefined
    return NextResponse.json(body, { status: error.status, headers })
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
    // Open an empty, request-scoped tenant slot for `getGridSession()` to fill.
    // `run()` bounds it, so this request cannot inherit a tenant from the
    // previous request on the same keep-alive socket, nor leave one behind.
    return runWithTenantSlot(async () => {
      try {
        const session = await requireAuthorizedSession()
        if (permission && !hasPermission(session, permission)) {
          throw new ForbiddenError()
        }
        // After authorization, before any work: an unauthorized caller should get
        // a 403 rather than have the refusal tell them a limit exists, and a
        // refused call must not have already touched the database.
        const rule = resolveLimitRule(options, request.method)
        if (rule) await enforceLimit(rule, memberSubject(session))
        const params = (await resolveParams(context)) as TParams
        const result = await handler({ request, session, params })
        return successResponse(result, options.status ?? 200)
      } catch (error) {
        return errorResponse(error, request)
      }
    })
  }
}

/**
 * Declare an internal service-to-service route guarded by
 * `GRID_INTERNAL_API_TOKEN` (fail-closed; see `@/lib/internal-auth`).
 */
export function internalApiRoute<TParams = Record<string, string | string[]>>(
  label: string,
  handler: (ctx: InternalApiContext<TParams>) => Promise<unknown>,
  options: InternalRouteOptions
) {
  return async (request: Request, context?: NextRouteContext): Promise<Response> => {
    const denied = requireInternalToken(request, label)
    if (denied) return denied
    // The slot matters most here: these routes carry no session, so a
    // `fromPayload` handler that forgot its scope MUST fail closed rather than
    // silently inherit whatever tenant last used this socket.
    return runWithTenantSlot(async () => {
      try {
        const params = (await resolveParams(context)) as TParams
        const run = () => handler({ request, params })
        // `fromPayload` routes establish their own scope once they have parsed the
        // organization out of the body; until they do, any query throws
        // MissingTenantContextError rather than reading across tenants.
        const result =
          'crossTenant' in options.tenancy
            ? await withPlatformAccess(`internal:${label} — ${options.tenancy.crossTenant}`, run)
            : await run()
        return successResponse(result, options.status ?? 200)
      } catch (error) {
        return errorResponse(error, request)
      }
    })
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
    // Health checks hold no session and touch no tenant data, but they still get
    // a slot: without one they would run under whatever tenant the previous
    // request on this socket left behind.
    return runWithTenantSlot(async () => {
      try {
        const params = (await resolveParams(context)) as TParams
        const result = await handler({ request, params })
        return successResponse(result, options.status ?? 200)
      } catch (error) {
        return errorResponse(error, request)
      }
    })
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

/**
 * Parse a multipart upload body, turning the one failure mode that is not the
 * caller's fault into an answer instead of a crash.
 *
 * When a body exceeds the server's transport limit it is cut off in FRONT of
 * the handler, so `request.formData()` gets a truncated multipart stream and
 * throws `TypeError: Failed to parse body as FormData`. Unhandled, that is a
 * 500 and an error-tracker issue that names neither the file nor a size — the
 * user is told nothing, and the operator is told something that reads like a
 * bug in the parser (it happened: issue #369, a 149 MB IFC against a 100 MB
 * transport ceiling).
 *
 * 413 is the honest code, and the message names the limit so the remedy is
 * visible. It cannot name the FILE — the body it would have come from is the
 * thing that failed to parse.
 */
export async function parseFormData(request: Request): Promise<FormData> {
  try {
    return await request.formData()
  } catch (error) {
    // Next throws TypeError for a missing/wrong Content-Type as well as for
    // a body past the transport ceiling. A 413 is only honest for the
    // latter; anything else is a bad request, not "file too large" (#368).
    const message = error instanceof Error ? error.message : ''
    if (/formdata/i.test(message) && !/size|limit|large/i.test(message)) {
      throw new BadRequestError('Request body is not multipart form data')
    }
    if (error instanceof TypeError) {
      throw new PayloadTooLargeError(requestBodyLimitBytes())
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
