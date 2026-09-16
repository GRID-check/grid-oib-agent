# Where is what

Concept to path. Arrive with the name of a thing — "chunk purge", "the answer
envelope", "Unvergeben" — and leave with the module that owns it, the doc that
explains it, and the decision that shaped it. It exists because locating a
module was costing more tool calls than changing it.

**Owning code** names the file, and the one symbol that is the entry point where
there is one. **Doc of record** is what to read before changing it. A dash means
nothing is written down beyond the code's own header — several of these headers
are the design doc, kept next to the code on purpose.

**The rule: a row is added in the same commit that creates a new owning module.**
A concept with no row here is a concept the next agent greps for.
`scripts/check_doc_paths.py` fails `task lint:repo` when a path in this file
does not exist, so a moved file is caught; a missing row is not.

## Documents and files

| Concept | Owning code | Doc of record | Decision |
|---|---|---|---|
| Filing a machine-authored document | `frontends/ui/src/lib/documents/generated.ts` — `fileGeneratedDocument` | [`docs/superpowers/specs/2026-08-20-agent-authored-documents-design.md`](../superpowers/specs/2026-08-20-agent-authored-documents-design.md) | ADR-0042, ADR-0038 |
| Producers and their reference kinds | `frontends/ui/src/lib/documents/generated.ts` — `GENERATED_DOCUMENT_PRODUCER_REF_KINDS` | same | — |
| Author and ref-kind vocabulary | `frontends/ui/src/lib/documents/document-authors.ts` — `AUTHORED_REF_KINDS` | [`document-roles.md`](document-roles.md) | ADR-0032 |
| The "written by a machine" marking in the bytes | `frontends/ui/src/lib/ai-provenance.ts` — `aiProvenanceMarking` | [`docs/user-guides/agent-authored-reports.md`](../user-guides/agent-authored-reports.md) | — |
| Documents table | `frontends/ui/src/lib/db/schema/documents.ts` | [`docs/database/schema.md`](../database/schema.md) | ADR-0017 |
| Status vocabulary (five spellings of "indexed", plus `stored`) | `frontends/ui/src/lib/documents/document-status.ts` — `DOCUMENT_STATUS_FACTS` | [`docs/technical-reference/document-ingestion.md`](../technical-reference/document-ingestion.md) | ADR-0056 (unified ingest) |
| Status reconciliation against the backend job | `frontends/ui/src/lib/documents/reconcile-status.ts` | same | — |
| Upload, list, search | `frontends/ui/src/lib/documents/service.ts` — `uploadDocument` | [`docs/ux/file-upload-and-explorer.md`](../ux/file-upload-and-explorer.md) | ADR-0017 |
| Ingest dispatch | `frontends/ui/src/lib/documents/service.ts` — `dispatchDocument` | [`docs/technical-reference/document-ingestion.md`](../technical-reference/document-ingestion.md) | ADR-0056 |
| Collection file ref and chunk purge | `frontends/ui/src/lib/documents/collection-file-ref.ts` — `collectionFileRef`, `purgeIngestedChunks` | [`deletion-pipeline.md`](deletion-pipeline.md) | ADR-0011 |
| Folders as a materialised path | `frontends/ui/src/lib/db/schema/project-folders.ts` | [`docs/database/schema.md`](../database/schema.md) | ADR-0049 |
| Roles on a document | `frontends/ui/src/lib/db/schema/document-roles.ts` | [`document-roles.md`](document-roles.md) | ADR-0032 |
| Diagram filing | `frontends/ui/src/lib/diagrams/filing.ts` | [`diagrams.md`](diagrams.md) | — |
| Version states and the transition table | `frontends/ui/src/lib/documents/lifecycle-types.ts` — `DOCUMENT_VERSION_TRANSITIONS` | [`docs/roadmap/piloti-writes-artifacts-and-approval.md`](../roadmap/piloti-writes-artifacts-and-approval.md) | ADR-0054 |
| The one place a version changes state | `frontends/ui/src/lib/documents/lifecycle.ts` — `transitionDocumentVersion` | same | ADR-0054, ADR-0055 |
| A version's BYTES: storage keys, the producer re-render, the marking re-check, the quota admission, the reads | `frontends/ui/src/lib/documents/version-content.ts` | same | ADR-0054 |
| Who a version may be sent to for release, and what a one-person project does | `frontends/ui/src/lib/documents/reviewers.ts` — `resolveReviewers`, `listReviewCandidates` | same | ADR-0054 |
| Whether an archived document is in a listing | `frontends/ui/src/lib/documents/repository.ts` — `listProjectDocuments`'s `includeArchived` | same | ADR-0054 |
| What a superseded version costs the organization | `frontends/ui/src/lib/storage/repository.ts` — `versionOverheadBytes` | [`../database/schema.md`](../database/schema.md) | ADR-0054, ADR-0042 |
| Where a project's delegated work is shown (Tasks, primary) | `frontends/ui/src/features/tasks/components/tasks-panel.tsx` — the Tasks tab root: runs timeline (`frontends/ui/src/features/tasks/components/task-list.tsx`, `frontends/ui/src/features/tasks/components/task-card.tsx` — one column of cards, grouped by recency, with the status filter row) plus the standing arrangements below it, and the timetable VIEW of the same tasks (`?view=timetable`); `frontends/ui/src/features/tasks/lib/task-view.ts` holds the three decisions a row makes (where its result lives, which filter it falls under, how recent it is), `frontends/ui/src/features/tasks/lib/tasks-view.ts` the two views. When a task runs is a property of the task, not a destination, and it is one choice of three — once on a date, recurring on a cron, or only by hand (`frontends/ui/src/features/jobs/lib/schedule.ts`, `cadenceOf`). The week grid places the first two (`frontends/ui/src/features/jobs/components/schedule-timetable.tsx`), the cards and the four-step builder (`frontends/ui/src/features/jobs/components/schedule-wizard.tsx`) all live on the Tasks tab now; the old Zeitplan tab is retired (`?tab=schedule` lands on Tasks with the timetable view). The two tabs live inside `frontends/ui/src/features/automation/components/automation-panel.tsx` — Tasks · Skills; `?tab=jobs` parses to Tasks | [`docs/roadmap/agentic-workspace-architecture.md`](../roadmap/agentic-workspace-architecture.md) | ADR-0051 |
| Version rows and the atomic publish | `frontends/ui/src/lib/documents/version-repository.ts` — `promoteVersionToPublished` | [`docs/database/schema.md`](../database/schema.md) | ADR-0054 |
| Version table | `frontends/ui/src/lib/db/schema/document-versions.ts` | [`docs/database/schema.md`](../database/schema.md) | ADR-0054 |
| The lifecycle's typed client (every consumer is one) | `frontends/ui/src/lib/documents/lifecycle-client.ts` | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0055 |
| The lifecycle contract, for the Python tier | `frontends/ui/src/lib/documents/lifecycle-schema.ts`; artifact at `frontends/ui/tests/fixtures/document-lifecycle.schema.json` | same | ADR-0055 |
| A Markdown document a chat turn wrote | `frontends/ui/src/lib/documents/agent-document.ts` — `fileAgentDocumentDraft` | [`docs/roadmap/piloti-writes-artifacts-and-approval.md`](../roadmap/piloti-writes-artifacts-and-approval.md) | ADR-0054 |
| Which shelf's permission a document item needs | `frontends/ui/src/lib/documents/access.ts` — `getAccessibleDocument` | [`docs/technical-reference/projects-access-control.md`](../technical-reference/projects-access-control.md) | ADR-0038, ADR-0047 |
| The chat working directory (per-conversation drafts) | `src/aiq_agent/tools/documents/draft_store.py` — `DraftBackend`, `get_draft_backend` | [`docs/roadmap/piloti-writes-artifacts-and-approval.md`](../roadmap/piloti-writes-artifacts-and-approval.md) | — |
| The four file verbs bound to a chat turn | `src/aiq_agent/tools/documents/tools.py` — `draft_tools_for_turn` | same | — |
| The card a written draft leaves | `src/aiq_agent/tools/documents/cards.py` — `emit_draft_card`; model in `src/aiq_agent/cards/models.py` — `DocumentDraftCard` | [`cards.md`](cards.md) | ADR-0012 |
| Agent-document provenance keys (`authored_by`, `approved_by`, `approved_at`, `producer`) | `src/aiq_agent/common/provenance.py` — `parse_agent_provenance` | [`agent-document-provenance.md`](agent-document-provenance.md) | ADR-0054 |
| The Piloti lane and its label | `src/aiq_agent/common/source_kinds.py` — `AGENT_AUTHORED_LANE` | [`agent-document-provenance.md`](agent-document-provenance.md) | ADR-0026 |
| Lane placement from stated provenance | `src/aiq_agent/common/norm_registry.py` — `lane_for_hit` | [`agent-document-provenance.md`](agent-document-provenance.md) | ADR-0026, ADR-0047 |
| The `Herkunft:` line in the grounding block | `src/aiq_agent/common/grounding_block.py` — `_header_lines`, from the `provenance` a hit states | [`agent-document-provenance.md`](agent-document-provenance.md) | ADR-0054, ADR-0061 |
| A verdict may not rest on an agent-authored source | `src/aiq_agent/common/answer_envelope.py` — `_gate_verdict` | [`agent-document-provenance.md`](agent-document-provenance.md) | ADR-0054 |
| The write-side workspace verbs (propose, never write) | `src/aiq_agent/tools/files/register.py` — `move_document`, `rename_document`, `create_folder`, `assign_document` | [`docs/roadmap/piloti-writes-artifacts-and-approval.md`](../roadmap/piloti-writes-artifacts-and-approval.md) | ADR-0055 |
| Resolving a file, folder or Dokumentart name against what the turn can see | `src/aiq_agent/tools/files/resolve.py` — `resolve_document`, `resolve_folder` | same | ADR-0047 |
| The card a proposed file operation leaves | `src/aiq_agent/tools/files/cards.py` — `propose_file_operation`; `src/aiq_agent/cards/models.py` — `FileOperationProposalCard` | [`cards.md`](cards.md) | ADR-0030 |
| Executing an accepted file-operation proposal | `frontends/ui/src/features/grid-cards/lib/file-operations.ts` — `applyFileOperations` | [`cards.md`](cards.md) | ADR-0030, ADR-0055 |
| The turn's inventory rows, for tools that resolve names | `src/aiq_agent/knowledge/inventory.py` — `set_turn_documents`, `get_turn_documents` | — | ADR-0047 |
| When a document shows a version-state badge, and which review controls a reader gets | `frontends/ui/src/features/documents/lib/document-lifecycle.ts` — one filter over `DOCUMENT_VERSION_TRANSITIONS` | [`docs/user-guides/agent-authored-reports.md`](../user-guides/agent-authored-reports.md) | ADR-0054 |
| Freigabe und Fassungen, rendered | `frontends/ui/src/features/documents/components/document-lifecycle-panel.tsx`; mounted in `frontends/ui/src/features/documents/components/file-preview-pane.tsx` and `frontends/ui/src/features/layout/components/ReportCard.tsx` | same | ADR-0054 |
| Which lifecycle permissions this reader holds | `frontends/ui/src/lib/documents/lifecycle-permissions.ts` — resolved on the server, handed to the pane as data | same | ADR-0038 |
| How the Files listing learns a document's editorial state | `frontends/ui/src/lib/documents/version-repository.ts` — `listDocumentVersionSummaries`; `frontends/ui/src/lib/documents/lifecycle.ts` — `summarizeDocumentVersions` | same | ADR-0054 |
| A version's bytes for „Öffnen" | `frontends/ui/src/app/api/documents/[id]/versions/[versionId]/content/route.ts` | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0055 |
| The piloti filename namespace for indexed agent documents | `frontends/ui/src/lib/documents/agent-namespace.ts` — `agentDocumentFilename`, `isAgentDocumentFilename` | [`agent-document-provenance.md`](agent-document-provenance.md) | ADR-0054 |
| Indexing a published version, with provenance | `frontends/ui/src/lib/documents/lifecycle.ts` — the `ingestPublished` effect | [`agent-document-provenance.md`](agent-document-provenance.md) | ADR-0054 |
| Chunk purge on supersede and archive | `frontends/ui/src/lib/documents/lifecycle.ts` — `purgeSupersededChunks`; `frontends/ui/src/lib/documents/version-content.ts` — `archiveDocument` | [`deletion-pipeline.md`](deletion-pipeline.md) | ADR-0054, ADR-0011 |
| The provenance wire on `/v1/ingest` | `frontends/aiq_api/src/aiq_api/routes/ingest.py`; `frontends/aiq_api/src/aiq_api/models/requests.py` — `IngestRequest` | [`docs/api/python-endpoints.md`](../api/python-endpoints.md) | ADR-0054 |
| Provenance on chunks and on the metadata row | `sources/knowledge_layer/src/llamaindex/adapter.py`; `src/aiq_agent/knowledge/factory.py` — `set_document_provenance` | [`docs/technical-reference/document-ingestion.md`](../technical-reference/document-ingestion.md) | ADR-0054 |
| What every file Piloti produces says about itself (header line, prose, footer, logo slot) and the platform-default / organization-override resolver | `frontends/ui/src/lib/documents/branding.ts` — `resolveDocumentBranding` | [`docs/user-guides/agent-authored-reports.md`](../user-guides/agent-authored-reports.md) | ADR-0054 |
| Filing a draft into the project, and submitting it | `src/aiq_agent/tools/documents/register.py` — `file_draft`, `submit_draft` | [`docs/roadmap/piloti-writes-artifacts-and-approval.md`](../roadmap/piloti-writes-artifacts-and-approval.md) | ADR-0054, ADR-0055 |
| The agent's one call to the lifecycle API (echoes the signed envelope, never signs) | `src/aiq_agent/tools/documents/filing.py` — `post_document_version` | same | ADR-0055 |
| Where a filed draft's document id is remembered | `src/aiq_agent/tools/documents/draft_store.py` — `FILING_KEYS`, `arecord_filing` | same | — |
| The signed envelope as the Python tier receives it | `src/aiq_agent/project_context.py` — `GridRequestContext.envelope_header`, `get_request_envelope_from_context` | same | ADR-0054 |
| Which conversation a version was filed from | `document_versions.origin_conversation_id` (migration `0084`), stamped in `frontends/ui/src/app/api/internal/document-versions/route.ts` from the verified envelope | [`docs/database/schema.md`](../database/schema.md) | ADR-0054 |
| A reviewer's „Änderungen anfordern“ reaching the next turn of the same conversation | `frontends/ui/src/lib/documents/review-decisions.ts` — `buildReviewDecisionsBlock`; rendered beside `PROPOSAL_DECISIONS` inside `project_context` (`piloti.j2`); how the agent reads it is `src/aiq_agent/agents/piloti/prompts/piloti_static.md` `<project_record>` | [`docs/roadmap/piloti-writes-artifacts-and-approval.md`](../roadmap/piloti-writes-artifacts-and-approval.md) | ADR-0051, ADR-0054 |
| The same decision becoming a `revision` task when nobody is in a conversation | `frontends/ui/src/lib/documents/lifecycle.ts` — the `openRevisionTask` effect | same | ADR-0051, ADR-0054 |
| Which version a revision's bytes go into | `frontends/ui/src/lib/documents/revision.ts` — `openDraftForRevision` | same | ADR-0054 |
| The draft card's filed state and its controls | `frontends/ui/src/features/grid-cards/components/DocumentDraftCard.tsx` | [`cards.md`](cards.md) | ADR-0030 |

