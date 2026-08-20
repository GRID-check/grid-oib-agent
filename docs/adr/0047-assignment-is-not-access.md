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

## Addendum, 2026-08-20: a fourth relation, because the author is not a person

Documents are now created by something that is not a human being. A commissioned
deep-research run is rendered by the BFF and filed into the project as an
ordinary `documents` row — `authored_by = 'agent'`, `authored_by_run_id` naming
the run, `status = 'stored'`, and **zero assignees**. The design is
[../superpowers/specs/2026-08-20-agent-authored-documents-design.md](../superpowers/specs/2026-08-20-agent-authored-documents-design.md).

Four things this ADR has to say about it.

**1. Provenance is now two questions, and neither is responsibility.** The
"Decision" above names three relations. There are four:

| Question | Column / table | Rule |
|---|---|---|
| Who caused these bytes to exist? | `documents.createdBy` | The commissioning **human**. Unchanged. The export and the audit both need a person to name. |
| Whose hand wrote them? | `documents.authored_by` (+ `authored_by_run_id`) | `user` or `agent`. New. |
| Who may open it? | visibility + `resource_shares` (ADR-0032) | Unchanged. |
| Who is on the hook? | `resource_assignments` | Unchanged. **Empty on arrival.** |

`createdBy` and `authored_by` are deliberately not collapsed: a report Piloti
wrote for Anna is *caused by* Anna and *written by* a machine, and a schema that
can only record one of those has to lie about the other.

**Decision §1's rule extends to the new column without amendment: the UI must
not render `authored_by` as „verantwortlich" either.** It is rendered as a quiet
`Von Piloti erstellt` byline, never as a face, never in the assignment row, and
never in a way that could be read as somebody having accepted the document. This
is not a stylistic preference. A Ziviltechniker carries the liability for what
leaves the office, and a machine cannot hold it — so „nobody yet" is the only
honest state a generated report can arrive in, and `Unvergeben` (§3, cardinality
0..n, *empty is valid*) is exactly the word for it. `Zuweisen` is the act that
makes it somebody's, and no new gesture was invented for the purpose.

**2. The risk this ADR called "UI collapse" now has a second face.** The original
risk was a face on a card being read as access-ownership. The new one is a
*byline* being read as responsibility — "Piloti wrote it, so Piloti is
answerable for it", which is worse, because there is nobody there. The mitigation
is the same shape as before and lives in the same place: the Files surfaces, the
copy, and the visual evidence
([../ux/visual-screenshots.md](../ux/visual-screenshots.md), targets
`agent-authored` and `research-filing`).

**3. The `document` purger is still unimplemented, and that limits which
lifecycle promises hold for these rows.** `frontends/ui/purger/index.js`
registers exactly one entity type — `project` — with `document`, `conversation`,
`organization` and `user` marked "later phases". So:

- **Immediate erasure works today.** `deleteDocument`
  (`frontends/ui/src/lib/documents/service.ts`) purges collaboration rows,
  assignments, chunks, the object, the thumbnail and the BIM siblings. An
  agent-authored document is erasable on day one, and its zero assignments make
  the assignment cascade trivially correct.
- **The queued, graced, legal-hold path does not.** Everything ADR-0011's
  deletion pipeline promises about a *scheduled* document purge — a grace
  window, a hold that suspends it, a retryable worker — is unreachable for a
  `document` row, because the queue would find no purger and fail the row
  permanently. That is true of every document, not only generated ones; this
  change neither causes it nor fixes it. It is written down here so the gap is
  read rather than assumed away by the presence of a pipeline ADR.

**4. ADR-0042's backup posture remains Proposed, and this change does not move
it.** [ADR-0042](0042-object-storage-durability-and-quota.md) is still
**Proposed** — the documents bucket's backup story is a deployment decision that
has not been taken. A generated report is bytes in the *same* store, admitted
through the *same* path (`admitOrDiscard`, one admitting path, so the quota
ledger sees it), so it inherits that posture exactly: no better, no worse, and no
second store was introduced that would have to be backed up separately. The
honest statement is that an agent-authored document is as durable as every other
document in the deployment, which is a sentence about ADR-0042 and not about this
feature.

## References

- ../superpowers/specs/2026-08-13-file-native-ownership-design.md
- ../superpowers/specs/2026-08-20-agent-authored-documents-design.md
- ../architecture/adding-a-shareable-resource-type.md
- ../design/collaboration-sharing-and-inbox-spec.md §5, Phase 3
