---
status: accepted
date: 2026-10-22
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# A held file's reason is a typed verdict, stored as data

## Context and Problem Statement

The upload content check (ADR-0086) holds a file back before any model reads
it, and has to say why: which office term or which detector, how often, on
which pages, with a masked sample. Until now it said so only inside a string.
The ingest job wrote `error_message = "quarantined:" + json`, the BFF's
reconcile stored that string on `documents.error_message`, and every surface
that showed a reason parsed it back: the review queue, the release audit, the
upload summary, the Files preview, the upload tray, the chat's file list. Two
client adapters even turned a parsed verdict back into the string, prefix
included, only to hand it to the parser again. A reason kind could be added in
Python and break nothing visible until a reader's regex-shaped expectations
drifted; the number of reasons the job left out (`omitted`) reached no audit
record at all; and the chat's file card could show the raw JSON behind a
„Details" disclosure.

The verdict is data the screen produced. The question is where it lives on its
way from the job to the person reading it.

## Decision Drivers

* One shape, written once by the producer and read by one schema in the BFF,
  held together by a fixture both suites read (testing-and-verification.md,
  cross-service contract fixtures).
* No reader parses an error string to learn a fact that has a field.
* Rolling deploys: the API tier, the ingest workers and the BFF do not move in
  one step, and rows written before the change stay in the database.
* The audit trail must not read a short list of reasons as the whole one.
* The reason stays visible only to whoever may see the held file (ADR-0086).

## Considered Options

* Keep the string, and put one shared parser in front of every reader.
* A typed verdict on the job status and the collection file list, stored in its
  own `documents.quarantine` jsonb column, with the string kept for one release.
* A normalised table of reasons, one row per reason.

## Decision Outcome

Chosen option: "a typed verdict, stored in its own jsonb column", because it
removes the parse from every reader without a second store to keep in step,
and the verdict is small, bounded and always read whole.

* **Python.** `QuarantineVerdict` and `QuarantineReason`
  (`src/aiq_agent/knowledge/schema.py`) are the model; `ScreeningVerdict.to_model`
  (`sources/knowledge_layer/src/llamaindex/screening.py`) is its only builder and
  keeps the bounds: ten reasons, fifty pages a reason, 2,000 characters of JSON,
  pages cut before reasons, `omitted` for what was left out. `FileProgress` and
  `FileInfo` carry it as `quarantine`, set beside `screening` before the failed
  status is persisted. The model serialises one shape everywhere: `term` and
  `sample` only when set, `pages_truncated` and `after_transcription` only when
  true, `omitted` only when not zero, `checked` always.
* **The legacy string stays for one release.** `error_message` still carries
  `quarantined:` and the same JSON, derived from the model, so a BFF that
  predates the field keeps reading it. Nothing new reads it except the one
  fallback below.
* **BFF boundary.** `verdictSchema` (`lib/upload-screening/quarantine.ts`)
  parses the job's and the file list's `quarantine`. The reconcile stores it in
  `documents.quarantine` (migration 0148) with the `quarantined` status, every
  kind kept as the job wrote it; the release clears it.
* **One reader.** Every surface takes the verdict through
  `quarantineVerdictOf({ quarantine, errorMessage })`, which reads the message
  only when the typed verdict is absent: a job from before the field, or a row
  the migration's backfill could not convert. The parser and the prefix are not
  exported, so no other module can read the string. `QuarantineFindings` takes
  a verdict, never a message.
* **Audit.** A decision row records `reasons_omitted`, and the
  `document.quarantined` event carries it as `reasonsOmitted`. The audited
  reason list ends in `,…` when it was cut at 200 characters.

### Consequences

* Good, because a reader gets typed data or `null`, and a reason kind this build
  does not know reads as `other` instead of blanking the verdict.
* Good, because the database holds the shape (an object with a `reasons` array,
  and only on a quarantined row), so a writer that forgets the release's clear
  fails instead of leaving a stale verdict.
* Good, because the trail can tell a partial list of reasons from a whole one.
* Bad, because for one release the same verdict is written twice, in the field
  and in the string, and the string still decides the failure category in
  `ingest_failures.py` (`quarantined:` prefix) until it goes.
* Bad, because a row whose legacy message did not parse at migration time keeps
  needing the fallback until the row leaves quarantine or is deleted.
* Neutral, because `documents.error_message` of a held row is still written and
  still served for the BFFs of the release before; readers ignore it.

### Confirmation

* `tests/fixtures/quarantine_verdict_cases.json`, read by
  `tests/knowledge_layer_tests/test_quarantine_verdict_contract.py` (the model
  round-trips each verdict, the screen produces it, the legacy string is the
  same JSON, the job status and file list carry it) and by
  `quarantine-verdict-contract.spec.ts` (`verdictSchema` reads it, from the
  field and from the legacy string alike).
* `documents_quarantine_shape_check` and `documents_quarantine_held_check`
  (migration 0148), proved with the backfill and the down migration by
  `scripts/rls-test-db.sh` (`task db:test:rls`).
* `parseQuarantine` and `QUARANTINED_PREFIX` are module-private: a new reader of
  the string does not compile.
* `document_quarantine_decisions_reasons_omitted_check`, and `reasonsOmitted` in
  the `document.quarantined` schema (`lib/audit/schemas.mjs`).

## Pros and Cons of the Options

### Keep the string, one shared parser

* Good, because nothing changes on the wire or in the database.
* Bad, because every new reader still parses, the string is bounded by an error
  column's purpose rather than its own, and `omitted` still reaches no audit.

### A normalised table of reasons

* Good, because reasons could be queried across documents.
* Bad, because nothing asks that question, a verdict is always read whole, and a
  second table must be written, cleared and secured with the status it explains.

## More Information

* Remove the legacy string, the `quarantined:` prefix in `PREFIX_CATEGORIES` and
  the fallback in `quarantineVerdictOf` once one release has run with the field
  and no held row's `quarantine` is NULL
  (`SELECT count(*) FROM documents WHERE status = 'quarantined' AND quarantine IS NULL`).
* ADR-0086 carries a dated pointer to this record.
