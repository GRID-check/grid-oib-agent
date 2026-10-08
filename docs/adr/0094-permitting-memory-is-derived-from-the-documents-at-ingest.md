---
status: proposed
date: 2026-10-08
decision-makers: Matthias Bigl
consulted:
informed:
---

# Permitting memory is derived from the documents at ingest, read by meaning

## Context and Problem Statement

A planning office's most expensive repetition is the authority's: the same
Nachforderung on the next Einreichung, the same Auflage forgotten until the
Bauverhandlung. The office's own past Bescheide and Nachforderungen hold the
answer to „Fragt die Behörde das wieder nach?", but only as PDF pages: the
cross-project search (ADR-0093) can return a passage of one, never what the
authority demanded, of whom, when, across projects. The roadmap
(`docs/roadmap/office-experience.md`, step 2) names this the clearest saving
the office-experience work can show.

Where should the structure come from, where does it live, who may read it, and
how is it found?

## Decision Drivers

* No hard-coded language: what a document is and what it demands are meanings,
  read by models, not matched by word lists (the precedent eval showed phrase
  lists reading answers wrong both ways, 7 Oct 2026).
* The BFF is the single writer of `grid_app` (ADR-0003); the Python tier asks.
* Derived content carries the access of its source (ADR-0087, ADR-0088): a
  requirement read off a restricted folder's Bescheid is restricted the same way.
* The archive import (roadmap step 1) brings closed projects: their documents
  must be extractable although a closed project is read-only (ADR-0089).

## Considered Options

* Extract at ingest into tables, read by meaning in the cross-project search
* Extract at question time (the agent reads Bescheide when asked)
* Project memory items (`kind: constraint`) written by the extractor
* Do nothing: the passage search already finds Bescheid pages

## Decision Outcome

Chosen option: "Extract at ingest into tables, read by meaning", because it is
the only one that answers across procedures without reading every Bescheid
again on every question, and the only one with a shape a later step can count
and link (dates, authority, kind of item).

* The sieve is the existing document-type decision (`Bescheid`), the pen one
  strict-schema call of the platform summary model per such document
  (`knowledge/permit_extraction.py`), pinned through the OpenRouter seam.
* Rows live in `permit_records` and `permit_requirements` (migration 0126),
  written only through `POST /api/internal/permit-records`, replaced per
  document on re-extraction, deleted with the document.
* Each row carries the document's restricting folders; the read filters by the
  reader's clearance as project memory is filtered, and serves a row only while
  its document is still in the collection it was read from, live, and not in
  the Papierkorb: the stored restriction is a snapshot, so access is decided by
  the document's state at read time, never by re-ingest.
* The cross-project search returns `permits` beside decisions and passages,
  ranked as memory recall ranks (embeddings fused with a token channel), and
  records them at hand-out (ADR-0093).
* No closed-project trigger on these tables: they are derived index data, like
  chunks and embeddings, and nobody edits them.

### Consequences

* Good, because one question finds every past demand of an authority by
  meaning, in any language, without re-reading documents.
* Good, because the facts keep their source: every requirement cites its
  document and page, so the reader opens the Bescheid behind it.
* Good, because the archive import gets permitting memory for free: whatever
  it ingests is extracted.
* Bad, because an extraction can be wrong and nothing a person confirms sits
  between it and the answer; the agent cites the document so the reader can
  check, and the debrief or a review surface may later confirm records.
* Bad, because every Bescheid costs one more model call at ingest, and existing
  documents need the backfill script once per collection.
* Bad, because `authority` and `municipality` are what the document says, not
  resolved against an official register; two spellings of one Gemeinde are
  matched only as closely as embeddings and tokens match them.

### Confirmation

* `rls-coverage.spec.ts` (both tables secured on `organization_id`), the
  migration journal test, and the real-Postgres suite
  (`src/lib/permits/repository.integration.spec.ts` in `scripts/rls-test-db.sh`):
  replace semantics, cascade on document delete, folder clearance,
  organization isolation, ranking by meaning with the embedder fingerprint gate.
* `tests/aiq_agent/common/test_openrouter_call_sites.py` fails a model call
  that bypasses the seam.
* The precedent eval (`suite.py --set precedent`) asks permit questions in its
  fixture office, with held-out questions.

## More Information

Revisit when an official Gemeinde register is bought (resolve `municipality`
to a GKZ), when outcomes are linked across a procedure's documents, or when a
person-confirmed review of records is added. Design and wire contract:
[`docs/design/permitting-memory.md`](../design/permitting-memory.md).
