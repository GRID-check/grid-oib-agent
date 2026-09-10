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
| Status vocabulary (five spellings of "indexed", plus `stored`) | `frontends/ui/src/lib/documents/document-status.ts` — `DOCUMENT_STATUS_FACTS` | [`docs/technical-reference/document-ingestion.md`](../technical-reference/document-ingestion.md) | ADR-0027 (unified ingest) |
| Status reconciliation against the backend job | `frontends/ui/src/lib/documents/reconcile-status.ts` | same | — |
| Upload, list, search | `frontends/ui/src/lib/documents/service.ts` — `uploadDocument` | [`docs/ux/file-upload-and-explorer.md`](../ux/file-upload-and-explorer.md) | ADR-0017 |
| Ingest dispatch | `frontends/ui/src/lib/documents/service.ts` — `dispatchDocument` | [`docs/technical-reference/document-ingestion.md`](../technical-reference/document-ingestion.md) | ADR-0027 |
| Collection file ref and chunk purge | `frontends/ui/src/lib/documents/collection-file-ref.ts` — `collectionFileRef`, `purgeIngestedChunks` | [`deletion-pipeline.md`](deletion-pipeline.md) | ADR-0011 |
| Folders as a materialised path | `frontends/ui/src/lib/db/schema/project-folders.ts` | [`docs/database/schema.md`](../database/schema.md) | ADR-0049 |
| Roles on a document | `frontends/ui/src/lib/db/schema/document-roles.ts` | [`document-roles.md`](document-roles.md) | ADR-0032 |
| Diagram filing | `frontends/ui/src/lib/diagrams/filing.ts` | [`diagrams.md`](diagrams.md) | — |
| Version states and the transition table | `frontends/ui/src/lib/documents/lifecycle-types.ts` — `DOCUMENT_VERSION_TRANSITIONS` | [`docs/roadmap/piloti-writes-artifacts-and-approval.md`](../roadmap/piloti-writes-artifacts-and-approval.md) | ADR-0054 |
| The one place a version changes state | `frontends/ui/src/lib/documents/lifecycle.ts` — `transitionDocumentVersion` | same | ADR-0054, ADR-0055 |
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
| The `Herkunft:` line in the grounding block | `sources/knowledge_layer/src/register.py` — `_format_results` | [`agent-document-provenance.md`](agent-document-provenance.md) | ADR-0054 |
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
| Chunk purge on supersede and archive | `frontends/ui/src/lib/documents/lifecycle.ts` — `purgeSupersededChunks`, `archiveDocument` | [`deletion-pipeline.md`](deletion-pipeline.md) | ADR-0054, ADR-0011 |
| The provenance wire on `/v1/ingest` | `frontends/aiq_api/src/aiq_api/routes/ingest.py`; `frontends/aiq_api/src/aiq_api/models/requests.py` — `IngestRequest` | [`docs/api/python-endpoints.md`](../api/python-endpoints.md) | ADR-0054 |
| Provenance on chunks and on the metadata row | `sources/knowledge_layer/src/llamaindex/adapter.py`; `src/aiq_agent/knowledge/factory.py` — `set_document_provenance` | [`docs/technical-reference/document-ingestion.md`](../technical-reference/document-ingestion.md) | ADR-0054 |

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
| Pinned requester session (a job acts as the human who scheduled it) | `frontends/ui/src/lib/auth/pinned-session.ts` — `resolvePinnedRequesterSession` | [`usage-budgets.md`](usage-budgets.md) | ADR-0023 |
| Verifying the signed request envelope in the BFF | `frontends/ui/src/lib/request-context.ts` — `verifyGridRequestContextEnvelope` | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0054 |

## Delegated work

