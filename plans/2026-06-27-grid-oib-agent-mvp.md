# Grid OIB Agent MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement each sub-plan. Execute the sub-plans in order: cleanup → backend → frontend. Do not pause for human confirmation between sub-plans.

**Goal:** Turn the NVIDIA AI-Q worktree into a clean, Grid-branded MVP that can answer Austrian building-regulation questions from a persistent OIB knowledge base plus existing web search, and render two proof-of-concept response cards (Summary, Legal Basis) in the Next.js UI.

**Architecture:**
- A persistent ChromaDB collection (`oib_knowledge`) is populated by an incremental folder-sync ingestion script and a manual `/v1/admin/oib/sync` API endpoint.
- A custom NAT tool (`oib_knowledge_search`) retrieves from that global collection, bypassing the per-session file-upload limit.
- A new workflow config (`configs/config_grid_oib.yml`) keeps the existing web search tools and adds the OIB source, and customizes `intent_classification.j2` for topic guardrails.
- The final response prompt is extended so the model can emit a `<grid_cards>` JSON payload; the Next.js UI parses and renders the two POC card components.

**Tech Stack:** Python 3.11, uv, NAT/NeMo Agent Toolkit, LlamaIndex + ChromaDB, NVIDIA embeddings, FastAPI, Next.js 16 + React + TypeScript + Tailwind.

---

## Sub-plans

1. [`2026-06-27-grid-oib-cleanup.md`](./2026-06-27-grid-oib-cleanup.md) — Strip NVIDIA template artifacts, keep runtime + frontends + agent dev files, rewrite README, update compose/config.
2. [`2026-06-27-grid-oib-backend.md`](./2026-06-27-grid-oib-backend.md) — Incremental OIB ingestion script, manual sync API route, custom `oib_knowledge_search` source package, Grid workflow config (with web search kept), topic guardrails.
3. [`2026-06-27-grid-oib-frontend.md`](./2026-06-27-grid-oib-frontend.md) — Remove NVIDIA branding, add Grid theme, parse `<grid_cards>` from agent responses, render SummaryCard and LegalBasisCard.

## Execution order

- Run cleanup first so the remaining sub-plans work in a clean tree.
- Run backend next; ingestion can be tested with `scripts/ingest_oib.py` and the sync endpoint.
- Run frontend last because it depends on the backend returning card payloads.
- Finish with the integration checks listed in each sub-plan, then update the root README and run `superpowers:finishing-a-development-branch`.
