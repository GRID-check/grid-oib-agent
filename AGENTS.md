# Grid Agent Contributor Guide

This repo is the Grid-branded AI-Q agent worktree. It contains a Next.js UI, a Python backend using the NeMo Agent Toolkit, and a custom OIB knowledge source.

This project is Docker-first. Run it via Docker Compose on Windows, macOS, or Linux; native commands are optional and mainly for local development outside the container stack.

## Repository layout

| Path | Purpose |
|------|---------|
| `.devcontainer/` | VS Code dev container configuration |
| `src/aiq_agent/` | Backend agent, FastAPI extensions, knowledge layer |
| `sources/` | NAT data-source packages (web search, knowledge layer, grid cards) |
| `frontends/ui/` | Next.js chat UI |
| `frontends/debug/` | Debug console mounted at `/debug` |
| `frontends/cli/` | `aiq-research` CLI |
| `frontends/benchmarks/` | Evaluation harnesses |
| `frontends/aiq_api/` | Python API client library |
| `configs/` | Workflow configs, including `config_grid_oib.yml` (default) |
| `deploy/` | Docker Compose assets and environment templates |
| `skills/` | API-consumer skill examples |
| `scripts/` | Utility scripts, including `scripts/ingest_oib.py` |
| `data/oib/` | OIB Richtlinien PDFs, tracked with Git LFS |

## Docker-first quick start

1. Copy the environment template and add your API keys:
   ```bash
   cp deploy/.env.example deploy/.env
   # edit deploy/.env with KIMI_API_KEY and NVIDIA_API_KEY
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

## Backend commands

Use these only for local development outside Docker:

```bash
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

## Frontend commands

Use these only for local development outside Docker:

```bash
cd frontends/ui
npm install
npm run lint
npm run type-check
npm run test:ci
npm run dev
```

## Conventions

- Python: ruff, line length 120, Python 3.11.
- New tools use `@register_function` and a `FunctionBaseConfig` subclass.
- Secrets live in environment variables only.
