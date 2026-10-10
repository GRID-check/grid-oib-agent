# Glossary

The words this codebase uses that a newcomer would not know, each pointing at the
file that defines it. The domain language (organization, shelf, Herleitung,
Befund, Laufblock and the rest of what users and the product say) lives in
[`CONTEXT.md`](../CONTEXT.md), and this page does not repeat it.

When a term here and its defining file disagree, the file wins: fix this page in
the same change.

## Architecture and runtime

| Term | Meaning | Defined in |
|---|---|---|
| BFF | The Next.js server in `frontends/ui` (API routes plus the `server.js` WebSocket gateway). It owns identity, authorization, tenancy and the `grid_app` database; the Python agent is stateless and trusts what the BFF sends it | [`frontends/ui/AGENTS.md`](../frontends/ui/AGENTS.md) |
| NAT | NVIDIA NeMo Agent Toolkit, the framework the Python agent runs on. Tools register with `@register_function`, are discovered through a `nat.plugins` entry point, and agents are `_type` entries in `configs/*.yml` | [`src/aiq_agent/AGENTS.md`](../src/aiq_agent/AGENTS.md) |
| Signed request context | The `X-Grid-Request-Context` envelope the BFF mints for every agent request, HMAC-signed, carrying the scope, project context and memory the agent may use | [`frontends/ui/src/lib/request-context.ts`](../frontends/ui/src/lib/request-context.ts) |
| Workspace primitive, typed client | A workspace capability exposed as one HTTP API with a typed client, which the UI, the agent's tools and tasks all call as equal clients (ADR-0055) | [`docs/adr/0055-api-first-workspace-primitives.md`](adr/0055-api-first-workspace-primitives.md) |
| Route factories | `apiRoute`, `internalApiRoute`, `publicApiRoute`, `platformApiRoute`: the only sanctioned wrappers for a BFF route handler, each declaring its authorization | [`frontends/ui/src/lib/api/handler.ts`](../frontends/ui/src/lib/api/handler.ts) |
| `SourceKind` | The code form of a source kind (`baurecht`, `buero`, `projekt`, `web`, plus `messung` for model measurements). Defined in Python and mirrored by hand in `source-kinds.ts`; changing one and not the other renders the chip as unknown | [`src/aiq_agent/common/source_kinds.py`](../src/aiq_agent/common/source_kinds.py) |
| `doc_class`, norm lanes | The stored Dokumentart (human-set, beats any filename guess), and the finer `norm_registry` lanes (`baurecht_oib`, `baurecht_land`, …) that sub-label a source kind | [`src/aiq_agent/knowledge/document_classification.py`](../src/aiq_agent/knowledge/document_classification.py) |
| Answer envelope | The one JSON object a research answer is generated as: the `answer` prose plus optional anatomy (kind, verdict, takeaways, callout, cards) | [`src/aiq_agent/common/answer_envelope.py`](../src/aiq_agent/common/answer_envelope.py) |
| Grounding block | The single renderer for what an evidence tool returns: each hit becomes a `--- Result N ---` block with source, citation and score, and a `## Trace-Lanes` line names the collections searched | [`src/aiq_agent/common/grounding_block.py`](../src/aiq_agent/common/grounding_block.py) |
| Knowledge layer | The `sources/knowledge_layer` package (LlamaIndex over ChromaDB) behind `knowledge_search` | [`sources/AGENTS.md`](../sources/AGENTS.md) |
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
| err2issue | The path that turns ERROR-level logs into deduplicated GitHub issues (ADR-0031) | [`docs/adr/0031-err2issue-errors-to-github-issues.md`](adr/0031-err2issue-errors-to-github-issues.md) |

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
