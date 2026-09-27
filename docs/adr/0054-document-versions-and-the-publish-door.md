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

### Corrections after review

The build was reviewed against the code, in several rounds, and each item below
is something in this record that was wrong or not true of what shipped. The
first review found nine; the later rounds added the rest. They are listed here
rather than silently edited above, because a record that quietly agrees with
itself teaches nobody what it cost to find them.

1. **A re-upload could not work at all.** "A re-upload writes version N+1 and
   leaves N standing" was the whole point of the table, and the code inserted
   the new row as `published` and superseded the old one afterwards.
   `uniq_document_versions_published_per_document` is a plain partial unique
   index — checked per statement, never deferred — so the INSERT was refused
   while version N was still published. The supersede, the insert and the
   pointer move are now one transaction (`insertPublishedVersion`), supersede
   first, and the invariant is exercised against a repository that enforces it
   rather than a double that says yes.

2. **The submit guard ran after the swap.** „Nobody to review this" was raised
   inside the `openReviewInbox` effect, which runs once the state has already
   moved: the version was left durably `in_review` with nobody told about it,
   and every exit from that state is a decision one of those untold people
   would have to make. Reviewers are resolved before the compare-and-swap now.
   The resolution itself was also wrong in the direction that mattered most —
   it fell back to the document's ASSIGNEES, and a document Piloti files is
   `Unvergeben` by construction, so `submit` was refused on every path the
   design built it for. The chain is in `lib/documents/reviewers.ts` and its
   last link is the submitter, as a waiver recorded on the audit event.

3. **The quota claim was not true.** The "Bad, because superseded versions stay
   charged" consequence below was a statement about a ledger that summed
   `documents.file_size` — the LIVE bytes — and therefore counted no superseded
   version and no draft at all. It is true now (`versionOverheadBytes`), on the
   reported usage and in both admitting transactions.

