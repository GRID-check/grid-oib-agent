/**
 * The tenant context — who the database is answering as, for the duration of
 * one request (ADR-0041).
 *
 * Migration `0030_row_level_security` makes Postgres enforce tenant isolation
 * from two settings: `grid.organization_id` and `grid.user_id`. This module is
 * the only place that decides what those settings hold. `@/lib/db` reads the
 * context established here and applies it to every statement it sends.
 *
 * ## Where the context comes from
 *
 * `getGridSession()` resolves who is asking — for API routes (via
 * `requireAuthorizedSession`), for server components and for server actions
 * (via `requireAuthorizedPageSession`). Every authenticated path in the app
 * funnels through it, so it is also where the answer is published to the
 * database, using {@link enterTenantContext}. The function that establishes
 * identity establishes it once, for both consumers.
 *
 * That leaves exactly three paths with no session to derive it from, and each
 * one names itself:
 *
 *   - `internalApiRoute` — the Python agent calling the BFF. The organization
 *     travels in the request, so the route states it with {@link withTenant}.
 *   - `platformApiRoute` — the cross-organization admin tier, which is
 *     deliberately not one tenant: {@link withPlatformAccess}.
 *   - Background workers, which sweep every tenant: {@link withPlatformAccess}
 *     to find the work, then {@link withTenant} per tenant to do it.
 *
 * ## Why AsyncLocalStorage, and why `enterWith`
 *
 * The context has to reach `@/lib/db` without every repository signature
 * growing an `organizationId` parameter that a caller could pass wrongly — the
 * exact class of mistake this feature exists to stop. AsyncLocalStorage carries
 * it out of band, and it holds PLAIN DATA, never a connection: entering a
 * context costs nothing and holds no pool slot, so wrapping a whole request is
 * free even when that request spends most of its time waiting on WorkOS or the
 * agent backend.
 *
 * `enterTenantContext` uses `enterWith` rather than `run` because a session
 * helper returns a value; it does not wrap a callback. Each Next.js request
 * already runs in its own async resource, so the write is confined to that
 * request's execution and its continuations.
 */

import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Postgres settings the RLS policies read. These names are also written in
 * `drizzle/0030_row_level_security.sql`; `tenant-context.spec.ts` parses that
 * migration and fails if the two ever disagree.
 */
export const ORGANIZATION_SETTING = 'grid.organization_id'
export const USER_SETTING = 'grid.user_id'

/**
 * The role a platform-scoped statement runs as. Holds BYPASSRLS, is reachable
 * only through `SET LOCAL ROLE`, and therefore shows up as `current_user` in
 * `pg_stat_activity` and the query log — a cross-tenant read is a fact the
 * database records, not an application claim.
 */
export const PLATFORM_ROLE = 'grid_app_platform'

/** One tenant, for the ordinary case: a signed-in member doing their own work. */
export interface TenantScope {
  readonly kind: 'tenant'
  readonly organizationId: string
  /** Drives the policy on tables keyed to a person (`user_preferences`). */
  readonly userId: string | null
}

/**
 * Deliberate cross-organization access. `reason` is required and is not
 * decoration: it is what makes a bypass reviewable in a diff and greppable in
 * the tree, the same discipline `lib/authz/decide.ts` applies to its named
 * rules.
 */
export interface PlatformScope {
  readonly kind: 'platform'
  readonly reason: string
}

export type TenantContext = TenantScope | PlatformScope

const storage = new AsyncLocalStorage<TenantContext>()

/**
 * Thrown when a statement is about to run with no context at all.
 *
 * Postgres would already return zero rows — that is the point of the policies —
 * but a silently empty list is a bug report about missing data, not about
 * missing authorization. Failing here turns it into one sentence naming the
 * fix, and RLS remains the backstop for anything that reaches the database by
 * another route.
 */
export class MissingTenantContextError extends Error {
  readonly code = 'MISSING_TENANT_CONTEXT'

  constructor() {
    super(
      'Database access outside a tenant context. Every query must run inside ' +
        'withTenant() or withPlatformAccess() — see lib/db/tenant-context.ts. ' +
        'Authenticated requests get this from getGridSession(); background and ' +
        'internal callers must state it.'
    )
    this.name = 'MissingTenantContextError'
  }
}

/** The active context, or `undefined` when there is none. */
export function getTenantContext(): TenantContext | undefined {
  return storage.getStore()
}

/** The active context, or throw {@link MissingTenantContextError}. */
export function requireTenantContext(): TenantContext {
  const context = storage.getStore()
  if (!context) throw new MissingTenantContextError()
  return context
}

/**
 * Publish the tenant for the rest of this request.
 *
 * Called by `getGridSession()` the moment a session resolves. A session with no
 * active organization publishes nothing: there is no tenant to answer as, and
 * `requireAuthorizedSession` is about to reject the request anyway.
 */
export function enterTenantContext(session: {
  organizationId: string | null
  userId: string
}): void {
  if (!session.organizationId) return
  storage.enterWith({
    kind: 'tenant',
    organizationId: session.organizationId,
    userId: session.userId,
  })
}

/**
 * Run `fn` scoped to one organization. For callers that have no session.
 *
 * `fn`'s result is awaited INSIDE the scope, and that detail is load-bearing.
 * A drizzle query builder is lazy — `db.select()...` does not touch the
 * database until something awaits it — so the natural one-liner
 *
 *     withTenant(scope, () => db.select().from(projects))
 *
 * would otherwise return an unexecuted query and run it after the scope had
 * closed, with no context and a thrown {@link MissingTenantContextError}.
 * Awaiting here makes the obvious way to call this the correct way.
 */
export function withTenant<T>(
  scope: { organizationId: string; userId?: string | null },
  fn: () => PromiseLike<T> | T
): Promise<T> {
  return storage.run(
    { kind: 'tenant', organizationId: scope.organizationId, userId: scope.userId ?? null },
    async () => await fn()
  )
}

/**
 * Run `fn` with row-level security bypassed, for work that is legitimately not
 * one tenant's.
 *
 * Use the narrowest scope that works: a worker should find its due work here
 * and then do that work inside {@link withTenant}, so the bypass covers the
 * query that genuinely spans tenants and nothing after it.
 */
export function withPlatformAccess<T>(reason: string, fn: () => PromiseLike<T> | T): Promise<T> {
  // Awaited inside the scope for the same reason as `withTenant` — see there.
  return storage.run({ kind: 'platform', reason }, async () => await fn())
}

/**
 * Scope work to an organization when there is one, and to the platform when
 * there genuinely is not.
 *
 * For the agent's telemetry — profiler spans, citation events — where
 * `organization_id` is nullable because a turn can come from a session with no
 * organization selected. Such a row belongs to no tenant, so no tenant
 * predicate can accept it: writing it inside a tenant scope is refused by
 * `WITH CHECK`, and it stays visible only to the platform tier afterwards.
 *
 * Prefer {@link withTenant} wherever the organization is genuinely required —
 * this exists for the columns that are nullable in the schema, not as a way to
 * avoid deciding.
 */
export function withOptionalTenant<T>(
  organizationId: string | null | undefined,
  reasonWhenAbsent: string,
  fn: () => PromiseLike<T> | T
): Promise<T> {
  return organizationId
    ? withTenant({ organizationId }, fn)
    : withPlatformAccess(reasonWhenAbsent, fn)
}
