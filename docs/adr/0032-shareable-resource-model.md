# ADR-0032: The shareable-resource model, and where resource-level grants live

- **Status:** Accepted
- **Date:** 2026-07-29
- **Deciders:** Platform engineering
- **Related:** ADR-0004 (tenancy, ownership & access), ADR-0007 (no local identity sync),
  ADR-0016 (platform tier & permission registry), ADR-0017 (BFF repository/service
  architecture), ../design/collaboration-sharing-and-inbox-spec.md (§5, OQ-1, OQ-2)

## Context

Collaboration requires a way to say "this specific thing is available to these
specific people". Nothing in the product expresses that today:

- **Projects** are the only resource registered with WorkOS FGA
  (`resourceTypeSlug: 'project'`, roles `project-viewer|editor|admin`, permissions
  `project:view|edit|manage`, plus a declared-but-unused `project:chat`). Access
  checks go through `requireProjectAccess`.
- **Conversations** carry `organization_id` + `created_by` and are resolved
  **org-scoped only** (`findConversationInOrg`). Any org member holding a
  conversation id can read its messages, and the unfiltered list returns every
  conversation in the org. There is no visibility concept, so **"private chat" does
  not exist** — the project-scoped UI is what masks this.
- Nothing else (documents, workflows, saved reports) has any per-resource ACL.

The collaboration spec requires the sharing mechanism to be a **reusable substrate**,
not a chat feature: future resource types must inherit visibility, invitations, roles,
revocation, audit and UI by declaring themselves shareable.

Two forces shape the storage decision. Sharing needs **two directions** of query:
"who can reach resource R" (the authorization check, on every read of R) and
"what has been shared with person P" (the inbox, the history list, the badge — on
essentially every page render). WorkOS FGA is authoritative and consistent for the
first; the second is its expensive direction, and it is a network round-trip per
call in a path we render constantly.

## Decision

**We will model sharing as visibility + additive grants over a registry of
shareable resource types, and store resource-level grants in `grid_app`.**

1. **Visibility lives on the resource's own row.** A shareable resource carries one
   of `private | project | organization`. It is read on the hot path together with the
   row itself — no join, no second query, no round-trip. The registry declares *how*
   to read it per type, so the substrate stays generic while the storage stays cheap.

2. **Grants live in one generic `grid_app` table, `resource_shares`**, keyed
   `(resource_type, resource_id, subject_user_id)` with a role, scoped by
   `organization_id`, and indexed for the reverse lookup
   `(organization_id, subject_user_id, resource_type)`. This is the system of record
   for resource-level access.

3. **WorkOS remains authoritative for project membership**, and every resource-level
   check is still gated by `requireProjectAccess` on the resource's container. A grant
   can raise a person's role on one resource; it can never grant them the container.

4. **Effective role = the strongest of (visibility-derived role, explicit grant)**,
   gated by same-organization and container access. Grants are additive only — there
   is no per-person deny.

5. **The role ladder is `viewer < collaborator < owner`**, deliberately aligned with
   the project ladder (`project-viewer → viewer`, `project-editor → collaborator`,
   `project-admin → collaborator`). A project admin does **not** implicitly own every
   private resource in the project; they may **escalate** themselves to owner, and
   that escalation is audited distinctly from a normal grant.

6. **Shareability is declared in one exhaustive registry** keyed by resource type,
   supplying: container resolution, permitted visibilities, default visibility, the
   role set, reference rendering, deep-link construction, and whether mentions apply.
   Adding a type must cost a registry entry and translations.

7. **Existing conversations become `project`-visible; new conversations default to
   `private`** (spec OQ-1/MG-1). This preserves access for everyone inside the project
   and withdraws the accidental org-wide read.

## Consequences

### Positive

- One model, one UI, one audit trail for every resource type — present and future.
  The compliance board in `../roadmap/collaborative-workspace-vision.md` becomes a
  registry entry rather than a subsystem.