4. **Archiving did not leave the listings.** „Archiviert" purged the chunks and
   wrote `documents.lifecycle`, and no listing read that column, so the file
   stayed exactly where it was in the Files pane. The default listings carry
   `lifecycle = 'active'` now, with an explicit filter as the way back (worded
   „Stillgelegte auch zeigen" since item 9 below).

5. **The three review decisions were reachable with the wrong permission.**
   `approve`, `request_changes` and `reject` listed `project:documents:write`
   beside `project:edit`, and the list is an ANY-OF — so any role that may
   upload a file could release a Brandschutzkonzept. „Darf Dateien ablegen" is
   not „darf freigeben"; those rows name `project:edit` alone.

6. **The commissioner could not approve their own commissioned report.** The
   not-the-submitter guard read `submitted_by`, which on an agent filing is the
   person whose session the run acted in and not the author. Migration `0085`
   adds `submitted_by_actor`, and the guard applies only to a `human`
   submission — plus a waiver, recorded, for a project with one editor.

7. **The internal read route was scoped only by an organization the caller
   states.** A version id is a uuid the caller supplies, so the internal token
   alone reached any version in any tenant. It now also requires the
   conversation the turn is running in, and refuses unless that conversation's
   subject IS the version's document.

8. **An update stripped the AI-provenance marking.** The Python tool sends the
   model's raw Markdown, and the replace path wrote it verbatim over bytes whose
   branding and marking the FILING seam had added — so version 2 of an
   agent-authored document said nothing about its own authorship, which is the
   one failure `markingIsInBytes` exists to make impossible. The update renders
   through the producer's renderer and re-checks the bytes.

9. **„Archivieren" named the opposite of what it did, and the whole section
   shouted.** Two faults, reported together by a reader in one sentence: no idea
   what archiving a document does, and the versioning UI does not make sense.

   The word first. This product has an Archiv — the office archive of ADR-0024,
   whose own empty state says „Hier abgelegte Dokumente werden zu Bürowissen und
   stehen jedem Projekt Ihrer Organisation zur Verfügung." A document is put
   INTO it to become cross-project knowledge. The item-level act described in
   this record does the inverse: the file leaves the working set and
   `purgeIngestedChunks` removes it from the retrieval corpus, so Piloti stops
   citing it. One verb was doing a thing and its opposite. The reader-facing
   copy is now „Stilllegen" / „Stillgelegt" (EN: retire / retired), and the act
   carries no archive-box glyph either, because that icon is the Büroarchiv's
   own provenance signal. The wire is unchanged — `POST …/archive`, the client
   method, and `documents.lifecycle = 'archived'` — because the collision was in
   the language, not in the data, and renaming an enum value nobody reads would
   be churn with a migration attached.

   The shape second. The section stood open at the TOP of the file rail on every
   document, above the summary and the facts, carrying a strip of review verbs
   and the full version history. On a person's upload — born `published`, with
   no decision left to take — the only control that strip could draw was that
   one unexplained verb, which is how an ordinary file came to offer a one-way
   door under a heading about approvals. It is now last in the rail and shut,
   stating only where the document stands: the word, a four-segment track that
   gives the word its order (Entwurf → In Prüfung → Freigegeben →
   Veröffentlicht, ink for walked and a dashed outline where a refusal stopped
   the walk), and the one sentence saying what it is waiting for. It opens
   itself when a gesture other than the item-level one is available to this
   reader — „need to know" cannot mean „notice it yourself" — and „Stilllegen"
   sits at the bottom of the opened body, set apart, behind a confirm that
   states all four of its consequences including the two nobody guesses: that
   Piloti stops citing the file, and that nothing in the product brings it back.

10. **Two overlapping re-uploads were the same version.** The version number
    was `max + 1` read outside any transaction, and the upload paths read it
    before the bytes moved to build the `v<n>/` key, so two re-uploads of one
    filename both got N, both PUT the same object key (the second replacing the
    first's bytes) and both recorded „Version N". Nothing refused either:
    `(document_id, version_number)` had an index and no uniqueness. Migration
    `0092` makes it `UNIQUE`; both inserts allocate the number inside their own
    transaction under a per-document advisory lock; every write gets its own
    object key (`v<n>/<write id>/`); and an upload records its version with the
    columns its own request stored rather than re-reading the item row.

11. **The loser of a concurrent publish got a 500.** `promoteVersionToPublished`
    called `tx.rollback()` and then `return null`, and drizzle's `rollback()`
    throws, so the null — the 409 — was unreachable. A sentinel is thrown and
    caught outside the transaction; a lint rule refuses the call.

12. **`If-Match` did not stop a lost update.** The digest was compared with a
    row read at the start, and the compare-and-swap filtered on `state` alone —
    and `update` goes draft → draft, so two writers holding the same digest
    both won and both wrote the version's one key. The swap now also asserts
    the storage key and `content_hash` it read, and each write stores its
    bytes under a fresh key BEFORE the swap, so a row only ever names an object
    that is already stored in full and the loser's object is deleted. "Steps 3
    and 4 in that order" in the old `replaceVersionContent` header had traded
    this for a different failure; writing to a unique key removes the trade.

13. **The quota still undercharged, in both admissions.** Correction 3 made the
    ledger count superseded versions, and the two admitting paths kept an
    argument from before this record: that a replacement frees what it
    replaces. A re-upload excluded the replaced row from the usage, although
    the row's bytes now stay as the superseded version; a draft rewrite
    charged `incoming − fileSize` outside any lock, and a fresh fork's
    `fileSize` is the published file's, so fork, write, reject, fork again was
    never checked. A re-upload now charges its full size, and a content write
    is admitted inside its swap transaction under the per-organization quota
    lock, by measuring the usage it is about to commit.

14. **Two races on the two partial unique indexes still answered 500.** Both
    indexes were described as closing a race the probe cannot, and both did —
    by refusing the second insert with a raw 23505 that no layer mapped.

    *Two first uploads of one filename.* Both probes miss, both PUT under a
    fresh id, and `uniq_documents_live_name_per_collection` refuses the second
    insert after its bytes have landed. The loser now becomes a NEW VERSION of
    the winner's document, because that is what the same two drops one after
    the other produce under this record, and an outcome that depended on
    milliseconds would be two products. It is safe because nothing of the
    first attempt survives it: the refused insert rolled back (no row, no
    quota charge) and `admitOrDiscard` deletes the object on any admission
    failure. `insertDocumentWithinQuota` maps the refusal — by constraint name,
    in `lib/documents/unique-conflicts.ts` — to `LiveFilenameTakenError`, and
    the project and Archiv uploads run their probe-store-admit step once more
    (`retryRacedUpload`, named `retryLostFirstUpload` until correction 16), which finds the winner and takes the re-upload
    path, charged in full for the object it keeps. The session shelf does not
    retry; there the mapped error is a `409`, object discarded.

    That retry exposed a second hole. A re-upload's key used the version-1
    shortcut whenever `nextVersionNumber` read 1, and it reads 1 for a row
    with no version yet — the winner, between its insert and its version — so
    the retry would have PUT over the winner's own object. A re-upload now
    always takes the `v<n>/<write id>/` segment.

    *Two forks of one document.* Both see no open version, and
    `uniq_document_versions_open_per_document` refuses the second insert. The
    route's contract already said what the loser is owed: „a second attempt is
    a 409 naming the draft that exists". `insertDocumentVersion` maps the
    refusal to `OpenVersionExistsError`, and `forkDraftVersion` re-reads the
    winner and throws the SAME 409, `{ versionId, state }`, its probe throws.
    The typed client and the Python filing tool are unchanged: the client
    already parses that 409 into `DocumentLifecycleError`, and the agent's
    internal route has no fork op. `openDraftForRevision` — whose question is
    "which version do the revised bytes go into", not "may I open one" — joins
    the winner's draft instead of failing the revision task.

    Only these two constraints are mapped. A 23505 on the version-number key
    means a path skipped the per-document lock, and one on the published index
    means a published row was inserted outside `insertPublishedVersion`; both
    are bugs and stay 500s.

15. **No race backstop that read `error.code === '23505'` ever ran.** Finding
    the two above turned up why the pattern was trusted: drizzle 0.45 wraps
    every failed query in `DrizzleQueryError`, whose own `code` is undefined —
    the driver's error, with `code` and `constraint_name`, is its `cause`. So
    the recovery in `fileGeneratedDocument` (two tabs filing one report), in
    the folder service (a duplicate folder name, the `Berichte` get-or-create),
    in project memory and in platform lessons matched nothing in production,
    and each loser got a 500. In the folder service it was not only a race:
    creating a folder under a name a sibling already has runs no probe, so it
    answered 500 every time. Their unit specs threw a flat `{ code: '23505' }`
    and passed. `isUniqueViolation(error, constraint?)` in `lib/db/errors.ts`
    walks the cause chain, every site uses it, the filing path names its index,
    and `no-restricted-syntax` refuses the literal `'23505'` outside specs.

16. **A re-upload of a document deleted underneath it orphaned its object.**
    `replaceDocumentWithinQuota` filtered its UPDATE on the id the upload had
    probed and never looked at how many rows it changed. A delete committing
    between the probe and the update left it changing none and answering
    „admitted": the new object was named by no row, invisible to the UI and to
    the quota ledger, and the upload went on to record a version for a
    document that no longer existed. Both an ordinary re-upload and the retry
    of correction 14 reach that update. It now reads what it matched
    (`RETURNING id`) and throws `ReplacedDocumentGoneError` on none, which
    rolls the admission back and lets `admitReplacementOrDiscard` delete the
    object.

    The project and Archiv uploads answer it the way correction 14 answers a
    lost first upload: `retryRacedUpload` runs the attempt once more, the
    probe now misses, and the bytes are filed as a FIRST upload under a new
    id. Not a 409, for the same reason the other way round: a delete followed
    by a drop of the same name is a first upload, the overlap of the two is
    that sequence, and there is no history left to attach to — the delete took
    every version with it. The session shelf does not retry; the error is a
    `ConflictError`, so it answers 409 with the object discarded.

17. **A delete after the upload's own write still let the upload finish.** The
    last window: the row is written and points at the upload's bytes, and a
    delete commits before `recordUploadedVersion` runs. The lookup missed and
    the function returned `null`, which no caller read, so the upload
    dispatched the deleted document for ingest, wrote „document.uploaded" to
    the trail and answered 200. The project and Archiv uploads now record
    through `recordUploadedVersionOrDiscard`, which turns that `null` into
    `DocumentDeletedError` (a 409, `reason: 'deleted_during_upload'`) after
    discarding the object it was handed, and the upload stops: no version, no
    ingest, no audit line. The
    same error covers a delete landing between that lookup and the insert,
    where the version's foreign key refuses the insert.

    Not retried as a first upload, unlike correction 16, and for the same
    reason read in the other direction: order by commit. In 16 the delete
    committed before the upload wrote anything, so the sequence is „delete,
    then upload" and the upload is a first one. Here the upload's write
    committed first, so the sequence is „upload, then delete" — the file being
    gone is the delete's outcome, and re-filing it would undo a decision
    somebody else made a moment later. The 409 tells the uploader exactly
    that.

    Closing it found the foreign key missing on two shelves. The only key from
    a version to its document was 0082's composite `(document_id,
    project_id)`, which is MATCH SIMPLE: with `project_id` NULL — every Archiv
    and chat-attachment version — it checks nothing and cascades nothing. So
    deleting an Archiv document left its version rows behind (correction 16's
    „the delete took every version with it" was true of the objects, not the
    rows), and an Archiv upload racing a delete recorded a published version,
    naming its own object, for a document that was already gone. Migration
    `0094` adds `document_versions_document_id_fkey`, `document_id →
    documents (id) ON DELETE CASCADE`, after deleting the orphan rows that
    already exist; the insert maps a 23503 on either key to the same
    `DocumentDeletedError`. The session shelf records through the same
    `recordUploadedVersionOrDiscard` as the project and Archiv shelves, so a
    chat attachment (or its chat) deleted before its version is recorded is
    discarded and answered 409 too, with its ingest dispatch moved after the
    version for the same reason.

    One window stays open and is stated rather than hidden: a delete landing
    after the version is recorded and before the ingest dispatch. The delete
    then sees every row and object, so nothing is orphaned in Postgres or the
    bucket, but a dispatch already in flight can index a document that no
    longer exists. Closing it needs the dispatch to be conditional on the row,
    which is the ingest pipeline's contract, not this upload's. Correction 18
    closes it there.

18. **An ingest indexed a document deleted while it ran.** Two windows, one
    cause: the ingest never learned about the delete. The window correction 17
    left open is one. The other is a delete on one replica during a same-name
    re-ingest on another: `delete_file` does not take the per-name
    `keyed_lock` the ingestor holds, so it removed the chunks that were there
    and the ingest inserted the rest after it. Both left chunks retrievable
    with no row behind them.

    One mechanism closes both, in the pipeline. Once a file is indexed and
    before its predecessor is retired, the ingestor asks the BFF whether the
    document it was dispatched for still exists (`GET
    /api/internal/document-exists`, service token, by the `document_id` and
    collection `/v1/ingest` already carried). Python never reads the BFF's
    Postgres, so this is an internal route rather than a query. On `exists:
    false` the attempt discards exactly the chunks it inserted
    (`_discard_partial_version`), retires nothing and writes no metadata row.
    Retiring would be wrong: after a delete and a new upload of the same name
    (correction 16's first upload under a new id), the predecessor this
    attempt found under the lock is the NEW document's version.

    Fail-open, and only on a definite answer. The route answers 200 with a
    boolean, and 404 is not "gone": it is also what a BFF without the route
    answers. A timeout, a non-200 or an unreadable body keeps the chunks,
    because an unreachable BFF deleting a live document's chunks is worse than
    the window it failed to close.

    Taking the lock in `delete_file` was the other option and was rejected:
    the ingestor holds it for a whole file, embedding included, so a delete
    would wait minutes and outlast the BFF's request timeout.

    Stated rather than hidden: the BFF's `deleteDocument` purges chunks first
    and deletes the row last, so an ingest whose check lands between those two
    steps still sees the row. That window is the object erase, not the ingest,
    and the orphaned-vector sweep removes what it leaves. Purging the chunks
    once more after the row is gone would close it.

    Pinned against a real Chroma collection in
    `tests/knowledge_layer_tests/test_reingest_replaces_versions.py` (a delete
    between two inserts leaves no chunk and no row; a stale attempt does not
    retire a new document's version; an unreachable BFF keeps the new
    version), the client's answers in `test_document_presence.py`, and the
    route in `src/app/api/internal/document-exists/route.spec.ts`.

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
  storage quota.** They exist, so the ledger counts them (`versionOverheadBytes`
  — see correction 3 above, which is what made this sentence true), and an office
  that re-uploads a plan set weekly will accumulate. A per-organization retention
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
- The service and the effects registry: `frontends/ui/src/lib/documents/lifecycle.ts`;
  the bytes, the renderer and the archive next door in
  `frontends/ui/src/lib/documents/version-content.ts`; who may review, in
  `frontends/ui/src/lib/documents/reviewers.ts`.
- The design of record:
  [`../roadmap/piloti-writes-artifacts-and-approval.md`](../roadmap/piloti-writes-artifacts-and-approval.md).
- What it amends: [ADR-0047](0059-assignment-is-not-access.md).
- The API-first doctrine this ships under: [ADR-0055](0055-api-first-workspace-primitives.md).
- **Revisit when** a tenant asks for retention on superseded versions, or when
  the first non-Markdown deliverable needs a review round — the first is a
  policy table, the second is a renderer, and neither should reopen this record.
