# External Dependency Register (externe Abhängigkeiten)

- **Date:** 2026-07-10 (repo tip `322ec65`); companion to
  [`compliance-audit-2026-07.md`](compliance-audit-2026-07.md).
- Feeds the public subprocessor page (`/legal/subprocessors`,
  `frontends/ui/src/lib/legal/content/{de,en}.ts`) — update both together.

## Statement on runtime AI-model switching (OpenRouter)

> **Grid's effective AI-model provider is dynamic, not fixed.** Organization admins
> can re-point each of the six agent groups (`intent`, `clarifier`,
> `shallow_research`, `deep_research`, `deep_research_router`, `memory_reflection`)
> at **any model in the OpenRouter public catalog at runtime** (ADR-0014). The
> upstream vendor that processes an organization's prompts, RAG excerpts of uploaded
> documents, project context and memory digests (e.g. DeepSeek — the reference
> default — OpenAI, Anthropic, Google, Meta, Mistral, xAI, Moonshot, …) therefore
> changes per organization, per admin action, without a release or operator
> involvement, and may be hosted outside the EU/EEA.
>
> **Bounded by design:** an override can never change `base_url` or the API key —
> all AI traffic always transits OpenRouter and only OpenRouter
> (`src/aiq_agent/common/model_overrides.py:25-31`); candidates are validated
> against the OpenRouter catalog server-side (422 on failure, 503 on catalog
> outage); every change is an immutable, author-attributed, one-click-reversible
> version with a catalog snapshot; changes emit the audit event
> `model_config.version.activated`; and the usage ledger records
> `requested_model`/`model` per generation, so which model actually served each
> answer is always reconstructible.
>
> **Not yet bounded:** there is no operator allowlist/denylist, no provider-region
> or data-policy (ZDR) constraint, and no notification mechanism — any legal
> document (DPA subprocessor annex, DORA Art. 30 flow-down, transfer-impact
> assessment) must therefore either name "OpenRouter plus all catalog upstream
> providers" or a tenant-scoped model allowlist must be built first
> (recommended — see roadmap item 1 in the audit).

## A. Runtime external services (data can leave the deployment)

| Service | Endpoint | Purpose | User content sent? | Required | Env var | Evidence |
|---|---|---|---|---|---|---|
| **OpenRouter** | `openrouter.ai/api/v1` | All LLM inference (6 agent groups), embeddings + VLM in prod config, model catalog for admin picker, summary generation | **Yes** — full prompts, chat history, project context/memory (via `x-grid-*` headers → prompt), RAG chunks of uploaded docs, web results; embeddings = raw chunk text; VLM = page images | Yes (reference config) | `OPENROUTER_API_KEY` (backend + frontend) | `configs/config_oib_openrouter.yml:51-150`; `lib/model-config/openrouter.ts` |
| **Upstream model providers** (via OpenRouter — dynamic) | varies | Actual inference of the org-selected model | Yes — OpenRouter forwards the full request | Implicit | none (runtime admin choice) | see statement above; `server.js:342` (`X-Grid-Model-Overrides`) |
| **WorkOS** | `api.workos.com` + hosted AuthKit | AuthN/AuthZ (SSO, MFA, RBAC, FGA), org lifecycle, feature flags, **entire audit trail** | Personal data: accounts, memberships, sessions; audit events carry actor email, client IP, user agent, doc filenames | Prod: yes (`REQUIRE_AUTH=true`) | `WORKOS_CLIENT_ID/API_KEY/COOKIE_PASSWORD` | `lib/audit/service.ts:57-62`; `lib/documents/service.ts:196-205` |
| **Tavily** | `api.tavily.com` | Primary web/news search | Search queries (LLM-derived from prompts); results flow back into prompts | Yes (all configs) | `TAVILY_API_KEY` | `sources/tavily_web_search/src/register.py:103-108` |
| **NVIDIA NIM** | `integrate.api.nvidia.com/v1` | Code-default embeddings + VLM captioning; LLMs in NIM configs | Doc chunk text, page images, prompts | Optional in prod (Coolify routes via OpenRouter) | `NVIDIA_API_KEY`, `AIQ_EMBED_*`, `AIQ_VLM_*` | `sources/knowledge_layer/src/llamaindex/adapter.py:76-78,583-591` |
| **Kimi/Moonshot** | `api.kimi.com/coding/v1` | LLM in unmaintained alt configs | Yes | Optional | `KIMI_API_KEY` | `configs/config_grid_oib.yml:32-68` |
| **OpenAI direct** | `api.openai.com` | `config_frontier_models.yml`; summary fallback | Yes | Optional | `OPENAI_API_KEY` | `frontends/aiq_api/.../generate_summary.py:52-58` |
| **Serper.dev / Exa / DuckDuckGo / Polymarket** | various | Optional search plugins | Prompt-derived queries | Optional | `SERPER_API_KEY`, `EXA_API_KEY`, none, none | `sources/*/src/register.py` |
| **Modal** | modal.com | Deep-research code sandbox (non-default config only; packages ship in prod image) | Agent-authored code + research-derived files | Optional | `MODAL_TOKEN_ID/SECRET` | `deepagents_runtime.py:244-366` |
| **LangSmith** | `api.smith.langchain.com` | Tracing — **one env var away**: lib is installed transitively; `LANGCHAIN_TRACING_V2=true` exports **full prompts/completions** | Yes if enabled | Optional, off | `LANGCHAIN_TRACING_V2`, `LANGCHAIN_API_KEY` | `.env.example`; `uv.lock` |
| **W&B / Jina** | — | Vestigial: env slots documented, **no code reads them** (`wandb` not even in lockfile) | No | Dead — remove | `WANDB_API_KEY`, `JINA_API_KEY` | negative code search |
| **OTLP/Phoenix exporter** | configurable | NAT span export incl. LLM I/O; **no shipped config enables it** (console only). Identity enrichment: `AIQ_TRACE_USER_IDENTITY_MODE=full` adds cleartext email/name to spans (default `none`) | If enabled | Optional, off | workflow YAML; `AIQ_TRACE_*` | `aiq_api/auth/middleware.py:59-89` |
| **Datadog RUM** | — | Frontend shim, no-ops unless deployment injects `DD_RUM` | If enabled | Optional, off | overlay | `shared/utils/rum.ts` |
| **Google Fonts** | fonts.googleapis.com | **Build-time only** (`next/font` self-hosts at runtime); Next telemetry disabled in image | No | Build only | — | `app/layout.tsx:13`; `deploy/Dockerfile:104,119` |
| **Build/CI**: PyPI, npm, Debian/nodesource, `nvcr.io`, GitHub Actions, Semgrep + gitleaks images (run in-CI, no source upload), OSV-Scanner (queries package names/versions against osv.dev) | — | provisioning/CI | Source code stays in CI; only dependency identifiers leave (OSV) | Build/CI | — | `.github/workflows/*` |

