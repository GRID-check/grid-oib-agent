---
status: accepted
date: 2026-09-10
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# A document has versions, and only a person opens the publish door

## Context and Problem Statement

Two gaps met in one table.

**A document had no history.** Since migration 0074, re-uploading a file under a
name a collection already holds replaces the document *in place* — the same
`documents.id`, deliberately, so citations, chat subjects, assignments and
folder placements survive a corrected plan — and `discardSupersededObjects` then
deleted the previous bytes. That is versioning without the history: the gesture
an architect means by dropping a corrected Grundriss is "this is the new one",
not "delete the old one", and until now the product could not answer "what did
this file say in March".

**A document had no editorial state.** ADR-0047 gave a document four relations —
who caused the bytes (`created_by`), whose hand wrote them (`authored_by`), who
may open it (visibility + `resource_shares`), who is on the hook
(`resource_assignments`). None of them says whether anybody has **asserted the
content**. A Ziviltechniker's *Freigabe* of a Brandschutzkonzept is a
professional act with liability attached; "Anna is on the hook for this file"
and "the office stands behind what this file says" are different sentences, and
the second one had nowhere to live.

The second gap became urgent because of what is about to be able to write.
`docs/roadmap/piloti-writes-artifacts-and-approval.md` puts a chat turn's
Markdown into the project as a document. Two failure modes follow immediately if
there is no editorial state: a machine-written document is indistinguishable
from a checked one in the Files pane, and — the one that cannot be walked back —
a machine-written document that reaches the retrieval index comes back to the
agent as *Projektwissen* under a green citable badge, indistinguishable from a
stamped Gutachten. The 2026-08-20 build spec closed that by never indexing
agent-authored rows at all, and left the seam open **with a condition**: "if a
tenant ever wants generated reports searchable, that is a policy granting
ingestion for a producer, and it must arrive together with the labelled-citation
work, never before it."

Versioning was cut once, on purpose. The same build spec lists "a node / version
/ blob store, `fs_edit`, exact-string patches" under *What this is not*, with
the reason: "Nothing in the repo reports an agent-authored report being edited.
Versioning solves an unobserved problem and is the largest cost item in the
exploration." That reasoning was correct for one producer that hands over a
finished report. It stopped being correct the moment a chat turn writes a
document a person is expected to send back for changes.

## Decision Drivers

- The thing that may be indexed must be a thing a **person** signed off, and
  that must be a row invariant rather than a predicate in a retrieval path whose
  documented posture is fail-open.
- ADR-0047's relations must not be collapsed. `Zuweisen` stays responsibility.
- A re-upload must stop destroying what it replaces.
- One vocabulary for humans and for Piloti: two review models would mean two
  badges, two inbox types and two answers to "what state is this file in".
- No new permission, no new resource type, no state-machine dependency.

## Considered Options

1. **Editorial state as columns on `documents`.** Cheapest; one row per file.
2. **A `document_versions` table**, with the item keeping every relation and a
   pointer to the live version.
3. **A new `documents` row per revision**, linked by a `supersedes` column.
4. **Keep the lifecycle for agent-authored rows only**, leaving human uploads on
   the replace-in-place path.

## Decision Outcome

Chosen option: **2, applied to every document** — a `document_versions` row per
set of bytes, carrying the editorial state; `documents` stays the item.

Option 1 re-opens ADR-0047 without an argument: it would put "in review" beside
"assigned to Anna" on the same row, where the product's own copy rules say a
byline must never read as responsibility. It also cannot hold a history at all.

Option 3 is unrepresentable. `uniq_documents_authored_ref_producer_per_project`
makes a second row per (project, reference, producer) impossible, every relation
in the product binds the item id, and each row would be an object plus a quota
charge.

Option 4 was the original brief and the product owner overturned it during the
build, correctly. Two lifecycles for one file type is two badge vocabularies,
two version lists and a permanent question at every surface about which one
applies. **One history for humans and agents**: a human upload writes version 1
`published`, born approved because the person who uploaded it *is* the
assertion; a re-upload writes version N+1 and leaves N standing as `superseded`
with its bytes intact; an agent filing writes a `draft` that walks the review
states. Approve and publish are available on a human-authored item and never
required.

What the states are, and why:

```
draft → in_review → approved → published → superseded
          ├→ changes_requested → (revise, file again) → draft
          └→ rejected
item: active → archived
```