## Shelves, session files, storage

| Concept | Owning code | Doc of record | Decision |
|---|---|---|---|
| Shelves (`archiv`/`project`/`session`/`base`), TypeScript | `frontends/ui/src/lib/collection-scope.ts` — `CollectionShelf`, `computeCollectionScope` | [`docs/technical-reference/collection-scoping.md`](../technical-reference/collection-scoping.md) | ADR-0006, ADR-0047 (shelf travels as data) |
| Shelves, Python | `src/aiq_agent/common/source_kinds.py` — `Shelf`, `parse_shelf` | same | ADR-0047 |
| Shelf the turn is restricted to | `src/aiq_agent/common/focus_file.py` — `shelves_for_turn` | same | — |
| The org-wide Archiv shelf | `frontends/ui/src/lib/archiv/service.ts`, `frontends/ui/src/lib/archiv/collection.ts` | [`docs/user-guides/documents.md`](../user-guides/documents.md) | ADR-0024 |
| Session documents | `frontends/ui/src/lib/session-documents/service.ts` — `uploadSessionDocument` | [`docs/technical-reference/collection-scoping.md`](../technical-reference/collection-scoping.md) | ADR-0006 |
| Session chunk purge | `frontends/ui/src/lib/session-documents/cleanup.ts` — `purgeSessionDocuments` | [`deletion-pipeline.md`](deletion-pipeline.md) | ADR-0011 |
| Quota admission for stored bytes | `frontends/ui/src/lib/storage/admission.ts` — `admitOrDiscard` | [`usage-budgets.md`](usage-budgets.md) | ADR-0042 |
| Object cleanup (originals and derivatives) | `frontends/ui/src/lib/documents/object-cleanup.ts` — `deleteDocumentObjects` | [`deletion-pipeline.md`](deletion-pipeline.md) | ADR-0011, ADR-0042 |
| Per-tenant buckets | `frontends/ui/src/lib/storage/bucket.ts`, `frontends/ui/src/lib/s3.ts` | [`docs/deployment/security-config.md`](../deployment/security-config.md) | ADR-0043 |
| Deletion policy | `frontends/ui/src/lib/deletion/policy.ts` | [`deletion-pipeline.md`](deletion-pipeline.md) | ADR-0011 |
| Legal holds | `frontends/ui/src/lib/db/schema/legal-holds.ts` | [`deletion-pipeline.md`](deletion-pipeline.md) | ADR-0011 |

