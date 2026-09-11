# Piloti writes: a product perspective on what this branch delivers

> **Status:** Product review for the owner, 2026-09-10. Written against the
> branch at HEAD (431 files, 28 349 insertions over `ee7ce67`) and its eleven
> release notes. Not an engineering assessment. Every "exists" claim names a
> file or a release-note slug; where a surface could not be verified from the
> repository it says so.
>
> **Baseline.** The design of record is
> [`piloti-writes-artifacts-and-approval.md`](piloti-writes-artifacts-and-approval.md);
> the consequences it is measured against are §2 of
> [`agentic-workspace-architecture.md`](agentic-workspace-architecture.md); the
> user evidence is [`../audit/pilot-feedback-triage-2026-09.md`](../audit/pilot-feedback-triage-2026-09.md).
> `docs/roadmap/architect-workspace-voice-and-agentic-loop.md` does not exist in
> this repository and was not read.

---

> **Closed on the same branch after this review was written** (each with a
> test that fails without it): the submit that found no reviewer for an
> Unvergeben draft (`lib/documents/reviewers.ts`: named → assignees → every
> `project:edit` holder → the submitter, recorded as a self-review); the
> commissioner who could not approve a run-submitted report (migration 0085,
> `submitted_by_actor`; the not-the-submitter guard applies to human
> submissions only); the delegated task with no surface (an „Aufgaben" tab in
> the Automation panel, `features/tasks/`); the thinking line's missing rules
> for the new verbs (`executed-steps.ts`). §1 and §3 below describe the state
> the review found; where they name one of these four, the fix is in.

## 1. One week in a planning office

Six moments, in the order an office meets them. **New** = this branch. **Was
there** = before `ee7ce67`. **Breaks** = what actually stops.

### Monday — a Brandschutz question

Unchanged, and that is the point: retrieval, citations, the Fundstellen rail and
the binding-status pill were already the best part of the product. What is new
sits underneath: if the office has ever published a Piloti-written document,
that document can now come back as a source, labelled **Piloti-Dokument ·
freigegeben von {Name}, {Datum}** in the office colour rather than in law blue
(`piloti-dokument-als-quelle`, `docs/architecture/agent-document-provenance.md`),
and a *verdict* — the masthead value a reader copies into a Nachweis — is
dropped when its Fundstelle resolves to such a document
(`_gate_verdict`, `src/aiq_agent/common/answer_envelope.py:294-336`). Nothing an
architect does differently; a class of quiet self-citation that can no longer
happen.

### Monday afternoon — the Aktenvermerk after the Behörde meeting

**New, and the largest single change.** „Schreib mir den Aktenvermerk" now
produces a file rather than a long message: `write_file` into a per-conversation
working folder (`src/aiq_agent/tools/documents/tools.py`, bound per turn at
`src/aiq_agent/agents/piloti/register.py:325`), with a `document_draft` card
beside the answer naming what was written
(`frontends/ui/src/features/grid-cards/components/DocumentDraftCard.tsx`).
„Kürze Punkt 3" edits that file in place instead of printing a second copy
(`piloti-working-directory`).

