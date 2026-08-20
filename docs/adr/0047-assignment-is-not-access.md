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
| Whose hand wrote them? | `documents.authored_by` (+ `authored_by_ref`, `authored_by_ref_kind`) | `user` or `agent`. New. The reference names the run for a report (`agent_run`) and the answer the drawing came from for a diagram (`answer_artifact`); migration 0066 split the two rather than calling both a run. |
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

## Addendum, 2026-08-20: for a filed diagram, the client asserts the provenance

The addendum above says a document can now have a non-human author. It does not
say who the server believes when it writes that down, and the two producers
answer that differently. A reader who assumes they are the same will read more
into `authored_by` than it can carry.

**The report's provenance is established by the server.** The BFF fetches the
finished report from the backend's job endpoint and files it in the same request
(`fileReportIfCommissioned`,
`frontends/ui/src/app/api/jobs/async/[...path]/route.ts`). The bytes never pass
through the browser: `readReportMarkdown` reads them off the upstream response,
and `authorize_job_access` (`frontends/aiq_api/src/aiq_api/jobs/access.py`) has
already refused a job whose owner is not the caller. Nobody can make that path
file prose of their own choosing.

**The diagram's provenance is asserted by the client.** The browser POSTs
`runId`, `title`, `sourceKind`, `source` and `svg` to
`/api/projects/[id]/diagrams`, and the server files two rows saying a machine
wrote this on the strength of the request saying so. That is not an oversight —
mermaid needs a DOM to lay a graph out and production has no browser
(`frontends/ui/src/lib/diagrams/filing.ts` states the constraint) — but it is a
different fact from the report's, and this ADR is where the difference belongs.

### What a hand-crafted POST buys, and what it does not

Assume the attacker is a member of the organization who already holds
`project:documents:write` on the project (or the legacy `project:edit`
umbrella) **and** `project:documents:generate` (see the addendum below —
machine authorship is a capability of its own, and the umbrella does not
satisfy it). Anything short of that is refused before a byte is stored.

| They can choose | Consequence |
|---|---|
| `svg` | Any drawing at all. It is parsed, allow-listed and **re-serialised** by `lib/diagrams/svg.ts`, so what lands is written from the allow-list rather than copied from the request — inert, but arbitrary. |
| `source` + `sourceKind` | The server escapes it into the `<metadata>` it writes itself. Nothing checks that the source draws the SVG beside it, so the two may disagree permanently. |
| `title` | The display name in Berichte, and the PDF's heading. |
| `runId` (the wire name) | Lands in `authored_by_ref` with `authored_by_ref_kind = 'answer_artifact'` (migration 0066), and is half the idempotency key. It is a **client-computed string** — `{answerId}-{fnv1a32(source)}`, `diagram-filing-context.tsx` — not a foreign key to anything. It need name no answer that ever existed. |

| They cannot choose | Why |
|---|---|
| the acting identity | `createdBy`, `organization_id` and the audit actor all come from the session (`requireAuthorizedSession`). |
| whether they may write here | `requireProjectAccess(project:documents:write \| project:edit)` **and** `requireProjectAccess(project:documents:generate)`, both inside the service. |
| the producer | Fixed by the route: `diagram_svg` / `diagram_pdf`. A forged **`deep_research`** row is unreachable from here. |
| the quota | One admitting path (`admitOrDiscard`), so the bytes are charged like every other document (ADR-0042). |
| indexability | `fileGeneratedDocument` dispatches nothing, and `dispatchDocument` re-reads the row and refuses a non-`user` author. |
| an unlogged write | `recordAuditEventOrThrow`; a document that could not be audited is unfiled. |

So `authored_by = 'agent'` means **this row was filed through the
generated-document path, in `createdBy`'s session, with `project:documents:write`
AND `project:documents:generate` in hand, and its bytes were never indexed.** It is a statement about the *path*,
not a warrant about the *hand*. It does **not** mean the model composed these
bytes, and `authored_by_ref` does not mean the answer it names exists or ever
held a diagram. The audit event inherits the same split exactly: the actor is the
session's real human, and the `answer_artifact` target beside it is whatever
string the request carried.

Two consequences that are not obvious from the row:

- **The forged shelf is the *less* capable one.** Everything `authored_by <>
  'user'` reaches is a restriction: not indexable, not joinable to a search hit
  (`joinHitsToFiles`), not readable back by the agent by name. An attacker who
  wants bytes in the project corpus uses the ordinary upload; this route is the
  way to put bytes somewhere they can be *seen and not retrieved*. The only thing
  it grants that upload does not is the byline — human-chosen bytes wearing
  „Von Piloti erstellt".
- **A reference can be squatted.** `uniq_documents_authored_ref_producer_per_project`
  makes the first filing of a `(project, ref, producer)` triple the only one, and
  a second returns it as `alreadyFiled`. Guessing the id is infeasible, but a
  participant in a shared conversation *knows* it: they can file their own
  drawing against a colleague's answer first, and the colleague's later press of
  the button silently hands back the squatter's document. This is bounded to
  people who can already read the thread and write to the project, and it is
  visible — the file is there to open — but it is the one case where the client's
  assertion changes what another person sees.

### The mitigation this ADR already names

