# ADR-0017: BFF repository/service architecture

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** Grid engineering
- **Related:** ../architecture/bff-service-architecture.md, ADR-0016 (permission registry), docs/architecture/multitenancy-and-auth-spec.md

## Context

The BFF (`frontends/ui/src/app/api`) grew route-by-route: ~40 route handlers
each hand-rolled session resolution, permission checks, zod parsing, drizzle
queries, and error mapping in try/catch pyramids. An audit of every endpoint
found the predictable consequences of that duplication:

- Inconsistent authorization: documents were readable org-wide even though
  uploads enforce per-project FGA; conversations stored client-supplied
  `projectId` without any access check.
- Inconsistent error contracts: three different `{error}` shapes, and access
  denials mapped variously to 403 or 404 via string-matching on
  `Error.message`.
- Unbounded list queries (projects, conversations, messages, documents,
  holds, deletions) and sequential external round-trips
  (`requireProjectAccess` made up to 3 serial WorkOS checks per request;
  project-member reads walked five WorkOS list endpoints serially).
- Business logic welded into transport handlers, untestable without HTTP
  mocking.

## Decision

We will structure the entire BFF — and every future service — in three
layers, documented in `docs/architecture/bff-service-architecture.md`:

1. **Routes** (`app/api/**/route.ts`) are thin transport adapters declared
   through the factories in `@/lib/api/handler` (`apiRoute`,
   `internalApiRoute`, `publicApiRoute`). The factory owns authentication,
   coarse permission enforcement (registry slugs from ADR-0016), input
   validation helpers, and uniform error mapping.
2. **Services** (`lib/<domain>/service.ts`) own business logic and
   fine-grained authorization, throw typed errors from `@/lib/api/errors`,
   and orchestrate repositories plus external systems (WorkOS, MinIO,
   backend, audit trail).
3. **Repositories** (`lib/<domain>/repository.ts`) are the only modules that
   issue drizzle queries for their domain; tenancy (`organizationId`) is
   enforced in the SQL WHERE clause and list queries are bounded.

Backend proxy routes remain streaming pass-throughs but resolve auth and
collection scope through the same shared guards.

This architecture is **mandatory**: new endpoints and modifications to
existing ones must follow it (enforced in review; AGENTS.md carries the
obligation).

## Consequences

### Positive

- Security is enforced structurally: an endpoint cannot exist without
  passing through an auth factory, and cross-tenant access is filtered in
  SQL rather than in per-route JS.
- One error contract (`{error, code, details?}`) and one place to change it.
- Services are unit-testable without HTTP; route specs shrink to
  shape/status assertions.
- Query bounding and parallelized external calls are the default, not an
  afterthought.

### Negative

- More files per domain (route + service + repository).
- A transitional period where legacy string-classified errors
  (`Error('Not found')`) are still mapped for backwards compatibility.

### Risks

- Drift back into fat routes — mitigated by the AGENTS.md obligation and the
  grep-able rule that `app/api` files must not import drizzle or `getDb`.
- Behavioral regressions during the migration — mitigated by keeping every
  existing route spec green and preserving response shapes.

## Alternatives Considered

- **Class-based repositories/services (DI container)** — rejected: the
  codebase is functional-module TypeScript; classes and a container add
  ceremony without improving testability under vitest module mocks.
- **tRPC / OpenAPI codegen layer** — rejected for now: valuable, but a
  transport rewrite on top of an architectural refactor multiplies risk; the
  factory pattern gets the safety benefits without changing the wire
  contract.
- **Keep per-route logic, add lint rules only** — rejected: linting cannot
  deduplicate authorization or error mapping, which is where the audit found
  the actual vulnerabilities.
