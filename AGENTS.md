# Grid Agent Contributor Guide

This repo is the Grid-branded AI-Q agent worktree. It contains a Next.js UI, a Python backend using the NeMo Agent Toolkit, and a custom OIB knowledge source.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch/commit/PR-title conventions, local validation steps, the CI merge gate, and secret-scanning + doc-link hygiene.

## Working style: prefer visuals

The maintainer values visual explanations. When explaining architecture, data
flows, deployment topology, sequence/interaction, or any non-trivial design,
render a diagram with the **Excalidraw** tool (`create_view`) rather than
describing it in prose alone. Keep diagrams structured: a clear layered/left-to
-right flow, aligned grid, orthogonal arrows that don't cross boxes, and a short
legend. Offer a diagram proactively for architecture/design discussions.

## Repository layout

| Path | Purpose |
|------|---------|
| `.devcontainer/` | VS Code dev container configuration |
| `src/aiq_agent/` | Backend agent (LangGraph agents, cards, knowledge layer) |
| `sources/` | NAT data-source packages (web search, knowledge layer, RIS adapter, grid cards) |
| `frontends/ui/` | Next.js app: UI + BFF API routes + WS proxy (`server.js`) |
| `frontends/aiq_api/` | The backend FastAPI front-end plugin (`_type: aiq_api`): REST routes, async jobs, `/v1/ingest` |
| `frontends/debug/` | Debug console mounted at `/debug` |
| `frontends/cli/` | `aiq-research` CLI |
| `frontends/benchmarks/` | Evaluation harnesses |
| `configs/` | Workflow configs. **LLM-agnostic** — any OpenAI-compatible endpoint (set `base_url`/key per config). **`config_oib_openrouter.yml` is the working reference config** (`config_grid_oib.yml`/Kimi is currently unmaintained). The `model_name` values are only the **boot fallback**: the live default per agent group is admin-controlled (Platform → Models, `platform_model_defaults`) and a tenant may override it (Organization → Models) — see `docs/architecture/org-model-configuration.md`. Do not edit the YAML to move the fleet to a new model. |
| `deploy/` | Docker Compose assets and environment templates; `deploy/pulumi/` holds the Pulumi (TypeScript) Kubernetes deployment (see `docs/deployment/kubernetes.md`) |
| `docs/architecture/` | Architecture docs (see `backend-deep-dive.md`, `project-memory-design.md`, `citation-system-audit-2026-07.md` for the citation pipeline as built) |
| `skills/` | API-consumer skill examples |
| `scripts/` | Utility scripts, including `scripts/ingest_oib.py` |
| `data/oib/` | OIB Richtlinien PDFs, tracked with Git LFS |

## Verification workflow

