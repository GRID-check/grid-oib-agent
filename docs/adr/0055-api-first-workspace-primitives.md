---
status: accepted
date: 2026-09-10
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# A workspace primitive is an HTTP route with a typed client, and every consumer is a client of it

## Context and Problem Statement

The repo has three consumers that reach the same domain logic and reach it three
different ways.

The **UI** calls `app/api` routes. The **agent** calls service functions through
internal routes that were added one at a time as each need arose
(`/api/internal/memory`, `/api/internal/skills`, `/api/internal/conversations`).
The **task runner** calls service functions directly, in-process, through a
pinned session. Each was reasonable on its own; together they mean a primitive's
rules are true wherever somebody remembered to make them true.

The cost is not hypothetical, and this repo has already paid it twice at one
level down. `AUDIT_ACTIONS` and the provisioning script's `SCHEMAS` array were
two lists meant to be one, drifted by nine actions, and the only symptom was one
ERROR log per privileged mutation on the side of the emitter that never throws.
`documents.authored_by_run_id` held a job id for one producer and a
client-computed string for two others, with the column, its comment and the
audit target all still saying "job id". Both were one description of a contract
with a second description beside it.

The document lifecycle is where that pattern would have become structural. It
has ten routes, a machine caller, a UI, a task runner and — one slice later — a
tool description the Python tier has to carry. Written the existing way, that is
an HTTP surface for the browser, a set of service calls for the agent, and a
hand-written Pydantic model describing a body nothing checks against the zod
schema that parses it.

## Decision Drivers

- A rule that is true on one path and not another is worse than no rule: the
  path where it holds makes the one where it does not look safe.
- The agent's principal is wider than any human's, so its writes must go through
  the same gate a human's do, not through a parallel one.
- A contract described twice in two languages drifts, and the drift is silent.
- Nothing here should need a new framework, a code generator in the build, or a
  service mesh.

## Considered Options

1. **Keep the status quo**: routes for the UI, internal routes and direct
   service calls for everything else, per feature.
2. **Shared service functions, no route for the agent** — the agent imports the
   same TypeScript the routes call.
3. **One HTTP API per primitive, with a typed client**, and every consumer —
   UI, agent tools, tasks, later integrations — a client of it.

## Decision Outcome

Chosen option: **3**.

**Every primitive this build adds is an HTTP route with a typed client first,
and no service function is reached from a second path.** Concretely, for the
document lifecycle (ADR-0054):

- the routes under `/api/documents/[id]/versions/…` are the surface;
- `lib/documents/lifecycle-client.ts` is the one client, holding the paths, the
  verbs and the response parsing, and the route specs drive the real handlers
  **through it** — so the client and the routes cannot disagree about a path or
  a field name with nothing to notice;
- `lib/documents/lifecycle-types.ts` holds the zod schemas, with no `server-only`
  and no drizzle, so the browser, the routes and the tests share them;
- those schemas are serialised to JSON Schema
  (`frontends/ui/tests/fixtures/document-lifecycle.schema.json`) for the Python
  tier, so there is **no second hand-written model**;
- the agent reaches exactly one internal route, which builds the acting person's
  session and calls the same service functions a user-session route calls.

Option 2 is the tempting one and it is the one that rebuilds the problem. A
shared function is shared code, not a shared *gate*: the agent would still be
the party deciding which function to call, with what session, in what order —
and every rule that lives at a route (the authz declaration the coverage spec
reads, the rate limit, the tenant slot, the body schema) would apply to the UI
and not to it.

Option 1 is what we have. It is not a decision; it is an accumulation.

### What this is not

- It is not a rule that a browser must go over HTTP to reach a server component.
  Server components read through repositories as they always have. This is about
  a **primitive with more than one consumer**.
- It is not a microservice boundary, an RPC framework, or a code generator in
  the build. It is one client module per primitive and one committed JSON Schema.
- It is not a promise to retrofit every existing primitive. Memory, skills and
  jobs keep their current shapes until something asks them to change; the rule
  binds what is added and what is rewritten.

### Consequences

* Good, because the agent's writes go through the gate the UI's go through:
  same permission checks, same audit, same effects, same tenant scope.
* Good, because a second consumer costs a call to the client rather than a
  second reading of the domain rules.
* Good, because "what does this endpoint accept" has one answer in two languages
  and a test that fails when they diverge.
* Bad, because an in-process consumer pays HTTP serialisation for a call it
  could have made directly. Measured against a WorkOS FGA round trip and a
  Postgres write, that is noise; measured against a tight loop it would not be,
  and a primitive with a hot in-process path is a reason to revisit rather than
  to quietly exempt one caller.
* Bad, because a typed client is one more module to keep honest. The route specs
  driving the handlers through it is what keeps it from becoming decoration.
* Neutral: the JSON Schema is a committed artifact, so it can go stale. The spec
  regenerates it under `UPDATE_FIXTURES=1` and fails otherwise.

### Confirmation

`src/app/api/documents/[id]/versions/route.spec.ts` exercises all ten routes
**through `createDocumentLifecycleClient`** rather than through hand-built
requests — a client that disagreed with a route about a path, a verb or a field
would fail there. `src/lib/documents/lifecycle-schema.spec.ts` compares the
generated JSON Schema against the committed fixture and refuses to describe a
zod node it does not understand, so an unexportable contract is a failing test
rather than a schema that permits anything. `authz-coverage.spec.ts` already
requires every route to declare how it is authorized.

Nothing enforces the doctrine itself across the repo — there is no lint rule
that says "this service function has two callers on two paths". Review is the
gate for that, and this record plus the row in the root `AGENTS.md` is what
review reads.

## More Information

- The first primitive built this way: [ADR-0054](0054-document-versions-and-the-publish-door.md).
- The client: `frontends/ui/src/lib/documents/lifecycle-client.ts`.
- The design of record, §7:
  [`../roadmap/piloti-writes-artifacts-and-approval.md`](../roadmap/piloti-writes-artifacts-and-approval.md).
- **Revisit when** an in-process consumer's latency is measured to matter, or
  when a third primitive has been built this way and the client modules have
  enough in common to share a base — not before, because two examples is not a
  pattern.