Backend agents fetch no arbitrary URLs themselves (only internal BFF call in
`cost_tracking.py:359-371`); web content arrives via search APIs.

## B. Self-hosted infrastructure

| Component | Image (pinning) | Data held |
|---|---|---|
| PostgreSQL | `postgres:16-alpine` (floating minor) | `grid_app` (projects, docs metadata, memory, usage ledger, model config), `aiq_jobs`, `aiq_checkpoints` (**full conversation/agent state**) |
| SeaweedFS | `chrislusf/seaweedfs:3.80` | Raw uploaded documents (`grid-documents`) |
| Chroma | embedded lib, volume `chroma_data` | Embeddings + chunk text (OIB corpus + user docs) |
| Dragonfly | `dragonflydb/dragonfly:v1.27.1` (pinned) | Transient cache, rate-limit counters (no persistence) |
| Frontend/purger | from `node:22-slim` (floating) | — |
| Backend | from `debian:bookworm-slim` (floating) | local OIB PDFs, fallback DBs |

## C. Software supply chain

- **Python:** uv workspace, `uv.lock` + `uv sync --frozen` in image (fully pinned).
  Core: `nvidia-nat*==1.7.0`, `deepagents`, `langgraph-checkpoint-*`, `chromadb`,
  `llama-index`, `langchain-tavily`, `langchain-modal==0.0.5` (pre-alpha maturity).
  Deliberate CVE floors + `override-dependencies` block (`pyproject.toml:214-227`).
- **Node:** `bun.lock` + `bun install --frozen-lockfile`; Next 16, `@workos-inc/*`,
  `@aws-sdk/client-s3`, `http-proxy` (old but latest), drizzle; security `overrides`
  for esbuild/postcss/uuid (Bun honours npm `overrides`). Bun is the installer and
  script runner only — Node remains the runtime for the app and the Next build.
  OSV-Scanner supports the text `bun.lock` format, so lockfile CVE scanning is
  unaffected by the switch (it does NOT support the binary `bun.lockb`, which
  this repo does not use).
- **CI controls:** Semgrep SAST (py+ts/js+actions) + weekly; OSV-Scanner lockfile
  CVEs; pip-audit + `bun audit`; gitleaks full history; detect-secrets baseline;
  Dependabot fix PRs. (GitHub dependency-review dropped: it needs GitHub Advanced
  Security on this private repo; OSV-Scanner + Dependabot cover new-dependency CVEs
  instead.) Gaps: Semgrep + OSV-Scanner and both dependency audits (pip-audit and
  `bun audit`) are currently non-blocking in
  [`.github/workflows/security.yml`](../../.github/workflows/security.yml)
  (Phase 1 — findings surface in the job log); no clean-as-you-code
  smell gate (CodeQL + Sonar removed — code smells now via ruff/eslint + coverage
  gate); actions tag-pinned not SHA-pinned (one `@main`); dev image pipes
  nodesource script to bash (dev only).

## Risk summary

1. Dynamic subprocessor set via model switching (see statement) — legal docs must
   reflect it or an allowlist must bound it.
2. Prompt-exfiltrating telemetry is one env var away (LangSmith) — forbid in prod
   without DPA.
3. PII in WorkOS beyond auth (email, IP, filenames in audit events; fail-silent
   emitter).
4. Concentration: one OpenRouter key = all inference + embeddings + VLM.
5. Unpinned/stale images (`chrislusf/seaweedfs:3.80`, floating bases), mutable CI action refs.
6. Vestigial secret slots (`WANDB_API_KEY`, `JINA_API_KEY`) mislead subprocessor
   lists — remove.
7. Uploaded document content leaves the deployment **by design** (embeddings/VLM/RAG
   to external providers); no local-embedding option exists in the repo.
