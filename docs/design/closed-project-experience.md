# What a closed project knows: fingerprint, decisions, edition

Status: building (ticket 3, slice F). Roadmap: `docs/roadmap/office-experience.md`.

Every other project can be searched safely (ADR-0094), but what a closed project
*knows about itself* is thin: its fingerprint comes only from the intake wizard,
its decisions only from what somebody wrote to memory while it ran, and nobody
knows under which OIB edition it was planned. This slice reads that from the
project's own documents, once, as suggestions a person confirms.

## The shape

```
close dialog ──POST /api/projects/{id}/experience──▶ BFF (lib/project-experience)
                                                      │  vocabulary from the intake definition
                                                      ▼
                         POST {backend}/v1/internal/project-experience   (aiq_api)
                                                      │  the ingest's summary model, the project's collection
                         choose documents ─▶ fingerprint pen ─▶ decision pen
                                                      │
BFF writes ◀──────── fingerprint + decisions, each with evidence (file, page, quote)
  profile assumptions (agent_suggested)  ·  project_memory rows (distillation, source_grounded)
```

* **One extractor, two callers.** The close dialog calls it now; the archive
  import calls the same backend route per imported project. Nothing runs on
  its own when a project closes (closing is one UPDATE and stays one).
* **Runs while the project is active.** A closed project refuses memory inserts
  (migration 0116 trigger) and profile writes. An already-closed project is
  reopened, read, and closed again; the import imports as active, reads, then
  closes. No closed-project rule changes.
