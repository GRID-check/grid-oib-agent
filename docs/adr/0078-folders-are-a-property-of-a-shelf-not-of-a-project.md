---
status: accepted
date: 2026-10-06
decision-makers: Grid engineering
consulted:
informed:
---

# Folders are a property of a shelf, not of a project: the Archiv gains folders through the one folder implementation

## Context and Problem Statement

A project's Dateien have folders: a `project_folders` table, a materialised
`path`, `documents.folder_id`, a folder upload, a re-file gesture and a path
mirror to the backend (ADR-0049). The org-wide Archiv (ADR-0024) is the same
`documents` table on another shelf (`scope = 'archiv'`, NULL project) and was
deliberately flat: `documents_folder_requires_project` made a filed document
without a project impossible, and a pilot office with a few hundred norms,
templates and Büro standards asked for exactly the structure projects already
have ([pilot feedback triage](../audit/pilot-feedback-triage-2026-09.md): "flat
and folder-less by DB constraint").

Copying the folder service for the Archiv was the obvious route and the wrong
one. The folder code is 600 lines whose value is in its details (the cycle
check, re-filing before a delete so `ON DELETE CASCADE` finds nothing, the
COALESCE unique index, the path mirror), and a second copy drifts on the first
fix. The Archiv upload had already drifted from the project upload once: no
origin path, no "same bytes, nothing to do" short-circuit, a different audit
shape, a listing with no lifecycle filter and no author filter.

## Decision Drivers

* The folder behaviour a project has today must not change in any observable way.
* The tenant boundary must hold for a shelf with no project to carry "same
  project implies same tenant" (ADR-0041).
* One implementation per concept (AGENTS.md, "correlated substrate debt"): the
  two shelves must not be able to drift.
* Reversible: the migration needs a working down path.

## Considered Options

* A second table `archiv_folders`, a second service, a second set of routes.
* A shelf-parameterised folder core over the existing table, with thin
  per-shelf authorization and the same for upload, listing, move and routes.
* Rename `project_folders` to `folders` in the same change.

## Decision Outcome

Chosen option: "a shelf-parameterised folder core over the existing table",
because the table's shape already is the answer once it states whose a folder is.

### The shelf

`DocumentShelf = { kind: 'project'; projectId } | { kind: 'archiv' }`
(`lib/documents/shelf.ts`) is the one value every shelf-dependent question takes:
`shelfDocumentWhere` and `shelfFolderWhere` say which rows are on it,
`shelfOwner` says what a new row is inserted with, `shelfCollectionName` says
which RAG collection it is ingested into, `requireShelfRead` / `requireShelfWrite`
(`lib/documents/shelf-authz.ts`) say who may. Those four are the whole of what
differs between a project and the Archiv, together with the object key's owner
prefix and the audit action's name. Everything else is written once:

* the folder CRUD, the ensure walk and the path mirror (`shelf-folders.ts`),
* moving a document into a folder (`move-to-folder.ts`),
* the upload pipeline (`shelf-upload.ts`: probe, store, admit, version,
  dispatch, audit), including a same-name upload into a different folder and the
  unchanged-bytes short-circuit,
* the listing query and its row hydration (`documents/repository.ts#listDocumentPage`,
  `shelf-listing.ts`) and its wire projection (`list-projection.ts`), with the
  query parameters shared (`list-query.ts`),
* the folder route handlers (`folder-route-handlers.ts`); each `route.ts` still
  calls `apiRoute` and declares its own `authz`.

`lib/projects/folder-service.ts` and `lib/archiv/folder-service.ts` are the names
each shelf's callers know these by, nothing more.

### The schema (migration 0102)

`project_folders` gains `organization_id` (backfilled from `projects`) and
`scope` (`project` | `archiv`), and `project_id` becomes nullable, tied by
`(scope = 'project') = (project_id IS NOT NULL)`. With the project gone from an
Archiv folder the tenant has to be a column, so:

* `UNIQUE (id, organization_id, scope)` is the foreign-key target;
* a folder's parent is `(parent_id, organization_id, scope)`: on its own shelf and tenant;
* a document's folder is `(folder_id, organization_id, scope)`: on its own shelf and
  tenant. A project document cannot be filed in an Archiv folder or the reverse, and
  a `session` attachment cannot be filed at all (no folder can have that scope);
* the sibling-uniqueness index widens to
  `(organization_id, COALESCE(project_id, nil), COALESCE(parent_id, nil), name)`;
* the RLS policy reads `organization_id` instead of joining `projects`.

The existing `(parent_id, project_id)` and `(folder_id, project_id)` keys stay:
they stop a folder of project A holding a document of project B inside one tenant,
which the new keys cannot see.

### The table keeps its name

`project_folders` is now a misnomer for the Archiv half of its rows. Renaming it
touches the Python mirror and ten earlier migrations and turns a column change
into a table swap. This is a **deliberate deferral**, written next to the table
in `schema/project-folders.ts` and `docs/database/schema.md`: rename it when
something else forces a table swap.

### Authorization

Any member of the organization reads the Archiv's folders, as they read the
Archiv. Creating, renaming, moving, deleting, ensuring and filing take
`org:archiv:manage` (`canManageArchiv`), the permission that already gates
uploading into and deleting from the Archiv. No new permission, so nothing to
provision.

### Consequences

* Good, because a project's folder behaviour is unchanged: its specs pass with
  only the edits the new `organizationId` argument and the tenant stamp on
  inserts force.
* Good, because the next shelf-level feature (a folder-level share, a
  folder-scoped search) is written once.
* Good, because the Archiv listing now carries the same row as a project's, so
  the browser has one row mapper, and it filters archived and agent-written
  documents like a project's does.
* Good, because the tenant and shelf rules are held by composite keys, so a bug
  in the service cannot file across either.
* Bad, because the table name now misleads, until the deferral is paid.
* Bad, because a re-upload of a document into a different Archiv folder re-files
  the one document (a document is unique per filename per collection), exactly as
  a project does; two Archiv folders cannot hold two files of one name.
* Bad, because the Archiv's S3 keys now include the folder path at upload for new
  documents, as a project's do. It is a label (the key is read off the row, and a
  later rename never rewrites it).
* Neutral: the `down` migration refuses while an Archiv folder exists and says
  why, because the old schema has no place for one and the backend still holds
  its path.

### Confirmation

* `tenant-isolation.integration.spec.ts` ("folders of a shelf") and
  `shelf-folders.integration.spec.ts` run against Postgres as the restricted role
  (`task db:test:rls`): cross-tenant folders are invisible and unattachable, a
  project document cannot enter an Archiv folder and vice versa, a session
  attachment cannot be filed, and a rename rewrites only its own shelf's subtree.
* `scripts/rls-test-db.sh` applies 0102 to a database that already holds project
  folders and filed documents, asserts the backfill row by row and the new
  constraints, then proves the down guard and the down migration.
* `schema/documents.spec.ts` pins the widened index and the declared keys, so a
  regeneration cannot drop them.
* `authz-coverage.spec.ts` covers the new routes; `generated.spec.ts` names the
  one upload pipeline as the sole admitter of a user row.

## More Information

Revisit if a third shelf (a per-team shelf, say) needs folders: it is a new
`DocumentShelf` member, a `scope` value and a branch in `shelfScope` and the
authz, and the `scope IN` CHECK. Supersedes nothing: ADR-0024's decision (an
org-wide shelf above projects) stands, and its flat layout is what this
amends. Builds on ADR-0049 (the path travels to the backend), ADR-0047 (the
shelf is data) and ADR-0055 (one primitive, one API).
