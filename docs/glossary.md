# Glossary

The words this codebase uses that a newcomer would not know, each pointing at the
file that defines it. The domain language (organization, shelf, Herleitung,
Befund, Laufblock and the rest of what users and the product say) lives in
[`CONTEXT.md`](../CONTEXT.md), and this page does not repeat it.

When a term here and its defining file disagree, the file wins: fix this page in
the same change.

## German domain term, English code name

Product copy is German and the code is English. Each term here is defined in
[`CONTEXT.md`](../CONTEXT.md); this table only says what to call it in an
identifier, a file name or a module. Say the German term to users and the code
name to the compiler. The stored values, URLs and permission slugs that still
read German are listed after the table.

| Domain term | Code name | Not |
|---|---|---|
| Fassung | `revision` (`lib/documents/revision-*`, `DocumentRevisions`, `revision_diff.py`) | `version`, which is the approval states |
| the links between Fassungen | `RevisionLinks` (`revision-links.ts`) | `RevisionFacts`, the Index and Rev printed in a title block |
| Büroablage, Archiv | `officeShelf` (`OFFICE_SHELF`, `lib/office-shelf`, `canManageOfficeShelf`) | `archive`, which already means soft-archived |
| Steckbrief | `projectRecord` (`ProjectRecordView`, `project-record-types.ts`, `/api/projects/{id}/project-record`) | |
| Grundstück, Bauwerk, Projekt (the scope of an intake question) | `plot`, `building`, `project` (`ProjectIntakeScope`); a building's id on the wire is `buildingId` | |
| ja, nein, offen (an intake answer) | `yes`, `no`, `open` (`YesNoOpen`); the answer mode is `value`, `estimated`, `open` (`IntakeAnswerMode`) | |
| Bundesland, Gemeinde | `federalState`, `municipality` | |
| Gebäudeklasse, Bauwerk | `buildingClass`, `building` | |
| Herleitung | `derivation` (`/dev/derivation`) | |
| Papierkorb | `bin` (`/dev/bin`) | |
| Punkt, Absatz (of a norm) | `clause`, `subsection` (`clause_chunking.py`, `build_clause_index.py`; the Qdrant keys `clause_id`, `clause_path`, `chunking: "clause"`; the `read_passage` argument `clause`) | |
| Richtlinie (OIB) | `guideline` (the Qdrant key `guideline`; `norm_registry.oib_doc_class` returns `guideline`, `guide`, `explanatory_note`, `definitions`, `referenced_standards`, `amendment`) | |
| Nutzung, Bauweise, Vorhabensart | `use` / `uses`, `construction_method`, `work_type` (the boost weights `use`, `use_max`; the `project_facts` payload keys) | |
| Hauptnutzung | `mainUse` / `main_use` (the `ifc_query` compliance argument, the BCF export query) | |
| Aufenthaltsraum, Nebenraum, Erschließung (a room's suspected use) | `habitable_room`, `ancillary_room`, `circulation`; unmatched `unclassified` (`room_inventory`, `RoomUseKind`). The lexicon terms (`buero`, `flur`) stay German: they are the room names to match | |
| Fluchtniveau (the `fire` aspect) | `escape_level` | |
| Gesetzesnummer (RIS law number in a norm's verify seed) | `statute_number` | the RIS URL parameter `Gesetzesnummer`, which is the external API's |
| Spatial result keys (`warum`, `abhilfe`, `lage`, `trennend`, `gemeinsam`, `oeffnungen` …) | `why`, `remedy`, `position`, `separating`, `shared`, `openings` … (`ifc-spatial`, `ifc-spatial-py`) | |
| Befund, Befundmatrix | `finding`, `findingsMatrix` | |
| erfüllt, nicht erfüllt, offen, nicht anwendbar | `met`, `notMet`, `open`, `notApplicable` | |
| Laufblock | `RunBlock`; states `running`, `waiting`, `done`, `cancelled`, `interrupted` | |
| Aktenvermerk | `fileNote` | |
| Unterlagen | `documents` (`DocumentsDialog`) | |

Office shelf (Büroablage): `office_shelf` / `officeShelf` everywhere, including
the scope value, `/app/office-shelf`, `/api/office-shelf`, `org:office_shelf:manage`
and `office_shelf.document.*` audit actions. Never `archive`, which means
soft-deleted. The one name still `archiv` is the collection prefix `archiv_<org>`
and the old audit and permission names, which are read beside the new ones until
the [operator runbook](deployment/office-shelf-rename-runbook.md) has run.

Qdrant points written before the payload rename still hold the German keys
(`punkt_id`, `project_facts.bundesland`, ...); every read accepts both until the
rewrite in [`qdrant-payload-rename-runbook.md`](deployment/qdrant-payload-rename-runbook.md).

The `grid-fassung-link:` advisory-lock salt in `document_metadata_store.py` stays
German for good: every running pod derives the same lock from it, so a rename
would let two pods take different locks.

## Agent surface and standard terms

What an agent reads (operation names, descriptions, schemas, refusals, the MCP
server's instructions) uses these words and no others, in English, one word per
concept, with the standard's word where one exists (AGENTS.md, "Industry
standard first"; ADR-0122). A person reads the German word in the last column,
through i18n. `lib/agent-api/english-only.spec.ts` holds the agent surface to
English.

| Term | What it is | Standard equivalent | Code | German in the UI |
|---|---|---|---|---|
| Task (task definition) | Work handed to Piloti, standing (on a schedule) or one-off: a name, a prompt, an optional skill, data sources and a schedule or due time | A2A `Task` is one attempt; ours is the definition behind attempts | `task_definitions` (`lib/db/schema/task-model.ts`); route `/api/projects/[id]/tasks`, wire `lib/tasks/task-wire.ts` (`TaskView`); operations `task-list`, `task-get`, `task-create`, `task-update`, `task-delete` | Aufgabe |
| Task run | One attempt at a task, or one commissioned deep research: queued, running, ended. Persisted in `task_runs`, shown as the run block | A2A `Task` (one unit of work with a lifecycle) | `task_runs` (`task-model.ts`), `lib/runs/`; route `/api/projects/[id]/runs`, wire `TaskRunView`, status `TASK_RUN_STATUSES`; operations `task-run-start`, `project-task-run-list` (filter by `taskId`, `status`, `review`), `task-run-get`, `task-run-cancel`, `task-run-commission`, `task-run-document-add`, `task-run-write-now`, `task-run-review`; inbox types `task_run.completed`, `task_run.failed`, `task_run.waiting` | Lauf |
| Job | A claim-queue item only: the row a worker claims and runs. Never a task or a task run | Queue job (any job queue) | `research_job_queue`, a run's `backendJobId`, `bff_job_queue`; the claim in `aiq_agent.common.claim_queue` | none |
| Schedule | When a task runs: once at a due time, on a 5-field cron with an IANA time zone, or only by hand | cron, IANA tz | `lib/jobs/schedule.ts` (`cadenceOf`) | Zeitplan |
| Run status | A task run's state. Four vocabularies today: `TASK_RUN_STATUSES` (`queued`, `running`, `succeeded`, `failed`, `interrupted`, `skipped`, `error`), the ledger's `RUN_STATUSES` (`created`, `running`, `waiting`, `done`, `failed`, `cancelled`, `interrupted`), the run block's and the backend job store's. A2A's states map as `submitted` = queued/created, `working` = running, `input-required` = waiting, `completed` = succeeded/done, `failed` = failed/error, `canceled` = cancelled/interrupted; one persisted vocabulary is a follow-up (ADR-0122) | A2A `TaskState` | `lib/tasks/task-vocabulary.ts`, `lib/runs/run-ledger-types.ts`, `lib/runs/run-vocabulary.ts` | angelegt, läuft, wartet, fertig, fehlgeschlagen, abgebrochen, unterbrochen |
| Agent surface, MCP server | What only Piloti has (the office's workspace, Piloti's domain knowledge, Piloti itself), offered to agents through one MCP server at `/api/mcp` | MCP server (Model Context Protocol) | `lib/agent-api/`, `app/api/mcp/route.ts`; [`architecture/agent-surface.md`](architecture/agent-surface.md) | none |
| Operation | One thing a person can do, as an agent sees it: a catalogued route method with a `<entity>-<verb>` name, a description and a zod input | MCP tool (in `tools` mode); OpenAPI operation (`operationId`) | `lib/agent-api/operation.ts` (`AgentOperation`) | none |
| Backend operation | One of the Python agent's read tools offered as an operation (knowledge search, passage read, files, page image, IFC, RIS), with its own English description over Piloti's native one | MCP tool | `lib/agent-api/backend-operations.ts`; `/v1/internal/tools/{name}` (`aiq_api/routes/internal_tools.py`) | none |
| Catalog | The list of every operation, one file per domain, held to the routes by the reachability ratchet | MCP `tools/list`; an OpenAPI document | `lib/agent-api/catalog/`, `agent-reachability.spec.ts`, `tests/fixtures/openapi.json` | none |
| Search mode, tools mode | How the server presents the catalog: four meta-tools (`search-operations`, `describe-operation`, `call-operation`, `report-missing-operation`), or one MCP tool per operation. `search` was `discovery` until October 2026 and is still accepted | MCP `tools/list`; MCP's own discovery is `server/discover`, which is why the mode is not called that | `lib/agent-api/mcp-server.ts` (`resolveMode`), `discovery.ts` | none |
| Principal | Who a call is: the subject (the person it acts for, a live-resolved session), the actor (`external_agent` or `piloti`) and the client (the OAuth client id) | OAuth token exchange (RFC 8693): subject, actor (`act`); OAuth client | `lib/agent-api/principal.ts` (`AgentPrincipal`, `AgentActor`) | none |
| Acting session | The person's session bound to one dispatched operation call, so the route's `getGridSession()` answers with it; carries who reads the answer (`ActingReader`: an agent reads English) | none | `lib/agent-api/acting-session.ts`; entered only by `dispatch.ts` | none |
| Pinned session | A person's session rebuilt from their id and organization, with membership, roles and every role's permissions as WorkOS states them now; what an agent and a background run act as | OAuth on-behalf-of (the subject's rights) | `lib/auth/pinned-session.ts` (`resolvePinnedRequesterSession`, ADR-0108) | none |
| Signed request context | The HMAC-signed envelope the BFF mints per agent request, naming the person, organization, project and conversation; the backend and Piloti echo it, never sign it. Not the answer envelope | A signed token carrying claims (like a JWT, HMAC) | `lib/request-context.ts`; header `X-Grid-Request-Context` | none |
| Requester, on behalf of | The person a task run, a proposal or a change acts for; `onBehalfOf` on a change record names them when Piloti made the change | RFC 8693 subject | `task_runs.requester_user_id`; `lib/changes/service.ts` (`onBehalfOf`) | „für Miriam“ |
| Sensitivity | The class of an operation that widens access (`access`), touches the organization's secrets (`secret`) or turns a control down (`control`); extra guards apply | OAuth step-up scope | `lib/agent-api/operation.ts` (`Sensitivity`), `policy.ts` | none |
| Exposure config | The one file that decides who sees each operation of the agent door: one entry per catalog operation and read tool, with `external` (an outside agent on an office door, and OpenAPI), `piloti` (`true`, `false`, or `native:<tool>`: Piloti does it with that native tool, so its door hides the operation) and `platform` (the platform door), plus `withheld` and a `reason`. Visibility only: an already filed proposal still applies. Sensitivity stays on the operation | none | `lib/agent-api/exposure.config.ts` (`EXPOSURE`), `exposure.ts` (`isExposedTo`, `isOnDoor`), `tests/fixtures/exposure.json` | none |
| Withheld operation | An operation kept in the catalog but offered on no door: product configuration, a service we only proxy, model compute with no office artifact, or a person's screen state (`withheld: { category, reason }` in its exposure config entry). It reads as an unknown name everywhere; replacing the entry offers it again | none | `lib/agent-api/exposure.config.ts` (`Withholding`, `WITHHELD_CATEGORIES`), `exposure.ts` (`isOnDoor`) | none |
| Door | One way agents reach the catalog: `office` (`/api/mcp`, A2A, Piloti's workspace door) or `platform` (the platform door). The principal carries it, set from the endpoint its token's audience binds | MCP server | `lib/agent-api/exposure.ts` (`AgentDoor`, `doorOfPrincipal`); what each door offers is the exposure config | none |
| Platform door | The operator console's own MCP server at `/api/platform/mcp`, for platform staff: the `platform` domain only, a token audience of its own that the office doors refuse (and the reverse), the GRID Platform organization only, flag `platform-agent-mcp` (ADR-0126) | MCP server; RFC 8707 resource | `app/api/platform/mcp/route.ts`, `lib/agent-api/mcp-door-route.ts`, `principal.ts` (`platformPrincipal`), `mcp-config.ts` (`platformMcpResourceUrl`) | none |
| Call decision | What the server does with one call: `run` it, or `propose` it (Piloti's writes) | MCP tool annotations decide the client's confirmation; ours is server-side | `lib/agent-api/policy.ts` (`callDecision`) | none |
| Wire module | A pure `lib/**/*-wire.ts` module holding a route's zod schema, imported by the route and the operation, so there is one contract | OpenAPI schema component | `lib/api/wire-modules.spec.ts` | none |
| Proposal, kind `operation` | A write Piloti attempted through the agent surface, stored for a person to accept (it runs as them) or dismiss | none | `lib/agent-api/operation-proposals.ts`, `lib/proposals/kinds.ts`, `operation-applier.ts` (ADR-0105) | Vorschlag |
| Change record | One row per change Piloti applied to an annotation or a thread, with its turn, for the turn's card and for undo | Audit record | `lib/changes/` (ADR-0109) | none |
| Steering | A note the asker types into a running turn, read at its next tool round; not a new turn | none | chat wire `steer` ([`api/websocket-protocol.md`](api/websocket-protocol.md#steering-a-running-turn-steer)) | none |
| Wake | Piloti answering in an annotation's thread when someone names it or answers its question, with nobody's chat open | none | `lib/annotations/wake*.ts` (ADR-0106) | weckt |
| Mention request | An outstanding request for a named person's input in a conversation, until it is released | none | `mention_requests` (`lib/db/schema/mention-requests.ts`); operation `mention-request-release` | Erwähnung |
| Skill | A packaged instruction Piloti loads into a turn (platform, office or project skill), named in a task by `/name` | Agent Skills (`SKILL.md`); not A2A's `AgentSkill`, which is an agent's advertised capability in its agent card | `lib/skills/`, `src/aiq_agent/skills/` (ADR-0060) | Skill |
| Version | One revision's approval record: its lifecycle state (draft, in review, approved, published, …), author and content hash. Not a revision | none | `document_versions`; operations `document-version-*` | Freigabestatus |
| Revision | One state of a document in its timeline | none | `revision` ([above](#german-domain-term-english-code-name)) | Fassung |
| Annotation | A mark on one page of one revision, with its thread | W3C Web Annotation | `lib/annotations/` | Anmerkung |
| Answer envelope | The JSON object a research answer is generated as (prose, kind, verdict, cards). Not the signed request context | none | `src/aiq_agent/common/answer_envelope.py` | none |
| Allow (a held upload) | A reviewer lets an upload the content check held back through. Never "release", which collides with approval | none | operations `document-quarantine-allow`, `document-quarantine-allow-request` (routes still `…/release`, a follow-up) | zulassen |
| Conversation | A thread with Piloti and people in it | A2A `contextId` | `conversations`; agents read "conversation" | Chat |
| Assignee | The person an annotation is assigned to, who answers it and closes it | none | `assigneeUserId` (`lib/annotations/`) | Zuständig |

Old names an agent may still send are accepted for one release
(`RENAMED_OPERATIONS`, `lib/agent-api/catalog/index.ts`); PostHog's
`agent_operation_called` carries the new names, and `agent_operation_missing`
replaced `agent_capability_missing`.

## Architecture and runtime

| Term | Meaning | Defined in |
|---|---|---|
| BFF | The Next.js server in `frontends/ui` (API routes plus the `server.js` WebSocket gateway). It owns identity, authorization, tenancy and the `grid_app` database; the Python agent is stateless and trusts what the BFF sends it | [`frontends/ui/AGENTS.md`](../frontends/ui/AGENTS.md) |
| NAT | NVIDIA NeMo Agent Toolkit, the framework the Python agent runs on. Tools register with `@register_function`, are discovered through a `nat.plugins` entry point, and agents are `_type` entries in `configs/*.yml` | [`src/aiq_agent/AGENTS.md`](../src/aiq_agent/AGENTS.md) |
| Signed request context | The `X-Grid-Request-Context` envelope the BFF mints for every agent request, HMAC-signed, carrying the scope, project context and memory the agent may use | [`frontends/ui/src/lib/request-context.ts`](../frontends/ui/src/lib/request-context.ts) |
| Workspace primitive, typed client | A workspace capability exposed as one HTTP API with a typed client, which the UI, the agent's tools and tasks all call as equal clients (ADR-0055) | [`docs/adr/0055-api-first-workspace-primitives.md`](adr/0055-api-first-workspace-primitives.md) |
| Route factories | `apiRoute`, `internalApiRoute`, `publicApiRoute`, `platformApiRoute`: the only sanctioned wrappers for a BFF route handler, each declaring its authorization | [`frontends/ui/src/lib/api/handler.ts`](../frontends/ui/src/lib/api/handler.ts) |
| `SourceKind` | The code form of a source kind (`building_law`, `office`, `project`, `web`, plus `measurement` for model measurements). Defined in Python and mirrored by hand in `source-kinds.ts`; changing one and not the other renders the chip as unknown | [`src/aiq_agent/common/source_kinds.py`](../src/aiq_agent/common/source_kinds.py) |
| `doc_class`, norm lanes | The stored Dokumentart (human-set, beats any filename guess), and the finer `norm_registry` lanes (`building_law_oib`, `building_law_state`, …) that sub-label a source kind | [`src/aiq_agent/knowledge/document_classification.py`](../src/aiq_agent/knowledge/document_classification.py) |
| Answer envelope | The one JSON object a research answer is generated as: the `answer` prose plus optional anatomy (kind, verdict, takeaways, callout, cards) | [`src/aiq_agent/common/answer_envelope.py`](../src/aiq_agent/common/answer_envelope.py) |
| Grounding block | The single renderer for what an evidence tool returns: each hit becomes a `--- Result N ---` block with source, citation and score, and a `## Trace-Lanes` line names the collections searched | [`src/aiq_agent/common/grounding_block.py`](../src/aiq_agent/common/grounding_block.py) |
| Knowledge layer | The `sources/knowledge_layer` package (LlamaIndex ingestion, Qdrant storage) behind `knowledge_search` | [`sources/AGENTS.md`](../sources/AGENTS.md) |
| Ingest, rendition | The path from upload to indexed chunks: stored in SeaweedFS, queued, chunked and embedded by ingest workers. Word and slide files are indexed from their PDF rendition | [`docs/architecture/system-overview.md`](architecture/system-overview.md) |
| Three instruction layers | What reaches the model as instructions: the platform prompt (managed in Langfuse), the office's standing instructions, and the skills the model picks (ADR-0060) | [`docs/architecture/backend-deep-dive.md`](architecture/backend-deep-dive.md) |
| Turn decision (Jev) | A decision model consulted at turn start under a 1.5-second budget, and for whether retrieved passages suffice. Fails open; `GRID_DECISIONS_ENABLED` switches it | [`docs/architecture/turns-per-answer-audit-2026-09.md`](architecture/turns-per-answer-audit-2026-09.md) |
| `escalate_to_deep` | The answer envelope's own decision to hand a question to deep research, with a reason. There is no intent classifier in front of it (ADR-0052) | [`src/aiq_agent/agents/piloti/AGENTS.md`](../src/aiq_agent/agents/piloti/AGENTS.md) |
| Research rounds | The tool budget counts rounds, not calls: one charge per round, with a cap on how many calls one round may make | [`src/aiq_agent/agents/piloti/AGENTS.md`](../src/aiq_agent/agents/piloti/AGENTS.md) |
| Post-answer stage | Background work after an answer is delivered (follow-ups, memory reflection), declared as a `StageSpec`, fault-isolated, dropped rather than queued when too many are pending | [`docs/architecture/post-answer-stages.md`](architecture/post-answer-stages.md) |
| Agent group | A named bundle of model slots an override targets (`clarifier`, `shallow_research`, `deep_research`, …), each with capability requirements | [`frontends/ui/src/lib/model-config/agent-groups.ts`](../frontends/ui/src/lib/model-config/agent-groups.ts) |
| Model override layers | The model an agent group uses: the organization's override, else the platform default (Platform → Models), else the YAML `model_name`, which is only the boot fallback | [`docs/architecture/org-model-configuration.md`](architecture/org-model-configuration.md) |
| Aufwand dial | The composer's reasoning-effort control for one chat, beside the per-group thinking level the platform sets | [`docs/architecture/org-model-configuration.md`](architecture/org-model-configuration.md) |
| Capability | A property derived from an infrastructure dependency (a VLM is configured), never a second flag. A feature is available when its flag is on AND its capability holds | [`docs/contributing/code-conventions.md`](contributing/code-conventions.md) |
| Ask (`piloti_asks`) | A question another agent puts to Piloti for a person (ADR-0124): `piloti-ask-create` on the MCP door, `SendMessage` on the A2A door. Runs as a headless turn (trigger `agent_consult`) in the person's own thread; its states are the A2A task states. Not an Aufgabe (`task`) and not a task run | [`frontends/ui/src/lib/piloti-asks/service.ts`](../frontends/ui/src/lib/piloti-asks/service.ts) |
| A2A | The Agent2Agent protocol: how one agent hands work to another. Piloti serves it at `/api/a2a` (JSON-RPC, 1.0 and 0.3) with its agent card at `/.well-known/agent-card.json`. Its words map onto ours: an A2A **task** is an ask, its **context** (`contextId`) the conversation, a **message** a question or an answer in it, a **part** the message's text, an **artifact** the answer or a document Piloti filed | [`docs/adr/0124-agents-consult-piloti-over-mcp-and-a2a.md`](adr/0124-agents-consult-piloti-over-mcp-and-a2a.md) |
| Piloti vs GRID | Piloti is the name in anything a user reads; GRID is the repository, the `GRID_*` variables, the `x-grid-*` headers and the CSS variables | [`frontends/ui/src/lib/brand.ts`](../frontends/ui/src/lib/brand.ts) |

## The chat wire

| Term | Meaning | Defined in |
|---|---|---|
| Chat wire v2 | The WebSocket protocol of a turn: typed events stamped `(turn_id, seq)`, closed by `RUN_FINISHED` with the authoritative result | [`docs/api/websocket-protocol.md`](api/websocket-protocol.md) |
| `attach` | The client message that re-registers a socket to a turn from a sequence number, replaying what it missed; sent on reconnect and reload | [`docs/api/websocket-protocol.md`](api/websocket-protocol.md) |
| `foldTurnEvent` | The one pure function that turns a wire event into the turn's view state, shared by the live socket, the replay and the spectator stream | [`frontends/ui/src/features/chat/lib/turn-fold.ts`](../frontends/ui/src/features/chat/lib/turn-fold.ts) |
| A2UI | The rendering layer every card is drawn through; its catalog is generated from the backend's card schema (`npm run generate:cards`) | [`docs/architecture/cards.md`](architecture/cards.md) |
| System card | A card type only a tool may emit (`memory_proposal`, `document_draft`, `task_created`, …); the model may not fabricate one | [`docs/architecture/cards.md`](architecture/cards.md) |

## Tenancy, identity and data

| Term | Meaning | Defined in |
|---|---|---|
| Tenant slot | The request-scoped context (`runWithTenantSlot`) that carries the organization as data. A query outside one throws `MissingTenantContextError` | [`frontends/ui/src/lib/db/tenant-context.ts`](../frontends/ui/src/lib/db/tenant-context.ts) |
| `getGridSession` | The one funnel every authenticated path goes through to resolve the caller and publish the organization and user into the tenant slot | [`frontends/ui/src/lib/auth/session.ts`](../frontends/ui/src/lib/auth/session.ts) |
| `withPageSession` | The wrapper that gives a server component or server action an authorized session and an open tenant slot | [`frontends/ui/src/lib/auth/require-auth.ts`](../frontends/ui/src/lib/auth/require-auth.ts) |
| `withTenant`, `withPlatformAccess` | Explicit tenant context where there is no session: one organization, or the deliberate cross-tenant path | [`frontends/ui/src/lib/db/tenant-context.ts`](../frontends/ui/src/lib/db/tenant-context.ts) |
| RLS | Row-level security: every tenant table has a Postgres policy keyed to the request's organization, so a query that lost its filter returns nothing (ADR-0041) | [`docs/database/row-level-security.md`](database/row-level-security.md) |
| `grid_secure_table()` | The SQL call that puts a new table under RLS, required in the migration that creates it; a test fails by table name without it | [`docs/database/row-level-security.md`](database/row-level-security.md) |
| Tenant-isolation suite | `task db:test:rls`: the specs that prove RLS against a real Postgres. Required when touching the tenant boundary, not part of `task verify` | [`docs/contributing/testing-and-verification.md`](contributing/testing-and-verification.md) |
| Authz catalog, `decide()` | Every permission is declared in the catalog and checked in one place. Code checks a permission, never a role name (ADR-0038) | [`frontends/ui/src/lib/authz/decide.ts`](../frontends/ui/src/lib/authz/decide.ts) |
| Tenant cache key | A cache key must carry the organization, or a hit serves another tenant's value; `grid/require-tenant-cache-key` enforces it | [`frontends/ui/src/lib/cache/index.ts`](../frontends/ui/src/lib/cache/index.ts) |
| Org-less token | A session token before an organization is active, which carries no organization or permissions; a new user creates one first | [`docs/architecture/multitenancy-and-auth-spec.md`](architecture/multitenancy-and-auth-spec.md) |
| Shareable resource | A resource type registered with the generic sharing substrate (grants in `resource_shares`); a new type needs a registry entry, not a migration | [`docs/architecture/adding-a-shareable-resource-type.md`](architecture/adding-a-shareable-resource-type.md) |
| Deletion queue, purger | Soft deletes write a tombstone row; the purger, a separate service in the frontend image, runs each entity's purge steps after the grace period, unless a legal hold blocks it | [`docs/architecture/deletion-pipeline.md`](architecture/deletion-pipeline.md) |
| WorkOS, AuthKit | The identity provider. Hosted AuthKit handles login; WorkOS organizations and roles are authoritative, with no local copy (ADR-0002, ADR-0007) | [`docs/architecture/multitenancy-and-auth-spec.md`](architecture/multitenancy-and-auth-spec.md) |
| Dragonfly | The Redis-protocol shared cache across BFF replicas, which also holds each conversation's frame stream (ADR-0020) | [`docs/adr/0020-dragonfly-shared-cache.md`](adr/0020-dragonfly-shared-cache.md) |
| SeaweedFS | The object store for document bytes, one bucket per organization (ADR-0043) | [`docs/adr/0043-seaweedfs-split-topology-and-per-tenant-buckets.md`](adr/0043-seaweedfs-split-topology-and-per-tenant-buckets.md) |
| Langfuse | The LLM trace store, and where the platform prompt is managed (ADR-0044) | [`docs/adr/0044-langfuse-durable-llm-observability.md`](adr/0044-langfuse-durable-llm-observability.md) |
| err2issue | The retired path that turned ERROR-level logs into deduplicated GitHub issues (ADR-0031); PostHog error tracking replaces it | [`docs/adr/0031-err2issue-errors-to-github-issues.md`](adr/0031-err2issue-errors-to-github-issues.md) |

## UI

| Term | Meaning | Defined in |
|---|---|---|
| Motion vocabulary | The named durations, easings and springs every animation uses; literal durations and curves are linted out by `grid/motion-vocabulary` | [`docs/design/grid-design-language.md`](design/grid-design-language.md) |
| Design tokens | The semantic CSS variables (`bg-background`, `text-muted-foreground`, …); components never hardcode a colour | [`frontends/ui/src/styles/tokens.css`](../frontends/ui/src/styles/tokens.css) |
| Card type scale | The six text steps a card may use (`card-eyebrow` to `card-headline`), held by `grid/card-type-scale` | [`docs/architecture/cards.md`](architecture/cards.md) |
| Atoms, domain atoms | The atomic-design layering: organisms compose atoms rather than raw Tailwind | [`frontends/ui/AGENTS.md`](../frontends/ui/AGENTS.md) |

## Working in the repo

| Term | Meaning | Defined in |
|---|---|---|
| `task` | go-task, the runner every repo command goes through; `task --list` is the live list | [`Taskfile.yml`](../Taskfile.yml) |
| `task verify` | The local merge gate; `verify:fast` skips the two production builds | [`docs/contributing/testing-and-verification.md`](contributing/testing-and-verification.md) |
| Definition of done | The bar for calling work done: observed evidence, summed up in a closing checklist in the PR | [`docs/contributing/definition-of-done.md`](contributing/definition-of-done.md) |
| Correction ratchet | After a correction, close the layer that let the error through, so a second occurrence is caught by machinery | [`docs/contributing/correction-ratchet.md`](contributing/correction-ratchet.md) |
| Gotchas register | Known failures indexed by the symptom you arrive with | [`docs/contributing/gotchas.md`](contributing/gotchas.md) |
| Answer suite | `task be:eval:answer-suite`: reference questions through the real agent, required before and after a change that shapes an answer | [`docs/contributing/testing-and-verification.md`](contributing/testing-and-verification.md) |
| Turn shapes | `task be:eval:turn-shapes`: the weekly live check that a greeting answers without searching and a commissioned report escalates to deep research (ADR-0052) | [`.github/workflows/turn-shapes-live.yml`](../.github/workflows/turn-shapes-live.yml) |
| Visual evidence | A change a user can see attaches a capture to its PR (never committed), shot from a `/dev/<name>` preview route | [`docs/ux/visual-screenshots.md`](ux/visual-screenshots.md) |
| AGENTS.md, CLAUDE.md bridge | Each area's guide is an `AGENTS.md`; a one-line `CLAUDE.md` beside it imports it for Claude | [`docs/contributing/agent-onboarding-files.md`](contributing/agent-onboarding-files.md) |
| Skill or document | A repo skill exists only for agent-specific procedure; anything a contributor needs too is a document | [`docs/contributing/agent-skills.md`](contributing/agent-skills.md) |
| apm, `apm.lock.yaml` | The agent package manager that installs third-party skills, and the lockfile that hashes them; `task agents:audit` fails on drift | [`docs/contributing/agent-skills.md`](contributing/agent-skills.md) |
| reno, release note | One YAML note per customer-visible change (`task release:note -- <slug>`), published to the changelog. The `no-release-note` label exempts a change nobody can notice | [`docs/contributing/release-notes.md`](contributing/release-notes.md) |
| oxlint, `grid/*` rules | The UI linter, and the repo's own rules it runs as a JS plugin (tenant scope, tenant cache key, motion vocabulary, card type scale, restricted syntax) | [`docs/contributing/lint-evaluation.md`](contributing/lint-evaluation.md) |

## CI

| Term | Meaning | Defined in |
|---|---|---|
| `CI OK` | The single required status check: passes only when every needed job passed or was skipped | [`docs/contributing/ci.md`](contributing/ci.md) |
| Plan | CI's first job: what the change touched, whether the tree was already tested, which images to build | [`docs/contributing/ci.md`](contributing/ci.md) |
| Tier | A path group in `.github/filters.yml` that gates a set of jobs. A skipped tier counts as passed | [`.github/filters.yml`](../.github/filters.yml) |
| Last green commit | The newest commit CI passed on a branch, which a push diffs against instead of the previous push | [`ci/last_green.py`](../ci/last_green.py) |
| Reuse marker | The artifact a green PR run leaves for the tree it tested, so the merge that lands that tree on a green parent skips its checks | [`ci/reuse_green_run.py`](../ci/reuse_green_run.py) |
| `inputs-<hash>` | An image's content tag: a hash of what its Dockerfile copies, plus the ISO week. Claims nothing about any commit | [`ci/image_inputs.py`](../ci/image_inputs.py) |
| `sha-<commit>` | The tag every image gets once every check on that commit's push passed; deploys pin to it | [`docs/contributing/ci.md`](contributing/ci.md) |
| Image pin | A third-party image referenced by digest in the Pulumi program (ADR-0029), scanned by trivy when added or moved | [`ci/pinned_images.py`](../ci/pinned_images.py) |
| Weekly checks | The scheduled workflows (security, links, turn shapes, WorkOS drift) for what turns red without a code change. A red run is a finding, not a blocked merge | [`docs/contributing/ci.md`](contributing/ci.md) |

## Deployment

| Term | Meaning | Defined in |
|---|---|---|
| Stack | A Pulumi stack: `dev` (staging) or `prod` (production), each configured by a committed `Pulumi.<stack>.yaml` | [`docs/deployment/cd.md`](deployment/cd.md) |
| ESC environment | The Pulumi ESC environment `grid-oib/<stack>` that holds a stack's secrets, imported by the stack file | [`deploy/pulumi/README.md`](../deploy/pulumi/README.md) |
| CrossGuard policy pack | The Pulumi policies a plan must pass before it is applied: rollout safety, resource bounds, image pulls | [`docs/deployment/cd.md`](deployment/cd.md) |
| `validate-crs` | The deploy gate that checks every custom resource in the plan against the upstream CRD schemas | [`deploy/pulumi/scripts/validate-crs.mjs`](../deploy/pulumi/scripts/validate-crs.mjs) |
| Promotion PR | The `develop` → `prod` pull request whose merge deploys production, behind the `production` environment's reviewers | [`docs/deployment/cd.md`](deployment/cd.md) |
| `imageTag` rollback | A manual deploy that pins all three services to an older `sha-<commit>`; any other deploy that would move a service backwards is refused | [`docs/deployment/cd.md`](deployment/cd.md) |
| `protectDataResources` | The stack flag that makes Pulumi refuse to delete or replace the database and object-store resources | [`deploy/pulumi/README.md`](../deploy/pulumi/README.md) |
| KEDA `ScaledObject` | The autoscaler that scales each queue worker tier on the depth of its Postgres queue | [`deploy/AGENTS.md`](../deploy/AGENTS.md) |