Host-native checks are the default; Docker is not required. Every command lives
in the root `Taskfile.yml` and is run with [go-task](https://taskfile.dev)
(`npm i -g @go-task/cli`), from the repo root, on any OS:

| Check | Command |
|-------|---------|
| **Everything CI runs** (repo lint + `be:verify` + `fe:verify` + `infra:types`) | `task verify` |
| The same set, minus only the slow production build | `task verify:fast` |
| First-time toolchain setup | `task setup` |
| Frontend typecheck | `task fe:types` |
| Frontend tests | `task fe:test` |
| Frontend lint / build | `task fe:lint` / `task fe:build` |
| Backend lint (ruff check + format) | `task be:lint` |
| Backend tests | `task be:test` (plugin suite: `task be:test:api`) |
| Infra typecheck (Pulumi + policy pack) | `task infra:types` |
| Repo lint (pre-commit, all files) | `task lint:repo` |
| UI screenshot evidence | `task fe:screenshots [-- <id>]` → PNGs in `frontends/ui/visual/screenshots/` |
| WorkOS authz drift | `WORKOS_API_KEY=sk_… task fe:provision:authz` (read-only; `-- --apply` reconciles) |

`task --list` is the full, always-current list. CI calls these same tasks
(`.github/workflows/ci.yml`), so `task verify` passing locally means the merge
gate passes — there is no second copy of the commands to drift out of sync.

The tasks also absorb two things that used to have to be remembered: the venv
lives in `.venv/Scripts` on Windows and `.venv/bin` elsewhere, and **backend
tests need `PYTHONPATH=src`** (otherwise pytest resolves `aiq_agent` from
whatever the venv has installed — possibly another worktree — and validates the
wrong code while appearing to pass). Both are set in `Taskfile.yml`; if you
bypass the tasks and call `pytest` directly, you own them again.

Note: the UI tsconfig includes test files, so spec type errors block the production `next build`.

**Visual screenshots (UI evidence).** User-visible UI changes are "done" only
with a committed screenshot. This repo has a reproducible harness: a registry
(`frontends/ui/visual/registry.mjs`) of `/dev/*` preview routes that render real
components with fixture data (no backend), captured in light + dark by
`task fe:screenshots`. When you build a user-visible surface, add a `/dev/<name>`
preview route + a registry target and commit the resulting PNGs. The
`visual-coverage` workflow nudges (comment-only, phase 1) when a PR adds a
component without that evidence — opt out non-visual components with a
`// no-visual: <reason>` marker. Full playbook
(dark-mode `.dark` class, module-scope fetch shims, pre-installed Chromium):
**`docs/ux/visual-screenshots.md`**.

**Security & static analysis (free, runs entirely in CI).** `.github/workflows/security.yml` runs on push/PR + weekly: **Semgrep** (SAST for Python/TS/JS/Actions — replaces CodeQL and Sonar's security rules), **OSV-Scanner** (dependency CVEs from lockfiles — replaces Sonar SCA), **pip-audit + npm audit**, **gitleaks** (secret scan, full history), and **trivy** (`image-scan` job: blocks on **fixable** HIGH/CRITICAL findings — it runs with `--ignore-unfixed` — in the digest-pinned observability images from `deploy/pulumi/src/config.ts`; findings inside those upstream images that no digest bump can clear go in `.trivyignore.yaml` as time-boxed exceptions with a justification and an `expired_at`, never by loosening the gate). No GitHub Advanced Security licence or SonarQube Cloud subscription needed. Semgrep and OSV-Scanner are currently non-blocking (Phase 1: findings in the job log while noise is tuned via `.semgrepignore` / `.gitleaks.toml`); drop their `continue-on-error` to make them required checks. **Dependabot** (`.github/dependabot.yml`) opens the dependency fix PRs. Code smells / maintainability are covered by the native linters and the coverage gate in `ci.yml` (ruff, eslint, `--cov-fail-under`); note this drops Sonar's **clean-as-you-code** gate, so the `PLR09xx` refactor rules ruff ignores (too-many-arguments/branches/statements) are no longer reported on new code.

## Authorization (RBAC)

The access model is **permission-driven, never role-name driven** (ADR-0016,
ADR-0038). Three things to know before touching it:

1. **`frontends/ui/src/lib/authz/catalog.ts` is the source of truth** for every
   resource type, permission and role. The app derives its permission types from
   it and `bun run provision:authz` applies it to WorkOS, so the code and the
   identity provider cannot drift apart. Add a permission there first.
2. **Every `app/api` route must declare how it is authorized.** `apiRoute` does
   not compile without an `authz` option — `{ permission }` (factory-checked),
   `{ enforcedBy }` (the service authorizes; name the function), or
   `{ sessionOnly, why }`. `src/app/api/authz-coverage.spec.ts` fails when a
   handler escapes the factories entirely.
3. **`lib/authz/decide.ts` is the single decision point** across the org,
   platform, project and workflow tiers. Every decision carries the named rule
   that produced it, so bypasses (`org-admin-bypass`, `platform-membership`) are
   visible rather than implicit.

Resource topology is `Organization → Project → Workflow`; Organization is the
immutable WorkOS root. Provisioning runbook:
[`docs/deployment/workos-provisioning.md`](docs/deployment/workos-provisioning.md).

## Environment variables

Secrets and deployment knobs live in environment variables only (`deploy/.env`). Beyond the LLM API keys, notable variables:

| Variable | Purpose |
|----------|---------|
| `GRID_INTERNAL_API_TOKEN` | Shared token for the internal BFF API (e.g. `POST /api/internal/memory`). Must match between the frontend and aiq-agent services. **Never ship the dev default.** |
| `GRID_DB_POOL_MAX` | Default `10`. Upper bound on PostgreSQL connections the Next.js BFF pool holds open. Bounds resource use so connection acquisition fails fast under load rather than piling requests up behind a saturated/unreachable database. Invalid/non-positive values fall back to `10`. |
| `GRID_ALLOW_AGENT_ORG_MEMORY` | Default `false`. When `true`, the internal memory endpoint accepts agent-authored **organization-scoped** writes. Default-deny protects against tenant-wide memory poisoning (audit finding S1); org-wide findings are otherwise a human-only action. |
| `GRID_MEMORY_REFLECTION_ENABLED` | Default `true`. Non-enforced-flags fallback that gates the post-answer **memory-reflection** stage (the agent's cross-chat learning loop). With `GRID_ENFORCE_FEATURE_FLAGS=true`, the per-org `memory-reflection` WorkOS flag controls it instead (fail-closed, including org-less sessions); without enforcement it defaults ON, anonymous sessions included. Reflection is a shipped core capability, not a dark-launched product gate. Frontend service; on Kubernetes set via the Pulumi stack key `grid-oib:memoryReflectionEnabled` (default `true`); see `docs/architecture/project-memory-design.md` §3.5. |
| `GRID_PROJECT_KNOWLEDGE_PAGE_ENABLED` | Default `false`. Non-enforced-flags fallback that shows the project-level "Knowledge" page (nav section + `/knowledge` route). With `GRID_ENFORCE_FEATURE_FLAGS=true`, the per-org `project-knowledge-page` WorkOS flag controls it instead. The platform owner's base-knowledge manager is independent of this. |
| `GRID_ADMIN_TOKEN` (frontend) | Now also required on the frontend service (must match aiq-agent): authenticates the platform-owner base-knowledge routes (`/api/platform/knowledge/*`) against the backend's `/v1/admin/oib/*` endpoints. |
| `OIB_UPLOADS_DIR` | Default `data/oib_uploads` (inside the persistent `aiq-data` volume). Writable home for base-corpus PDFs uploaded via the platform admin UI; scanned by OIB sync alongside the read-only repo corpus. aiq-agent service. |
| `FRONTEND_INTERNAL_URL` | Backend→frontend base URL on the compose network (default `http://frontend:3000`) |
| `SEAWEED_ENDPOINT` | Internal SeaweedFS endpoint (backend-consumed presigns/uploads) |
| `SEAWEED_PUBLIC_ENDPOINT` | Browser-reachable SeaweedFS endpoint for presigned preview/download URLs (dev default `http://localhost:8333`) |
| `PROJECT_PURGE_GRACE_DAYS` | Grace period before soft-deleted projects are hard-purged |
| `GRID_BUDGET_EUR_PER_USD` | Default `0.86`. Euros per 1 USD for comparing EUR budget limits against the USD costs OpenRouter reports (ADR-0015). Frontend service. |
| `GRID_PLATFORM_OWNER_EMAILS` | Break-glass platform-owner bootstrap (comma-separated emails). Empty in steady state; the WorkOS `org-platform-owner` role is the source of truth (ADR-0016). |
| `GRID_PLATFORM_ORG_EXTERNAL_ID` | Default `grid-platform`. External id of the GRID Platform organization in WorkOS (ADR-0016). |
| `GRID_DISABLE_SELF_SERVE_ORGS` | Default `false`. `true` = invite-only platform: no self-service organization creation. |
| `GRID_ENFORCE_FEATURE_FLAGS` | Default `false`. `true` enforces WorkOS feature flags (registry: `frontends/ui/src/lib/authz/feature-flags.ts`) — flip only after provisioning the flags in WorkOS. |
| `GRID_BYOK_SECRET_BACKEND` | BYOK key store (ADR-0022): `vault` (WorkOS Vault, default when `WORKOS_API_KEY` is set) or `local` (AES-256-GCM under `GRID_BYOK_LOCAL_KEK`). Frontend service. |
| `GRID_BYOK_LOCAL_KEK` | 32-byte base64 KEK for the `local` BYOK backend (`openssl rand -base64 32`). Frontend service. |
| `GRID_BYOK_ALLOW_PRIVATE_BASE_URLS` | Default `false`. `true` lets org admins point BYOK base URLs at private-network hosts (self-hosted OpenAI-compatible gateways). |
| `OPENROUTER_API_KEY` (frontend) | Also passed to the frontend service now: authenticates the OpenRouter model-catalog fetch for the model-config pickers, platform and org alike (ADR-0014). |
| `GRID_DEFAULT_MODEL` | Boot-fallback model id for every `llms:` entry in `config_oib_openrouter.yml` (default `deepseek/deepseek-v4-flash`). Only applies where no platform default and no org override exist — i.e. a fresh install or a deployment running without the BFF. Changing the fleet's model is a save under Platform → Models, not this variable. Backend (aiq-agent) service. |
| `REDIS_URL` | Redis-protocol URL of the shared cache (Dragonfly service in compose, ADR-0020). Both services. Unset = per-process in-memory fallback — everything still works on a single replica. |
| `GRID_NORMS_DIR` | Default `configs/norms`. YAML seed root of the flat norm catalog (ADR-0025 v2, `configs/norms/<country>/registry.yml`): verified RIS pointers + curated prose legal notes, consumed by the `ris_search` short-circuit, `ris_catalog_lookup`, and the researcher prompt block. The admin store (summary DB, platform UI) supersedes the YAML at runtime; fail-open on missing/invalid. Backend (aiq-agent) service. |
| `GRID_RIS_CACHE_TTL_DAYS` | Default `7`. Days a fetched RIS full text (and a live `ris_search` result) is kept in the shared Dragonfly/Redis cache (`aiq_agent.common.cache`, ADR-0020) and served without re-hitting the RIS API — cutting repeated OGD-RIS + planner-LLM spend across turns, replicas, and restarts. Cache-only/fail-open: a miss or cache error just does a live fetch. `0`/invalid falls back to `7`. Backend (aiq-agent) service. |
| `GRID_CITATION_EVENTS_ENABLED` | Default `true`. Emits one citation-health batch per research turn to the internal BFF endpoint `POST /api/internal/citation-events`, which backs the platform dashboard's **Citation health** surface (clean rate, defect mix, removal reasons, missing-source candidates, the derived action list, and the JSON diagnostic export). Best-effort and off the answer path: emission runs on a daemon thread and never raises. Set to `false` to disable. Backend (aiq-agent) service. |
| `GRID_WS_UPGRADE_RATE_LIMIT` | Default `30`. Max WebSocket upgrades per client IP per minute at the gateway (shared counter via Dragonfly). `0` disables. |
| `GRID_SHUTDOWN_DRAIN_MS` | Default `2000`. Frontend gateway shutdown drain: after SIGTERM, `server.js` fails readiness, refuses new WS upgrades, and keeps serving in-flight requests/streams for this long before forcing exit. The Kubernetes deployment sets 30s and sizes `terminationGracePeriodSeconds` above it so rolling updates don't drop live chat (`deploy/pulumi/src/platform/rollout.ts`). Frontend service. |
| `GRID_MAX_ACTIVE_JOBS` / `GRID_MAX_ACTIVE_JOBS_PER_ORG` | Defaults `8` / `3`. Admission control for async research jobs (global / per-org caps); beyond a cap, submits get 429 / a friendly chat message. `0` disables. Scheduled workflow runs (ADR-0023) go through the same caps; rejected occurrences are recorded as `skipped` runs. |
| `GRID_MAX_RUN_COMPLETION_TOKENS` | Default `0` (disabled). Per-run completion (output) token ceiling for `deep_research_agent` jobs, enforced across every LLM call in the run including concurrent researcher workers (`BudgetGuardCallback`, `src/aiq_agent/common/budget_guard.py`, backlog T4-4). Exceeding it fails the job with an explicit budget-exceeded message instead of a generic internal error. Independent of the USD budget ledger (`GRID_BUDGET_EUR_PER_USD` etc.). Backend (aiq-agent) service. |
| `GRID_RESEARCHER_RECURSION_LIMIT` | Default `100`. Per-worker step cap for single-query researcher runnables (source: `RESEARCHER_RECURSION_LIMIT` in `tools/research.py`). A stuck researcher is caught by the `GraphRecursionError` → terminal `ResearcherExhaustedError` path instead of by the wall-clock kill. Backend (aiq-agent) service. |
| `GRID_WRITER_CHAR_BUDGET` | Default `200000`. Total-character ceiling for the writer's tool-result context (`ToolResultPruningMiddleware.total_char_budget`). Oversized tool results within the keep-last-N window are monotonically truncated when their sum exceeds this budget, preventing unbounded growth. Backend (aiq-agent) service. |
| `GRID_MAX_QUERY_SUBMISSIONS` | Default `3`. Maximum number of times the same query digest can be re-submitted before it is returned as a terminal unresearchable gap. Backend (aiq-agent) service. |
| `AIQ_DEEP_CHECKPOINT_DB` | Default unset = durability OFF (strictly opt-in; a default-on relative path crashed container startup on read-only workdirs — post-#72 hotfix, unopenable values now fail open with a warning). Optional SQLite path or Postgres DSN for durable per-job LangGraph checkpointing of async deep-research runs (`thread_id = job_id`, `durability="async"`, backlog T3-8). A worker crash no longer silently loses execution state, but resume today is manual-resubmit-based, not automatic — resubmitting a duplicate `job_id` still errors; see `docs/architecture/backend-deep-dive.md` §9. Mirrors the existing `AIQ_CHECKPOINT_DB` pattern for the sync chat graph. Backend (aiq-agent) service. |
| `OTEL_SERVICE_NAME` / `OTEL_EXPORTER_OTLP_ENDPOINT` | Kubernetes-only, Pulumi-injected (ADR-0029): per-tier `service.name` (`grid-ui` / `grid-aiq-agent` / `grid-agent-worker`) plus the OTLP collector endpoint. Python tiers get the FULL path (`http://otel-collector:4318/v1/traces` — the NAT exporter posts as-is); the frontend gets the BASE URL (JS exporter appends `/v1/traces` per spec). Unset → frontend `src/instrumentation.ts` no-ops. Producers hold no ingestion key — it lives in the Kubernetes Secret `aspire-dashboard-secrets`, referenced only by the OTel Collector and the Aspire dashboard (cluster's single ingestion point; `docs/deployment/kubernetes.md` §9). |
| `GRID_COLLABORATION_ENABLED` | Default `false`. Dark-launch gate for collaboration (ADR-0032…0035: shared chats, `@`-mentions with the agent hand-off, the inbox). Shows the inbox nav entry + page, the share surfaces and the mention picker, and enables the `/api/inbox/*`, `/api/sharing/*`, `/api/mentions/*` and `/api/stream` routes while `GRID_ENFORCE_FEATURE_FLAGS` is off; with enforcement on, the per-org `collaboration` WorkOS flag controls them. Unlike an ordinary flag this is **default-deny rather than fail-open** — the feature changes who can see conversations, so an operator must choose it. No paired capability var: without `REDIS_URL` live updates degrade to polling, so there is no infrastructure dependency to derive one from. Frontend service. |
| `GRID_WORKFLOWS_ENABLED` | Default `false`. Dark-launch gate for the Workflows feature (per-project scheduled deep research, ADR-0023): shows the Workflows tab + BFF routes while `GRID_ENFORCE_FEATURE_FLAGS` is off, and gates the `workflow-scheduler` worker's start. With enforcement on, the per-org `workflows` WorkOS flag controls the UI/API instead. Frontend + workflow-scheduler services. |
| `GRID_WORKFLOW_SCHEDULER_POLL_MS` / `GRID_WORKFLOW_SCHEDULER_BATCH` / `GRID_WORKFLOW_RUNS_RETENTION_DAYS` | Defaults `30000` / `20` / `90`. Workflow-scheduler knobs: tick interval, max due schedules claimed per tick (`FOR UPDATE SKIP LOCKED`), and run-history retention. workflow-scheduler service. |
| `GRID_WORKFLOW_MIN_INTERVAL_MINUTES` | Default `15`. Minimum cron cadence accepted when saving a workflow schedule (validated in the BFF). Frontend service. |
| Unified LLM credential resolution | The bespoke (non-NAT) LLM call sites — VLM (`AIQ_VLM_API_KEY`), embeddings (`AIQ_EMBED_API_KEY`), the backfill script, and the two BFF routes below — resolve through one shared helper (`aiq_agent.common.credential_resolution.resolve_llm_credential`). Order: org BYOK (when an org id is supplied — swaps key + base URL only, never the model) → explicit key env → fallback envs → **provider inference** (the conventional key env for the resolved base URL host: `openrouter.ai`→`OPENROUTER_API_KEY`, `integrate.api.nvidia.com`→`NVIDIA_API_KEY`, `api.openai.com`→`OPENAI_API_KEY`). All env reads treat a literal `${...}` placeholder as unset. **VLM ingestion now reaches BYOK + runtime model override** — `/v1/ingest` forwards `x-grid-organization-id` into the (detached) ingest thread's job config, so per-project/Archiv uploads resolve the org's BYOK vision key + base URL (`resolve_vlm_credential(org_id)`) and its `ingest_vlm` model override (`AgentGroup.INGEST_VLM`); org-agnostic base-corpus sync passes no org id and gets the deployment default. Embeddings BYOK is still a follow-up (needs an embeddings-capable BYOK endpoint). |
| `AIQ_VLM_API_KEY` / `AIQ_EMBED_API_KEY` | Explicit VLM / embeddings key overrides. Each resolves via the shared helper: explicit → `NVIDIA_API_KEY` fallback → provider inference from `AIQ_VLM_BASE_URL` / `AIQ_EMBED_BASE_URL`. `AIQ_VLM_API_KEY` is the single source of truth both image ingestion and the `vlm_available` capability bit consult. Provider inference never changes the base URL (embeddings need an embeddings-capable endpoint). Backend (aiq-agent) service. |
| `AIQ_VLM_BATCH_WORKERS` / `AIQ_VLM_TIMEOUT_SECONDS` / `AIQ_EMBED_BATCH_SIZE` | Defaults `4` / `180` / `64`. Ingestion-pipeline tuning knobs: concurrent VLM caption calls per file in `enrich_vlm_batch`; per-request timeout on the VLM OpenAI client (single retry — SDK defaults let a hung provider park an ingest worker ~20 min); texts per embedding HTTP call (llama-index default 10 serialized ~50 round-trips for a 500-chunk document). The VLM caption cache key is model-scoped (`vlm:caption:{model}:{prompt_type}:{sha256}`), and failed VLM analyses (exception or placeholder caption) are skipped rather than indexed as content-free chunks — and never cached, so a re-ingest retries them instead of replaying the failure for the 30-day TTL. Backend (aiq-agent) service. |
| `AIQ_RENDER_VISUAL_PAGES` (+ `AIQ_PAGE_RENDER_MAX_DIM`, `AIQ_VISUAL_PAGE_MIN_TEXT_CHARS`, `AIQ_VISUAL_PAGE_MIN_PATHS`, `AIQ_MAX_RENDERED_PAGES`) | Default `true`. Renders **text-sparse / vector-heavy PDF pages** to a full-page image (long edge ≈`AIQ_PAGE_RENDER_MAX_DIM`, default `2048`px) and VLM-captions them with a drawing-aware German prompt, so vector CAD/architectural drawings (plans, sections, elevations, perspectives) — which carry almost no extractable text and no embedded raster image, and which text + image extraction therefore miss entirely — are captured with their drawing type, scale and spatial relationships. A page is "visual" when its watermark-stripped text is below `AIQ_VISUAL_PAGE_MIN_TEXT_CHARS` (default `200`) OR it has ≥`AIQ_VISUAL_PAGE_MIN_PATHS` (default `300`) vector paths; at most `AIQ_MAX_RENDERED_PAGES` (default `20`) pages are rendered per document. Effective only when a VLM key resolves; text PDFs skip it (zero extra cost). For such drawing PDFs the rendered-page description also feeds the document summary, so the summary describes the drawing instead of a licence watermark (e.g. "VECTORWORKS EDUCATIONAL VERSION"). Backend (aiq-agent) service. |
| `CONSISTENCY_LLM_MODEL` / `CONSISTENCY_LLM_API_KEY` / `CONSISTENCY_LLM_BASE_URL` / `SUMMARY_LLM_*` | LLMs for the end-of-wizard free-text consistency-check (`POST /v1/consistency-check`) and AI project-summary (`POST /v1/generate-summary`) endpoints. Both resolve the key through the shared helper and reach org **BYOK**: the BFF (`profile-service`) forwards `x-grid-organization-id` on these POSTs, the routes pass it to the resolver, so a tenant's own key + base URL are used when configured (fail-open to the env chain: `CONSISTENCY_LLM_*`/`SUMMARY_LLM_*` → `LLM_*` → `OPENROUTER_API_KEY`/provider inference). Model/base URL keep their two-level env fallback; BYOK never changes the model. Best-effort: no key resolvable → `error=llm_not_configured` (HTTP 200) and the wizard saves anyway. Backend (aiq-agent) service. |
| `BACKFILL_SUMMARY_API_KEY` / `BACKFILL_SUMMARY_BASE_URL` / `BACKFILL_SUMMARY_MODEL` | Credentials for the one-off `scripts/backfill_document_tags.py` tagging LLM (runs outside the NAT runtime, so it builds an OpenAI-compatible client from env via the shared resolver). `BACKFILL_SUMMARY_API_KEY` falls back to `NVIDIA_API_KEY`, then provider inference from `BACKFILL_SUMMARY_BASE_URL`; none resolvable → the script exits `2`. `BACKFILL_SUMMARY_BASE_URL` default `https://integrate.api.nvidia.com/v1`; `BACKFILL_SUMMARY_MODEL` default `nvidia/nemotron-mini-4b-instruct`. BYOK N/A (runs outside NAT). Must match the config's `summary_llm` block. |

## BFF architecture (obligation)

The Next.js BFF follows a **repository/service architecture** (ADR-0017,
`docs/architecture/bff-service-architecture.md`). **Every future service and
every change to an existing endpoint MUST follow it** — this is not optional:

- **Routes** (`frontends/ui/src/app/api/**/route.ts`) are thin transport
  adapters declared via the factories in `@/lib/api/handler` (`apiRoute`,
  `internalApiRoute`, `publicApiRoute`). No bare `export async function GET`,
  no drizzle/`getDb()` imports, no hand-rolled error responses in routes.
- **Services** (`frontends/ui/src/lib/<domain>/service.ts`) own business
  logic and authorization (tenancy + `requireProjectAccess`/permission
  checks) and throw typed errors from `@/lib/api/errors`.
- **Repositories** (`frontends/ui/src/lib/<domain>/repository.ts`) are the
  only modules that query the DB for their domain; `organizationId` scoping
  lives in the SQL WHERE clause and every list query is bounded.
- Every endpoint is authenticated through a factory; `publicApiRoute` is for
  health checks only and anything else needs an ADR.

The projects domain (`lib/projects/repository.ts`, `lib/projects/service.ts`,
`app/api/projects/**`) is the reference implementation.

## Cards — interactive cards must persist the user's answer (obligation)

Cards are the agent's rich-UI presentation layer (ADR-0012,
`docs/architecture/cards.md`). Most are pure presentation, but a card with a
button that **writes something** — today `project_profile_patch` (applies a JSON
Patch to the project brief) and `memory_proposal` (writes an org/project memory
row) — is a different kind of object. Those cards follow *propose, never
auto-apply*, so the user's click is the only place that authorization exists.

**Never hold that outcome in component-local `useState`.** The card *payload*
persists (localStorage and `messages.metadata.cards`), so a lost decision means
the card returns after a reload looking untouched, with a live button that
applies the patch or writes the memory **a second time** — neither endpoint is
idempotent. The decision is conversation history and belongs on the
`ChatMessage`, exactly like `isPromptResponded` does for a HITL prompt:
`ChatMessage.cardInteractions`, keyed by `cardKey(card, index)`, read and
written through `useCardDecision`. Rationale and full contract: **ADR-0030**.

Adding a card type? You must classify it in `CARD_INTERACTIVITY`
(`frontends/ui/src/features/grid-cards/card-decision.ts`) — the map is
exhaustive over the generated union, so `task fe:types` fails until you do.
Classify it `'interactive'` if answering it starts a commitment that is not
safely repeatable; opening a read-only preview is not one. Two further guards
back this up: `card-interactivity.spec.tsx` (an interactive card must actually
reach the store) and `tests/aiq_agent/cards/test_interactive_card_parity.py`
(the backend `INTERACTIVE_CARD_TYPES` must agree with the frontend map). Full
checklist for a new card type: `docs/architecture/cards.md`.

## Knowledge systems

GRID has two distinct "knowledge" systems: **project knowledge** (the intake-wizard profile plus the agent-curated project/org memory, injected as WS headers `x-grid-project-context` and `x-grid-project-memory`; memory writes go through the token-guarded internal BFF endpoint so `grid_app` stays single-writer) and **RAG document knowledge** (SeaweedFS uploads ingested into scoped collections via `/v1/ingest`). See `docs/architecture/backend-deep-dive.md` and `docs/architecture/project-memory-design.md`.

**Project profile — one surface, one editor.** The project profile (facts like
building class, use, location) has a single editor: the **intake wizard**. The
project **Settings** page *displays* it read-only via the `ProjectBrief` card
(facts, summary, assumptions, open gaps) and links to the wizard to change it —
do **not** add a second parameters form or inline field-editing on Settings.
The facts are interdependent (they drive which OIB standards apply), so edits
must run through the wizard's guided, consistency-checked flow. Rationale:
`docs/design/click-dummy-overhaul-spec.md` §9.1.

RAG document knowledge has **three tiers**, all sharing one pipeline (SeaweedFS → `/v1/ingest` → per-collection retrieval): the platform-owner **base corpus** (`oib_knowledge`, org-agnostic, always in scope); per-**project** documents (`proj_<uuid>`, in scope for that project only); and the org-wide **Archiv** (ADR-0024, `archiv_<orgId>`, `scope='archiv'` rows in the `documents` table, injected into every project's scope for that org). The Archiv reuses the project document machinery (`lib/documents/*`) wholesale — only the authorization scope differs (org-level `org:archiv:manage` for writes; any member reads). See `lib/archiv/*`, `/api/archiv/*`, and `computeCollectionScope`.

**Source-kind model (obligation).** Every source the agent surfaces — OIB corpus, RIS live law, Büroarchiv, Projektwissen, web — is classified into **one coarse `SourceKind`** (`baurecht | buero | projekt | web`) that drives *all* rendering: the "Belegt durch" chips, the Herleitung fan-out, and the report sources section. The taxonomy is defined once in `src/aiq_agent/common/source_kinds.py` (backend) and mirrored in `frontends/ui/src/features/chat/lib/source-kinds.ts` (frontend); the fine `norm_registry.lane_for_hit` lanes (OIB-Richtlinie, Bundesrecht, …) are the *sub-label within* a kind, not a competing taxonomy. **The OIB corpus and RIS are the same kind (`baurecht`)** — do not add per-surface kind mappings or a second source taxonomy. Rationale and rollout: ADR-0026. This unifies the two knowledge planes at the presentation/doctrine layer while keeping them as separate stores (Chroma corpus for semantic retrieval, the norm registry for authoritative live law — ADR-0025).

**Document classification (`doc_class` / "Dokumentart").** What a base-corpus document *is* (OIB-Richtlinie verbindlich, OIB-Leitfaden/Erläuterung, Norm, Gesetz, Sonstiges) is an **explicit, human-set fact**, not a filename guess. The vocabulary lives in `src/aiq_agent/knowledge/document_classification.py` (`DOCUMENT_CLASSES`/`DOCUMENT_CLASS_LANES`) mirrored in `frontends/ui/src/lib/knowledge/doc-class.ts` (parity-tested); it is stored on `summaries.doc_class`, pre-filled at ingest from `norm_registry.guess_doc_class(filename)`, and **preferred over the filename/collection heuristic everywhere** — `lane_for_hit(doc_class=…)`, the citation `SourceKind`, and the `Dokumentart:` line the LLM reads. Retrieval is **store-authoritative** for `doc_class` (chunk metadata is a fallback), so reclassifying reflects immediately with no re-ingest. Platform owners manage it in the base-knowledge admin panel (`app/app/platform/base-knowledge.tsx`): PDF/ZIP upload (non-blocking, status-polled), a pre-filled Dokumentart dropdown per document (`PATCH /v1/admin/oib/documents/{file}/doc-class`), and a binding-OIB-vs-other split.

## Documentation is part of the work (obligation)

Updating documentation is **not optional and not a follow-up** — it is part of the same change that alters behavior. When you (human or agent) do any of the following, you MUST update the relevant docs in the SAME change, before it is considered done:

| You changed… | Update… |
|---|---|
| Architecture, a data flow, a subsystem, or a cross-cutting mechanism | `docs/architecture/backend-deep-dive.md` (and the specific subsystem doc) |
| A significant/hard-to-reverse decision (new subsystem, transport, storage, provider model, security boundary) | add an **ADR** under `docs/adr/` (copy `0000-template.md`, next number) |
| An env var, config key, or default | this file's Environment-variables table + `docs/deployment/environment-variables.md` |
| An API route, WS message, or tool contract | `docs/api/*` |
| A DB schema / migration | `docs/database/*` |
| User-facing behavior | the relevant `docs/user-guides/*` |
| Setup, containers, or the run/verify flow | `README.md` + the Quick-start / Verification sections here |

Rules of thumb: prefer updating an existing doc over adding a new one; delete docs that a change makes wrong rather than leaving them stale; keep the `docs/architecture/` deep-dives and the ADR log as the source of truth. If a change is significant enough to explain in a PR, it is significant enough to document in the repo.

## Git workflow (branching & commits)

- **One feature, one branch.** Each distinct feature/fix gets its **own branch cut
  from `develop`** (e.g. `feature/rich-ui-cards`, `fix/research-403`). Do **not**
  keep piling unrelated work onto an existing feature branch that already has an
  open PR — that makes the PR unreviewable and couples unrelated changes.
- **Merge target is `develop`.** Open the PR against `develop`; `develop` is the
  integration branch. Only release promotes `develop` onward.
- If new work genuinely depends on an unmerged branch, **stack** the new branch on
  it (branch from that tip) and note the dependency in the PR — but prefer branching
  from `develop` whenever the work is independent.
- **Conventional Commits** (`type(scope): summary`), imperative, small and
  independently revertible — one logical change per commit. Reference the ADR/issue
  when relevant.
- Never commit secrets. Branch before committing if you're on `develop`/`main`.

## Conventions

- Python: ruff, line length 120, Python 3.11.
- New tools use `@register_function` and a `FunctionBaseConfig` subclass.
- Secrets live in environment variables only.
- Capability doctrine: feature flags are **product decisions**, environment
  variables are **real infrastructure dependencies**, a **capability** is
  DERIVED from a dependency (never a second flag), and a feature's
  **availability = flag AND capability**. Example: image upload = the
  `image-upload` flag AND `vlm_available` (derived from the VLM key) — do not
  add a redundant env opt-in for something the dependency already implies.
- **Raw `sql<T>` results are not runtime-validated — coerce at the repository
  boundary.** Drizzle only decodes column values for direct column references;
  a raw `sql<Date>\`max(...)\`` / `sql<number>\`count(...)\`` fragment is a
  *compile-time assertion only*, so `tsc` and the LSP see no error even when the
  driver returns a string. Convert on the way out of the repository (e.g.
  `new Date(row.x)`, `Number(row.x)`) — never trust the annotation downstream.
  A missing coercion here caused the profiler `toISOString is not a function`
  crash; the fix and the `totalDurationMsRaw` sibling are the reference pattern.
- **`any` is not a type we accept — in production code or in tests.**
  `@typescript-eslint/no-explicit-any` is an **error** (not a warning) in
  `frontends/ui/eslint.config.mjs`, and the suite is clean. Reach for the real
  type, a `Partial<T>`/`Pick<T, …>` of it, `unknown`, or a deliberate
  `as unknown as T` at a single documented boundary. For spec fixtures use
  `@/test-utils/store-fixtures` (`DeepPartial<TState>` + `asStoreState` for
  zustand selector mocks — the fixture stays partial but every field is still
  checked against the real store) and `@/test-utils/db-fixtures`
  (`makeProject` / `makeDocument` / `makeMemoryItem` for whole repository rows,
  `asDb` for the one drizzle query-builder-stub boundary).
  `any` in a test double is how fixtures silently drift from the code they
  stand in for. `no-console` allows `warn`/`error`/`debug`; `console.debug` is
  the dev-only diagnostic channel and its call sites are `NODE_ENV`-gated.
- Documentation obligations above apply to every change — treat stale docs as a bug.
- **Fix errors you find — never dismiss them as "pre-existing."** If, while
  working, you identify a bug, a failing/broken test, or wrong behavior — even
  one that pre-dates your change — fix it. "It was already broken" is not a
  reason to leave it broken. If a fix is genuinely out of scope, flag it loudly
  and explicitly (in the PR/log), never silently wave it away.
- **Question necessity, then simplify — "the best part is no part."** START every
  task by asking why the thing must exist at all and whether existing machinery
  already covers it — the cheapest code is the code you don't write. FINISH every
  task with a skeptical review that tries to DELETE: remove parts, collapse
  layers, reuse instead of add, cut complexity — while keeping the feature set
  intact (reduce complexity, never features). Reducing complexity is part of
  "done," not a follow-up. When work is finished, a senior-skeptic review pass
  (its own sub-agent) that challenges necessity and hunts deletions is expected.
- Git workflow above (feature-branch-per-feature, Conventional Commits, PR to
  `develop`) applies to every change.
