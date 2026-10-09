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
> documents, project context and memory digests (e.g. OpenAI — the reference
> default — DeepSeek, Anthropic, Google, Meta, Mistral, xAI, Moonshot, …) therefore
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
| **Cloudflare** | Email Routing MX for `GRID_INBOUND_MAIL_DOMAIN` + an Email Worker; also the zone's DNS (host records unproxied) | Receives mail to project addresses and streams the raw message to the BFF webhook ([ADR-0075](../adr/0075-project-mail-inbox-via-cloudflare-email-routing.md)); DNS | **Yes, in transit**: the whole inbound mail (headers, body, attachments); no content stored (Cloudflare's statement); activity log keeps from, to, subject, Message-ID, auth verdicts ~30 days, operator-only | Only if the project mail inbox is configured AND the organization's `project-mail-inbox` flag is on (DNS: when the stack manages the zone) | `GRID_INBOUND_MAIL_DOMAIN`, `GRID_INBOUND_MAIL_TOKEN` | `deploy/pulumi/src/platform/inbound-mail.ts`; `frontends/ui/src/app/api/internal/inbound-mail/route.ts`; review: [`inbound-mail-review-2026-09.md`](inbound-mail-review-2026-09.md) |
| **Cloudflare Email Sending** (landing site) | `api.cloudflare.com/client/v4/accounts/{id}/email/sending/send`; Email Routing for `kontakt@<apex>` | The public site's contact form sends each message to the founders' verified addresses; `kontakt@` is forwarded to the same mailboxes ([ADR-0090](../adr/0090-contact-form-via-cloudflare-email-sending.md)) | **Yes, in transit**: the form's fields (name, email, office, message) and mail to `kontakt@`. Not stored on the site; "Email preview" would keep sent messages ~7 days and must be off (manual). Operator is controller | Only if `contactAddress` is set (Kubernetes only) | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_TOKEN`, `CONTACT_FORWARD_TO`, `CONTACT_FROM`, `CONTACT_FORM_SECRET` (web service) | `frontends/web/src/lib/contact.ts`; `deploy/pulumi/src/platform/contact-mail.ts`; review §8: [`inbound-mail-review-2026-09.md`](inbound-mail-review-2026-09.md) |
| **Tavily** | `api.tavily.com` | Primary web/news search | Search queries (LLM-derived from prompts); results flow back into prompts | Yes (all configs) | `TAVILY_API_KEY` | `sources/tavily_web_search/src/register.py:103-108` |
| **OpenAI direct** | `api.openai.com` | summary fallback only | Yes | Optional | `OPENAI_API_KEY` | `frontends/aiq_api/.../generate_summary.py:52-58` |
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
  Core: `nvidia-nat*==1.9.0`, `deepagents`, `langgraph-checkpoint-*`, `chromadb`,
  `llama-index`, `langchain-tavily`, `langchain-modal==0.0.5` (pre-alpha maturity).
  Outlook archives (ADR-0085): `libpff-python==20260926` (libyal, LGPL-3.0-or-later,
  a native extension used unmodified as a library from its manylinux wheel; the
  maintainer labels it alpha, and this is its first release with cp314 wheels)
  and `striprtf==0.0.33` (BSD-3, pure Python) for RTF bodies.
  Deliberate CVE floors + `override-dependencies` block (`pyproject.toml:214-227`).
- **Node:** `bun.lock` + `bun install --frozen-lockfile`; Next 16, `@workos-inc/*`,
  `@aws-sdk/client-s3`, `http-proxy` (old but latest), drizzle; for the project mail
  inbox `mailauth` (DKIM verification), `postal-mime` (MIME parsing) and `file-type`
  (sniffing nameless parts), each pinned to an exact version; security `overrides`
  for esbuild/postcss/uuid (Bun honours npm `overrides`). `frontends/ui/bunfig.toml`
  sets `minimumReleaseAge = 604800`: `bun install` and `bun add` resolve no version
  younger than 7 days. Bun is the installer and
  script runner only — Node remains the runtime for the app and the Next build.
  OSV-Scanner supports the text `bun.lock` format, so lockfile CVE scanning is
  unaffected by the switch (it does NOT support the binary `bun.lockb`, which
  this repo does not use).
- **CI controls:** Semgrep SAST (py+ts/js+actions) + weekly; OSV-Scanner lockfile
  CVEs over all seven lockfiles in the tree; gitleaks full history; Dependabot
  fix PRs. (GitHub dependency-review dropped: it needs GitHub Advanced Security
  on this private repo; OSV-Scanner + Dependabot cover new-dependency CVEs
  instead. The separate pip-audit / `bun audit` / `npm audit` job was dropped in
  Sep 2026: it covered three of the eight lockfiles the tree then had against
  advisory databases OSV already ingests — GHSA and PyPA — while taking longer
  than the whole rest of the workflow (9m53s with it, 2m36s without), and two of
  its three steps were silently reporting nothing. Rationale in
  [`security.yml`](../../.github/workflows/security.yml).) Gaps: Semgrep
  blocks only findings a pull request introduces (CI), and OSV-Scanner is
  advisory in the weekly
  [`.github/workflows/security.yml`](../../.github/workflows/security.yml); no clean-as-you-code
  smell gate (CodeQL + Sonar removed — code smells now via ruff/oxlint + coverage
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
8. Inbound project mail and the site's contact form transit Cloudflare (US,
   nearest data centre, no EU guarantee) under the DPF, whose Cloudflare entry
   read "Active – re-certification under review" on 2026-09-30. The "Email
   preview" setting, which would store sent content, is a manual dashboard
   setting nothing checks: it must stay off for `piloti.at` and the inbound
   domain must never be onboarded for sending. Review:
   [`inbound-mail-review-2026-09.md`](inbound-mail-review-2026-09.md).
