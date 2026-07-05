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

## Environment variables

Secrets and deployment knobs live in environment variables only (`deploy/.env`). Beyond the LLM API keys, notable variables:

| Variable | Purpose |
|----------|---------|
| `GRID_INTERNAL_API_TOKEN` | Shared token for the internal BFF API (e.g. `POST /api/internal/memory`). Must match between the frontend and aiq-agent services. **Never ship the dev default.** |
| `FRONTEND_INTERNAL_URL` | Backend→frontend base URL on the compose network (default `http://frontend:3000`) |
| `MINIO_ENDPOINT` | Internal MinIO endpoint (backend-consumed presigns/uploads) |
| `MINIO_PUBLIC_ENDPOINT` | Browser-reachable MinIO endpoint for presigned preview/download URLs (dev default `http://localhost:9000`) |
| `PROJECT_PURGE_GRACE_DAYS` | Grace period before soft-deleted projects are hard-purged |

## Knowledge systems

GRID has two distinct "knowledge" systems: **project knowledge** (the intake-wizard profile plus the agent-curated project/org memory, injected as WS headers `x-grid-project-context` and `x-grid-project-memory`; memory writes go through the token-guarded internal BFF endpoint so `grid_app` stays single-writer) and **RAG document knowledge** (MinIO uploads ingested into scoped collections via `/v1/ingest`). See `docs/architecture/backend-deep-dive.md` and `docs/architecture/project-memory-design.md`.

## Conventions

- Python: ruff, line length 120, Python 3.11.
- New tools use `@register_function` and a `FunctionBaseConfig` subclass.
- Secrets live in environment variables only.
