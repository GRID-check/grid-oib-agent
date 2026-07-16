# ADR-0024: Org-wide document Archiv

- **Status:** Proposed
- **Date:** 2026-07-16
- **Deciders:** Grid engineering
- **Related:** ADR-0004 (tenancy), ADR-0016 (permission registry), ADR-0017 (BFF repository/service architecture), the OIB base-corpus / platform base-knowledge manager, `docs/architecture/backend-deep-dive.md` (Knowledge systems)

## Context

Grid already has two document tiers:

1. **Per-project documents** — uploaded on a project's Files tab, ingested into
   that project's `proj_<uuid>` RAG collection, and retrieved only for that
   project (`lib/documents/*`, `/api/documents/*`).
2. **The OIB base corpus** — the shared regulatory knowledge every project is
   grounded on, managed by the *platform owner* and ingested into
   `oib_knowledge` (`lib/knowledge/*`, `/v1/admin/oib/*`).

There was no tier in between: a place where **one organization** can keep
documents that every one of *its* projects should see, without the platform
owner's involvement and without copying the file into each project. Enterprises
asked for exactly that — a top-level "Archiv" that lives above projects and is
shared across the whole org.

The document pipeline this needs already exists and is enterprise-hardened
(MinIO storage, best-effort `/v1/ingest` dispatch, lazy status reconciliation,
presigned download/preview, controlled tags, audit trail). Rebuilding it for the
Archiv would be duplication; the only genuinely different concern is
**authorization scope** — org-level instead of per-project.

## Decision

We will add the Archiv as a **hierarchical add-on on top of the existing
documents domain**, reusing the pipeline wholesale and swapping only the
authorization scope.

- **Storage model.** An Archiv document is a row in the existing `documents`
  table with `project_id = NULL`, a new `scope = 'archiv'` discriminator, and
  `collection_name = archiv_<orgId>`. `project_id` becomes nullable (migration
  `0019_org_archiv`). No parallel table.
- **Reused machinery.** MinIO upload, `dispatchIngest` → `/v1/ingest`, status
  reconciliation, and the item routes (`/api/documents/[id]/{download,preview,
  status,reingest,tags}`) are shared unchanged. Those item routes become
  *scope-aware*: for an `archiv` document they authorize at the org level; for a
  `project` document they keep per-project FGA. The Archiv adds only the two
  endpoints the project routes cannot serve org-wide: `GET /api/archiv/documents`
  (list) and `POST /api/archiv/documents/upload`, plus `DELETE
  /api/archiv/documents/[id]`.
- **Retrieval sharing (the crux).** The org's `archiv_<orgId>` collection is
  injected into `computeCollectionScope` alongside the base corpus, via
  `buildCollectionScopeFromRequest` (which already has `session.organizationId`).
  Because every retrieval path funnels through that one function (WS chat, the
  `/api/v1` proxy, async jobs, workflows), every project in the org
  automatically retrieves across its Archiv — no backend retrieval change.
- **Authorization.** Reads (list/preview/download) are open to any org member —
  the Archiv is shared knowledge. Mutations (upload/delete/reingest/retag) gate
  on a new `org:archiv:manage` permission (org admins hold it via the
  permission-registry back-compat rule). The `/api/v1` proxy's collection-authz
  gains an `archiv_*` branch that verifies the collection is the caller-org's
  Archiv and the caller holds `org:archiv:manage`.
- **Rollout.** Dark-launched behind the `organization-archiv` WorkOS feature
  flag, with the `GRID_ORG_ARCHIV_ENABLED` env fallback while enforcement is off
  — mirroring `isWorkflowsEnabled` / `isProjectKnowledgePageEnabled`.

## Consequences

### Positive

- Maximum reuse: one document pipeline, one reconciler, one storage convention,
  one set of item routes. The Archiv is genuinely "the same machinery with the
  project scope swapped for org scope".
- Every project in an org transparently gains the shared corpus in retrieval
  with zero backend changes and no per-project copies.
- Enterprise parity with the per-project feature: audited, tenant-scoped in SQL,
  bounded lists, permissioned writes, feature-flagged rollout.

### Negative

- The `documents` table now mixes project and archive rows; queries that assume
  a non-null `project_id` must be scope-aware. Mitigated by the explicit `scope`
  column and the `documents_org_scope_idx` index.
- A second collection now rides in every retrieval scope, marginally widening
  fan-out for orgs that enable the feature.

### Risks

- **Weakened tenancy invariant on a hot table.** `project_id` is now nullable.
  Mitigation: archive rows are always `scope='archiv'` with `project_id=NULL`
  and are only ever queried org-scoped; project queries still filter by
  `project_id`, so archive rows never leak into a project.
- **Cross-org collection access via the proxy.** Mitigation: the `archiv_*`
  authz branch pins the collection to `archiv_<caller-org>` and requires
  `org:archiv:manage`.

## Alternatives Considered

- **A separate `archiv_documents` table + duplicated service/repository/routes.**
  Rejected: it duplicates the reconciler (which writes back by row id), the item
  routes, and the storage/ingest core — the opposite of the DRY, "extract as much
  as possible" goal, for no tenancy benefit the `scope` discriminator doesn't
  already give.
- **Reusing the platform base-corpus (`/v1/admin/oib/*`) path.** Rejected: that
  corpus is platform-owner-scoped and org-agnostic (single `oib_knowledge`
  collection). The Archiv is per-organization tenant data and belongs in the
  tenant document pipeline, not the base corpus.
- **Copying archive files into every project collection at upload time.**
  Rejected: O(projects) storage and ingest per file, and no single source of
  truth to delete. Collection-scope injection gives the same retrieval result
  with one copy.
