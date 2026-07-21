# Grid Agent Contributor Guide

This repo is the Grid-branded AI-Q agent worktree. It contains a Next.js UI, a Python backend using the NeMo Agent Toolkit, and a custom OIB knowledge source.

This project is Docker-first. Run it via Docker Compose on Windows, macOS, or Linux; native commands are optional and mainly for local development outside the container stack.

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
| `configs/` | Workflow configs. **LLM-agnostic** — any OpenAI-compatible endpoint (set `base_url`/`model_name`/key per config). **`config_oib_openrouter.yml` is the working reference config** (`config_grid_oib.yml`/Kimi is currently unmaintained) |
| `deploy/` | Docker Compose assets and environment templates |
| `docs/architecture/` | Architecture docs (see `backend-deep-dive.md`, `project-memory-design.md`) |
| `skills/` | API-consumer skill examples |
| `scripts/` | Utility scripts, including `scripts/ingest_oib.py` |
| `data/oib/` | OIB Richtlinien PDFs, tracked with Git LFS |

## Docker-first quick start

1. Copy the environment template and add your API keys:
   ```bash
   cp deploy/.env.example deploy/.env
   # edit deploy/.env with your LLM API keys (OpenRouter for the working config)
   ```

2. Build and start the full stack:
   ```bash
   docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env up -d --build
   ```

3. Initial OIB ingestion starts automatically in the background when the `aiq-agent` container boots (`deploy/entrypoint.py`). Watch its progress in the container logs:
   ```bash
   docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env logs -f aiq-agent
   ```
   To re-run ingestion manually (incremental — e.g. after adding PDFs to `data/oib/`):
   ```bash
   docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env exec aiq-agent python scripts/ingest_oib.py
   ```
   The same re-run can be triggered over HTTP via the admin-token-guarded `POST /v1/admin/oib/sync` endpoint.

4. Open the UI at http://localhost:3000.
   The backend API is available at http://localhost:8000.

VS Code users can also open the project in the dev container configured in `.devcontainer/`.

## Verification workflow

Host `npm install` is unreliable on this project — run frontend checks in Docker:

| Check | Command |
|-------|---------|
| Frontend typecheck + tests | `cd frontends/ui && docker build -f Dockerfile.typecheck -t grid-tsc . && docker run --rm grid-tsc` |
| Backend syntax | `.venv/Scripts/python.exe -m py_compile <files>` |
| Backend lint | `.venv/Scripts/ruff.exe check <files>` (and `ruff format --check`) |
| Backend tests | `.venv/Scripts/python.exe -m pytest tests/` |

Note: the UI tsconfig includes test files, so spec type errors block the production `next build`.

**Static analysis (SonarQube Cloud).** `sonar-project.properties` + `.github/workflows/sonar.yml` run Sonar on push/PR. It uses the **clean-as-you-code** gate: smells the repo already carries (notably the `PLR09xx` refactor rules ruff ignores — too-many-arguments/branches/statements) are reported on **new/changed** code only, so we pay the debt down incrementally rather than in a big-bang cleanup. The job is gated on a `SONAR_TOKEN` secret and is a no-op until an owner completes the one-time setup documented in `sonar-project.properties`.

## Environment variables

Secrets and deployment knobs live in environment variables only (`deploy/.env`). Beyond the LLM API keys, notable variables:

