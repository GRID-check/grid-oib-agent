# ADR-0047: Assignment is not access (and not provenance)

- **Status:** Proposed
- **Date:** 2026-08-13
- **Deciders:** Platform engineering
- **Related:** ADR-0004 (tenancy, ownership & access), ADR-0032 (shareable-resource
  model), ADR-0035 (inbox),
  [../superpowers/specs/2026-08-13-file-native-ownership-design.md](../superpowers/specs/2026-08-13-file-native-ownership-design.md),
  [../architecture/adding-a-shareable-resource-type.md](../architecture/adding-a-shareable-resource-type.md)

## Context

A project file needs a person you can go to: “this Brandschutzplan is Anna’s —
what’s up with it?” Three existing facts look like they could answer that, and
all three are the wrong fact.

- **`documents.createdBy`** is who put the bytes in the bucket. Bulk upload
  makes that a secretary, an import job, or last week’s intern. Provenance is
  real and must stay; it is not responsibility.
- **The shareable-resource `owner` role** (ADR-0032) means “can change the
  roster”. The last-owner invariant forbids a resource with nobody in that
  role. Responsibility must be allowed to be *empty* — that is the honest
  state after a dump of forty PDFs, and it is a project-health signal.
- **Project membership** answers who may *see* the file. A Brandschutzplan is
  usually visible to the whole project and still belongs to one or several
  people.

The collaboration substrate is the right *place* for a second resource type
(documents). It is the wrong *column* for “who is on the hook.” Mixing them
would make `private` and `verantwortlich` the same word.

## Decision

**We will model professional responsibility as a polymorphic assignment,
independent of access grants and of upload provenance.**

1. **Three relations, never collapsed.** Provenance (`createdBy`) is who
   uploaded. Access (visibility + `resource_shares`) is who may open or
   manage. Assignment is who is accountable. The UI must not render provenance
   as “verantwortlich.”
2. **Assignments live in one generic `grid_app` table**, keyed
   `(resource_type, resource_id, subject_user_id)`, scoped by
   `organization_id`, the same shape as `resource_shares`. Documents are the
   first consumer. A later compliance lane is a registry entry, not a second
   table.
3. **Cardinality is 0..n.** Empty is valid. Several people on one file is
   valid. Upload writes *no* assignment row.
4. **Assignment never grants access and access never implies assignment.**
   A project-visible file is readable by every project member with zero
   assignment rows. Assigning Anna does not change who can open the file.
   Making a file `private` is an access change (ADR-0032) and does not clear
   or create assignments.
5. **The shareable-resource `owner` role stays what ADR-0032 defined** — the
   person who can change visibility and the grant roster, subject to the
   last-owner invariant. It is not reused as “responsible.”
6. **Inbox items that say “this file is yours” or “Anna asked you about this
   file” point at the resource** through the existing inbox target registry
   (ADR-0035). They are not a second assignment store.

## Consequences

### Positive

- Bulk upload stays honest: files arrive unassigned and the gap is visible.
- Several people can share responsibility without anyone becoming the last
  access-owner by accident.
- The compliance board in the vision doc becomes another assignment consumer,
  the same way it was supposed to become another shareable type.
- Access tightening (private drafts) can ship later without rewriting who is
  on the hook.

### Negative

- Two tables that look similar (`resource_shares`, `resource_assignments`).
  A reader must know which question each answers. Mitigated by this ADR, by
  naming, and by never writing an assignment from a share mutation or a share
  from an assign mutation.

### Risks

- **UI collapse.** A face on a file card will be read as “owner” in the access
  sense unless the copy says verantwortlich / unassigned and the share chip
  stays a separate control. The spec forbids an AccessChip on project-visible
  files and forbids rendering `createdBy` as verantwortlich. Mitigated in the
  Files surfaces (`docs/superpowers/specs/2026-08-13-file-native-ownership-design.md`
  § UX language), not in the schema.
- **A missed call site writes `createdBy` into the assignment table** “as a
  default.” Forbidden. Tests must show a fresh upload has zero assignment rows.

## Alternatives Considered

- **Reuse `owner` as responsible, allow multiple owners.** Rejected: the
  last-owner invariant makes empty illegal, so bulk upload would have to
  invent an owner. Access-admin and professional responsibility would share a
  word and a mutation path.
- **A `responsible_user_id` column on `documents`.** Rejected: one person
  only, and a third consumer (a compliance lane) would need another column.
  The inbox and sharing substrate are already polymorphic.
- **Default assignment to the uploader, user can clear it.** Rejected: it
  paints a name on every bulk-uploaded file and hides the gap the product is
  supposed to surface. Provenance remains on `createdBy` for anyone who needs
  the historical fact.
- **Do not register `document` as shareable; assignment only.** Rejected as a
  *complete* answer: “ask Anna about this file” needs mentions and inbox
  targets, which hang off the shareable registry. Assignment still is not a
  grant. Both exist; they answer different questions. The substrate leaks
  that make a second type expensive are paid down in the same change (see
  the design spec) — they are not a reason to avoid the registry.

## References

- ../superpowers/specs/2026-08-13-file-native-ownership-design.md
- ../architecture/adding-a-shareable-resource-type.md
- ../design/collaboration-sharing-and-inbox-spec.md §5, Phase 3