## Collaboration

| Concept | Owning code | Doc of record | Decision |
|---|---|---|---|
| Assignments, and the "Unvergeben" filter | `frontends/ui/src/lib/assignments/service.ts` — `addResourceAssignment`; filter in `frontends/ui/src/features/documents/lib/file-filters.ts` | [`collaboration-lifecycle.md`](collaboration-lifecycle.md) | ADR-0047 (assignment is not access) |
| Shareable resource types | `frontends/ui/src/lib/sharing/registry.ts` — `SHAREABLE_REGISTRY` | [`adding-a-shareable-resource-type.md`](adding-a-shareable-resource-type.md) | ADR-0032 |
| Share grants and roles | `frontends/ui/src/lib/sharing/service.ts`, `frontends/ui/src/lib/db/schema/resource-shares.ts` | [`docs/design/collaboration-sharing-and-inbox-spec.md`](../design/collaboration-sharing-and-inbox-spec.md) | ADR-0032 |
| A conversation's subject resource ("Asking about this file") | `frontends/ui/src/lib/db/schema/conversations.ts` — `subjectResourceType`; created in `frontends/ui/src/lib/conversations/service.ts` | [`docs/technical-reference/conversation-persistence.md`](../technical-reference/conversation-persistence.md) | ADR-0033 |
| Inbox item types and their gates | `frontends/ui/src/lib/inbox/registry.ts` — `INBOX_TYPE_DEFINITIONS` | [`docs/design/collaboration-sharing-and-inbox-spec.md`](../design/collaboration-sharing-and-inbox-spec.md) | ADR-0035 |
| Inbox wire shapes and presentation | `frontends/ui/src/lib/inbox/types.ts` | [`docs/api/collaboration-routes.md`](../api/collaboration-routes.md) | ADR-0035 |
| Mentions and handoff | `frontends/ui/src/lib/mentions`, `frontends/ui/src/lib/db/schema/mention-requests.ts` | [`docs/api/collaboration-routes.md`](../api/collaboration-routes.md) | ADR-0034 |
| Live presence in a shared turn | `frontends/ui/src/lib/conversations/presence.ts` | [`collaboration-lifecycle.md`](collaboration-lifecycle.md) | ADR-0039 (live shared turns) |