* **Only files every member may open.** What the reading finds becomes a
  profile every member reads and memory rows with no folder restriction, so
  the BFF names the files it may read (`fileNames`,
  `lib/project-experience/readable-files.ts`): in the project's main
  collection, filed where a reader cleared for no restricted folder is served
  from now (`liveFolderAccess`, the document's live folder), past the upload
  screen as a model may read it (`SCREENED_ONLY`), active. A restricted folder
  is its own collection (`…_r<hex>`), but the collection alone is not enough:
  placement moves a document's chunks some time after its folder changes, and
  a held upload can sit in it. The backend shows the chooser no other file,
  and the BFF drops evidence naming one before it writes.
* **The model decides meaning; code checks facts.** Which documents to read is
  a model's choice from the inventory, never a list of file-name words. Every
  value must be a token of the vocabulary the BFF sent and carry evidence; a
  value without a quote, or outside the vocabulary, is dropped in code.
* **Suggested, then confirmed.** Fingerprint values land as profile
  `assumptions` (`source: agent_suggested`, `status: unconfirmed`, the evidence
  as `reason`). Accepting one writes the fact through the ordinary patch route,
  which retires the assumption (`pruneResolvedAssumptions`). Decisions land as
  memory rows with `provenanceType: distillation` and
  `verification: source_grounded` and their evidence; the debrief confirms
  (`user_confirmed`) or dismisses (`status: dismissed`) each.
* **Masked like a note.** The quote stored as an assumption's `reason` goes
  through the office's „Sensible Daten" policy (ADR-0086) first, as a memory
  note does: the profile rides every turn, and a Bescheid names its addressee.
* **Inside one request.** The BFF gives the backend 90 s, under the ~100 s the
  edge proxy allows a request. A slower extraction writes nothing and the
  person asks again; the backend's work is lost, never half-written.
* **Confirmed beats suggested, suggested beats nothing.** The similarity
  ranking reads a confirmed fact first and a suggested one only where no fact
  exists; the agent is told which is which.

## Wire contract: `POST {backend}/v1/internal/project-experience`

Internal token (`x-grid-internal-token`), like `/v1/note-embeddings`. Never
answers non-200 for an extraction failure: `error` says why and the lists are
empty.

Request:

```json
{
  "organizationId": "org_…",
  "projectId": "uuid",
  "collection": "the project's main collection",
  "fileNames": ["Baubeschreibung.pdf", "Bescheid.pdf"],
  "vocabulary": {
    "bundesland":     { "multiple": false, "options": [{ "token": "niederoesterreich", "label": "Niederösterreich" }] },
    "gebaeudeklasse": { "multiple": false, "options": [{ "token": "4", "label": "GK 4" }] },
    "bauweise":       { "multiple": true,  "options": [{ "token": "holzbau", "label": "Holzbau" }] },
    "nutzungen":      { "multiple": true,  "options": [] },
    "vorhabensart":   { "multiple": true,  "options": [] },
    "oib_ausgabe":    { "multiple": false, "options": [{ "token": "2019", "label": "OIB-Richtlinien 2019" }] }
  },
  "knownFacts": ["bundesland"],
  "knownDecisions": ["Brandsperre je Geschoß aus 1 mm Stahlblech …"]
}
```

`fileNames` (required, at least one) are the only files of `collection` the
backend may read; a file the inventory lists and the request does not name is
never offered to the chooser. With none, the BFF answers `no_documents` without
asking the backend. `knownFacts` are keys a person already confirmed: the pen is not asked for
them. `knownDecisions` (at most 60, each at most 300 characters) are the
project's active decisions and constraints, so the pen drafts only new ones.

Response:

```json
{
  "model": "provider/model",
  "documentsRead": ["Baubeschreibung.pdf"],
  "fingerprint": [
    { "key": "gebaeudeklasse", "value": "4",
      "evidence": [{ "fileName": "Baubeschreibung.pdf", "page": "2", "quote": "Gebäudeklasse 4" }] }
  ],
  "decisions": [
    { "kind": "decision",
      "content": "Fluchttreppe außen in Stahl statt eines zweiten Stiegenhauses, weil …",
      "outcome": "accepted",
      "evidence": [{ "fileName": "Bescheid.pdf", "page": "3", "quote": "…" }] }
  ],
  "error": null
}
```

* `value` is a token string, or a list of tokens when the key is `multiple`.
* `kind`: `decision` (a choice the project made) or `constraint` (a condition
  it had to meet, an Auflage among them). `outcome`: `accepted`, `auflage`
  (accepted with a condition), `rejected`, `unknown`.
* At most 12 decisions; `content` at most 600 characters, German, naming what
  was asked, what was done and why.
* `quote` at most 300 characters, verbatim from the document.
* `error`: `null`, or one of `no_documents`, `no_model`, `extraction_failed`.

## What the agent and people see

* `project_lookup` find and brief print a project's Bundesland and the OIB
  edition it was planned under, marked „aus den Unterlagen, unbestätigt" when
  only suggested. A decision line says „aus den Unterlagen erschlossen: Datei
  S. n" for a source-grounded row.
* **Evidence names follow the reader, now.** A decision stores the file names
  it was read from, as they were then. A name is shown, to the agent as to a
  person, only while a document of that name in the project is open to that
  reader: filed where their clearance is served from (the live folder; the
  Papierkorb never is), visible to their document reader (`SCREENED_ONLY` for
  the agent), active (`withServedEvidence`, `lib/projects/memory-evidence.ts`,
  called by `getProjectMemory` and `searchProjectDecisions`). A file moved into
  a restricted folder after the extraction drops out of the line for anyone
  not cleared for it; the decision stays, since it was read while the file was
  open to every member. A document's name is restricted information as the
  audit trail and the download log treat it (ADR-0087).
* A hit from another project stays kind `projekt`; what marks it is the
  project it carries (`SourceProject`, on the wire `{id, name, status,
  landNote}`). The answer's source chips label it „Präzedenzfall" with the
  project's status and Bundesland (`features/chat/lib/precedent.ts`), and the
  prompt asks an answer that uses one to keep Norm, Büro and Präzedenz apart.
* `/app/projects/{id}/referenzen` shows a person the closed projects most like
  this one that they may open, with what they share, their Auflagen and their
  decisions, under the same access rules as the agent.

## Not here

* An in-force table of OIB editions per Land and date. The agent's data has
  none; the only one in the repo is marketing copy, and the norm registry marks
  the Wien case open. The edition a project was *planned under* is read from
  its documents instead, which is evidence rather than a lookup.
* A closed-project exception to the insert trigger.
