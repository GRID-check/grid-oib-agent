# Grid Agent Contributor Guide

This repo is the Grid-branded AI-Q agent worktree. It contains a Next.js UI, a Python backend using the NeMo Agent Toolkit, and a custom OIB knowledge source.

This project is Docker-first. Run it via Docker Compose on Windows, macOS, or Linux; native commands are optional and mainly for local development outside the container stack.

## Repository layout

| Path | Purpose |
|------|---------|
| `.devcontainer/` | VS Code dev container configuration |
| `src/aiq_agent/` | Backend agent (LangGraph agents, cards, knowledge layer) |
| `sources/` | NAT data-source packages (web search, knowledge layer, grid cards) |
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

3. Trigger initial OIB ingestion:
   ```bash
   docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env exec aiq-agent python scripts/ingest_oib.py
   ```

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
| `GRID_ALLOW_AGENT_ORG_MEMORY` | Default `false`. When `true`, the internal memory endpoint accepts agent-authored **organization-scoped** writes. Default-deny protects against tenant-wide memory poisoning (audit finding S1); org-wide findings are otherwise a human-only action. |
| `MEMORY_REFLECTION_ENABLED` | Default `false`. Anonymous/non-WorkOS fallback that turns the async memory-reflection stage on. With WorkOS, the per-org `memory-reflection` feature flag controls it instead. Also requires `memory_reflection_llm` set in the workflow config. |
| `FRONTEND_INTERNAL_URL` | Backend→frontend base URL on the compose network (default `http://frontend:3000`) |
| `MINIO_ENDPOINT` | Internal MinIO endpoint (backend-consumed presigns/uploads) |
| `MINIO_PUBLIC_ENDPOINT` | Browser-reachable MinIO endpoint for presigned preview/download URLs (dev default `http://localhost:9000`) |
| `PROJECT_PURGE_GRACE_DAYS` | Grace period before soft-deleted projects are hard-purged |
| `GRID_BUDGET_EUR_PER_USD` | Default `0.86`. Euros per 1 USD for comparing EUR budget limits against the USD costs OpenRouter reports (ADR-0015). Frontend service. |
| `GRID_PLATFORM_OWNER_EMAILS` | Break-glass platform-owner bootstrap (comma-separated emails). Empty in steady state; the WorkOS `org-platform-owner` role is the source of truth (ADR-0016). |
| `GRID_PLATFORM_ORG_EXTERNAL_ID` | Default `grid-platform`. External id of the GRID Platform organization in WorkOS (ADR-0016). |
| `GRID_DISABLE_SELF_SERVE_ORGS` | Default `false`. `true` = invite-only platform: no self-service organization creation. |
| `GRID_ENFORCE_FEATURE_FLAGS` | Default `false`. `true` enforces WorkOS feature flags (registry: `frontends/ui/src/lib/authz/feature-flags.ts`) — flip only after provisioning the flags in WorkOS. |
| `OPENROUTER_API_KEY` (frontend) | Also passed to the frontend service now: authenticates the OpenRouter model-catalog fetch for the org model-config picker (ADR-0014). |
| `REDIS_URL` | Redis-protocol URL of the shared cache (Dragonfly service in compose, ADR-0020). Both services. Unset = per-process in-memory fallback — everything still works on a single replica. |
| `GRID_WS_UPGRADE_RATE_LIMIT` | Default `30`. Max WebSocket upgrades per client IP per minute at the gateway (shared counter via Dragonfly). `0` disables. |
| `GRID_MAX_ACTIVE_JOBS` / `GRID_MAX_ACTIVE_JOBS_PER_ORG` | Defaults `8` / `3`. Admission control for async research jobs (global / per-org caps); beyond a cap, submits get 429 / a friendly chat message. `0` disables. |

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
- Documentation obligations above apply to every change — treat stale docs as a bug.
- Git workflow above (feature-branch-per-feature, Conventional Commits, PR to
  `develop`) applies to every change.