## Authorization, audit, the internal seam

| Concept | Owning code | Doc of record | Decision |
|---|---|---|---|
| Permission and role catalog | `frontends/ui/src/lib/authz/catalog.ts` — `ALL_PERMISSION_SPECS`, `ROLES` | [`multitenancy-and-auth-spec.md`](multitenancy-and-auth-spec.md) | ADR-0038, ADR-0016 |
| The decision point | `frontends/ui/src/lib/authz/decide.ts`, `frontends/ui/src/lib/authz/projects.ts` — `requireProjectAccess` | [`docs/technical-reference/projects-access-control.md`](../technical-reference/projects-access-control.md) | ADR-0038 |
| Every route is covered by a check | `frontends/ui/src/app/api/authz-coverage.spec.ts` | [`authorization-audit-2026-08.md`](authorization-audit-2026-08.md) | ADR-0038 |
| Feature flags | `frontends/ui/src/lib/authz/feature-flags.ts` — `FEATURE_FLAGS` | [`docs/deployment/environment-variables.md`](../deployment/environment-variables.md) | ADR-0016 |
| Catalog provisioning into WorkOS | `frontends/ui/scripts/provision-workos-authz.ts` | [`docs/deployment/workos-provisioning.md`](../deployment/workos-provisioning.md) | ADR-0002 |
| Audit actions and their WorkOS schemas | `frontends/ui/src/lib/audit/schemas.mjs` — `AUDIT_SCHEMAS`; provisioned by `frontends/ui/scripts/provision-workos-audit-schemas.mjs` | [`docs/deployment/workos-provisioning.md`](../deployment/workos-provisioning.md) | ADR-0002 |
| Emitting an audit event | `frontends/ui/src/lib/audit/service.ts` — `recordAuditEvent`, `recordAuditEventOrThrow` | [`docs/compliance/compliance-audit-2026-07.md`](../compliance/compliance-audit-2026-07.md) | — |
| Internal token check | `frontends/ui/src/lib/internal-auth.ts` — `requireInternalToken` | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0003 |
| Internal routes (backend calls the BFF) | `frontends/ui/src/app/api/internal` | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0003 |
| Row-level security | `frontends/ui/src/lib/db/tenant-context.ts`; coverage in `frontends/ui/src/lib/db/rls-coverage.spec.ts` | [`docs/database/row-level-security.md`](../database/row-level-security.md) | ADR-0041 |
| Session and sign-in | `frontends/ui/src/lib/auth` | [`docs/technical-reference/authentication-flow.md`](../technical-reference/authentication-flow.md) | ADR-0002, ADR-0007 |
| Pinned requester session (scheduled or delegated work acts as the human who asked for it) | `frontends/ui/src/lib/auth/pinned-session.ts` — `resolvePinnedRequesterSession` | [`usage-budgets.md`](usage-budgets.md) | ADR-0023 |
| Verifying the signed request envelope in the BFF | `frontends/ui/src/lib/request-context.ts` — `verifyGridRequestContextEnvelope` | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0054 |

