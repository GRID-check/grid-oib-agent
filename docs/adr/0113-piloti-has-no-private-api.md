---
status: accepted
date: 2026-10-17
decision-makers: product owner, Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Piloti has no private API: every capability is a public-shaped HTTP operation first, the way Genesys Cloud is built

## Context and Problem Statement

ADR-0055 made a workspace primitive one HTTP route with a typed client, and every
consumer a client of it. It deliberately bound only **a primitive with more than
one consumer**, and only what was added or rewritten. Since then twenty-odd
typed clients and eight JSON Schema contracts have been built that way
(`frontends/ui/src/lib/*/client.ts`, `*-client.ts`,
`frontends/ui/tests/fixtures/*.schema.json`), and every one that later gained a
second consumer (the agent's tools, a task, the intake) gained it as a call
rather than a port.

The capabilities built for the UI alone did not. A feature with one consumer is
still written the old way, and when the agent, a task or an integration needs
it, someone first has to turn a page's private plumbing into an API. The office
runs its work in Piloti; the direction is that offices and their other systems
reach that work from outside too. A product whose UI holds private doors cannot
offer that without a rewrite per capability.

Genesys Cloud is the reference we want to resemble. Its web client has no
private API: everything a person does in it is a call to the public Platform
API, so integrations, its own automation (Architect, data actions) and
customers' code can do whatever the UI can. That works because the API is held
to a few rules everywhere: resources named the same way, permissions shaped
`domain:entity:action`, one error body, contracts that change additively, an
event a client can subscribe to instead of polling, and machine clients that
hold roles like people.

How far do we take ADR-0055?

## Decision Drivers

- A capability the agent or an integration cannot reach is a capability Piloti
  as a colleague does not have (VISION.md).
- The second consumer always arrives; paying for the API when it does costs a
  rewrite, paying when the capability is built costs a client module.
- A rule true on one path and not another is worse than no rule (ADR-0055).
- No framework, gateway or code generator in the build before an external
  client exists to need it.

## Considered Options

1. **Keep ADR-0055's scope**: API-first only once a primitive has two consumers.
2. **No private API**: every capability added or rewritten is an HTTP operation
   with a contract and a typed client first, whatever its consumer count, held
   to the Genesys-style conventions below.
3. **Option 2 plus a public API now**: versioned URL prefix, generated OpenAPI,
   machine credentials, webhooks.

## Decision Outcome

Chosen option: **2**, with option 3's pieces named as the target and built when
the first external client is commissioned.

**Every capability a person can use is an operation on the BFF's HTTP API, and
the UI is one client of it**, beside the agent's tools, the task runner and any
later integration. ADR-0055's rule now binds every capability added or
rewritten, not only one with two consumers today. The conventions every such
operation follows:

1. **Contract first.** The zod contract (`lib/<domain>/*-types.ts`, no
   `server-only`, no drizzle), then the route through a factory in
   `lib/api/handler.ts`, then the typed client, then the UI or the agent tool.
   The route spec drives the real handler through the client. A contract the
   Python tier reads is exported as a JSON Schema fixture (`lib/api/zod-json-schema.ts`);
   there is no second hand-written model.
2. **Resources, not screens.** Paths are nouns under `/api/<domain>/…/[id]`,
   named for the domain object (CONTEXT.md's word), never for the page that
   first used them. HTTP verbs carry their meaning; a state transition is a
   named sub-resource (`…/versions/[versionId]/submit`, `…/approve`). A response
   carries what a client needs to act, not what one screen renders.
3. **One permission vocabulary.** Every operation declares its `authz` and
   checks permissions from `lib/authz/catalog.ts`, shaped `scope:resource:action`
   (`project:documents:write`). A new capability adds its permission there
   rather than reusing a broader one.
4. **One error body.** Failures are thrown `ApiError`s with a stable `code` and
   machine-readable `details`; a client branches on `code`, never on `message`.
5. **Lists are bounded** at the repository, and paged when they can grow. A
   client never receives an unbounded collection.
6. **Contracts change additively.** Add a field, a route, an enum member a
   client may ignore. Removing or renaming is a breaking change: ship the new
   shape beside the old, move the clients, then remove. The agent tier, a
   browser tab open across a deploy and a stored envelope are all clients that
   lag.
7. **Changes are announced, not polled for.** A capability whose state changes
   behind the client's back says how a client learns of it: a live-channel event
   (ADR-0110), an inbox item, an event that wakes a turn (ADR-0106).
8. **A machine is a client with an identity, never a bypass.** The agent and
   tasks act as a person through the signed envelope (`lib/api/internal-envelope.ts`).
   `/api/internal/*` builds that identity and then calls the same service the
   session route calls; it never holds a second implementation of a capability.
9. **Documented where clients look.** Every operation has its row in
   `docs/api/bff-routes.md`, naming its typed client and contract, in the same
   change.

ADR-0055's exception stands: a server component may render from the service
function its GET route calls, in the same session. Every write goes through the
route.

### Not decided yet, and when it will be

These are option 3, and the conventions above are what make them cheap later.
Each is decided by its own ADR when the first external client is commissioned:

- **A versioned public prefix** (Genesys's `/api/v2`). Until then the surface is
  unversioned and rule 6 is what keeps clients working.
- **A published OpenAPI document and generated SDKs**, from the same zod
  contracts. Buy first: `@asteasolutions/zod-to-openapi`, or zod 4's own JSON
  Schema export once the UI is on zod 4.
- **Machine credentials for integrations** (Genesys's OAuth client credentials
  with roles). Buy first: WorkOS machine-to-machine applications, so an
  integration holds a role and permissions like a person.
- **Webhooks or an event subscription API** for external clients, over the
  events rule 7 already requires.

### Consequences

- Good, because the agent, tasks and integrations can reach a capability the day
  it ships, through the gate the UI uses: same permissions, audit, rate limit
  and tenant scope.
- Good, because a public API later is a matter of exposure, not of rewriting
  each feature.
- Bad, because a capability with one consumer pays for a contract, a client and
  a route spec it does not need yet. That is the price of not paying a rewrite
  per capability.
- Bad, because the BFF-to-browser round trip replaces a server action or a
  direct import in a few places where one would have been shorter.
- Neutral: existing UI-only plumbing is not retrofitted wholesale. It moves to
  this shape when it is rewritten, or when a second client needs it.

### Confirmation

What holds today: `apiRoute` and its siblings do not compile without `authz`;
`authz-coverage.spec.ts` inventories every route; the lifecycle's route spec
drives all its handlers through `createDocumentLifecycleClient`, the pattern
each new capability copies; the committed `*.schema.json` contracts are
regenerated from zod under `UPDATE_FIXTURES=1` and a spec fails when they
drift, and `tests/aiq_agent/tools/documents/test_wire_contract.py` validates
the payloads the agent's tools build against theirs.

Nothing enforces "no private API" itself. Review is the gate, reading the rule
in the root `AGENTS.md` and the checklist in
[`docs/contributing/api-first.md`](../contributing/api-first.md).

## More Information

- Widens [ADR-0055](0055-api-first-workspace-primitives.md), which remains in
  force for everything it says.
- The route factories: [ADR-0017](0017-bff-repository-service-architecture.md);
  the permission catalog and required `authz`:
  [ADR-0038](0038-one-authorization-catalog-and-decision-point.md).
- The reference: Genesys Cloud's Platform API, which its own web client uses for
  everything (developer.genesys.cloud).
- **Revisit when** the first external integration is commissioned (then write
  the ADRs above), or when a capability's in-process latency is measured to
  make the HTTP hop matter.
