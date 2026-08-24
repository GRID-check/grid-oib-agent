# ADR-0049: Folders reach the backend as a materialised path, mirrored on move

- **Status:** Proposed
- **Date:** 2026-08-20
- **Deciders:** Grid engineering
- **Related:** ADR-0047 (document shelf travels as data), ADR-0006 (knowledge collection scoping), ADR-0027 (unified ingest pipeline), ADR-0017 (BFF repository/service architecture)

## Context

Project documents are filed into folders. The whole feature lives in the BFF:
`project_folders` (self-referential `parent_id`, plus a **materialised** `path`
column such as `Brandschutz/Fluchtwege`), `documents.folder_id`, and full CRUD
in `frontends/ui/src/lib/projects/folder-service.ts`.

The Python backend — ingestion, vector retrieval, and the agent's
document-surfacing tools — had no idea folders existed. Two consequences, both
of them things a user notices:

- **Surfacing.** The knowledge-base inventory the agent answers listing
  questions from carried `(collection, file_name, summary, tags, shelf)` and
  nothing about the filing. A user who put three plans in `Brandschutz` could
  not be told "die drei Dokumente in Brandschutz", because the agent could not
  see that the folder existed.
- **Retrieval.** There was no way to scope a search to a folder. "Was steht in
  meinen Brandschutz-Unterlagen?" searched the whole shelf and answered from
  whatever scored well, which on this corpus routinely means a neighbouring
  document the user did not mean.

## Decision

**The folder travels as the materialised PATH — a string — denormalised onto the
backend's per-document metadata row (`document_metadata.folder_path`), and the
BFF mirrors every path change onto it.**

Three parts, each of which was a real choice.

### 1. The path, not the `folder_id`

`folder_id` is a UUID into a table the backend does not have and must not grow a
copy of. To render "Brandschutz/Fluchtwege" from an id, the backend would need
`project_folders`, its `parent_id` walk, and a second sync problem for the
folder rows themselves.

The path needs none of that:

- it **reads as itself** — the inventory line `**plan.pdf** (Ordner:
  Brandschutz/Fluchtwege)` is the value, not a lookup of it;
- a **prefix match is the subtree**, which is the entire reason the column was
  materialised in the first place. `folder=Brandschutz` covering
  `Brandschutz/Fluchtwege` is a `startswith`, not a recursive query;
- it survives with **no join**, which matters because the read happens on the
  retrieval hot path.

The cost is that a path **moves**. Part 3 is how we pay it.

### 2. On the metadata ROW, not in the chunk vectors

The obvious alternative was to stamp `folder_path` into each chunk's metadata at
ingest, next to `file_name` and `collection`. We did not, and the reason is
exactly the mobility above.

A document is many chunks. Baking the folder into all of them means a folder
rename has to rewrite every chunk of every document in the subtree — an
expensive, partially-appliable write against the vector store — or else go
stale, which is worse: a stale folder on a chunk is a **confident wrong answer**
about where the user's file lives, and nothing in the retrieval path would
contradict it.

`document_metadata` is one row per `(collection, file_name)`, and this repo has
already made this decision twice: `doc_class` and `display_title` are both
"store-authoritative, chunk metadata is only a fallback", so a reclassification
or a rename applies **with nothing re-ingested**. Folders join them. The
retrieval-time read is the same batched shape (`_resolve_folder_paths`, one
query per in-scope collection, fail-open) that `_resolve_doc_classes` and
`_resolve_display_titles` already use.

### 3. Rename and move stay consistent through ONE mirror call

This is the crux, and leaving it unanswered is what would have made the path a
bad choice.

`PATCH /v1/collections/{c}/folder-paths` takes `{from_path, to_path}` and
re-files every document whose `folder_path` is `from_path` or sits under
`from_path/`. `to_path: null` re-files the subtree at the project root.

It is called by `mirrorFolderPathRewrite` in `folder-service.ts` after the
folder transaction commits. **One primitive covers all three mutations**, because
the BFF's own `rewriteDescendantPaths` is the same prefix replace:

| Folder operation | Mirror call |
|---|---|
| Rename `Brandschutz` → `Feuer` | `Brandschutz` → `Feuer` |
| Move `Alt/Brandschutz` under `Neu` | `Alt/Brandschutz` → `Neu/Brandschutz` |
| Delete `Brandschutz/Alt` (parent `Brandschutz`) | `Brandschutz/Alt` → `Brandschutz` |

A delete works out to a prefix rewrite because `deleteProjectFolder` re-files
the folder's documents at its parent and re-parents its children the same way:
`Brandschutz/Alt` → `Brandschutz` and `Brandschutz/Alt/EG` → `Brandschutz/EG`
are the same replacement.

The boundary is `/`, on both sides. `Brandschutz` must never carry
`Brandschutzkonzepte` with it, and `LIKE` metacharacters are escaped so a folder
called `100 % Plans` cannot match half the project — the TS `escapeLikePattern`
and the Python `_escape_like` exist for the same sentence.

The precedent for the mirror's *contract* is the display-title mirror
(`PATCH /v1/collections/{c}/documents/{f}/display-title`, called from
`renameDocument`): **best-effort, with the ordering stating which side wins.**
The durable truth is the BFF's rows. A backend that is down must not fail a
folder rename the user is entitled to. The consequence is bounded and visible —
the agent keeps the old path in its inventory and its `folder=` filter until the
next rewrite or re-ingest — and it self-heals on the next move.

The one thing the mirror is NOT is best-effort in arity: a per-document PATCH
would have made a rename O(documents in subtree) HTTP calls, each able to fail
independently, i.e. a partially-renamed folder. One call, one transaction-shaped
outcome.

### What each half looks like once this is in place

**Surfacing.** `AvailableDocument.folder_path` and `FileInfo.folder_path` carry
it; the inventory prints `(Ordner: …)` per file and explains the convention only
when some file in the turn actually has a folder; `surface_documents` states it
in the briefing the agent writes prose from.

**Retrieval.** `knowledge_search` gains `folder=`, applied post-merge like its
sibling agent filters so it works uniformly across base/session/project, and
`_format_results` emits an `Ordner:` line so a cited passage can say where its
document lives.

## Consequences

- **A folder is only as good as its metadata row.** `document_metadata` is
  anchored by the summary (the column is `NOT NULL`), so a document that failed
  to summarise has no row and therefore no folder. That is the same limitation
  `tags`, `doc_class` and `display_title` already carry, and the ingest pipeline
  already has a structural "ingested ⇒ has a summary row" backstop.
- **A folder question with an unreadable store returns nothing rather than
  everything.** The store read fails open (empty map), but an empty map means
  "filed at the root", so a `folder=`-scoped search drops every hit and the tool
  tells the model to retry. Returning shelf-wide results labelled as "the
  documents in Brandschutz" would be the worse failure.
- **The BFF's folder rows remain the only source of truth.** Nothing reads
  `document_metadata.folder_path` back into the UI; it exists for the agent.
- **`folder_path` is one more nullable column on `document_metadata`**, added
  through the same `_OPTIONAL_COLUMNS` backfill that added `tags`, `doc_class`
  and `display_title`. Existing rows read as "at the root" until the next
  ingest or mirror call.
- **Reversing this is cheap by construction.** Nothing was baked into a vector,
  which is precisely why part 2 went the way it did: dropping the column and the
  mirror endpoint would leave the index untouched.