| Concept | Owning code | Doc of record | Decision |
|---|---|---|---|
| Tasks | `frontends/ui/src/lib/tasks/service.ts` — `createTaskForRun`, `reviewTask` | [`docs/roadmap/agentic-workspace-architecture.md`](../roadmap/agentic-workspace-architecture.md) | ADR-0051 |
| Jobs and runs | `frontends/ui/src/lib/jobs/service.ts`, `frontends/ui/src/lib/db/schema/jobs.ts` | [`docs/api/bff-routes.md`](../api/bff-routes.md) | ADR-0021, ADR-0023 |
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
| The researcher tool loop | `src/aiq_agent/agents/researcher/agent.py` — `ResearcherAgent.run` | [`backend-deep-dive.md`](backend-deep-dive.md) | ADR-0052 |
| Research budget and the interaction allowance | `src/aiq_agent/agents/researcher/agent.py` — `_INTERACTION_TOOL_ALLOWANCE`; `max_tool_iterations` in `src/aiq_agent/agents/researcher/register.py` | same | ADR-0052 |
| Forced synthesis at the ceiling | `src/aiq_agent/agents/researcher/agent.py` — `_forced_synthesis`, `_SYNTHESIS_ANCHOR` | same | ADR-0052 |
| The envelope-enforced LLM call | `src/aiq_agent/agents/researcher/envelope_call.py` — `ainvoke_with_envelope_json_mode` | same | ADR-0052 |
| Answer envelope, Python | `src/aiq_agent/common/answer_envelope.py` — `extract_answer_envelope`, `gate_answer_meta` | [`docs/api/websocket-protocol.md`](../api/websocket-protocol.md) | ADR-0037 |
| Answer envelope, TypeScript sanitizer | `frontends/ui/src/lib/conversations/message-answer-meta.ts` — `sanitizeAnswerMeta` | same | ADR-0037 |
| Answer envelope, shared wire fixture | `tests/fixtures/answer_meta/wire_payload.json` | same | ADR-0037 |
| Answer repair after verification | `src/aiq_agent/agents/researcher/repair.py` — `repair_answer` | [`citation-system-audit-2026-07.md`](citation-system-audit-2026-07.md) | ADR-0044 (retrieval correctness) |
| Confidence markers and the overconfidence guard | `src/aiq_agent/agents/researcher/markers.py` | [`quote-verification-calibration-2026-07.md`](quote-verification-calibration-2026-07.md) | ADR-0044 (retrieval correctness) |
| Turn status steps | `src/aiq_agent/common/turn_status.py` — `emit_status` | [`docs/api/websocket-protocol.md`](../api/websocket-protocol.md) | ADR-0009 |
| Trace lanes in the UI | `frontends/ui/src/features/chat/lib/trace-lanes.ts` — `deriveTraceLanes` | [`docs/design/streaming-chat-answer.md`](../design/streaming-chat-answer.md) | ADR-0026 |
| Turn dispatch and streaming | `src/aiq_agent/turn/dispatch.py`, `src/aiq_agent/turn/streaming.py` | [`docs/technical-reference/chat-flow.md`](../technical-reference/chat-flow.md) | ADR-0009 |
| Deep researcher runtime | `src/aiq_agent/agents/deep_researcher/deepagents_runtime.py` — `DeepAgentsRuntime` | [`backend-deep-dive.md`](backend-deep-dive.md) | ADR-0018 |
| Deep researcher graph assembly | `src/aiq_agent/agents/deep_researcher/factory.py` — `build_deep_research_graph` | same | ADR-0018 |
| Deep researcher cutoffs | `src/aiq_agent/agents/deep_researcher/cutoff.py` | same | ADR-0018 |

## Knowledge and retrieval

| Concept | Owning code | Doc of record | Decision |
|---|---|---|---|
| Knowledge retrieval tool | `sources/knowledge_layer/src/register.py` — `knowledge_retrieval` | [`rag-system-audit-2026-08.md`](rag-system-audit-2026-08.md) | ADR-0039 (retrieval quality) |
| Ingestion and chunking backends | `sources/knowledge_layer/src/llamaindex/adapter.py` | [`docs/technical-reference/document-ingestion.md`](../technical-reference/document-ingestion.md) | ADR-0027 |
| Visual ingestion | `sources/knowledge_layer/src/llamaindex/visual_analysis.py` | [`visual-ingestion.md`](visual-ingestion.md) | — |
| Data-source registry (the UI toggles) | `src/aiq_agent/common/data_source_registry.py` | [`docs/user-guides/knowledge-search.md`](../user-guides/knowledge-search.md) | ADR-0026 |
| Source kinds, Python | `src/aiq_agent/common/source_kinds.py` — `SOURCE_KINDS`, `kind_for_lane` | [`rag-system-audit-2026-08.md`](rag-system-audit-2026-08.md) | ADR-0026 |
| Source kinds, TypeScript mirror | `frontends/ui/src/features/chat/lib/source-kinds.ts` — `KIND_TO_SIGNAL`, `kindForLane` | same | ADR-0026 |
| `doc_class` (human-set, beats every filename guess) | `src/aiq_agent/knowledge/document_classification.py`; UI in `frontends/ui/src/lib/knowledge/doc-class.ts` | [`docs/superpowers/specs/2026-07-17-norm-registry-design.md`](../superpowers/specs/2026-07-17-norm-registry-design.md) | ADR-0025 |
| Norm registry lanes | `src/aiq_agent/common/norm_registry.py` | same | ADR-0025 |
| Citation verification | `src/aiq_agent/common/citation_verification.py` | [`citation-system-audit-2026-07.md`](citation-system-audit-2026-07.md) | ADR-0044 (retrieval correctness) |
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