## Delegated work

| Concept | Owning code | Doc of record | Decision |
|---|---|---|---|
| Tasks — the work object: one row per attempt (pinned requester, lifecycle, filed result, review decision) over `task_runs`, with the standing intent in `task_definitions` since migration 0086 | `frontends/ui/src/lib/tasks/service.ts` — `recordRunOutcome`, `reviewTask`; `frontends/ui/src/lib/db/schema/task-model.ts` | [`docs/roadmap/agentic-workspace-architecture.md`](../roadmap/agentic-workspace-architecture.md) | ADR-0051 |
| Delegating work from a chat turn, and what each kind runs on | `frontends/ui/src/lib/tasks/delegation.ts` — `delegateTask`, `TASK_ENGINES` | [`docs/roadmap/piloti-writes-artifacts-and-approval.md`](../roadmap/piloti-writes-artifacts-and-approval.md) | ADR-0051, ADR-0055 |
| The route a machine delegates through (verified envelope, pinned requester, op `create` only) | `frontends/ui/src/app/api/internal/tasks/route.ts`; `frontends/ui/src/lib/tasks/wire.ts` | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0051, ADR-0055 |
| The `create_task` tool | `src/aiq_agent/tools/tasks/register.py`; its one call in `src/aiq_agent/tools/tasks/client.py` | same | ADR-0051 |
| The run ledger — what a run DID, as the reader is told it: phases, steps described by the INTENT the runner stated (never a tool name), the documents each step reached, the result or the error | `frontends/ui/src/lib/runs/run-ledger-types.ts` (zod, the one definition); `frontends/ui/src/lib/runs/run-ledger.ts` — `sanitizeRunLedger` and the pure moves (`appendStep`, `openPhase`, `closePhase`, `finishRun`, `failRun`) | [`docs/database/schema.md`](../database/schema.md) | ADR-0062, ADR-0055 |
| The run ledger's shape in the other language, and what pins the two together | `src/aiq_agent/common/run_ledger.py`; the exported JSON Schema `frontends/ui/tests/fixtures/run-ledger.schema.json`, written by `frontends/ui/src/lib/runs/run-ledger-schema.ts` | same | ADR-0055 |
| Where a run's ledger and report are stored | `messages.metadata.run_ledger` on the ONE message `messages.run_id` names (migration `0091`); the service is `frontends/ui/src/lib/runs/service.ts` — `applyRunLedgerOp`, `createRunMessage` | [`docs/database/schema.md`](../database/schema.md) | ADR-0062 |
| The route a run flushes its ledger through (internal, ops `append` and `finish`, identity from the `task_runs` row) | `frontends/ui/src/app/api/internal/runs/[runId]/ledger/route.ts`; its typed client `frontends/ui/src/lib/runs/run-ledger-client.ts` | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0055, ADR-0062 |
| Folding a run's own events into its ledger, and streaming it as `run.ledger` | `frontends/aiq_api/src/aiq_api/jobs/run_ledger_fold.py` — `RunLedgerFold`, `FoldingEventStore`; built per run in `frontends/aiq_api/src/aiq_api/jobs/runner.py` | [`docs/api/websocket-protocol.md`](../api/websocket-protocol.md) | ADR-0062, ADR-0018 |
| Posting a ledger flush from the backend to the BFF | `frontends/aiq_api/src/aiq_api/jobs/run_ledger_client.py` — `RunLedgerClient` (`append`, `finish`) | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0055, ADR-0003 |
| Reading one run — where its message is and what its ledger says | `frontends/ui/src/app/api/projects/[id]/runs/[runId]/route.ts` — `getRunView` (`project:view`) | same | ADR-0062 |
| Zod wire schemas as JSON Schema, for the contracts Python also reads | `frontends/ui/src/lib/api/zod-json-schema.ts` — `toJsonSchema`, `jsonSchemaDocument` | [`docs/adr/0055-api-first-workspace-primitives.md`](../adr/0055-api-first-workspace-primitives.md) | ADR-0055 |
| The identity pair every internal route with an acting person uses | `frontends/ui/src/lib/api/internal-envelope.ts` — `requireVerifiedContext`, `requirePinnedSession` | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0054, ADR-0055 |
| What a finished task leaves behind, by kind | `frontends/ui/src/lib/tasks/service.ts` — `fileResultFor`, `FILES_ITS_RESULT` | [`docs/roadmap/agentic-workspace-architecture.md`](../roadmap/agentic-workspace-architecture.md) | ADR-0051 |
| Closing ANY run — job-fired or delegated — in one recorder | `frontends/ui/src/lib/tasks/service.ts` — `recordRunOutcome`; the ONE lookup in `frontends/ui/src/app/api/internal/jobs/[jobId]/outcome/route.ts` | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0051 |
| Definitions — the standing intent (a project-scoped prompt on a timer, due once on a date, manual-only, or a chat handover) — and runs — the attempt, including skipped/errored fires that never reached the agent | `frontends/ui/src/lib/jobs/service.ts` (definition CRUD + the fire path), `frontends/ui/src/lib/tasks/repository.ts` (all SQL), `frontends/ui/src/lib/db/schema/task-model.ts` | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0021, ADR-0023, ADR-0051 |
| Schedules | `frontends/ui/src/lib/jobs/schedule.ts` | same | ADR-0023 |
| Worker outcome route | `frontends/ui/src/app/api/internal/jobs/[jobId]/outcome/route.ts` | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0021, ADR-0051 |
| Project and organization memory (BFF) | `frontends/ui/src/lib/projects/memory-service.ts` — `buildProjectMemoryDigest` | [`project-memory-design.md`](project-memory-design.md) | ADR-0008 |
| Memory tool and reflection (agent) | `src/aiq_agent/memory/register.py`, `src/aiq_agent/memory/reflection.py` | [`memory-system-audit-2026-07.md`](memory-system-audit-2026-07.md) | ADR-0008 |
| Post-answer stages | `src/aiq_agent/stages/runner.py`, `src/aiq_agent/stages/registry.py` | [`post-answer-stages.md`](post-answer-stages.md) | — |

