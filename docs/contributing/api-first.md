# Building a capability API-first

Piloti has no private API ([ADR-0113](../adr/0113-piloti-has-no-private-api.md),
widening [ADR-0055](../adr/0055-api-first-workspace-primitives.md)). Every
capability a person can use is an operation on the BFF's HTTP API, and the UI is
one client of it beside the agent's tools, the task runner and later
integrations. The model is Genesys Cloud, whose web client uses its public
Platform API for everything. This page is the order of work and the checklist a
reviewer reads against. The ADR says why.

## The test

Before writing a capability, answer: **could the agent, a task or an outside
system do this tomorrow with only an HTTP client and a person's rights?** If the
answer needs a page, a server action, a direct service import or a second
implementation, the capability has a private door.

## Order of work

Build in this order, one layer done before the next starts. A worked example of
every step is the document lifecycle: `frontends/ui/src/lib/documents/lifecycle-*.ts`
and `src/app/api/documents/[id]/versions/`.

1. **Contract.** Zod schemas for every request and response in
   `lib/<domain>/<capability>-types.ts`. No `server-only`, no drizzle, so the
   browser, the routes, the client and the tests import the same file. If the
   Python tier reads it, add a `*-schema.ts` that exports it through
   `lib/api/zod-json-schema.ts` and commit the fixture under
   `frontends/ui/tests/fixtures/`. No Pydantic twin.
2. **Permission.** The narrowest permission from `lib/authz/catalog.ts`, shaped
   `scope:resource:action`. When none fits, add one there rather than borrowing a
   broader one.
3. **Route.** Under `src/app/api/<domain>/…`, declared through a factory from
   `lib/api/handler.ts` with its `authz`. The route is a thin adapter: parse with
   the contract, call the service, return plain data. The service owns the rules,
   the repository owns the SQL and bounds every list.
4. **Typed client.** `lib/<domain>/<capability>-client.ts` holds the paths, verbs
   and response parsing, and is the only code that knows them. Every consumer
   calls it, or, from Python, sends the payload the JSON Schema fixture
   describes.
5. **Route spec through the client.** The spec drives the real handlers through
   the typed client, not through hand-built requests, so a client and a route
   that disagree on a path or a field fail there.
6. **Consumers.** Only now the UI, the agent tool, the task. The agent reaches
   the capability as the acting person: an internal route verifies the signed
   envelope (`lib/api/internal-envelope.ts`), builds that person's session and
   calls the same service the session route calls.
7. **Docs.** Its row in [`docs/api/bff-routes.md`](../api/bff-routes.md), naming
   the typed client and the contract.

## The conventions

| Area | Rule | Genesys Cloud equivalent |
|---|---|---|
| Paths | Nouns under `/api/<domain>/…/[id]`, named with the domain word from [`CONTEXT.md`](../../CONTEXT.md), never with the page that first used them | `/api/v2/{domain}/{entity}/{id}` |
| State changes | A transition is a named sub-resource: `…/versions/[versionId]/submit`, `…/approve` | Action endpoints on an entity |
| Responses | What a client needs to act on the resource, not what one screen renders | Entity representations |
| Permissions | One catalog, `scope:resource:action`, declared on every route | `domain:entity:action` permissions |
| Errors | Throw an `ApiError` with a stable `code` and machine-readable `details`; clients branch on `code` | One error body with a `code` |
| Lists | Bounded at the repository, paged when they can grow | `pageSize` / cursor paging |
| Change | Additive. A rename or removal ships the new shape beside the old, moves every client, then removes | Versioned, deprecate before removing |
| Async state | Say how a client learns of a change: live-channel event (ADR-0110), inbox item, a wake (ADR-0106). Never leave clients to poll | Notifications API topics |
| Machines | Act as a person through the signed envelope. `/api/internal/*` builds the identity and calls the same service; it never implements the capability a second time | OAuth clients holding roles |

## When the rule does not apply

- **A server component rendering a page** may read through the service function
  its GET route calls, in the same session. Writes always go through the route.
- **Existing UI-only plumbing** is not retrofitted wholesale. It takes this
  shape when it is rewritten, or when a second client needs it, in the change
  that needs it.

## Not built yet

A versioned public prefix, a published OpenAPI document, machine credentials for
integrations and webhooks are the target, not the present. Each gets its own ADR
when the first external client is commissioned; ADR-0113 names the library to
try first for each. Until then, do not invent a local version of one: the
conventions above are what make them cheap to add.

## Review checklist

- [ ] The capability passes [the test](#the-test): nothing it does is reachable
      only from a page, a server action or a direct import.
- [ ] Contract in a `*-types.ts` with no server imports; JSON Schema fixture
      committed if Python reads it.
- [ ] Route through a `lib/api/handler.ts` factory, `authz` declared, the
      narrowest catalog permission.
- [ ] Typed client is the only holder of the paths; the route spec drives the
      handlers through it.
- [ ] Errors are `ApiError`s with a `code`; lists are bounded.
- [ ] Contract changes are additive, or the old shape ships beside the new one.
- [ ] Asynchronous state changes reach clients as events.
- [ ] Row in `docs/api/bff-routes.md`.