`approved` and `published` stay distinct because approving a Befund on Tuesday
and issuing it with the Einreichung on Friday are two acts by two people, and
because a later `scheduled` state attaches to publish without touching approval.

Four decisions carry the rest:

- **The publish door is `actor: 'human'` in the transition table, and the table
  is data.** The agent's internal route serves `create`, `update` and `submit`;
  the machine-reachable set is *derived* from the `actor` field rather than
  listed a second time, so widening it is a change to the row a reviewer reads.
- **Only a version a person approved may ever be published**, as a CHECK:
  `state <> 'published' OR (approved_by IS NOT NULL AND approved_at IS NOT
  NULL)`. Slice 4 dispatches only a published version to the index. That chain —
  indexed ⟹ published ⟹ approved by a person — is held by the database, not by
  anybody remembering it.
- **Superseded bytes stay.** A version keeps its object under a `v<n>/` key of
  its own; objects are purged when the document is deleted (`deleteDocument`
  walks every version) and not when one is replaced. History you cannot open is
  a list of dates.
- **No state-machine library.** The authority is Postgres: the CHECKs plus a
  compare-and-swap `UPDATE … WHERE state = $expected`. A library holds the rule
  in one process's memory, which is the one place it cannot be true — two
  reviewers pressing Freigeben at the same instant, a retried request, a
  half-applied deploy.

### Indexing: what a publish does to the retrieval corpus

Written as an addendum because the record above said "Slice 4 dispatches only a
published version to the index" and left the mechanism to that slice. It is
built now, and three properties carry it.

**Only a published version, and only its own bytes.** `dispatchDocument`'s guard
refuses a machine-authored row unless the dispatch names the version the row's
`published_version_id` points at. That is a COMPARISON and not a list of allowed
states, so `draft`, `in_review`, `changes_requested`, `approved`-but-unpublished,
`superseded` and `rejected` are refused by one rule rather than six, and a later
state cannot be forgotten. The dispatch happens in the `ingestPublished` effect
of the transition table's `publish` row and nowhere else, so "only a published
version is dispatched" is a property of the table.

The clause is worth what stands behind it, and what stands behind it is the
database: `document_versions_published_is_approved` refuses a published row with
no approver, and `uniq_document_versions_published_per_document` refuses a
second. **Indexed ⟹ published ⟹ approved by a person** is a chain of
constraints, not a chain of call sites.

**A filename namespace, from creation.** `documents.filename` is the retrieval
index's join key and is never renamed, so a published Piloti document is filed
as `piloti/<document id>/<name>` from the moment the row is written — not
rewritten on the way into the index, which would index under one string and
purge under another. No browser produces a filename containing `/`, so no upload
shelf can present a name inside the namespace: the collision `generatedFilename`
put within the model's reach (a report landing on the filename of the document
it was written from) becomes unrepresentable rather than unlikely. Migration
0083 widens `uniq_documents_live_name_per_collection` to
`authored_by = 'user' OR filename LIKE 'piloti/%'` — two arms that cannot meet —
and `collectionFileRef` accepts a machine-authored row only when it is published
AND namespaced, which keeps "indexed" and "purgeable" the same set. The OBJECT
key stays flat and unchanged; the row's name and the key's basename are allowed
to differ because the ingest dispatch now STATES the name (`file_name` on
`POST /v1/ingest`) instead of letting the backend read it off the presigned URL.

