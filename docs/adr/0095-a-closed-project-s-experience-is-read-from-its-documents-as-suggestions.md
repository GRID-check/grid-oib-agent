---
status: proposed
date: 2026-10-08
decision-makers: Matthias Bigl
consulted:
informed:
---

# A closed project's experience is read from its documents, as suggestions a person confirms

## Context and Problem Statement

Every other project can be searched safely (ADR-0093), but what a closed
project knows about itself is thin. Its fingerprint (Bundesland,
Gebäudeklasse, Bauweise, uses, kind of work) comes only from the intake
wizard, which a project may have skipped and which leaves the Gebäudeklasse
open on purpose; so "similar projects" decays into "recent projects". Its
decisions exist only if somebody wrote them to memory while it ran, so the
agent usually gets 900-character passages and guesses the decision. And
nobody knows under which OIB edition it was planned, so a precedent cannot be
marked as decided under rules that have changed since.

The documents hold all three. Where should they be read from, when, by whom,
and how much should a reading be trusted?

## Decision Drivers

* No hard-coded language: which documents state the facts, and what they
  state, are meanings a model reads; code checks only what it can check.
* Suggested is not confirmed: a person confirms a project's facts (the profile
  is edited in the intake wizard or by an accepted patch, `frontends/ui/AGENTS.md`),
  and a confirmed value must never be overwritten by a reading.
* Derived content carries the access of its source (ADR-0087, ADR-0088): the
  profile is read by every member, so nothing a restricted folder holds may
  reach it.
* The archive import (roadmap step 1, another worker) brings closed projects:
  it must be able to call the same reading, not a copy.
* A closed project is read-only (ADR-0089); closing is one UPDATE.

## Considered Options

* Read on request, from the close dialog and the import, into suggestions
* Read automatically when a project closes
* Read every document at ingest into per-document hints, aggregated at close
* An in-force table of OIB editions per Land and date, instead of reading the
  edition

## Decision Outcome

Chosen option: "Read on request into suggestions", because it is the one
reading both the close dialog and the import can call, costs a model call only
when somebody asks, and keeps every value a suggestion until a person accepts
it.

* `POST /v1/internal/project-experience` (Python) reads the project's main
  collection with the ingest's summary model: a chooser picks documents from
  the inventory, one pen answers the fingerprint keys in the vocabulary the BFF
  sends (read off the intake definition, plus the OIB edition), another drafts
  decisions and constraints. Every value needs a quote that code finds in the
  text the pens read; a token outside the vocabulary is dropped in code.
* `POST /api/projects/{id}/experience` (BFF, the single writer) stores
  fingerprint values as profile assumptions (`agent_suggested`), never over a
  key a person answered, the quote masked (ADR-0086); decisions as memory rows
  (`distillation`, `source_grounded`) with their evidence (migration 0127).
* Only files every member may open are read, and the BFF names them
  (`fileNames`): in the main collection, filed where a reader cleared for no
  restricted folder is served from now (the document's live folder), past the
  upload screen as a model may read it, and active. The collection alone does
  not say it: placement moves a document's chunks some time after its folder
  changes, and a held upload can sit in it. The BFF also drops any evidence
  naming another file before it writes, whatever the backend answered.
* It runs while the project is active. An already-closed project is reopened,
  read and closed; the import imports as active, reads, then closes. No
  closed-project rule changes.
* The similarity ranking reads a confirmed fact first and a suggestion only
  where none exists; the agent sees which is which.
* The edition is read as the edition a project was *planned under*, from its
  own documents, not looked up.

### Consequences

* Good, because the ranking, the agent's precedent lines and a person's
  similar-projects page get facts for projects that never went through the
  wizard, imported ones included.
* Good, because every suggestion cites its document, page and words, so a
  person confirms against the source in the close dialog.
* Good, because one reading serves the close dialog and the import.
* Bad, because a reading can be wrong; an unconfirmed suggestion ranks
  projects until a person corrects it. The agent is told it is unconfirmed.
* Bad, because the reading runs inside one request (90 s under the edge
  proxy's limit): a slow model writes nothing and the person asks again.
* Bad, because nothing reads a project on its own: a project closed without
  opening the debrief keeps what the wizard gave it.

### Confirmation

* `tests/aiq_agent/knowledge/test_project_experience.py`: vocabulary, quotes
  found in the read text, evidence from read files only, bounds, fail-open.
* `src/lib/project-experience/readable-files.integration.spec.ts` (live
  Postgres): a held upload, a document in a restricted folder whose chunks have
  not moved, one in the Papierkorb and an archived one are not offered.
* `src/lib/project-experience/service.spec.ts`: only the named files are
  sent, evidence from any other is never written, suggestions never over an
  answered key, masked quotes, source-grounded decisions, access refused on a
  closed project.
* `tests/aiq_agent/common/test_openrouter_call_sites.py` fails a model call
  that bypasses the seam.
* The migration journal test and `rls-coverage.spec.ts` (0127 adds a column to
  an already-secured table).

## More Information

Not chosen: an in-force table of editions. The agent's data has none; the only
one in the repo is marketing copy (`frontends/web/src/data/landing/baurecht.ts`)
and the norm registry marks the Wien case open. Revisit when such a table is
maintained as data with a source, or when the import asks for an unattended
reading. Design and wire contract:
[`docs/design/closed-project-experience.md`](../design/closed-project-experience.md).
