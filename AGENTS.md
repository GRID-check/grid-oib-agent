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
| `MEMORY_REFLECTION_ENABLED` | Default `false`. Anonymous/non-WorkOS fallback that turns the async memory-reflection stage on. With WorkOS, the per-org `memory-reflection` feature flag controls it instead. Also requires `memory_reflection_llm` set in the workflow config. |
| `GRID_PROJECT_KNOWLEDGE_PAGE_ENABLED` | Default `false`. Non-enforced-flags fallback that shows the project-level "Knowledge" page (nav section + `/knowledge` route). With `GRID_ENFORCE_FEATURE_FLAGS=true`, the per-org `project-knowledge-page` WorkOS flag controls it instead. The platform owner's base-knowledge manager is independent of this. |
| `GRID_ADMIN_TOKEN` (frontend) | Now also required on the frontend service (must match aiq-agent): authenticates the platform-owner base-knowledge routes (`/api/platform/knowledge/*`) against the backend's `/v1/admin/oib/*` endpoints. |
| `OIB_UPLOADS_DIR` | Default `data/oib_uploads` (inside the persistent `aiq-data` volume). Writable home for base-corpus PDFs uploaded via the platform admin UI; scanned by OIB sync alongside the read-only repo corpus. aiq-agent service. |
| `FRONTEND_INTERNAL_URL` | Backend→frontend base URL on the compose network (default `http://frontend:3000`) |
| `MINIO_ENDPOINT` | Internal MinIO endpoint (backend-consumed presigns/uploads) |
| `MINIO_PUBLIC_ENDPOINT` | Browser-reachable MinIO endpoint for presigned preview/download URLs (dev default `http://localhost:9000`) |
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
| `GRID_WS_UPGRADE_RATE_LIMIT` | Default `30`. Max WebSocket upgrades per client IP per minute at the gateway (shared counter via Dragonfly). `0` disables. |
| `GRID_MAX_ACTIVE_JOBS` / `GRID_MAX_ACTIVE_JOBS_PER_ORG` | Defaults `8` / `3`. Admission control for async research jobs (global / per-org caps); beyond a cap, submits get 429 / a friendly chat message. `0` disables. Scheduled workflow runs (ADR-0023) go through the same caps; rejected occurrences are recorded as `skipped` runs. |
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

GRID has two distinct "knowledge" systems: **project knowledge** (the intake-wizard profile plus the agent-curated project/org memory, injected as WS headers `x-grid-project-context` and `x-grid-project-memory`; memory writes go through the token-guarded internal BFF endpoint so `grid_app` stays single-writer) and **RAG document knowledge** (MinIO uploads ingested into scoped collections via `/v1/ingest`). See `docs/architecture/backend-deep-dive.md` and `docs/architecture/project-memory-design.md`.

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

## Multi-agent feature playbook (obligation for agent-built features)

Substantial features (a new subsystem, several components, anything cross-service) built by AI agents MUST follow this phased process. It is how the Workflows feature (ADR-0023, PR #65) was built end-to-end; small fixes skip the ceremony, but the documentation obligations above always apply. Model tiering throughout: **exploration = mid-tier** (Sonnet-class, read-only, cheap to fan out), **implementation = high tier** (Opus-class), **architecture, orchestration, and reconciliation = the lead agent itself** (the most capable model in the session) — hard decisions are never delegated.

### Phase 0 — Parallel exploration (read-only)

- Before writing anything, fan out parallel **read-only** exploration subagents, one per relevant area (e.g. frontend conventions, backend infrastructure, docs/ADR conventions + backlog precedent).
- Each explorer returns a structured report with concrete file paths and code snippets of the exact patterns to copy. Explorers never edit.

### Phase 1 — Architecture and binding spec (lead agent, docs-first)

- The lead agent makes the architectural decisions itself and writes them down as an **ADR** (next number, from `docs/adr/0000-template.md`) plus a **subsystem doc in `docs/architecture/`** that doubles as the binding implementation contract: components table, data model, API contracts, env vars, cron/queue/algorithm semantics, testing expectations.
- Land the ADR + spec as a **docs-first commit** before any implementation (precedent: ADR-0021, ADR-0023). The spec — not inter-agent chatter — is where implementation agents get their interfaces.

### Phase 2 — Implementation waves (parallel, disjoint ownership)

- Launch implementation subagents in parallel waves. Non-negotiable rules:
  - **Strictly disjoint file ownership.** Every prompt lists the paths the agent owns AND an explicit "do NOT touch" list (other agents' trees, migrations, package manifests).
  - **Contracts come from the spec.** Every agent reads the ADR + subsystem doc first and codes against the documented contract; agents never negotiate interfaces with each other.
  - **Sequence only real dependencies.** Exactly one agent owns shared chokepoints (drizzle migrations + `_journal.json`, `package.json`); dependents launch after it lands. Everything else runs concurrently.
  - **Subagents never run git commands.** They leave changes in the working tree; the lead agent reviews, commits, and pushes.
  - **Require verification evidence.** Each agent reports the exact commands it ran with results, plus any deviation from the spec with justification. Claims without a tool result behind them don't count.

### Phase 3 — Multi-angle adversarial review

- Fan out independent review finders over the **full diff including untracked files** (`git add -A -N` first), one angle each: line-by-line scan, removed-behavior audit, cross-file contract tracing, reuse, simplification, efficiency, altitude (is each fix at the right depth, or a bandaid on shared infrastructure?), and conventions-vs-this-file.
- Finding is **recall-biased**: report everything with a nameable failure scenario; do not self-filter for severity — verification happens downstream. Fresh-context verification (a separate agent or the lead re-reading the code) beats self-critique.
- Dedupe, verify each candidate, fix what survives, and re-run the affected test suites before shipping.

### Phase 4 — Verify, document, ship

- Run the full verification matrix (see Verification workflow), and additionally apply DB migrations 0000→latest against a real Postgres when the change adds one.
- Complete every applicable row of the documentation-obligations table in the same change — including compose `environment:` wiring for every new env var (a documented-but-unwired var is a bug, not a docs gap).
- Conventional commits; PR against `develop` per the Git workflow below.

### Prompting subagents (from Anthropic's Claude Fable 5 prompting guidance)

- **Goal, constraints, and intent up front — not step-by-step scaffolding.** Over-prescriptive prompts reduce output quality on strong models; state what "done" looks like and the boundaries, give the full task spec in one well-specified prompt, and let the agent choose the steps.
- **Say why, not just what.** Agents connect the task to the right context when they know who the output is for and what it enables.
- **Explicit boundaries beat implied ones**: owned paths, forbidden paths, when to stop, and what to do when blocked (report, don't improvise around the spec).
- **Evidence-grounded reporting**: instruct agents to audit every progress claim against a tool result and report failures verbatim — never "should work".
- **Review prompts ask for coverage, not judgment**: "report every issue you find, including uncertain/low-severity ones, with confidence and severity" — a downstream verify step filters; conservative-reporting instructions silently destroy recall.

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