**Provenance is metadata, never a `doc_class`.** Four keys —
`authored_by`, `approved_by` (the approver's display name), `approved_at`,
`producer` — travel on the dispatch, onto every chunk and onto the backend's
document-metadata row. `doc_class` is untouched: it is a closed norm-hierarchy
vocabulary whose fail-open lane is „Basisdokument", and filing authorship there
would file it under the hierarchy of authority. The retrieval side maps the keys
to the `buero_piloti` lane
([`../architecture/agent-document-provenance.md`](../architecture/agent-document-provenance.md)).

**Supersede and archive purge.** Publishing over a previous version purges that
version's chunks BEFORE the new bytes are sent — a version has no filename, the
ITEM does, so both address the same chunks and purging afterwards would delete
what had just been written. It also decides the failure case correctly: with the
backend down, the replaced version's passages are already gone rather than still
answering. Archiving purges too, for every document and not only a Piloti one:
„archiviert" is a statement that the file has left the working set, and a file
that keeps coming back as a hit has not left it. Both go through
`purgeIngestedChunks`, never `discardSupersededObjects` — the bytes stay, which
is what makes a version list openable. The backend's `unregister_summary` takes
the document-metadata row with the chunks, so a superseded version's provenance
does not outlive the passages it described.

### What this amends in ADR-0047

ADR-0047's 2026-08-20 addendum says `Zuweisen` is the promotion gesture and that
no new one was invented. **That stays true for responsibility.** Assignment
still says who is on the hook, `Unvergeben` is still the honest arrival state of
a generated report, and neither `created_by` nor `authored_by` is ever rendered
as *verantwortlich*.

What this adds is a statement about the **content**: that the office asserts it
(`published`) or does not yet (`draft`, `in_review`). That is a fifth relation,
and it is not a substitute for any of the four. A file can be Anna's and not yet
freigegeben; a file can be published and `Unvergeben`. Collapsing them would
make „verantwortlich" and „freigegeben" the same word, which is the mistake
ADR-0047 exists to prevent one level down.

### Consequences

* Good, because a re-upload stops destroying the file it replaces, and „was
  stand im März drin" becomes a query.
* Good, because "a document Piloti wrote is citable" becomes a row the database
  refuses to store rather than a filter in a fail-open retrieval path.
* Good, because humans and Piloti share one vocabulary, one badge set and one
  version list — a reviewer does not have to know who wrote a file to know what
  state it is in.
* Good, because a new state is one row of the transition table, one CHECK edit
  and one i18n key; a new consumer is one effects-registry entry.
* Bad, because **superseded versions stay charged against the organization's
  storage quota.** They exist, so the ledger counts them, and an office that
  re-uploads a plan set weekly will accumulate. A per-organization retention
  policy is the answer and it is a later row on a later table, not an `if` in
  the upload path. Stated here so it is read rather than discovered.
* Bad, because an upload now emits a second audit event
  (`document.version.published` beside `document.uploaded`). They answer
  different questions — who brought this file into the project, and which bytes
  are live — but the trail is chattier.
* Bad, because one more table sits inside the tenant boundary, and its RLS
  predicate carries a NULL arm for the two shelves with no project.
* Neutral: `documents.lifecycle` (`active | archived`) is item-level, not a
  version state. „Archiviert" is a statement about the file, and a version-level
  answer would leave it ambiguous which version was archived.

### Confirmation

The invariants are CHECKs and a test, not a comment.

Migration `0082_document_versions.sql` carries
`document_versions_state_known`, `document_versions_review_complete` (copied
from `tasks_review_complete`, ADR-0051), `document_versions_published_is_approved`
and `document_versions_refusal_has_comment`, plus two partial unique indexes
with `COMMENT ON INDEX`: one open version per document, one published version
per document. `rls-coverage.spec.ts` lists `0082` in `BOUNDARY_MIGRATIONS`;
`task db:test:rls` is what proves the policy holds.

The publish door is `lifecycle.spec.ts` and
`src/app/api/internal/document-versions/route.spec.ts`: the machine-reachable op
set is derived from the table's `actor` field and asserted to be exactly
`create`, `update`, `submit`; every transition that asserts content is asserted
to be `human`; a machine caller is refused before any permission is read.
`schemas.spec.ts` fails when a transition names an audit action WorkOS does not
know.

The indexing addendum has its own: `dispatch.spec.ts` walks every version state
through the dispatcher's guard, `lifecycle.spec.ts` asserts the dispatch happens
from the effect with the four provenance keys and that the purge precedes it,
`collection-file-ref.spec.ts` asserts both halves of the addressability rule, and
`frontends/aiq_api/tests/test_ingest_provenance.py` is the backend twin for the
wire.

## More Information

- The table as data: `frontends/ui/src/lib/documents/lifecycle-types.ts`.
- The service and the effects registry: `frontends/ui/src/lib/documents/lifecycle.ts`.
- The design of record:
  [`../roadmap/piloti-writes-artifacts-and-approval.md`](../roadmap/piloti-writes-artifacts-and-approval.md).
- What it amends: [ADR-0047](0047-assignment-is-not-access.md).
- The API-first doctrine this ships under: [ADR-0055](0055-api-first-workspace-primitives.md).
- **Revisit when** a tenant asks for retention on superseded versions, or when
  the first non-Markdown deliverable needs a review round — the first is a
  policy table, the second is a renderer, and neither should reopen this record.