## Agent surface

| Concept | Owning code | Doc of record | Decision |
|---|---|---|---|
| Card catalog shown to the model | `src/aiq_agent/cards/catalog.py` — `describe_card_catalog` | [`cards.md`](cards.md) | ADR-0012 |
| Card models | `src/aiq_agent/cards/models.py` | [`docs/design/grid-card-charter.md`](../design/grid-card-charter.md) | ADR-0012 |
| Per-session card registry | `src/aiq_agent/cards/registry.py` — `get_or_create_card_registry` | [`cards.md`](cards.md) | ADR-0012, ADR-0030 |
| Generated card schemas | `shared/cards/schemas.json` and `frontends/ui/src/shared/cards/generated.ts`, from `scripts/generate_card_schema.py` | [`cards.md`](cards.md) | ADR-0012 |
| Platform skills, source | `src/aiq_agent/skills/builtin` | [`agent-skills.md`](agent-skills.md) | ADR-0046 |
| Platform skills, generated | `frontends/ui/src/lib/skills/platform-skills.ts`, from `frontends/ui/scripts/sync-platform-skills.mjs` | [`agent-skills.md`](agent-skills.md) | ADR-0046 |
| Skill resolution and firing | `src/aiq_agent/skills/resolver.py`; routes under `frontends/ui/src/app/api/internal/skills` | [`agent-skills.md`](agent-skills.md) | ADR-0046 |
| Contributor skills (the ones agents read), source | `skills` — locked by `apm.lock.yaml`, validated by `scripts/validate_skills.py` | [`docs/contributing/agent-skills.md`](../contributing/agent-skills.md) | ADR-0046 |

## The answering agent