| Variable | Purpose |
|----------|---------|
| `GRID_INTERNAL_API_TOKEN` | Shared token for the internal BFF API (e.g. `POST /api/internal/memory`). Must match between the frontend and aiq-agent services. **Never ship the dev default.** |
| `GRID_DB_POOL_MAX` | Default `10`. Upper bound on PostgreSQL connections the Next.js BFF pool holds open. Bounds resource use so connection acquisition fails fast under load rather than piling requests up behind a saturated/unreachable database. Invalid/non-positive values fall back to `10`. |
| `GRID_ALLOW_AGENT_ORG_MEMORY` | Default `false`. When `true`, the internal memory endpoint accepts agent-authored **organization-scoped** writes. Default-deny protects against tenant-wide memory poisoning (audit finding S1); org-wide findings are otherwise a human-only action. |
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
| `OPENROUTER_API_KEY` (frontend) | Also passed to the frontend service now: authenticates the OpenRouter model-catalog fetch for the org model-config picker (ADR-0014). |
| `REDIS_URL` | Redis-protocol URL of the shared cache (Dragonfly service in compose, ADR-0020). Both services. Unset = per-process in-memory fallback — everything still works on a single replica. |
| `GRID_NORMS_DIR` | Default `configs/norms`. YAML seed root of the flat norm catalog (ADR-0025 v2, `configs/norms/<country>/registry.yml`): verified RIS pointers + curated prose legal notes, consumed by the `ris_search` short-circuit, `ris_catalog_lookup`, and the researcher prompt block. The admin store (summary DB, platform UI) supersedes the YAML at runtime; fail-open on missing/invalid. Backend (aiq-agent) service. |
| `GRID_RIS_CACHE_TTL_DAYS` | Default `7`. Days a fetched RIS full text (and a live `ris_search` result) is kept in the shared Dragonfly/Redis cache (`aiq_agent.common.cache`, ADR-0020) and served without re-hitting the RIS API — cutting repeated OGD-RIS + planner-LLM spend across turns, replicas, and restarts. Cache-only/fail-open: a miss or cache error just does a live fetch. `0`/invalid falls back to `7`. Backend (aiq-agent) service. |
| `GRID_WS_UPGRADE_RATE_LIMIT` | Default `30`. Max WebSocket upgrades per client IP per minute at the gateway (shared counter via Dragonfly). `0` disables. |
| `GRID_MAX_ACTIVE_JOBS` / `GRID_MAX_ACTIVE_JOBS_PER_ORG` | Defaults `8` / `3`. Admission control for async research jobs (global / per-org caps); beyond a cap, submits get 429 / a friendly chat message. `0` disables. Scheduled workflow runs (ADR-0023) go through the same caps; rejected occurrences are recorded as `skipped` runs. |
| `GRID_MAX_RUN_COMPLETION_TOKENS` | Default `0` (disabled). Per-run completion (output) token ceiling for `deep_research_agent` jobs, enforced across every LLM call in the run including concurrent researcher workers (`BudgetGuardCallback`, `src/aiq_agent/common/budget_guard.py`, backlog T4-4). Exceeding it fails the job with an explicit budget-exceeded message instead of a generic internal error. Independent of the USD budget ledger (`GRID_BUDGET_EUR_PER_USD` etc.). Backend (aiq-agent) service. |
| `AIQ_DEEP_CHECKPOINT_DB` | Default unset = durability OFF (strictly opt-in; a default-on relative path crashed container startup on read-only workdirs — post-#72 hotfix, unopenable values now fail open with a warning). Optional SQLite path or Postgres DSN for durable per-job LangGraph checkpointing of async deep-research runs (`thread_id = job_id`, `durability="async"`, backlog T3-8). A worker crash no longer silently loses execution state, but resume today is manual-resubmit-based, not automatic — resubmitting a duplicate `job_id` still errors; see `docs/architecture/backend-deep-dive.md` §9. Mirrors the existing `AIQ_CHECKPOINT_DB` pattern for the sync chat graph. Backend (aiq-agent) service. |
| `GRID_WORKFLOWS_ENABLED` | Default `false`. Dark-launch gate for the Workflows feature (per-project scheduled deep research, ADR-0023): shows the Workflows tab + BFF routes while `GRID_ENFORCE_FEATURE_FLAGS` is off, and gates the `workflow-scheduler` worker's start. With enforcement on, the per-org `workflows` WorkOS flag controls the UI/API instead. Frontend + workflow-scheduler services. |
| `GRID_WORKFLOW_SCHEDULER_POLL_MS` / `GRID_WORKFLOW_SCHEDULER_BATCH` / `GRID_WORKFLOW_RUNS_RETENTION_DAYS` | Defaults `30000` / `20` / `90`. Workflow-scheduler knobs: tick interval, max due schedules claimed per tick (`FOR UPDATE SKIP LOCKED`), and run-history retention. workflow-scheduler service. |
| `GRID_WORKFLOW_MIN_INTERVAL_MINUTES` | Default `15`. Minimum cron cadence accepted when saving a workflow schedule (validated in the BFF). Frontend service. |
| Unified LLM credential resolution | The bespoke (non-NAT) LLM call sites — VLM (`AIQ_VLM_API_KEY`), embeddings (`AIQ_EMBED_API_KEY`), the backfill script, and the two BFF routes below — resolve through one shared helper (`aiq_agent.common.credential_resolution.resolve_llm_credential`). Order: org BYOK (when an org id is supplied — swaps key + base URL only, never the model) → explicit key env → fallback envs → **provider inference** (the conventional key env for the resolved base URL host: `openrouter.ai`→`OPENROUTER_API_KEY`, `integrate.api.nvidia.com`→`NVIDIA_API_KEY`, `api.openai.com`→`OPENAI_API_KEY`). All env reads treat a literal `${...}` placeholder as unset. BYOK is not wired for embeddings/VLM (ingestion is org-agnostic today — known follow-up). |
| `AIQ_VLM_API_KEY` / `AIQ_EMBED_API_KEY` | Explicit VLM / embeddings key overrides. Each resolves via the shared helper: explicit → `NVIDIA_API_KEY` fallback → provider inference from `AIQ_VLM_BASE_URL` / `AIQ_EMBED_BASE_URL`. `AIQ_VLM_API_KEY` is the single source of truth both image ingestion and the `vlm_available` capability bit consult. Provider inference never changes the base URL (embeddings need an embeddings-capable endpoint). Backend (aiq-agent) service. |
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
- Documentation obligations above apply to every change — treat stale docs as a bug.
- Git workflow above (feature-branch-per-feature, Conventional Commits, PR to
  `develop`) applies to every change.