The byline risk is the one the addendum above calls "UI collapse with a second
face", and the answer is unchanged by any of the above: **a byline is not
responsibility, and provenance is not evidence.** A forged agent-authored
document is `Unvergeben` like every other, is not citable, and names a real human
in `createdBy` and in the audit trail — the person a Ziviltechniker would go to.
The label is weaker than it looks; the relations around it are not.

### What would make the label mean more, and whether to do it now

The proposal is server-side derivation: on a filing request, look the message up
by the reference's answer id, confirm it belongs to this org, conversation and
project, confirm it
carries a diagram block of that `sourceKind`, and take `source` and `title` from
**that row** rather than from the body — leaving the client to supply only the
`svg`, which is the one thing it alone can produce.

**We are not doing it now, and the reason is not cost.** It would not establish
what it appears to establish. An assistant message is persisted by the *browser*,
through `POST /api/conversations/{id}/messages` — ADR-0033 §3 keeps private
conversations local-first on purpose, and the server-side writer
(`/api/internal/conversations/{id}/messages`) is a fail-soft path that runs only
when a client dropped mid-turn. Deriving the diagram's provenance from the
message row would therefore re-read a claim the same client wrote a moment
earlier, one row sideways, and buy a stricter-looking check that a hostile client
satisfies by POSTing the message first. Worse, it would read as a verification in
review forever after.

The change that would actually make `authored_by = 'agent'` a warrant is the
server persisting the assistant turn itself — server-authoritative messages on
the private path, not only on the shared one (ADR-0033's explicit non-goal).
Until that exists, derivation is theatre.

Three things follow, and they are cheap:

1. **Say what the column means** wherever it is read as an assurance — this
   section is that record, and `docs/api/bff-routes.md` carries the same
   statement on the route.
2. **The producer set stays route-fixed.** A route that let the caller name the
   producer would make the report's server-established provenance forgeable
   through the diagram's client-asserted one, which is the only way this becomes
   a real escalation.
3. **Revisit with server-authoritative messages**, not before. At that point the
   derivation costs one indexed lookup and buys a real fact, which is a different
   trade from today's.

## Addendum, 2026-08-20: machine authorship is a capability, and it is a conjunction

The addenda above give a document a fourth relation — who wrote it. They left the
*capability* undivided: filing was gated on `project:documents:write`, which is
also what authorizes a human upload, a delete and a re-ingest
(`frontends/ui/src/lib/documents/service.ts`). An organization that wanted Piloti
to answer but not to write into its file system therefore had exactly one lever,
and pulling it stopped its own architects uploading plans. That is not a choice,
and a deploy runbook that offered it as a kill switch was wrong; the correction
is in `../deployment/agent-authored-documents-rollout.md` §4.

**`project:documents:generate` is now required at every generated-document seam,
IN ADDITION to `project:documents:write` and never instead of it.** Three
reasons, all of them this ADR's own:

1. **This ADR adds relations; it does not substitute them.** The first addendum's
   whole point is that `createdBy` and `authored_by` are not collapsed, because a
   record that can hold only one of two facts has to lie about the other. Letting
   authorship REPLACE access at the gate would collapse, one level up, the pair
   the data model was careful to keep apart. Filing a generated document *is* a
   document write — same bucket, same `admitOrDiscard` quota ledger, same folder
   tree, same `deleteDocument` — and whose hand shaped the bytes does not change
   that question, it adds a second one.
2. **Substitution would rebuild the wider principal the design deleted.** The
   write happens in the commissioning human's session precisely so the agent
   never holds authority the human lacks. A standalone `generate` would let an
   organization grant a role the power to put bytes into a project's file system
   that it cannot put there by uploading, and cannot delete afterwards — a
   principal that writes more than it can undo.
3. **It keeps the sentence above literally true.** "The forged shelf is the LESS
   capable one" rests on the filer already holding ordinary document-write
   authority. An author who could file but not upload or delete would not be
   less capable in the way that paragraph claims.

Two consequences worth stating rather than discovering:

- **The `project:edit` umbrella is deliberately not accepted for it.** The
  any-of list exists to keep grants that predate ADR-0038 §3's *split* working.
  This is not a split of anything, and a permission every legacy role already
  implicitly holds is exactly the un-withholdable lever it exists to replace. So
  nothing holds it until the catalog is provisioned
  (`npm run provision:authz -- --apply`), and a custom project role written
  before this change stops filing until somebody grants it. A capability whose
  purpose is to be withholdable must fail to the state the organization has not
  asked for.
- **Withholding it is a tenant act, and a flag is the operator's.** An
  organization withholds machine authorship by putting people on a custom
  project role that omits the permission — ADR-0038 §4's extensibility contract,
  and drift-free because custom roles are not in the catalog. An OPERATOR who
  has to stop filing across every tenant at once cannot use the same lever: the
  only fleet-wide withdrawal is editing the built-in `project-editor` /
  `project-admin` roles in WorkOS, which then fails `provision:authz --check` in
  CI (ADR-0038 §1). That case is served by the `agent-authored-documents`
  feature flag (`GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED`, default ON), checked at
  the same seam so every producer rides it. Two instruments, two questions;
  neither can answer the other's.

## References

- ../superpowers/specs/2026-08-13-file-native-ownership-design.md
- ../superpowers/specs/2026-08-20-agent-authored-documents-design.md
- ../architecture/adding-a-shareable-resource-type.md
- ../design/collaboration-sharing-and-inbox-spec.md §5, Phase 3