| Concept | Owning code | Doc of record | Decision |
|---|---|---|---|
| Piloti's tool loop | `src/aiq_agent/agents/piloti/agent.py` — `PilotiAgent.run` | [`backend-deep-dive.md`](backend-deep-dive.md) | ADR-0052 |
| Research budget, in ROUNDS | `src/aiq_agent/agents/piloti/agent.py` — `_charge_tool_calls`; `max_tool_iterations` in `src/aiq_agent/agents/piloti/register.py` | same | ADR-0052 |
| The turn's cost bound | `src/aiq_agent/agents/piloti/agent.py` — `_turn_cutoff`, `_turn_input_tokens`; `max_input_tokens_per_turn` in `src/aiq_agent/agents/piloti/register.py`, metered by `src/aiq_agent/common/cost_tracking.py` | same | ADR-0015 |
| A data source switched off for a turn | `src/aiq_agent/common/data_sources.py` — `disabled_source_notice`, `unavailable_source_ids`, refused at the `ToolNode` boundary in `agent._split_round` | same | ADR-0022 |
| Forced synthesis at the ceiling | `src/aiq_agent/agents/piloti/agent.py` — `_forced_synthesis`, `_SYNTHESIS_ANCHOR` | same | ADR-0052 |
| Which limit on a turn is a ratchet, a budget or a hobble | `src/aiq_agent/agents/piloti/agent.py`, `configs/config_oib_openrouter.yml` — the register indexes them one by one and says what closed each | [Hobble register (2026-09)](hobble-register-2026-09.md) | ADR-0060 |
| The office's standing instructions for every turn | `frontends/ui/src/lib/org-instructions/service.ts` — `saveOrgInstructions`; read back in `src/aiq_agent/project_context.py` — `normalize_org_instructions` | [`agent-skills.md`](agent-skills.md) | ADR-0060 |
| The envelope-enforced LLM call | `src/aiq_agent/agents/piloti/envelope_call.py` — `ainvoke_with_envelope_json_mode` | same | ADR-0052 |
| Answer envelope, Python | `src/aiq_agent/common/answer_envelope.py` — `extract_answer_envelope`, `gate_answer_meta` | [`docs/api/websocket-protocol.md`](../api/websocket-protocol.md) | ADR-0037 |
| Answer envelope, TypeScript sanitizer | `frontends/ui/src/lib/conversations/message-answer-meta.ts` — `sanitizeAnswerMeta` | same | ADR-0037 |
| Answer envelope, shared wire fixture | `tests/fixtures/answer_meta/wire_payload.json` | same | ADR-0037 |
| Answer repair after verification | `src/aiq_agent/agents/piloti/repair.py` — `repair_answer` | [`citation-system-audit-2026-07.md`](citation-system-audit-2026-07.md) | ADR-0058 (retrieval correctness) |
| Confidence markers and the overconfidence guard | `src/aiq_agent/agents/piloti/markers.py` | [`quote-verification-calibration-2026-07.md`](quote-verification-calibration-2026-07.md) | ADR-0058 (retrieval correctness) |
| Turn status steps | `src/aiq_agent/common/turn_status.py` — `emit_status` | [`docs/api/websocket-protocol.md`](../api/websocket-protocol.md) | ADR-0009 |
| What one round of retrieval calls RAN, repeated or failed | `src/aiq_agent/common/retrieval_rounds.py` — `repeat_fetches`, `ran_signatures`, `assistant_checkpoint`; Piloti's own guards in `src/aiq_agent/agents/piloti/agent.py` — `_split_round` | [`backend-deep-dive.md`](backend-deep-dive.md) | ADR-0052 |
| The retrieval ledger: announced rounds joined with the hits they returned | `src/aiq_agent/common/retrieval_ledger.py` — `build_retrieval_ledger`; wire fixture `tests/fixtures/herleitung/retrieval_ledger_wire.json` | [`docs/design/streaming-chat-answer.md`](../design/streaming-chat-answer.md) | ADR-0026 |
| Trace lanes in the UI | `frontends/ui/src/features/chat/lib/trace-lanes.ts` — `deriveTraceLanes` | [`docs/design/streaming-chat-answer.md`](../design/streaming-chat-answer.md) | ADR-0026 |
| Turn dispatch and streaming | `src/aiq_agent/turn/dispatch.py`, `src/aiq_agent/turn/streaming.py` | [`docs/technical-reference/chat-flow.md`](../technical-reference/chat-flow.md) | ADR-0009 |
| Deep researcher runtime | `src/aiq_agent/agents/deep_researcher/deepagents_runtime.py` — `DeepAgentsRuntime` | [`backend-deep-dive.md`](backend-deep-dive.md) | ADR-0018 |
| Deep researcher graph assembly | `src/aiq_agent/agents/deep_researcher/factory.py` — `build_deep_research_graph` | same | ADR-0018 |
| Deep researcher cutoffs | `src/aiq_agent/agents/deep_researcher/cutoff.py` | same | ADR-0018 |

## Knowledge and retrieval

