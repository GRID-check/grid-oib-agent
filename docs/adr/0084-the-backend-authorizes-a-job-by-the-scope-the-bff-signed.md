---
status: proposed
date: 2026-10-08
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# The backend authorizes a job by the scope the BFF signed

## Context and Problem Statement

A deep-research run is a backend job. With `REQUIRE_AUTH=true` the job routes
in `frontends/aiq_api` (status, stream, state, report, cancel, write-now,
documents, and the run listing) used to compare one thing: the caller's
principal against the job's owner on `job_access`. Anyone else got 404.

That broke the project. A teammate who can see a run in the BFF, because
`getRunView` checks `project:view`, opened its live stream and got 404, and the
same for its cancel. A scheduled or shared task's runs are submitted over the
internal route as the definition's requester, so nobody else on the project
could follow them. The product had access control for runs, and the backend
ignored it.

The backend cannot decide project access itself. It validates a JWT and reads
the context headers, and has no view of WorkOS memberships or the
conversation grants (ADR-0003, ADR-0007, `frontends/aiq_api/AGENTS.md`). The
BFF can, and does: `buildCollectionScopeFromRequest` checks `CHAT_PERMISSIONS`
on a project before it puts the project in a request's scope, and `viewer` on a
conversation. It already signs that scope into the `X-Grid-Request-Context`
envelope for the submit.

## Decision Drivers

* One policy decision point. Authorization is decided in the BFF (ADR-0038); a
  second copy in Python would drift.
* The backend must not act on a value a caller chose. Only signed fields may
  widen access.
* A refusal must not tell the caller whether the job exists.
* The listing and the single-job routes must agree, so a run the list shows is
  a run its stream opens.

## Considered Options

* Keep owner-only access.
* Have the backend ask the BFF, or WorkOS, about project membership on each request.
* Route every job request through the BFF on the internal service token.
* Have the BFF sign the scope it checked, and the backend check that the job lies inside it.

## Decision Outcome

Chosen option: "the BFF signs the scope it checked, and the backend checks that
the job lies inside it", because it keeps the decision in the BFF, adds no
network call to the backend, and reuses an envelope every producer already
mints.

With `REQUIRE_AUTH=true` a caller reaches job J when one of these holds:

1. **It owns J**: the principal's type and subject equal J's
   `owner_auth_type` and `owner_subject`, as before.
2. **J is in the signed project**: the request carries a valid signed
   envelope whose `organizationId` equals J's `organization_id`, and the
   project collection the envelope signed equals J's `project_collection`.
   This allows reads and controls.
3. **J is in the signed conversation**: as in 2, but the envelope's
   `conversationId` equals J's `conversation_id`. This allows reads only.

Reads are status, stream, stream resume, state and report. Controls are
cancel, write-now and documents; the proxy's DELETE is signed the same way. The
listing returns the caller's own runs plus every run that 2 or 3 reaches. Its
filters narrow that set and never widen it. A mismatch is the same 404 as a job
that does not exist.

An envelope grants anything only when all of these hold. Otherwise the caller
keeps what it owns and nothing more:

* It is signed with `GRID_INTERNAL_API_TOKEN`. With no secret configured,
  nothing is granted.
* `issuedAt` is present and within `GRID_REQUEST_CONTEXT_MAX_AGE_MS` (six
  hours) of now, in either direction. This is the BFF verifier's window, held
  equal by a test.
* `userId` equals the bearer token's subject, so a captured envelope does not
  travel with another person's token.
* A row whose `organization_id` is NULL matches no envelope, so it stays its
  owner's alone. So does a NULL project or conversation.

The project collection is derived from the signed `collectionScope` by
`derive_project_collection` in `aiq_api/jobs/access.py`. Submit uses the same
function to write `job_access.project_collection`, so the two sides cannot
disagree about one scope.

