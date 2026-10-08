# Permitting memory

Roadmap step 2 in [`docs/roadmap/office-experience.md`](../roadmap/office-experience.md):
„Fragt die Behörde das wieder nach?" answered from what the office's own past
procedures went through. Decision record: [ADR-0086](../adr/0086-permitting-memory-is-derived-from-the-documents-at-ingest.md).

## What it is

Every project document the ingest pipeline types as `Bescheid` (the existing
document-type decision, `knowledge/document_classification.py`) is read once
more by an LLM with a strict schema, and what it says is stored as rows:

- one **permit record** per document: what kind of notice it is, which
  authority issued it, for which Gemeinde, when, under which reference;
- its **requirements**, one row each: an Auflage of a granted permit, an item
  a Nachforderung or Mängelbehebungsauftrag demands, with the evidence it
  asks for (a Gutachten, a Nachweis, a plan) and the legal basis it cites.

The agent reads them beside other projects' passages and decisions in the
cross-project search, ranked by meaning. Nothing here is a word list: the
sieve is the type decision, the pen is a model with a schema, the ranking is
embeddings fused with a token channel, as project memory recall ranks.

## Flow

```
ingest (per document, adapter.py loop)
  tags contain "Bescheid"? ── no ──> nothing
        │ yes
        ▼
  extract_permit_record(text)        knowledge/permit_extraction.py
  (summary LLM, strict json schema, PLATFORM_FIXED)
        │ PermitRecord | None
        ▼
  POST /api/internal/permit-records  (internal token, organizationId)
        │ BFF: resolve document + project from documentId+collection,
        │      restricted folders from the collection, embed requirements,
        ▼      replace the document's record
  permit_records / permit_requirements (RLS, organization_id)
        ▲
        │ searchPermitRequirements (hybrid rank, reach + folder clearance)
  POST /api/internal/cross-project/search → `permits` beside `decisions`
        ▲
        │ project_lookup renders each record as one citable source
  agent
```

## Contract

### Tables (migration `0117_permit_records.sql`)

`permit_records`, one row per source document (re-extraction replaces it):

| column | type | notes |
|---|---|---|
| `id` | uuid pk default gen_random_uuid() | |
| `organization_id` | text not null | RLS: `organization_id = grid_current_org()` |
| `project_id` | uuid not null | composite FK `(project_id, organization_id)` → `projects (id, organization_id)` on delete cascade |
| `document_id` | uuid not null unique | FK → `documents(id)` on delete cascade |
| `collection_name` | text not null | the document's collection (a restricted folder has its own) |
| `file_name` | text not null | as indexed, for the citation |
| `restricted_folder_ids` | uuid[] null | the document's restricting folders, canonical (sorted, deduped), null when open; CHECK 1..20 entries when set |
| `kind` | text not null | CHECK in (`bewilligung`, `nachforderung`, `ablehnung`, `sonstiges`) |
| `authority` | text null | as the document names it („Magistratsabteilung 37", „Stadtgemeinde Mödling"); null when the document does not name it (a scan without its letterhead) |
| `municipality` | text null | the Gemeinde the procedure is in, as written |
| `bundesland` | text null | intake token (`wien`, `niederoesterreich`, …) when the document makes it clear |
| `issued_on` | date null | the notice's date |
| `reference` | text null | Geschäftszahl / Aktenzahl |
| `model` | text not null | the model that extracted it |
| `created_at`, `updated_at` | timestamptz not null default now() | |

`permit_requirements`, the record's items:

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `organization_id` | text not null | RLS as above |
| `record_id` | uuid not null | FK → `permit_records(id)` on delete cascade |
| `project_id` | uuid not null | copied, for scoping without a join |
| `restricted_folder_ids` | uuid[] null | copied from the record |
| `position` | integer not null | order in the document |
| `kind` | text not null | CHECK in (`auflage`, `nachforderung`, `hinweis`) |
| `content` | text not null | the requirement, close to the document's words, ≤ 1000 chars |
| `evidence` | text null | what is demanded as proof (a Gutachten, a Nachweis, a plan) |
| `legal_basis` | text null | as cited (§ 13 Abs. 3 AVG, § 70 BO Wien) |
| `page` | integer null | page in the document |
| `embedding` | real[] null | from `/v1/note-embeddings`, of `content` + evidence |
| `embedding_model` | text null | the fingerprint stored beside it |
| `created_at` | timestamptz not null default now() | |

No closed-project trigger on either table: they are derived index data, like
chunks and embeddings, and the archive import (step 1) extracts from closed
projects. A person never edits them; re-extraction replaces them.

### Write: `POST /api/internal/permit-records`

`internalApiRoute`, internal token, tenancy `fromPayload: 'body.organizationId, the org the ingest was dispatched for'`.

Request:

```json
{
  "organizationId": "org_…",
  "documentId": "uuid" (optional),
  "collection": "proj_…",
  "fileName": "Baubescheid_Baden_2020.pdf",
  "model": "…",
  "record": null | {
    "kind": "bewilligung|nachforderung|ablehnung|sonstiges",
    "authority": "…"|null, "municipality": "…"|null, "bundesland": "…"|null,
    "issuedOn": "YYYY-MM-DD"|null, "reference": "…"|null,
    "requirements": [
      { "kind": "auflage|nachforderung|hinweis", "content": "…",
        "evidence": "…"|null, "legalBasis": "…"|null, "page": 1|null }
    ]
  }
}
```

- `authority` is null when the document does not name it; the record is still stored.
- The BFF finds the document by `documentId` AND `collection` in that
  organization (as `document-exists`), or, without an id, by `collection` AND
  `fileName` among live documents (a live name is unique per collection: the
  backfill only knows the name); unknown, binned or project-less →
  `{ stored: false }`, 200.
- `record: null` deletes the document's record and answers `{ stored: false }`.
  The ingest hook sends it when the tag decision positively types the document
  as another kind (a document-type tag other than Bescheid and Sonstiges,
  `typed_as_something_else`), without a model call and under a 5 s deadline.
  Anything less drops nothing: `None` (the tagger timed out or failed, the
  classifier abstained, summaries are off), discipline tags alone (the fallback
  drops an off-vocabulary type, so „Baubescheid" leaves only „Brandschutz"),
  or Sonstiges, the type picked when unsure. Placement re-ingests on every
  move, and a slow or unsure tagger must not erase a real record. The pen
  never sends null for a FAILED extraction: an outage must not erase a stored
  record.
- Otherwise it replaces the document's record and requirements in one
  transaction, sets `restricted_folder_ids` from the collection
  (`sourceFoldersOfCollections`), and embeds the requirements with
  `embedNotes` (fail-open: null embedding, the token channel still ranks).
- Response `{ stored: boolean, requirements: number }`. Bounds: ≤ 60
  requirements, strings capped as above, validated with zod.

### Read: `permits` in the cross-project search

**Who may be served a record is judged from where its document is now.** The
restriction stored on a record is a snapshot of where the document was read,
and the document's collection only follows a folder change once placement has
run (a move or a new access list updates `folder_id` first; placement skips a
document whose ingest is in flight and moves a batch per call). So the search
joins the document and judges its LIVE `folder_id` against the project's folder
tree, as the document hits beside it are judged (`lib/permits/live-access.ts`):
a record from a restricted folder only for a reader cleared for every folder
restricting it now, and the restriction the hand-out records is that live one.
A record whose document is quarantined, archived or in the Papierkorb is not
served at all. Neither re-ingest nor placement is needed for any of this to
hold.

`CrossProjectSearchResponse` gains `permits: CrossProjectPermit[]` (≤ 8
records), ranked as `searchProjectDecisions` ranks (query embedding against
`permit_requirements.embedding`, fused by reciprocal rank with the token
channel over `content`, `evidence`, the record's `authority` and
`municipality`), over the same scopes as decisions: the searched page's
projects, filtered by the reader's folder clearance exactly as
`memoryVisibleTo` filters memory (open, or `restricted_folder_ids <@
readable`). The token channel keeps German letters (`normalizeContentGerman`):
folded to ASCII, „Mödling" became „m" + „dling" and matched every
requirement in metres. Records are returned with only their matching requirements (≤ 6
each), best first. The document-type and discipline filters of a search do not apply to permits, as they do not to decisions.

```json
{
  "project": { "id", "name", "status", "bundesland" },
  "collection": "…", "fileName": "…",
  "kind": "nachforderung", "authority": "…"|null, "municipality": "…"|null,
  "issuedOn": "YYYY-MM-DD"|null, "reference": "…"|null,
  "requirements": [{ "kind", "content", "evidence", "legalBasis", "page" }],
  "restricted": false
}
```

Recorded at hand-out with their projects and restricted folders, before the
response, like passages and decisions.

### Agent

`project_lookup`'s search renders each permit record as one citable source
citing the DOCUMENT (its file name, collection and the first requirement's
page), titled by kind, authority and date, placed after decisions and before
passages, carrying the `Projekt:` and `Bundesland:` lines every cross-project
hit carries. A record from a restricted folder or a running project shuts the
same doors a passage from there shuts.

## Not in this step

- Gemeinde resolution against an official register (Statistik Austria GKZ):
  a dataset to buy, not a matcher to write. `municipality` is what the
  document says; the ranking's token and meaning channels match it.
- Outcomes (was the Nachforderung met, how long did it take): needs the next
  document in the procedure; the records carry dates so a later step can
  link them.
- Counts across procedures („6 von 8"): open product question on the
  minimum sample (roadmap, open questions).