- "Shared with me" is a single indexed query, not a fan of FGA round-trips, so the
  inbox and history list stay cheap on every render.
- The accidental org-wide readability of conversations is closed as a side effect of
  shipping the feature, deliberately rather than incidentally.
- The container gate makes the dangerous case structurally impossible: sharing a
  resource can never be a back door into a project.

### Negative

- **Two access-control stores.** Project membership is in WorkOS; resource grants are
  in Postgres. A reader must know which question is answered where. Mitigated by
  routing every resource check through one helper that consults both in the right
  order, and by never expressing container access locally.
- Revocation of a grant is only as fast as the request that reads it (no caching is
  introduced here, deliberately).
- Visibility-on-the-row means each new shareable type adds a column rather than
  inheriting one, and the registry must know how to read it.

### Risks

- **Divergence from the project precedent** could confuse future contributors into
  putting project roles in Postgres too. Mitigated by stating the boundary here and in
  the sharing module's own documentation: *containers in WorkOS, resources in
  `grid_app`*.
- **A missed call site** could read a conversation without the new gate. Mitigated by
  making the org-scoped repository lookups private to the domain and routing all reads
  through the access helper, plus explicit cross-tenant and lost-container-access
  tests.
- If WorkOS later ships an efficient reverse lookup, this decision is worth
  revisiting; the registry keeps the migration to one module.

## Alternatives Considered

- **Store grants in WorkOS FGA as resource types per shareable type.** Consistent with
  projects, audit included, no new tables. Rejected because "everything shared with me"
  is the expensive direction, and it is on the render path of the inbox badge, the
  history list and the notification list — turning a page render into N network calls
  to an external service, whose outage would then black out the inbox.
- **A generic `resource_visibility` table** instead of a column per resource. Rejected:
  it adds a join or a second query to the hottest read in the product for a
  normalisation win we cannot spend.
- **Per-person deny rules.** Rejected: negative permissions make effective access
  non-composable and are the classic source of unexplainable access bugs.
- **Give project admins implicit ownership of every resource in their project.**
  Rejected: it would make `private` a lie. Auditable escalation gives the same
  operational capability without the dishonesty.
- **Keep conversations org-readable and add sharing on top.** Rejected: it would ship
  a "private" chip over a chat every colleague can read.

## Open Questions / Follow-ups

- `project:chat`, declared in the permission union but never checked, should either be
  enforced for posting or removed. Tracked separately; this ADR does not change it.
- Organisation-wide visibility and an org policy restricting available modes are
  specified (spec SH-15, SH-2) but deferred to phase 2; the model already carries the
  value.
- Second consumer (documents or workflows) is the real test of SH-9; if it costs more
  than a registry entry, fix the substrate.

## Addendum, 2026-07-31: the promise, measured

The "Consequences" section above says the second consumer is the real test, and
that anything it must change outside its own registry entry is a substrate
defect. With `conversation` still the only consumer, that was audited rather than
proven — the result is
[`../architecture/adding-a-shareable-resource-type.md`](../architecture/adding-a-shareable-resource-type.md).

The short version: storage, effective-access resolution, the sharing mutations
and their HTTP surface, and the inbox read path are genuinely generic. Mentions,
the events layer, the cleanup cascade and about twenty "generic" i18n strings are
not — and three declared descriptor fields (`defaultVisibility`,
`supportsMentions`, `labelKey`) are read by nobody, which is the tell. A second
type today would pay roughly twice its legitimate cost in refactoring the
substrate on the way through.

That document is the checklist and the debt register. Update it when you add a
type, and when you pay a piece of the debt down.

## References

- ../design/collaboration-sharing-and-inbox-spec.md — §5 (requirements SH-1…SH-20),
  §12 (migration), OQ-1, OQ-2
- ../architecture/multitenancy-and-auth-spec.md — §6 tenancy, ownership & access model
- ADR-0004, ADR-0007, ADR-0016
