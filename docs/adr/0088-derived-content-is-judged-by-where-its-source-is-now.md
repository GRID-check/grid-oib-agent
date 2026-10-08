---
status: proposed
date: 2026-10-08
decision-makers: Matthias Bigl
consulted:
informed:
---

# Derived content is judged by where its source is now

## Context and Problem Statement

Much of what a reader is served is derived from a document rather than read
from it: a permit record and its requirements (ADR-0086), a memory item a chat
or the closing extraction drew from a folder (ADR-0081, ADR-0087), a summary,
a chunk. Each carries the access of its source (ADR-0080): what a restricted
folder holds is served only to a reader cleared for it.

The easy way to carry that access is to copy it onto the derived row when the
row is written (`restricted_folder_ids`) and filter by the copy. A document's
access changes after that: it is moved, its folder gains or loses an access
list, it goes to the Papierkorb, it is quarantined. Those changes land on the
document first (`folder_id`, `deleted_at`, `status`) and reach its other
columns later or never: `collection_name` follows only when placement runs,
which skips a document whose ingest is in flight and moves a batch per call.
In that window a copy says „open" for content that no longer is. Three leaks
of permitting memory were this one shape.

Where is a derived row's access decided?

## Decision Drivers

* A reader is never served what its source would not serve them now.
* No fix may depend on a background job catching up: re-ingest, placement,
  a purge sweep or a backfill.
* One rule, so every derived store is judged the same way as the documents
  beside it in the same answer.

## Considered Options

* Judge at read time from the source's live location
* Keep the copy, and update every derived table wherever a document's access
  changes
* Keep the copy, and accept the window until placement runs

## Decision Outcome

Chosen option: "Judge at read time from the source's live location", because
it is the only one that holds without anything else running, and the only one
whose correctness a reader of one query can check.

* A reader of derived rows joins the source document and decides from its
  live `folder_id` against the project's folder tree and the reader's
  clearance, as document hits are decided. `lib/permits/live-access.ts` is the
  shape: the folders a reader may be served from, and the live restriction a
  hand-out records.
* A source that is in the Papierkorb, quarantined or archived serves nothing
  derived from it.
* A stored restriction is history: kept on the row, never consulted for
  access.
* A derived row with no live source to join (a memory item whose folder was
  purged) follows its own retention rule (ADR-0081), never the copy alone.

### Consequences

* Good, because a move, a new access list or a bin takes effect for derived
  content in the same transaction it takes effect for the document.
* Good, because the hand-out record names where the content is now, so the
  audience judgement (ADR-0085) reads a true restriction.
* Bad, because every read joins the source and walks the folder tree once per
  project; bounded by the projects one search reads.
* Bad, because project memory still filters by its stored copy: it predates
  this rule and is not yet migrated.

### Confirmation

* `src/lib/permits/repository.integration.spec.ts` (real Postgres): the lag
  window itself (folder restricted, collection unchanged, ingest in flight),
  the bin, a nested restricted folder, served only to a cleared reader, with
  the live restriction handed out.
* `src/lib/permits/live-access.spec.ts`: the folder judgement.
* Nothing enforces this yet for project memory (`memoryVisibleTo` reads
  `project_memory.restricted_folder_ids`). Migrating it is the open follow-up.

## More Information

Reached by three findings of an independent review of permitting memory, each
closing one way through: a filename-only join, a collection snapshot, and the
placement lag. The symptom and the fix are indexed in
[`docs/contributing/gotchas.md`](../contributing/gotchas.md) under
„Data and correctness".
