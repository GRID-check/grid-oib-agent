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
| [0013](0013-base64url-context-headers.md) | base64url-encoded context headers | Accepted |
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
| [0027](0027-unified-ingest-pipeline.md) | Unified document processing pipeline with concurrent VLM enrichment (duplicate number — see note below) | Accepted |
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
| [0039](0039-agentic-retrieval-quality-package.md) | Agentic retrieval quality package (filters, hybrid RRF, LLM-judge reranker) | Accepted |
| [0039](0039-live-shared-turns-and-composing-presence.md) | Live shared turns and composing presence | Accepted |
| [0040](0040-layered-rate-limiting-and-load-protection.md) | Layered rate limiting — the edge limits traffic, the app limits consumption | Accepted |
| [0041](0041-row-level-security-for-tenant-isolation.md) | Row-level security for tenant isolation | Accepted |
| [0042](0042-object-storage-durability-and-quota.md) | Object-storage durability — backup, quota, and least privilege | Proposed |
| [0043](0043-seaweedfs-split-topology-and-per-tenant-buckets.md) | SeaweedFS split topology, a Postgres filer store, and a bucket per tenant | Proposed |
| [0044](0044-langfuse-durable-llm-observability.md) | Langfuse as the durable LLM-observability backend | Proposed |
| [0044](0044-retrieval-correctness-and-the-measurement-gate.md) | Retrieval correctness and the measurement gate (duplicate number) | Proposed |
| [0045](0045-ifc-models-as-a-queryable-building-not-a-document.md) | IFC models are a queryable building, not another document | Accepted |
| [0046](0046-agent-skills.md) | Agent skills — user-selected, progressive-disclosure instruction packages | Proposed |
| [0047](0047-document-shelf-travels-as-data.md) | A document's shelf travels as data, not as a name or a label | Proposed |
| [0047](0047-assignment-is-not-access.md) | Assignment is not access (and not provenance) | Proposed |
| [0048](0048-tool-schemas-stay-with-the-provider.md) | Tool schemas stay with the provider, and a namespace is what makes that true | Proposed |
| [0049](0049-folders-travel-as-a-materialised-path.md) | Folders reach the backend as a materialised path, mirrored on move | Proposed |
| [0050](0050-scoped-agent-onboarding-guides.md) | Agent onboarding guides are scoped per service and bridged into Claude Code by import | Accepted |

> Note: two ADRs were independently numbered 0027, two more 0039, and two more
> 0047. Each collision is recorded rather than renumbered so existing links
> keep resolving (the status column is authoritative;
> `0027-platform-workflow-templates` is superseded, the others are in effect).
> Number the next new ADR from the highest in this table.

## Related documents

- System overview (source of truth): [`../architecture/system-overview.md`](../architecture/system-overview.md)
- Backend deep-dive: [`../architecture/backend-deep-dive.md`](../architecture/backend-deep-dive.md)
- Multi-tenancy & auth: [`../architecture/multitenancy-and-auth-spec.md`](../architecture/multitenancy-and-auth-spec.md)