| Concept | Owning code | Doc of record | Decision |
|---|---|---|---|
| Knowledge retrieval tool | `sources/knowledge_layer/src/register.py` — `knowledge_retrieval` | [`rag-system-audit-2026-08.md`](rag-system-audit-2026-08.md) | ADR-0039 (retrieval quality) |
| Ingestion and chunking backends | `sources/knowledge_layer/src/llamaindex/adapter.py` | [`docs/technical-reference/document-ingestion.md`](../technical-reference/document-ingestion.md) | ADR-0056 |
| Visual ingestion | `sources/knowledge_layer/src/llamaindex/visual_analysis.py` | [`visual-ingestion.md`](visual-ingestion.md) | — |
| Data-source registry (the UI toggles) | `src/aiq_agent/common/data_source_registry.py` | [`docs/user-guides/knowledge-search.md`](../user-guides/knowledge-search.md) | ADR-0026 |
| Source kinds, Python | `src/aiq_agent/common/source_kinds.py` — `SOURCE_KINDS`, `kind_for_lane` | [`rag-system-audit-2026-08.md`](rag-system-audit-2026-08.md) | ADR-0026 |
| Source kinds, TypeScript mirror | `frontends/ui/src/features/chat/lib/source-kinds.ts` — `KIND_TO_SIGNAL`, `kindForLane` | same | ADR-0026 |
| `doc_class` (human-set, beats every filename guess) | `src/aiq_agent/knowledge/document_classification.py`; UI in `frontends/ui/src/lib/knowledge/doc-class.ts` | [`docs/superpowers/specs/2026-07-17-norm-registry-design.md`](../superpowers/specs/2026-07-17-norm-registry-design.md) | ADR-0025 |
| Norm registry lanes | `src/aiq_agent/common/norm_registry.py` | same | ADR-0025 |
| Citation verification | `src/aiq_agent/common/citation_verification.py` | [`citation-system-audit-2026-07.md`](citation-system-audit-2026-07.md) | ADR-0058 (retrieval correctness) |
| The grounding block: the record, and the one renderer | `src/aiq_agent/common/grounding_block.py` — `GroundingHit`, `GroundingBlock`, `render_grounding_block` | [`backend-deep-dive.md`](backend-deep-dive.md) | ADR-0061 |
| Building hits from retrieved chunks | `sources/knowledge_layer/src/register.py` — `_grounding_hit`, `_format_results` | same | ADR-0061 |
| Building hits from RIS passages | `sources/ris_adapter/src/lookup/render.py` — `format_passages` | same | ADR-0061 |
| Reading a tool result back as sources | `src/aiq_agent/common/citation_verification.py` — `extract_sources_from_tool_result`, `_entry_from_hit`; `_parse_knowledge_layer` is the text fallback for cached and replayed turns | same | ADR-0061 |
| Citation persistence and export | `frontends/ui/src/lib/citations/service.ts` | same | ADR-0037 |
| IFC tools for the agent | `src/aiq_agent/tools/bim/register.py` — `ifc_query` | [`docs/user-guides/bim-models.md`](../user-guides/bim-models.md) | ADR-0045 |
| IFC models in the BFF | `frontends/ui/src/lib/bim/model-service.ts` | same | ADR-0045 |
| OIB corpus sync | `src/aiq_agent/oib_sync.py`, `scripts/ingest_oib.py` | [`docs/technical-reference/oib-sync.md`](../technical-reference/oib-sync.md) | — |

## Frontend plumbing and the database

| Concept | Owning code | Doc of record | Decision |
|---|---|---|---|
| i18n dictionaries | `frontends/ui/src/i18n/dictionaries` | [`backend-message-localization.md`](backend-message-localization.md) | — |
| Every key the code asks for exists | `frontends/ui/src/i18n/key-coverage.spec.ts` | [`docs/contributing/testing-and-verification.md`](../contributing/testing-and-verification.md) | — |
| Backend message localization | `src/aiq_agent/common/human_prompt.py` | [`backend-message-localization.md`](backend-message-localization.md) | — |
| Migrations (drizzle-named, `.down.sql` companions run by hand) | `frontends/ui/drizzle` | [`docs/database/migrations.md`](../database/migrations.md) | ADR-0017 |
| Every migration is in the journal | `frontends/ui/tests/db/migrations-journal.test.ts` | [`docs/database/migrations.md`](../database/migrations.md) | — |
| Drizzle schema | `frontends/ui/src/lib/db/schema` | [`docs/database/schema.md`](../database/schema.md) | ADR-0017 |
| BFF proxy to the agent | `frontends/ui/src/lib/backend-proxy.ts` | [`docs/technical-reference/bff-proxy-pattern.md`](../technical-reference/bff-proxy-pattern.md) | ADR-0003 |
| Collection scope header | `frontends/ui/src/lib/collection-scope-request.ts` | [`docs/technical-reference/collection-scoping.md`](../technical-reference/collection-scoping.md) | ADR-0013 |

## Repo process

| Concept | Owning code | Doc of record | Decision |
|---|---|---|---|
| Release notes | `releasenotes/notes`, started by `task release:note -- <slug>` | [`docs/contributing/release-notes.md`](../contributing/release-notes.md) | — |
| ADR directory and its index | `scripts/check_adrs.py` | [`docs/adr/README.md`](../adr/README.md) | ADR-0001 |
| Agent guides and their bridges | `scripts/check_agent_docs.py` | [`docs/contributing/agent-onboarding-files.md`](../contributing/agent-onboarding-files.md) | ADR-0050 |
| Paths in this file | `scripts/check_doc_paths.py` | this file | — |
| The documentation index | `docs/README.md` | [`docs/contributing/documentation.md`](../contributing/documentation.md) | — |
