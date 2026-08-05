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
 * ## Why AsyncLocalStorage, and why a slot
 *
 * The context has to reach `@/lib/db` without every repository signature
 * growing an `organizationId` parameter that a caller could pass wrongly — the
 * exact class of mistake this feature exists to stop. AsyncLocalStorage carries
 * it out of band, and it holds PLAIN DATA, never a connection: entering a
 * context costs nothing and holds no pool slot, so wrapping a whole request is
 * free even when that request spends most of its time waiting on WorkOS or the
 * agent backend.
 *
 * The scope comes from `run()`, never from a bare `enterWith()`. That is a
 * correctness requirement, not a style choice: `enterWith` has no scope end, so
 * on a keep-alive connection its value survives into the NEXT request on the
 * same socket. See {@link TenantSlot} — and `tenant-context.spec.ts`, which
 * reproduces the leak against a real HTTP server and proves this design does
 * not have it.
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

/**
 * A per-request slot the session helper fills in later.
 *
 * The indirection is what makes the context SAFE, and it is not optional.
 * `AsyncLocalStorage.enterWith()` has no scope end: it writes into the current
 * async resource, and on a keep-alive connection Node reuses that resource for
 * the NEXT request on the same socket. Measured, not theorised — a request that
 * set a tenant leaked it to the two requests that followed it, and an enclosing
 * `run()` on another AsyncLocalStorage did not contain it either.
 *
 * A leak like that turns this feature inside out. The danger is not the request
 * that sets a tenant; it is the request that sets NONE and should therefore
 * fail closed, but instead inherits whoever used the socket last and quietly
 * reads or writes as them.
 *
 * So requests get their scope from `run()`, which is properly bounded — and
 * because `run()` fixes its value up front while the session resolves later,
 * the value it fixes is this mutable slot.
 */
interface TenantSlot {
  scope: TenantContext | null
}

const storage = new AsyncLocalStorage<TenantSlot>()

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
  return storage.getStore()?.scope ?? undefined
}

/** The active context, or throw {@link MissingTenantContextError}. */
export function requireTenantContext(): TenantContext {
  const context = getTenantContext()
  if (!context) throw new MissingTenantContextError()
  return context
}

/**
 * Open an empty, request-scoped slot for `fn` to fill.
 *
 * Every route factory calls this before running its handler, which does two
 * things at once: it gives `getGridSession()` somewhere to publish the tenant,
 * and — because `run()` restores the previous store when it returns — it
 * guarantees the request starts with NO inherited tenant and leaves none
 * behind. That is what makes "no context" mean no context, rather than
 * "whatever the last request on this socket was".
 */
export function runWithTenantSlot<T>(fn: () => PromiseLike<T> | T): Promise<T> {
  return storage.run({ scope: null }, async () => await fn())
}

/**
 * Wrap a route handler that is NOT declared through one of the factories.
 *
 * The seven hand-rolled routes (`authz-coverage.spec.ts` lists them, each with
 * a reason) bypass the factories, and therefore bypassed the slot the factories
 * open — leaving them on the unbounded `enterWith` fallback, which is the one
 * path that can inherit a tenant from the previous request on a keep-alive
 * socket. This gives them the same bounded scope in one line, without forcing
 * them through a factory whose response shape they cannot use.
 */
export function tenantSlotRoute<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<Response>
): (...args: TArgs) => Promise<Response> {
  return (...args: TArgs) => runWithTenantSlot(() => handler(...args))
}

/**
 * Publish the tenant for the rest of this request.
 *
 * Called by `getGridSession()` the moment a session resolves. A session with no
 * active organization publishes nothing: there is no tenant to answer as, and
 * `requireAuthorizedSession` is about to reject the request anyway.
 *
 * Writes into the slot {@link runWithTenantSlot} opened for this request.
 * Without one — a server component or server action, which no factory wraps —
 * it falls back to `enterWith`, and that fallback is deliberately a fresh slot
 * OBJECT rather than a bare value: if a previous request on this socket leaked
 * its slot, the next `getGridSession()` replaces it wholesale instead of
 * inheriting it. Pages resolve their session before they query, so the slot is
 * always filled by the time a query runs.
 */
export function enterTenantContext(session: {
  organizationId: string | null
  userId: string
}): void {
  // No active organization means NO scope — never "whatever was there". This
  // assigns `null` rather than returning early, and the difference is a
  // cross-tenant read: a request that inherited a scope and then resolved an
  // org-less session would otherwise keep the PREVIOUS tenant and read as them.
  const scope: TenantContext | null = session.organizationId
    ? { kind: 'tenant', organizationId: session.organizationId, userId: session.userId }
    : null

  const slot = storage.getStore()
  if (slot) {
    slot.scope = scope
    return
  }
  storage.enterWith({ scope })
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
    { scope: { kind: 'tenant', organizationId: scope.organizationId, userId: scope.userId ?? null } },
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
  return storage.run({ scope: { kind: 'platform', reason } }, async () => await fn())
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