What the person sees: the card with the draft's name, path and size, the „Von
Piloti erstellt" byline, and — while it is unfiled — a control that **prefills
the composer** with the sentence that files it, deliberately not a filing button
(the reasoning is in the card's own header, `DocumentDraftCard.tsx:24-49`). Say
„leg das ins Projekt" and `file_draft` writes a `documents` row with a `draft`
version, in the asking person's pinned session and under their permissions
(`piloti-legt-entwurf-ins-projekt`, ADR-0054 §4).

**Where it breaks.** „Zur Freigabe einreichen" — on the card and in the Files
panel — sends no reviewer (`DocumentDraftCard.tsx:168`,
`document-lifecycle-panel.tsx:278`), and neither does the agent's `submit_draft`
(`src/aiq_agent/tools/documents/register.py:332`, whose comment says the route
"falls back to the project's reviewers"). It does not: `resolveReviewers`
(`frontends/ui/src/lib/documents/lifecycle.ts:160-169`) falls back to the
document's **assignments**, and a freshly filed Piloti draft is „Unvergeben" by
construction. With no assignee the submit is refused with *"Nobody to review this
version: name a reviewer or assign the document first"* (`lifecycle.ts:594`).
There is no reviewer picker anywhere in the UI. So the common path — Piloti
writes, Piloti files, submit for approval — stops at the third step until
somebody presses **Zuweisen** first. Unverified whether a running deployment
shows that 422 as usable copy.

### Tuesday — a colleague reviews it

**New.** Every document has **Freigabe und Fassungen** in the right-hand column
of the file page (`file-preview-pane.tsx:936`): submit, Freigeben, Änderungen
anfordern, Ablehnen, Veröffentlichen, Archivieren, offered only where state and
role allow, with the two refusals demanding a written reason
(`document-lifecycle-ui`). The reviewer gets a Postfach entry that names the file
and resolves itself once decided. **Piloti überarbeiten lassen** stands beside
Änderungen anfordern: the same required reason, and Piloti drafts the next
version instead of handing the work back to a colleague
(`piloti-ueberarbeiten-lassen`). In the same conversation the reviewer's words
arrive verbatim as a `REVIEW_DECISIONS v1` block
(`src/aiq_agent/agents/piloti/prompts/piloti.j2:365`); with no live conversation
a `revision` task is opened instead (`auftraege-und-ueberarbeitung`).

**Where it breaks.** The submitter cannot approve their own version
(`lifecycle.ts:542-545`) — correct, and it means a two-person office needs the
second person present, and a sole Ziviltechniker cannot close the loop at all.
**Mit … vergleichen** puts two versions side by side and marks nothing; the repo
has no diff library and the component says so
(`document-version-list.tsx:7-13`).

### Wednesday — the corrected Grundriss is re-uploaded

**New, and it needs no learning.** Re-uploading under the same name still
replaces the file; the previous bytes now stay as version N and can be opened
(`document-lifecycle`, migration `0082_document_versions.sql`). „Was stand im
März drin" is a query. A human upload is born `published` and wears no badge —
the badge appears only where there is something to know: more than one version,
or Piloti wrote it.

### Thursday — the scheduled report

**Changed, and this is the one behaviour change an existing user will notice.**
A finished deep-research report is filed as an **Entwurf** and submitted for
approval rather than arriving as a filed file
(`auftraege-und-ueberarbeitung`, upgrade note;
`frontends/ui/src/lib/documents/research-report.ts:298-370`). It is submitted to
the person who commissioned it — and that person is the submitter, so **they
cannot approve it themselves**. Publishing one is also a no-op for search:
`deep_research` output lives outside the `piloti/` namespace and
`ingestPublished` refuses to index it (`lifecycle.ts:326-338`) — correct, and
the Veröffentlichen button is still offered.

**Besprechen** now stands on the file, on the report card in chat and on the
Postfach entry (`discuss-document-button.tsx`, mounted in
`file-preview-pane.tsx`, `ReportCard.tsx`, `InboxItemRow.tsx`), and works on an
unpublished draft by reading the version's bytes
(`dokument-besprechen`). It is gated on `projectId`: a chat outside a project
gets nothing.

### Friday — tidying the Einreichung folder

**New.** „Leg die Einreichunterlagen zusammen" produces one
`file_operation_proposal` card listing every move; nothing changes until Apply,
and the moves then run in the reader's own session, with partial failures named
per entry (`piloti-schlaegt-ablage-vor`,
`FileOperationProposalCard.tsx`). Five verbs: move, rename, create folder,
assign — `set_doc_class` was deliberately left out
(`configs/config_oib_openrouter.yml:563`).

**Note on the tool surface.** The four working-directory verbs are *not* in
`configs/config_oib_openrouter.yml`; they are folded in per turn in
`piloti/register.py` and vanish when a turn has no conversation (CLI, eval,
worker). The YAML binds `file_draft`, `submit_draft`, `create_task` and the five
proposal tools (`:557-600`, listed at `:660-666`).

---

## 2. Where the needle moved

### Against the three consequences of the 2026-09-01 review

| Consequence (§2) | Movement |
|---|---|
| **Traceability is the product** | Sideways-and-forward. The *retrieval* chain is untouched here — the query is still blanked before storage, `Punkt` and score still do not reach the row (§4 of the architecture doc). What is new is a second chain: who wrote a document, who asserted it, when, and which bytes were live in March — held by CHECK constraints (`0082`) and nine audit actions (`lib/audit/schemas.mjs:277-360`), not by call sites. |
| **The agent must hold work** | Real movement. `create_task` from chat, a `TaskCreatedCard` naming a row the BFF already wrote, `revision` tasks opened from a reviewer's comment, a deep-research report filed at completion in the pinned requester's session. What is still missing is the surface: no UI reads `GET /api/projects/[id]/tasks` (no consumer found in `frontends/ui/src`), so a task is visible only as the card in the thread that made it. |
| **Every loop closes on a measurement** | Barely moved, and this is the weakest column. The design names three measurements (design of record §8); the audit actions that would feed them exist; nothing reads them. The one live-model harness (`task be:eval:turn-shapes`, `Taskfile.yml:433`) has three cases and none is a drafting turn (`tests/benchmarks/test_turn_shapes_live.py:267-302`). |

### Against the pilot's actual asks

| Pilot ask (triage doc) | Status | Evidence |
|---|---|---|
| Versioning / „Weiterarbeiten am Original" | **Answered** | `document-lifecycle`, migration `0082` |
| Delta and re-upload without losing the old file | **Answered** | superseded versions keep their bytes (ADR-0054 §Superseded) |
| „Gute Details werden befördert" (move between shelves) | **Indirect** | a Piloti document reaches the index by publish; a human file still cannot move shelves |
| „Das Archiv ist eine Sicht" / Bürowissen | **Indirect** | a published Piloti document is `buero_piloti` inside the office kind (`agent-document-provenance.md`); the Archiv itself gains no Freigabe section (`file-preview-pane.tsx:936` requires `projectId`) |
| Agent könnte öfter Rückfragen stellen | **Not answered** | untouched on this branch |
| „@Kollegin erwähnen" reaches somebody who is not in the app | **Not answered** | no mail transport in the repo; inbox only |
| Folder upload | **Answered, but not here** | `webkitdirectory` landed 2026-09-08 (`project-uppy-upload.tsx`), before this branch |
| Drag & drop between folders | **Answered, but not here** | `onDropDocument` / `onDropFolder` in `folder-navigation.tsx`, pre-branch |
| Projekt abschließen (project status) | **Not answered** | `projects` still has no status column |
| Viewer/Vorschau für CAD- und Office-Formate | **Not answered** | unchanged; still an ADR-first dependency decision |
| Deep research bricht ab | **Not answered here** | fixed pre-branch; this branch changes only where the report lands |

---

## 3. What is still lacking, in the order an office will hit it

1. **The review round-trip needs a reviewer and cannot name one.** An unassigned
   draft cannot be submitted (§1, Monday). This is the first step of the flow
   every release note describes. *Cheapest honest fix:* a reviewer picker on
   submit, and a fallback to the project's members with `project:edit` in
   `resolveReviewers`, with the tool's stale comment corrected.
2. **The commissioner cannot approve their own report.** Two-person offices and
   sole Ziviltechniker have no exit from „In Prüfung" for a scheduled report.
   *Cheapest fix:* do not submit a report to its own commissioner — file it as
   `draft` and let them submit it to somebody, or allow self-approval where the
   submitter is a machine-opened round.
3. **No live validation of a single real turn.** 115 changed spec files, no
   backend in this environment, no drafting case in the live harness, and
   `task be:eval:retrieval` needs an operator corpus that `data/oib` does not
   hold (README only). *Cheapest fix:* three cases in
   `test_turn_shapes_live.py` — commission, revise, file — before pilot day one.
4. **No task list.** ADR-0051 argues correctly against a `jobs` row per
   delegation, and the consequence is that delegated work is listed nowhere. An
   office that delegates twice on Monday has no way to ask what is running.
   *Cheapest fix:* a „Läufe" list over the existing `GET …/tasks`.
5. **Retention.** Superseded versions and per-conversation working directories
   accumulate and count against quota; the release note says so and says there
   is no policy (`document-lifecycle`, upgrade). *Cheapest fix:* an org setting
   with a default, plus the conversation-cascade cleanup the design specifies.
6. **The diff shows no differences.** Two texts side by side, in a product whose
   whole review gesture is „was hat sich geändert". *Cheapest fix:* one small
   diff dependency, line granularity, rendered client-side — the route already
   returns both contents.
7. **The Archiv has no Freigabe section**, so office knowledge — the shelf the
   pilot asked to grow — cannot be reviewed or versioned through the panel.
   *Cheapest fix:* resolve org-level permissions on that surface and mount the
   same panel.
8. **The unfiled draft card cannot file.** By design (`DocumentDraftCard.tsx:24-49`,
   ADR-0055), and still a person pressing a control and then a send button. Live
   with it; revisit only if the bytes ever reach the browser.
9. **Deep research now costs a review round.** Yesterday a report was filed;
   today it waits. For an office that trusted the old behaviour this reads as a
   regression in convenience, and item 2 makes it a dead end. *Cheapest fix:*
   items 1 and 2, plus one line in the success banner naming the new state.
10. **The working directory is per conversation.** A draft started in one chat is
    invisible in another; the only bridge is filing it. Correct for isolation,
    surprising for a person who thinks in projects. *Cheapest fix:* say it in
    the card, once.
11. **`project:edit` is the Freigabe permission.** A Ziviltechniker's sign-off
    and "may edit the project" are the same right. *Cheapest fix:* leave it, and
    put the question to the first customer who has both roles in one office.
12. **Nobody learns Piloti can write.** No onboarding surface for the new verbs
    was found; discovery is a person happening to phrase a request as a
    commission. *Cheapest fix:* one follow-up chip after a long answer — „als
    Aktenvermerk schreiben".
13. **The thinking line does not name the new verbs.** The design said
    `turn_status` gets an action key per verb; no such wiring was found, and
    `STEP_NAME_RULES` (`features/chat/lib/executed-steps.ts:74-82`) has no rule
    for `write_file`, `edit_file` or `file_draft`. Unverified against a running
    turn.
14. **Mobile.** Not verified. The review controls live in a right-hand rail on a
    file page; whether that rail is reachable on a phone was not checked.

---

## 4. Risks in the first two weeks

- **The approval door as ritual.** Freigeben is one click with no comment
  required, on a document the reviewer may not have opened. The product's
  defence is that the reason is required only for the two refusals — the
  cheapest thing that is not rubber-stamping. Watch the median time between
  `document.version.submitted` and `document.version.approved`; a distribution
  clustered under a minute is the signal.
- **Quota.** Every re-upload now keeps its predecessor. An office that re-uploads
  a plan set weekly grows monotonically, and nothing warns before the ceiling.
- **The audit-schema deploy step fails silently when skipped.**
  `docs/deployment/agent-authored-documents-rollout.md:90-111` — nine new
  actions must be reconciled into WorkOS; on Kubernetes the frontend does not
  wait for the job. Symptom: filing appears to work and the trail is missing.
- **The backfill on a large tenant.** `0082` writes one `document_versions` row
  per existing `documents` row in a single INSERT, then an UPDATE over the same
  set, inside the migration. Guarded by `NOT EXISTS` and re-runnable; not
  batched. Nothing lands in a review queue, which is the right call and worth
  saying out loud to the pilot before the deploy.
- **The interaction budget, 6 → 9** (`agents/piloti/agent.py:95-135`). Three more
  non-research calls per turn. The derivation is written down and the ceiling is
  a ceiling, not a quota — but the same loop now has more room to spend on
  output before it spends on retrieval. No before/after measurement exists.
- **The provenance line.** „Herkunft: Piloti-Dokument · freigegeben von …" is
  text a model copies. A reader who sees the office's own approved document
  quoted beside an OIB passage may still read both as authority; the verdict
  gate protects the copyable value and not the prose.
- **Prompt growth.** Three new blocks and +367 lines in `piloti.j2` (plus 69 in
  `plan_generation.j2`, 203 in `research_clarification.j2`). Every turn pays for
  them in tokens and latency, including the greeting. Unmeasured.

---

## 5. Five numbers for week one

| Number | Source |
|---|---|
| Drafts written vs. drafts filed vs. drafts submitted | `document.version.drafted` / `.submitted` audit actions (`lib/audit/schemas.mjs:300-320`); the gap between the first two is the composer hand-off, between the second and third is the reviewer bug |
| Submits refused for want of a reviewer | 422s from `resolveReviewersOrRefuse` (`lifecycle.ts:594`) — the single best test of §3 item 1 |
| Median time `in_review` → `approved`, per producer | `document.version.submitted` / `.approved`; under a minute means rubber-stamping, never means nothing |
| Verdicts dropped for naming an agent-authored source | `emit_verdict_dropped`, `status:verdict:dropped` (`common/turn_status.py`, `answer_envelope.py:294`) — the rate says how often the agent reaches for its own document as a norm |
| Drafting turns that behave, on the live model | `task be:eval:turn-shapes` extended with commission / revise / file cases (`Taskfile.yml:433`) |

---

## 6. Verdict

This is a large step toward the workspace the 2026-09-01 review described, and
it is the step that review put second of three. "Piloti is a member of the
office" is now true in the parts that concern *artifacts*: it writes documents
instead of describing them, it files them under the asking person's name and
permissions, what it files is a draft the database refuses to index until a
person has asserted it, that assertion is a first-class audited act with a
version history behind it, and an approved document comes back into an answer
labelled as the office's own word rather than as law. That is a coherent,
constraint-held answer to the half of the reframing about work leaving a trace a
human can open. What remains a claim is the half about *holding* work: a task
exists as a row, a card and a route, and nowhere as a place a person looks; the
review round-trip that everything else rests on stops on a missing reviewer in
its most common shape; and the third consequence — every loop closes on a
measurement — is answered by instrumentation that is written and unread, with no
turn on this branch validated against a live model. The honest summary for the
pilot is that the office can now be given a document to approve, cannot yet be
given a queue of them, and that nobody has watched one full round-trip happen.
