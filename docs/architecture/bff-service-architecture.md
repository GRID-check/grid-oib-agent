# BFF Repository/Service Architecture

Status: **mandatory** for every BFF endpoint (ADR-0017). All new services and
every change to an existing endpoint MUST follow this layering.

## The three layers

```
app/api/**/route.ts        →  lib/<domain>/service.ts  →  lib/<domain>/repository.ts
(transport: HTTP only)        (business logic + authz)     (drizzle data access only)
```

### 1. Route handlers (`frontends/ui/src/app/api/**/route.ts`)

Routes are **thin transport adapters**. They:

- are declared through a factory from `@/lib/api/handler` — never as bare
  `export async function GET(...)`:
  - `apiRoute(handler, options?)` — session-authenticated routes (the default).
    `options.permission` enforces an org/platform permission from the registry
    (`@/lib/authz/permissions`) before the handler runs.
  - `internalApiRoute(label, handler, { tenancy })` — service-to-service routes guarded by
    `GRID_INTERNAL_API_TOKEN` (fail-closed).
  - `publicApiRoute(handler)` — intentionally unauthenticated (health checks
    only; anything else needs an ADR).
- validate input **shape** with zod via `parseJsonBody` / `parseQuery`
  (both throw a 400 `BadRequestError` with issues).
- call exactly one service function and return plain data (auto-serialized,
  `options.status` for 201/202) or a `Response` for streams/redirects.
- contain **no drizzle imports, no `getDb()`, no WorkOS/SeaweedFS/backend calls,
  and no hand-rolled `NextResponse.json({ error })`.**

### 2. Services (`frontends/ui/src/lib/<domain>/service.ts`)

Services own the business logic and the **authorization decision**:

- Start with `import 'server-only'`.
- Take the `AuthorizedSession` (or validated internal-call context) as the
  first argument; enforce tenancy and fine-grained access (e.g.
  `requireProjectAccess`) before touching data.
- Orchestrate repositories, WorkOS, SeaweedFS, the Python backend, and the audit
  trail (`recordAuditEvent` for every mutating admin/compliance action).
- Signal failures by throwing typed errors from `@/lib/api/errors`
  (`BadRequestError`, `ForbiddenError`, `NotFoundError`, `ConflictError`,
  `UnprocessableError`, `UpstreamError`). Cross-tenant or no-access lookups
  throw `NotFoundError` — never confirm existence to unauthorized callers.
- Never import `next/server` and never build HTTP responses.

### 3. Repositories (`frontends/ui/src/lib/<domain>/repository.ts`)

Repositories are the **only** modules that run queries for their domain:

- drizzle only — no HTTP, no auth logic, no external services.
- Every tenant-data query takes `organizationId` (and, where applicable,
  `projectId`) and scopes the WHERE clause in SQL. Tenancy filtering in JS
  after an unscoped SELECT is a bug.
- List queries are always bounded — accept a `limit` with a domain default;
  no unbounded `SELECT *`. **Clamp it**: a cap a caller can pass straight
  through is not a bound.
- Every tenant-data query also **runs** in that organization's tenant context,
  via `withTenant({ organizationId })` (ADR-0041). The layer that receives the
  `organizationId` is the layer that states it, so no caller can forget — see
  "Server components" below for what forgetting cost.
- Multi-statement invariants (soft-delete + queue insert, optimistic version
  bumps) run in `db.transaction`.

### Server components and server actions are transport too

The three layers above are usually described in terms of `app/api/**`, but the
rule is about **transport**, not about HTTP. A React server component, a layout
and a server action are all transport: they resolve the session, call exactly
one service, and render. They contain **no `getDb()` and no drizzle imports**,
exactly like a route handler.

This was left implicit once, and every consequence the layering prevents arrived
together. The pages under `app/projects` each ran their own queries, and so:

- `projects/page.tsx` selected every non-deleted project in the organization
  instead of calling `listProjects()`, bypassing the per-project FGA filtering
  and showing every member every project in the tenant — the exact enumeration
  ADR-0038 closed;
- four project pages matched on `projects.id` alone, with no organization
  predicate at all;
- that same list was unbounded;
- and none of them ran in a tenant context, so when row-level security began
  being enforced they failed closed with `MissingTenantContextError`.

A page cannot rely on the tenant context being *ambient*. `getGridSession()`
publishes it, but for a server component that publish uses `enterWith`, which
does not survive the way this Next version renders a page — the scope is gone by
the time a query runs. Going through a repository is what makes it reliable,
because the repository opens the scope itself with `withTenant`.

`frontends/ui/src/lib/db/server-component-db-access.spec.ts` enforces this: it
parses every file under `src/app` and fails the build when one imports values
from `@/lib/db`. Route handlers that predate the rule are held in an explicit
list in that spec so the count can only go down; server components and server
actions have no allowlist.

## Error contract

`@/lib/api/handler` maps thrown errors to a uniform envelope:

```json
{ "error": "<message>", "code": "<CODE>", "details": <optional> }
```

- `ApiError` subclasses → their status/code.
- Legacy `Error('Not found'|'Unauthorized…'|'Forbidden…')` → 403 (transitional;
  migrate call sites to typed errors).
- Anything else → logged and returned as a 500 `INTERNAL` without leaking the
  message.

## Security invariants

1. **Every endpoint is authenticated** through one of the three factories.
   `publicApiRoute` usage is an explicit, ADR-documented exception.
2. **Coarse permission at the route** (`options.permission`), **fine-grained
   authz in the service** (`requireProjectAccess`, ownership conditions).
3. **Tenancy in SQL** — repositories scope by `organizationId`.
4. Client-supplied resource ids (projectId, subjectId, folderId, …) are
   validated against the caller's org/access before use.
5. User-controlled strings never reach headers, audit metadata, or SQL
   unbounded — cap lengths and sanitize (e.g. filenames in
   `Content-Disposition`).
6. Secrets/tokens are compared constant-time (`lib/internal-auth.ts`) and are
   never logged.

## Performance rules

- Bound every list (repository `limit`, UI-driven pagination where needed).
- Batch or parallelize independent I/O (`Promise.all`) — no sequential
  round-trips to WorkOS/DB when the results are independent.
- Aggregate in SQL (`count(*)`, `sum(...) filter`), not in JS loops.
- No per-row queries in loops; fetch once and map.

## Exemplar

The projects domain is the reference implementation:

- `lib/projects/repository.ts`
- `lib/projects/service.ts`
- `app/api/projects/route.ts`, `app/api/projects/[id]/route.ts`,
  `app/api/projects/[id]/restore/route.ts`

Proxy routes (`/api/v1/[...path]`, `/api/jobs/async/[...path]`) are transport
pass-throughs, not data endpoints: they keep using `lib/backend-proxy.ts`
helpers but must still resolve auth/scope through the shared guards.

## Testing

Route specs mock `@/lib/auth/require-auth` and the domain service; service
tests mock the repository (or run against the integration DB). The factories
keep specs stable: mocking `requireAuthorizedSession` works unchanged.