The BFF sends the envelope on every job request, built by
`signJobRequestContext` (`frontends/ui/src/lib/jobs/request-envelope.ts`). The
async-job proxy sends it on GET, POST and DELETE, the run controls in
`lib/runs/service.ts` send it, and the research-runs listing names its project
by `projectId` so the proxy checks it before signing. Because the job routes
now decide on the envelope, they left the envelope middleware's exempt list:
a WorkOS-authenticated call without one is refused. The internal-token routes
are unchanged. With `REQUIRE_AUTH` off nothing is enforced, as before.

**Why a conversation viewer may read and not steer.** `viewer` on a thread is
the right to read what is in it, and a run writes its progress and its report
into the thread that commissioned it. Following the run is reading. Cancelling
it, telling it to write now, or adding a document to it changes the answer
everyone in the project gets and spends the organization's budget, and the
BFF's own run controls require `CHAT_PERMISSIONS` on the project for that. A
thread grant is not that permission.

### Consequences

* Good, because a project teammate can follow and steer a run somebody else
  started, including scheduled and shared tasks' runs, and the backend learns
  nothing about memberships to allow it.
* Good, because a revoked membership takes effect on the next request: the
  BFF checks again before it signs.
* Bad, because members who may view a project but not chat in it
  (`project:view` without `project:chat`) still cannot open the live stream,
  status or report of a run they did not start. The BFF signs a project only
  after `CHAT_PERMISSIONS`, so their requests carry no project the backend
  would accept. They see the run's row and its stored ledger through the BFF's
  run view, not the live stream, and a listing that names the project is
  refused for them. This is a known limit. Lifting it needs a second, read-only
  project claim on the envelope, checked with `project:view`. That would change
  the envelope's contract, so it would need a decision of its own.
* Bad, because the project match depends on both tiers naming the base corpus
  the same way (`BASE_COLLECTION_NAME` in the BFF, `OIB_COLLECTION_NAME` in the
  backend). If they disagree, the scope looks ambiguous, no project is derived,
  and only owners get through. It fails closed, and silently.
* Bad, because rows written before `job_access.organization_id` existed stay
  owner-only.
* Bad, because the check runs when a stream opens. A stream that is already
  open stays open after the reader's access is revoked, until it closes.
* Neutral, because a deployment without `GRID_INTERNAL_API_TOKEN` (local dev)
  is owner-only, since no envelope can be verified.

### Confirmation

* `frontends/aiq_api/tests/test_job_access.py`: the rule, each envelope
  condition, the organization and NULL cases, reads against controls, the full
  middleware chain, and `test_the_job_envelope_window_is_the_bff_verifiers`,
  which reads the TypeScript constant.
* `frontends/aiq_api/tests/test_research_runs.py`: the listing returns own plus
  project or conversation runs and never another organization's.
* `frontends/aiq_api/tests/test_context_envelope.py`: no job read or control is
  exempt from the envelope.
* `frontends/ui/src/app/api/jobs/async/[...path]/route.spec.ts`: every method
  sends an envelope that `verifyGridRequestContextEnvelope` accepts and that
  names the checked project, and the listing forwards only the signed project.
* `frontends/ui/src/lib/jobs/backend-client.spec.ts` and
  `frontends/ui/src/lib/runs/service.spec.ts`: the run controls send it.

## Pros and Cons of the Options

### Keep owner-only access

* Good, because it needs nothing new.
* Bad, because it contradicts what the BFF shows: a teammate sees a run they
  cannot open, and a task's runs belong to one person.

### The backend asks the BFF or WorkOS on each request

* Good, because the answer is always current.
* Bad, because it adds a network call to every status poll and stream
  reconnect, and a dependency from the api tier on the BFF or on WorkOS.
* Bad, because it is a second place that decides access.

### Route every job request through the BFF on the internal token

* Good, because the backend would trust one caller.
* Bad, because the internal token names no user. The backend would lose the
  owner binding, and the service would hold a principal wider than any person
  (the concern of ADR-0051 and ADR-0054 §4).

## More Information

* ADR-0054 added the envelope's `issuedAt` and the BFF verifier whose window
  this reuses.
* ADR-0038 makes the BFF the one place that decides.
* Revisit when view-only members need the live stream (see the known limit),
  or when the backend gains its own view of project membership.
