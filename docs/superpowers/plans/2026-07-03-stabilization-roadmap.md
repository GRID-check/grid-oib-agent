# GRID Stabilization Roadmap

**Goal:** MVP → stable, coherent product. Correctness first, structure second, visuals third.
**Verification policy:** all runtime verification happens in the Docker Compose stack, not on the host.

## Phase 0 — Land in-flight work ✅ (done 2026-07-03)

Five commits: ingestion hardening + parallel OIB sync, collection-scope alignment,
deploy/auth hardening, UI upload targeting, plan docs.

## Phase 1 — P0 correctness (in progress)

| # | Item | Status |
|---|------|--------|
| 1.1 | `AIQ_VLM_API_KEY=${OPENROUTER_API_KEY}` env_file interpolation bug (literal string reaches backend) | fixed in .env + defensive placeholder check in adapter |
| 1.2 | `/v1/ingest` only exists in the dead `src/aiq_agent/fastapi_extensions/` front-end, but the UI upload route calls it → **project file ingestion broken at runtime**. Port ingest route into `frontends/aiq_api` plugin, then delete `fastapi_extensions` entirely (its register.py is broken anyway — wrong call arity). | agent running |
| 1.3 | Docker stack: postgres container reports unhealthy → backend never starts | debugging |
| 1.4 | Escalation heuristic (`should_escalate`) only matches English phrases; product domain is German (OIB). Add German equivalents + prefer structured signal. | agent running |
| 1.5 | Dead duplicate `return graph.compile(...)` and `except (ImportError, Exception)` in chat_researcher | agent running |
| 1.6 | Secrets: live API keys in `deploy/.env` on developer disk — **user must rotate**; add stronger .gitignore note | flagged |
| 1.7 | Config drift: `config_grid_oib.yml` vs `config_oib_openrouter.yml` retrieval scopes differ; unify or document the delta | todo |
| 1.8 | Backend DBs (aiq_jobs/aiq_checkpoints) have no migration mechanism (init-db.sql runs only on first volume init) | todo |
| 1.9 | Verify OIB ingestion end-to-end in Docker (39–40 PDFs, 0 binary chunks, retrieval smoke test) — plan `2026-07-02-oib-ingestion-app-overhaul.md` Task 8 | blocked on 1.3 |

## Phase 2 — Structural debt

- Extract shared BFF proxy helper (auth header, backend URL, error envelope) used by chat/generate/respond/jobs/v1 routes; dedupe overview query (server component vs API route).
- Decide fate of dual chat transports (SSE `use-chat` vs WebSocket `use-websocket-chat`) — pick WS as primary, remove or quarantine legacy `/api/chat` + SSE path.
- Replace NAT monkeypatching risk: pin NAT version + add regression test around `websocket_reconnect`.
- Break up 1,000+-line zustand slices only where behavior demands it (don't churn).
- Global singletons/env-var coupling in knowledge factory — contain, document.

## Phase 3 — Frontend replatform (per product direction)

- Migrate KUI Foundations → shadcn/ui as the ONLY component library (big: KUI is behind `src/adapters/ui`, which makes swap feasible adapter-by-adapter).
- TanStack Form + Zod for all forms (intake wizard, project forms, onboarding).
- Design language: understated, premium, minimalist; no gradients/emojis; semantic tokens.
- Journey-first UX pass: onboarding → projects → intake → files → chat → deep research.

## Phase 4 — Landing page

After core UI is stable on shadcn.
