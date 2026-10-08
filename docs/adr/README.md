# Architecture Decision Records

This directory holds the **Architecture Decision Records (ADRs)** for the Grid Agent
project. An ADR captures a single architecturally significant decision together with
its context, the decision itself, and its consequences, so the rationale survives
team and template churn.

New records use [MADR 4](https://adr.github.io/madr/). The shape is in
[`0000-template.md`](0000-template.md). Records 0001–0049 predate that template
and follow the lightweight
[Michael Nygard pattern](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions);
they are left in the shape they were written in, because an accepted decision is
superseded rather than rewritten.

Working in here: [`AGENTS.md`](AGENTS.md).

## Why ADRs

Grid is a small team rapidly evolving a product built on a third-party template
(AI-Q). Decisions that are costly to reverse need a durable rationale trail: new
services, datastores, external dependencies, auth/tenancy/security models,
data-model changes, cross-cutting patterns, or anything that changes a public
contract. ADRs give us shared context and make onboarding easier.

## Process

```bash
python3 scripts/check_adrs.py --next    # the next free number, read from disk
cp docs/adr/0000-template.md docs/adr/NNNN-short-kebab-title.md
python3 scripts/check_adrs.py           # what `task lint:repo` runs
```

1. Take the number from `--next`. It reads the directory; this index lags it,
   and reading the index is how four numbers ended up used twice.
2. Open it as `proposed`. Fill in the frontmatter and the sections.
3. Add its row to the index below **in the same commit**.
4. When the team agrees, set `accepted` and update `date` in the same edit, in
   the file *and* in the index row.
5. When a later ADR replaces it, set `superseded by ADR-NNNN` here and name this
   one in the new record.

An accepted ADR is superseded, not rewritten; clarifications and typo fixes are
fine. Fill in **Confirmation** before accepting: the gate that keeps the decision
true, or an explicit statement that nothing enforces it yet.

## Status legend

The frontmatter takes one of these and nothing else. Qualifications go in
Consequences, where a reader looks for them.

| Status | Meaning |
|--------|---------|
| `proposed` | Drafted and under discussion; not yet agreed. |
| `accepted` | Agreed and in effect. |
| `rejected` | Considered and declined; kept so it is not re-proposed. |
| `superseded by ADR-NNNN` | Replaced by a later decision; kept for history. |
| `deprecated` | No longer relevant, but not directly replaced. |

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-use-architecture-decision-records.md) | Use Architecture Decision Records | Accepted |
| [0002](0002-outsource-identity-to-workos.md) | Outsource identity to WorkOS | Accepted |
| [0003](0003-nextjs-bff-and-stateless-python-agent.md) | Next.js BFF + stateless Python agent | Accepted |
| [0004](0004-tenancy-ownership-and-access-model.md) | Tenancy, ownership & access model | Accepted |
| [0005](0005-object-storage-for-documents-minio.md) | Object storage for documents (MinIO) (store later migrated to SeaweedFS; see the ADR's Update section) | Accepted |
| [0006](0006-knowledge-collection-scoping.md) | Knowledge collection scoping | Accepted |
| [0007](0007-no-local-identity-sync.md) | No local identity sync | Accepted |
| [0008](0008-project-and-organization-memory.md) | Project & Organization Memory (single-writer) | Accepted |
| [0009](0009-websocket-only-chat-transport.md) | WebSocket-only chat transport | Accepted |
| [0010](0010-llm-agnostic-openai-compatible.md) | LLM-agnostic via OpenAI-compatible endpoints | Accepted |
| [0011](0011-deletion-pipeline.md) | Deletion pipeline (soft-delete → purge, legal holds) | Accepted |
| [0012](0012-cards-as-rich-ui-layer.md) | Cards as a general rich-UI presentation layer | Accepted |
| [0013](0013-base64url-context-headers.md) | base64url-encoded context headers | Superseded by ADR-0077 |
| [0014](0014-org-runtime-model-configuration.md) | Org-level runtime model configuration per agent group | Accepted |
| [0015](0015-llm-budgets-and-usage-ledger.md) | LLM spend limits and the auditable usage ledger | Accepted |
| [0016](0016-platform-tier-and-permission-registry.md) | Platform tier and the permission-driven authorization model | Accepted |
| [0017](0017-bff-repository-service-architecture.md) | BFF repository/service architecture | Accepted |
| [0018](0018-per-run-state-for-deep-research.md) | Per-run construction of deep research run state | Accepted |
| [0019](0019-write-through-usage-rollups.md) | Write-through daily rollups for budget enforcement | Accepted |
| [0020](0020-dragonfly-shared-cache.md) | Dragonfly as the shared cache tier | Accepted |
| [0021](0021-db-claimed-research-workers.md) | DB-claimed workers for deep-research execution | Accepted |
| [0022](0022-org-byok-llm-credentials.md) | Enterprise BYOK LLM credentials per organization (WorkOS Vault) and the org web-search setting | Accepted |
| [0023](0023-workflows-scheduled-research.md) | Workflows — saved research briefs with cron scheduling | Superseded by ADR-0046 |
| [0024](0024-org-wide-document-archiv.md) | Org-wide document Archiv | Proposed |
| [0025](0025-norm-registry.md) | Norm catalog — flat curated pointers + prose legal notes, admin-managed | Accepted |
| [0026](0026-unified-source-kind-model.md) | Unified source-kind model for citations, Herleitung, and reports | Accepted |
| [0027](0027-platform-workflow-templates.md) | Platform-managed workflow templates | Superseded by ADR-0046 |
| [0028](0028-horizontal-agent-scaling-conversation-affinity.md) | Horizontally scaling the aiq-agent container via conversation affinity | Accepted |
| [0029](0029-aspire-dashboard-telemetry.md) | Aspire standalone dashboard as the live telemetry pane | Accepted |
| [0030](0030-interactive-card-decisions-persist-on-the-message.md) | Interactive-card decisions persist on the message | Accepted |
| [0031](0031-err2issue-errors-to-github-issues.md) | err2issue — ERROR telemetry becomes deduplicated GitHub issues | Accepted |
| [0032](0032-shareable-resource-model.md) | The shareable-resource model, and where resource-level grants live | Accepted |
| [0033](0033-server-authoritative-shared-conversations.md) | Server-authoritative shared conversations (and the seam that keeps private ones local-first) | Accepted |
| [0034](0034-mention-handoff-persisted-state.md) | The mention hand-off is persisted conversation state, not the agent's in-memory HITL | Accepted |
| [0035](0035-notification-model-and-inbox.md) | The notification model — a generic item frame, a type registry, and the database as the record | Accepted |
| [0036](0036-when-the-agent-answers-in-a-shared-thread.md) | When the agent answers in a shared thread (engagement modes, not judgement) | Accepted |
| [0037](0037-answer-provenance-persists-on-the-message.md) | An answer's provenance — and its open questions — persist on the message | Accepted |
| [0038](0038-one-authorization-catalog-and-decision-point.md) | One authorization catalog, one decision point, and a coverage gate | Accepted |
| [0039](0039-live-shared-turns-and-composing-presence.md) | Live shared turns and composing presence | Accepted |
| [0040](0040-layered-rate-limiting-and-load-protection.md) | Layered rate limiting — the edge limits traffic, the app limits consumption | Accepted |
| [0041](0041-row-level-security-for-tenant-isolation.md) | Row-level security for tenant isolation | Accepted |
| [0042](0042-object-storage-durability-and-quota.md) | Object-storage durability — backup, quota, and least privilege | Proposed |
| [0043](0043-seaweedfs-split-topology-and-per-tenant-buckets.md) | SeaweedFS split topology, a Postgres filer store, and a bucket per tenant | Proposed |
| [0044](0044-langfuse-durable-llm-observability.md) | Langfuse as the durable LLM-observability backend | Proposed |
| [0045](0045-ifc-models-as-a-queryable-building-not-a-document.md) | IFC models are a queryable building, not another document | Accepted |
| [0046](0046-agent-skills.md) | Agent skills — user-selected, progressive-disclosure instruction packages | Proposed |
| [0047](0047-document-shelf-travels-as-data.md) | A document's shelf travels as data, not as a name or a label | Accepted |
| [0048](0048-tool-schemas-stay-with-the-provider.md) | Tool schemas stay with the provider, and a namespace is what makes that true | Proposed |
| [0049](0049-folders-travel-as-a-materialised-path.md) | Folders reach the backend as a materialised path, mirrored on move | Proposed |
| [0050](0050-scoped-agent-onboarding-guides.md) | Agent onboarding guides are scoped per service and bridged into Claude Code by import | Accepted |
| [0051](0051-tasks-are-the-durable-unit-of-delegated-work.md) | A task row is the durable unit of delegated work: pinned requester, lifecycle and review, filing at completion | Accepted |
| [0052](0052-one-answering-agent-no-intent-router.md) | One answering agent per turn, no intent router in front of it | Accepted |
| [0053](0053-credits-price-list-and-usd-cost.md) | Tenants see credits, the platform sees USD as charged, and a margin multiplier sits between them | Accepted |
| [0054](0054-document-versions-and-the-publish-door.md) | A document has versions, and only a person opens the publish door | Accepted |
| [0055](0055-api-first-workspace-primitives.md) | A workspace primitive is an HTTP route with a typed client, and every consumer is a client of it | Accepted |
| [0056](0056-unified-ingest-pipeline.md) | Unified document processing pipeline with concurrent VLM enrichment | Accepted |
| [0057](0057-agentic-retrieval-quality-package.md) | Agentic retrieval quality package (filters, hybrid RRF, LLM-judge reranker) | Accepted |
| [0058](0058-retrieval-correctness-and-the-measurement-gate.md) | Retrieval correctness, structure-aware chunking, and the measurement gate | Proposed |
| [0059](0059-assignment-is-not-access.md) | Assignment is not access (and not provenance) | Proposed |
| [0060](0060-three-instruction-layers-and-tools-that-answer.md) | Instructions live in three layers, and a tool delivers an answer | Accepted |
| [0061](0061-a-grounding-hit-is-a-record-and-the-text-is-its-rendering.md) | A grounding hit is a record, and the text a tool returns is its rendering | Proposed |
| [0062](0062-a-run-is-a-message-in-the-thread-that-commissioned-it.md) | A run is one message in the thread that commissioned it, and its ledger is what the reader sees | Proposed |
| [0063](0063-short-skill-bodies-ride-the-prompt.md) | A short skill body rides the prompt; the catalog line is for the long ones | Proposed |
| [0064](0064-a-decision-model-decides-and-never-withholds.md) | A decision model decides before the answer, and may only add to the turn | Proposed |
| [0065](0065-a2ui-renders-every-card.md) | A2UI renders every card, and an answer may compose them | Accepted |
| [0066](0066-the-answer-prose-streams-and-the-verified-frame-settles-it.md) | The answer's prose streams as it is written, and the verified frame settles it | Accepted |
| [0067](0067-the-repair-corrects-a-misremembered-quote-in-place.md) | The repair corrects a misremembered quote in place, and nothing else | Accepted |
| [0068](0068-use-nemo-agent-toolkit-as-designed.md) | Use the NeMo Agent Toolkit as designed: NAT runs the workflow, LangGraph streams natively, and the chat wire is ours | Accepted |
| [0069](0069-the-answer-is-markdown-and-a-card-must-earn-its-place.md) | The answer is Markdown, drawn richly, and a card must carry what Markdown cannot | Accepted |
| [0070](0070-office-files-are-viewed-through-a-pdf-rendition.md) | Office files are viewed through a PDF rendition that Gotenberg makes | Accepted |
| [0071](0071-word-and-presentation-files-are-indexed-from-their-rendition.md) | Word and presentation files are indexed from their PDF rendition | Accepted |
| [0072](0072-the-knowledge-layer-has-one-backend-llamaindex.md) | The knowledge layer has one backend: llamaindex | Accepted |
| [0073](0073-a-coverage-gap-is-stated-never-enforced.md) | A coverage gap is stated in the block, never enforced on the pool | Accepted |
| [0074](0074-zero-data-retention-is-the-default-enforced-at-one-seam.md) | Zero data retention is the default, enforced at one OpenRouter seam | Accepted |
| [0076](0076-ingestion-is-claimed-fairly-from-a-durable-queue.md) | Ingestion is claimed fairly from a durable queue, by a tier that scales on its depth | Proposed |
| [0077](0077-prompt-context-is-loaded-over-http-not-websocket-headers.md) | Prompt context is loaded over HTTP, not carried in WebSocket headers | Accepted |
| [0078](0078-folders-are-a-property-of-a-shelf-not-of-a-project.md) | Folders are a property of a shelf, not of a project: the Archiv gains folders through the one folder implementation | Accepted |
| [0079](0079-background-work-runs-on-one-claim-substrate.md) | Background work runs on one claim substrate, in worker pools KEDA scales on their queues | Proposed |
| [0080](0080-chat-drops-affinity-for-the-conversation-bus.md) | Chat drops conversation affinity for the conversation bus, and the backend scales on turn occupancy | Proposed |
| [0081](0081-every-model-call-passes-one-priority-aware-provider-limiter.md) | Every model call passes one priority-aware provider limiter that adapts to 429s | Proposed |
| [0082](0082-backend-roles-are-split-by-job-and-named-after-it.md) | Backend roles are split by job, and named after it | Proposed |
| [0083](0083-postgres-connections-go-through-a-transaction-pooler.md) | Postgres connections go through a transaction pooler; session features take a direct connection | Proposed |
| [0084](0084-the-backend-authorizes-a-job-by-the-scope-the-bff-signed.md) | The backend authorizes a job by the scope the BFF signed | Proposed |
| [0085](0085-outlook-archives-are-read-by-range-and-filed-as-the-person-per-mail.md) | Outlook archives are read by range and filed as the person, one folder per mail | Proposed |
| [0086](0086-uploads-are-screened-locally-and-matches-wait-in-quarantine.md) | Uploads are screened locally before any model sees them, and matches wait in quarantine | Accepted |
| [0087](0087-folder-access-follows-workos-roles-and-a-restricted-folder-is-its-own-collection.md) | Folder access follows WorkOS roles, and a restricted folder is its own retrieval collection (partly superseded by 0088) | Accepted |
| [0088](0088-folder-access-is-read-write-per-role.md) | Folder access is read/write per role | Accepted |
| [0089](0089-a-closed-project-is-read-only-and-open-to-the-office.md) | A closed project is read-only and open to the whole office | Accepted |
| [0090](0090-the-steckbrief-keeps-people-apart-from-the-profile.md) | The Steckbrief keeps its people apart from the profile | Accepted |
| [0091](0091-ausmisten-proposes-from-metadata-and-bins-through-a-subfolder.md) | „Ausmisten" proposes from metadata, and bins through a subfolder of each document's folder | Accepted |
| [0092](0092-the-server-marks-the-message-that-drew-on-a-restricted-folder.md) | The server marks the message that drew on a restricted folder, and the mark outlives the chat | Accepted |

> Note: 0027, 0039, 0044 and 0047 were each independently used twice, every
> time because two people read the next number off this index instead of off
> the directory. The four later records were renumbered to 0056–0059 and
> `scripts/check_adrs.py` now fails on any repeat, so this table can no longer
> disagree with the directory about which record a number names. The renumbered
> four keep the pre-template shape they were written in — a number is metadata,
> a decision is not, so renumbering one does not rewrite it.
> Take the next number from `python3 scripts/check_adrs.py --next`, which reads
> the directory, not from this table.

## Related documents

- System overview (source of truth): [`../architecture/system-overview.md`](../architecture/system-overview.md)
- Backend deep-dive: [`../architecture/backend-deep-dive.md`](../architecture/backend-deep-dive.md)
- Multi-tenancy & auth: [`../architecture/multitenancy-and-auth-spec.md`](../architecture/multitenancy-and-auth-spec.md)
