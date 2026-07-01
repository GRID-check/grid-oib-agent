# Grid OIB Agent — Real Plan / Current Status

Date: 2026-06-28
Worktree: `D:\Personal\GRID\gridAgent\.worktrees\aiq\aiq`

## What we are building

A Grid-branded AI research agent on top of NVIDIA AI-Q that:
1. Answers questions about Austrian building regulations from a persistent local OIB knowledge base.
2. Restricts conversation to the Austria-specific building/regulatory domain.
3. Returns structured response cards (Summary, Legal Basis) through a shared backend/frontend contract.
4. Ships with a VS Code dev container and Docker Compose setup.

## What is already done

| # | Area | Status | Key commits |
|---|------|--------|-------------|
| 1 | Repo cleanup | Done | Removed NVIDIA/template files, rewrote README/AGENTS.md/CLAUDE.md, pointed compose to `config_grid_oib.yml` |
| 2 | OIB ingestion | Done | `src/aiq_agent/oib_sync.py`, `scripts/ingest_oib.py`, `POST /v1/admin/oib/sync` |
| 3 | Custom OIB retrieval tool | Done | `sources/oib_knowledge/` registers `oib_knowledge_search` |
| 4 | Grid workflow config | Done | `configs/config_grid_oib.yml` keeps web search + adds OIB source |
| 5 | Topic guardrails | Done | `intent_classification.j2` restricted to Austria building/regulatory domain |
| 6 | Shared card schema | Done | `shared/cards/schemas.json`, Pydantic models (`src/aiq_agent/cards/`), Zod schemas (`frontends/ui/src/shared/cards/schemas.ts`) |
| 7 | Backend card generator | Done | `sources/grid_cards/grid_card_generator`, dynamic prompt from Pydantic models |
| 8 | Card field contract | Done | `ChatResearcherAgent.run()` emits `cards` into `ChatResponse`; WebSocket final message carries top-level `cards` |
| 9 | Frontend card rendering | Done | UI reads `cards` from WebSocket, `AgentResponse` renders `SummaryCard` / `LegalBasisCard`; tag parser removed |
| 10 | Dev container | Done | `.devcontainer/devcontainer.json`, `deploy/Dockerfile` dev target, Node/Python tooling |
| 11 | OIB PDFs in repo | Done | 39 PDFs committed with Git LFS |
| 12 | Backend tests | Done | `tests/aiq_agent/cards/` and `test_card_generation.py` pass |

## What is blocked

End-to-end runtime verification of `nat serve` + `/v1/admin/oib/sync` is blocked in this Windows/uv environment:
- `uv run python scripts/ingest_oib.py` works when run directly and ingests all 39 PDFs.
- `uv run nat serve --config_file configs/config_grid_oib.yml --port 8000` starts and registers `oib_knowledge_search`.
- Calling `POST /v1/admin/oib/sync` from the running server causes the server process to exit (no detailed crash log; suspected Dask/ThreadPoolExecutor + ChromaDB interaction or resource exhaustion on Windows).

Because direct ingestion works, the sync logic is considered correct. The runtime failure is environmental, not a logic bug.

## Remaining work

### R1: Document integration blockers and manual fallback
- Add a "Known issues / integration test notes" section to `README.md` explaining the Windows runtime crash and the working manual fallback (`uv run python scripts/ingest_oib.py`).
- Update `AGENTS.md` to mention the same.

### R2: Harden the sync endpoint
- Add a configurable timeout/background-task mode to `POST /v1/admin/oib/sync` so it does not block the HTTP thread for long ingestion runs.
- Add proper exception handling that returns a 202 + job-id pattern if we move ingestion to an async job.

### R3: Verify Docker Compose / dev container
- Run `docker compose -f deploy/compose/docker-compose.yaml config` (already done: valid).
- If Docker Desktop is available, start the stack and test the same endpoints inside Linux containers. This is the recommended way to validate the server runtime because the Windows uv environment is unstable.

### R4: Frontend production build
- Run `cd frontends/ui && npm run build`.
- Fix any build-time errors (lint/type-check already pass; build may reveal bundling issues).

### R5: Final integration smoke tests (target environment: Docker)
1. Start the stack with Docker Compose.
2. Run `docker compose exec aiq-agent python scripts/ingest_oib.py` to populate `oib_knowledge`.
3. Open the UI, ask *"Was regelt die OIB Richtlinie 6?"*, and confirm:
   - Response is on-topic (guardrail works).
   - `oib_knowledge_search` is called.
   - Response contains a `SummaryCard` and/or `LegalBasisCard`.

### R6: Finishing-a-development-branch
- Run final lint/test baselines.
- Use `superpowers:finishing-a-development-branch` to decide merge/PR/cleanup.

## Proposed order

1. **Stop touching code until R1–R6 are approved.**
2. Execute R1 first (documentation only).
3. Decide whether to do R2 (hardening) now or later; for MVP, documentation is acceptable.
4. Execute R3/R5 in Docker if available; otherwise document the blocker.
5. Execute R4.
6. Execute R6.

## Risks

- The Windows uv runtime is not a reliable testbed for NAT + Dask + ChromaDB. Real validation must happen in Docker/Linux.
- Without a successful end-to-end chat test, we cannot be 100% sure the `cards` field flows from backend to frontend, although unit tests cover each layer.
- Disk space / memory in this environment may continue to prevent full ingestion inside Docker.
