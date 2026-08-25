# Grid documentation

Everything written down about this project, grouped by the question you arrived
with. See the [root README](../README.md) for what Grid is, and
[CONTRIBUTING.md](../CONTRIBUTING.md) for how to set up and ship a change.

## New here? Read these five, in order

1. [`architecture/system-overview.md`](architecture/system-overview.md) — what
   the system is, how the pieces fit, and what lives where in the checkout (§12).
2. [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — setup, branching, the merge gate.
3. [`contributing/testing-and-verification.md`](contributing/testing-and-verification.md)
   — `task verify`, and the traps behind it.
4. [`contributing/code-conventions.md`](contributing/code-conventions.md) —
   house rules that already cost somebody an afternoon.
5. [`adr/README.md`](adr/README.md) — the decisions, and why they went that way.

## Where things live

| Directory | What lives there | Go there when |
|---|---|---|
| [`architecture/`](architecture/) | How the system actually works: deep dives, subsystem designs, audits | You need to change a subsystem and want to know what it touches |
| [`adr/`](adr/) | Architecture decision records, numbered, with the reasoning | You are wondering why something is the way it is, or you are about to make a decision that is hard to reverse |
| [`contributing/`](contributing/) | How we work: conventions, obligations, quirks | You are shipping a change and want to do it the way this repo does |
| [`technical-reference/`](technical-reference/) | Mechanism reference: auth flow, chat flow, ingestion, WebSocket gateway | You need the exact shape of one mechanism |
| [`api/`](api/) | Route and protocol contracts | You are calling or changing an endpoint or a WebSocket message |
| [`database/`](database/) | Schema, migrations, row-level security | You are adding a table or touching the tenant boundary |
| [`deployment/`](deployment/) | Compose, Kubernetes, Coolify, environment variables, secrets | You are deploying, or you need to know what a variable does |
| [`user-guides/`](user-guides/) | What the product does, from the user's side | You need to know how a feature is meant to behave |
| [`design/`](design/) | Design language, card charter, UI specs | You are building a surface |
| [`ux/`](ux/) | UX playbooks: visual evidence, file explorer | You are adding a user-visible component |
| [`product/`](product/) | Vision, positioning, long-form writing | You want the why behind the roadmap |
| [`roadmap/`](roadmap/) | Where this is going: IFC, spatial reasoning, cross-project RAG | You are scoping something that is not built yet |
| [`audit/`](audit/) | Frozen run logs from past audit and feedback-triage loops | You are tracing where a finding or a spec's evidence came from |
| [`compliance/`](compliance/) | Audits and external dependency review | You are answering a compliance question |
| [`superpowers/`](superpowers/) | Archived plans and specs from past pieces of work | You are reconstructing the history of a change |

## Architecture

Start with [`system-overview.md`](architecture/system-overview.md), then
[`backend-deep-dive.md`](architecture/backend-deep-dive.md).

| Area | Documents |
|---|---|
| Whole system | [`system-overview.md`](architecture/system-overview.md), [`overview.md`](architecture/overview.md), [`backend-deep-dive.md`](architecture/backend-deep-dive.md) |
| BFF and data | [`bff-service-architecture.md`](architecture/bff-service-architecture.md), [`grid-app-database.md`](architecture/grid-app-database.md), [`multitenancy-and-auth-spec.md`](architecture/multitenancy-and-auth-spec.md) |
| Documents and projects | [`document-roles.md`](architecture/document-roles.md) |
| Knowledge and retrieval | [`rag-system-audit-2026-08.md`](architecture/rag-system-audit-2026-08.md), [`citation-system-audit-2026-07.md`](architecture/citation-system-audit-2026-07.md), [`quote-verification-calibration-2026-07.md`](architecture/quote-verification-calibration-2026-07.md), [`meta-vs-research-contract.md`](architecture/meta-vs-research-contract.md) |
| Memory | [`project-memory-design.md`](architecture/project-memory-design.md), [`memory-system-audit-2026-07.md`](architecture/memory-system-audit-2026-07.md), [`memory-reflection-audit.md`](architecture/memory-reflection-audit.md), [`post-answer-stages.md`](architecture/post-answer-stages.md) |
| Agent surface | [`cards.md`](architecture/cards.md), [`agent-skills.md`](architecture/agent-skills.md), [`llm-providers.md`](architecture/llm-providers.md), [`org-model-configuration.md`](architecture/org-model-configuration.md) |
| Collaboration and lifecycle | [`collaboration-lifecycle.md`](architecture/collaboration-lifecycle.md), [`adding-a-shareable-resource-type.md`](architecture/adding-a-shareable-resource-type.md), [`deletion-pipeline.md`](architecture/deletion-pipeline.md) |
| Scale and cost | [`scaling-review-2026-07.md`](architecture/scaling-review-2026-07.md), [`scaling-review-2026-07-phase2.md`](architecture/scaling-review-2026-07-phase2.md), [`rate-limiting-and-load-protection.md`](architecture/rate-limiting-and-load-protection.md), [`usage-budgets.md`](architecture/usage-budgets.md) |
| Reach | [`country-extensibility.md`](architecture/country-extensibility.md), [`backend-message-localization.md`](architecture/backend-message-localization.md) |

## Working practices

Index: [`contributing/README.md`](contributing/README.md).

| File | Description |
|---|---|
| [Working style](contributing/working-style.md) | The cases behind the four rules in `AGENTS.md` |
| [Testing and verification](contributing/testing-and-verification.md) | `task verify` as the merge gate, CI's sharding, the security stack, visual evidence |
| [Code conventions](contributing/code-conventions.md) | The `any` ban, coercing raw `sql<T>`, where shared helpers belong, capability doctrine |
| [Release notes](contributing/release-notes.md) | reno, what makes a note customer copy, publishing |
| [Gotchas](contributing/gotchas.md) | Known failures by symptom. Read before debugging a surprise |
| [Agent skills](contributing/agent-skills.md) | How `.claude/` is generated and which skills are installed |
| [Correction ratchet](contributing/correction-ratchet.md) | Closing the layer that allowed an error |
| [Documentation obligations](contributing/documentation.md) | Which doc to update for which change |

## User guides

| File | Description |
|------|-------------|
| [Chat](user-guides/chat.md) | Chat interface, conversation workflows, data source toggles |
| [Projects](user-guides/projects.md) | Organizing documents and chats into projects with access control |
| [Documents](user-guides/documents.md) | Uploading, tracking, and downloading documents |
| [Knowledge Search](user-guides/knowledge-search.md) | How the assistant searches OIB knowledge and uploaded documents |
| [Keyboard Shortcuts](user-guides/keyboard-shortcuts.md) | Command palette, `g …` section jumps, composer keys |

## Technical reference

| File | Description |
|------|-------------|
| [Architecture Overview](technical-reference/architecture-overview.md) | Two-tier architecture, component diagram, data flow |
| [Authentication Flow](technical-reference/authentication-flow.md) | WorkOS AuthKit sign-in, session resolution, JWT validation |
| [Chat Flow](technical-reference/chat-flow.md) | SSE and WebSocket chat, chat store, message streaming |
| [Collection Scoping](technical-reference/collection-scoping.md) | How `X-Grid-Collection-Scope` is computed and consumed |
| [Conversation Persistence](technical-reference/conversation-persistence.md) | Drizzle schema, CRUD routes, store hydration |
| [Document Ingestion](technical-reference/document-ingestion.md) | SeaweedFS upload, `/v1/ingest`, chunking, embedding, ChromaDB |
| [OIB Sync](technical-reference/oib-sync.md) | Incremental OIB PDF ingestion with a SHA-256 hash registry |
| [WebSocket Gateway](technical-reference/websocket-gateway.md) | Gateway proxy, scope resolution, auth forwarding |
| [BFF Proxy Pattern](technical-reference/bff-proxy-pattern.md) | Auth, scope injection, error handling, SSE passthrough |
| [Projects Access Control](technical-reference/projects-access-control.md) | WorkOS FGA project permissions |
| [UI Layout & Providers](technical-reference/ui-layout-providers.md) | App Router structure, providers, panel system, store |

## Deployment

| File | Description |
|------|-------------|
| [Environment Variables](deployment/environment-variables.md) | Every variable by category, with required-ness, defaults and owning service |
| [Docker Compose](deployment/docker-compose.md) | Service reference: images, ports, volumes, healthchecks, networks |
| [Kubernetes](deployment/kubernetes.md) | The Pulumi stack |
| [Coolify](deployment/coolify.md) | The Coolify deployment path |
| [CD](deployment/cd.md) | Continuous delivery |
| [Startup Flow](deployment/startup-flow.md) | Boot sequence: PostgreSQL init, SeaweedFS, Dask, uvicorn, gateway |
| [Security Config](deployment/security-config.md) | Auth configuration, storage credentials, key management |
| [WorkOS Provisioning](deployment/workos-provisioning.md) | Applying the authorization catalog |

## API reference

| File | Description |
|------|-------------|
| [BFF Routes](api/bff-routes.md) | Next.js API routes |
| [Collaboration Routes](api/collaboration-routes.md) | Sharing, inbox and mentions endpoints |
| [Python Endpoints](api/python-endpoints.md) | FastAPI backend endpoints |
| [WebSocket Protocol](api/websocket-protocol.md) | Message shapes over the socket |

## Database

| File | Description |
|------|-------------|
| [Schema](database/schema.md) | Tables and relationships |
| [Migrations](database/migrations.md) | How migrations run, and who runs them |
| [Row-Level Security](database/row-level-security.md) | The tenant boundary, and how to add a table to it |
