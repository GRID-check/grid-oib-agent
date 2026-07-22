# Compliance Audit — GDPR/DSGVO · EU AI Act · EU Data Act · DORA

- **Date:** 2026-07-10 (repo tip `322ec65`)
- **Method:** four independent expert-persona code audits (data-protection officer,
  EU AI/Data Act counsel, DORA/ICT-resilience auditor, supply-chain auditor), each
  evidence-based against this repository, then consolidated. Best-effort analysis —
  **not legal advice**; have counsel review before relying on it.
- **Companion documents:** [`external-dependencies.md`](external-dependencies.md)
  (full third-party register + model-switching statement), the legal pages shipped at
  `frontends/ui/src/lib/legal/content/{de,en}.ts` (served at `/legal/*`).

## Executive summary

Grid is a **limited-risk AI system** under the AI Act (not high-risk, not a GPAI-model
provider), a **processor** under GDPR for customer-org content, and — since it is not a
financial entity — **not directly in scope of DORA** (but becomes an *ICT third-party
provider* the moment a DORA-regulated customer signs up). The architecture shows real
privacy-by-design substance (deletion pipeline with legal holds, audited privileged
actions, versioned model config, budget ledger, tenant isolation). The material gaps
cluster in five places:

1. **Third-country data flows with a dynamic recipient set.** All prompts, RAG excerpts
   of uploaded documents, and memory digests flow through OpenRouter (US) to whichever
   upstream model an org admin selects — with capability-only validation, no
   provider/region/data-policy allowlist, and no OpenRouter zero-data-retention pinning.
   This is simultaneously the top GDPR (Art. 44 ff/28), AI Act (provider responsibility),
   and DORA-benchmark (Art. 30 subcontracting) finding.
2. **Data-subject rights are only partially executable.** Only *project* purge is
   implemented end-to-end; document/conversation/organization/user purgers are stubs,
   conversation deletion leaks LangGraph checkpoints, and there is **no data export**
   (GDPR Art. 15/20; Data Act Arts. 23–31 switching/egress).
3. **Transparency surfaces were missing entirely** — no Impressum, privacy policy,
   terms, or AI-interaction notice (ECG §5, GDPR Art. 13, AI Act Art. 50 — applicable
   2026-08-02). *Addressed in this branch:* `/legal/*` pages + persistent chat AI
   disclosure; texts need operator identity + counsel review.
4. **Operational resilience:** no backups of Postgres/MinIO, no DR plan, no
   monitoring/alerting/incident process, single-host topology.
5. **Prompt hygiene:** chat prompts logged in cleartext at INFO; several
   telemetry integrations (LangSmith et al.) would exfiltrate full prompts if ever
   enabled by env var.

## 1. GDPR / DSGVO

Full persona report highlights (severity · finding · key evidence):

| Sev | Finding | Evidence |
|---|---|---|
| Crit | Third-country transfer of all prompts via OpenRouter; recipient set changes per org-admin click; no ZDR/provider pinning, no transfer safeguards documented | `configs/config_oib_openrouter.yml:52-56`; ADR-0014; no `provider.data_collection` anywhere |
| Crit | No privacy policy / Impressum / terms (Art. 12–14; ECG §5) | *(fixed in this branch — placeholders must be completed)* |
| Crit | Art. 15/17/20 not implemented for users: purgers for document/conversation/org/user are "later phases"; no export endpoint; no account deletion UI | `frontends/ui/purger/index.js:47-50`; `app/api/documents/[id]/` (no DELETE) |
| Crit | Conversation delete removes only DB rows; LangGraph checkpoints (full content) persist indefinitely | `lib/conversations/repository.ts:87-92`; `docs/architecture/deletion-pipeline.md` (self-acknowledged) |
| High | Chat prompts logged cleartext at INFO | `src/aiq_agent/agents/chat_researcher/register.py:518` |
| High | WorkOS EU data residency unverified (own ADR); audit events ship email + client IP + doc filenames to WorkOS; no DPA evidence | ADR-0002 Open Questions; `lib/audit/service.ts:56-93` |
| High | Document content flows to NVIDIA US API by config default (embeddings/VLM) | `sources/knowledge_layer/src/llamaindex/adapter.py:583-591` |
| High | `REQUIRE_AUTH=false` default (Art. 25(2) violation); anon mode has known cross-tenant memory-write gap (S3) | `deploy/.env.example`; `docs/architecture/memory-reflection-audit.md` |
| High | No retention limits for `messages`, `llm_usage_events` (deliberately survive purge, user-attributed), `project_memory`, checkpoints, WorkOS audit logs | schema comments in `lib/db/schema/budgets.ts` |
| Med | Memory reflection persists LLM distillates without PII filter (open finding S4); Tavily & co. receive prompt-derived queries undocumented; weak dev credentials/open ports in dev compose; optional tracing exfiltrates prompts; legal holds lack expiry/review | respective audit files |

Positive: legal-hold implementation (Art. 18) with per-step re-check in the purger,
audited hold lifecycle; HMAC-pseudonymized trace identity defaulting to `none`; no
analytics/tracking anywhere in the UI; encrypted session cookie; deletion queue as
erasure evidence (Art. 5(2)).

**Roles:** for customer-org content the operator is processor (Art. 28) — an AVV/DPA
template, records of processing (Art. 30), TOMs document, and a DPIA (LLM processing +
third-country transfers) are all still missing.

## 2. EU AI Act (Reg. 2024/1689)

**Classification:** Grid is an AI system (Art. 3(1)); the operator is a **provider of a
limited-risk AI system**, customers are deployers. No Annex III category matches
(users are private professionals, not judicial/public authorities; Grid is not a safety
component); the architect remains the decision-maker with cited primary sources. GPAI
Chapter V sits upstream (DeepSeek et al., OpenRouter) — **unless the operator ever
fine-tunes a model**. Customer model-swapping does *not* shift provider status: the
operator remains responsible for system behavior under **every selectable model**.

| Sev | Finding | Provision |
|---|---|---|
| High | No AI-interaction notice / output labeling in chat, cards, reports (deadline **2026-08-02**). LegalBasisCard shows *model-generated* "original text" styled as authoritative citation | Art. 50(1),(2) — *chat notice fixed in this branch; cards/reports + machine-readable marking still open* |
| High | Model switching validated for capability only — no allowlist, uncensored/`:free` models pass; prompt-level-only guardrails tuned to reference model | provider responsibility; ties to GDPR finding |
| Med | No AI-literacy material for users/admins/staff (applicable since 2025-02) | Art. 4 |
| Med | Model identity in ledger but not stamped on individual messages; `agent_group` unpopulated; ledger best-effort | traceability |
| Low | Human oversight genuinely good (plan approval, patch acceptance, citation verification, anti-fabrication rules, memory chips) — formalize as documentation | — |

Also flagged: Rechtsberatung edge (project-specific legal subsumption + authoritative
card styling + "never from unsourced generalities" marketing overclaim → UWG §2
exposure; soften to a verifiable claim), and re-assess if a Baubehörde ever becomes a
customer (Annex III pt. 8 re-analysis trigger).

## 3. EU Data Act (Reg. 2023/2854)

Grid is not a connected product (Ch. II n/a) but **is a "data processing service"**
(SaaS, Art. 2(8)) — switching/egress duties (Arts. 23–31) apply since 2025-09-12:
max-2-month notice, ≤30-day transition, exportable-data catalog, structured
machine-readable export, no switching charges from 2027. Primitives exist
(per-document download, per-conversation JSON, audit CSV, erasure pipeline) but
**bulk org/project export is missing** and the ToS must carry switching/exit clauses
(template section included in `/legal/terms`; clause completion needed).

## 4. DORA (Reg. 2022/2554) — benchmark & flow-down readiness

**Not directly applicable** (operator is not a financial entity). If a bank/insurer
becomes a customer, Art. 28–30 requirements flow down contractually. Readiness gaps,
by pillar:

- **Risk mgmt:** no backup/restore for Postgres/MinIO (**critical** — OIB corpus is
  reproducible, tenant data is not), no DR/BCP plan or RTO/RPO, single-host topology
  with acknowledged SPOFs (gateway, backend+embedded Chroma, Dask). Positives: health
  checks everywhere, admission control, WS rate limiting, budget enforcement.
- **Incidents:** no monitoring/alerting/status page/incident process; WorkOS audit
  trail + SIEM streaming is strong but fail-silent and third-party-hosted.
- **Testing:** CI security scanning comprehensive (Semgrep SAST, OSV-Scanner,
  gitleaks full-history, dependency-review blocking); Semgrep/OSV/pip-audit/npm-audit
  non-blocking (Phase 1); no load/chaos tests.
- **Third-party risk:** no vendor register (see companion register), OpenRouter
  concentration (one key = all LLM+embeddings+VLM; outage kills chat *and* knowledge
  search; retries-only, no circuit breaker), dynamic subcontractor chain via model
  switching (mitigations credited: gateway pinning, versioning, audit, per-request
  model record), exit strategy architecturally strong (ADR-0010 LLM-agnostic, portable
  stores) but procedurally absent; WorkOS is the hard lock-in (identity + FGA + audit
  history, no local mirror).

## 5. WorkOS as a compliance asset

Confirmed against the live WorkOS account (Staging + Production environments):
audit-log events with **CSV export** and **SIEM streaming** (Datadog, Splunk, S3, GCS,
Azure Sentinel, generic HTTPS), per-user **session revocation**, MFA policy +
factor reset, **user deletion**, RBAC/permissions, impersonation enable/disable,
feature flags (already used: `runtime-model-config`, `deep-research`,
`memory-reflection`), organization lifecycle APIs, domain verification, Radar
bot/fraud detection, Vault key settings. These directly support GDPR accountability
(Art. 5(2)/32) and DORA-style audit/access rights. Counterweights: EU residency and
audit retention must be contractually confirmed; the audit emitter is non-throwing
(silent loss possible); exporting the audit history is part of any WorkOS exit plan.

## 6. Prioritized remediation roadmap

1. **Model governance (top structural fix):** OpenRouter provider pinning
   (`provider: {data_collection: "deny"}`, optional region), operator-curated model
   allowlist per agent group (extend `AgentGroupRequirements`), picker warning +
   acknowledgment, list model providers as authorized sub-processors in the DPA.
2. **Erasure & export:** implement purger phases 2–5 (document/conversation/org/user),
   delete LangGraph checkpoints on conversation delete, build org/project bulk export
   (JSON + originals) — closes GDPR Art. 15/17/20 *and* Data Act Arts. 23–31.
3. **Transparency (deadline 2026-08-02):** complete `/legal/*` placeholders with real
   operator identity + counsel review; add AI-generated labels to LegalBasisCard and
   deep-research reports (incl. machine-readable marking + model id per Art. 50(2));
   AI-literacy guide linked from chat first-run and model-config page.
4. **Prompt hygiene:** remove prompt fulltext from INFO logs; define log retention;
   forbid `AIQ_TRACE_USER_IDENTITY_MODE=full` and LangSmith/W&B tracing in prod
   without a DPA.
5. **Contracts & records:** DPA/AVV template with sub-processor list, records of
   processing (Art. 30), TOMs, DPIA, breach process; confirm WorkOS DPA + residency;
   SCCs/TIA per upstream provider.
6. **Resilience:** pg_dump/WAL archiving + MinIO replication + tested restore runbook
   (RPO/RTO); monitoring/alerting on existing health endpoints; incident severity
   matrix with customer notification timelines (4h/24h/72h rhythm); make prod compose
   fail-fast on credentials, default `REQUIRE_AUTH=true` outside previews.
7. **Retention:** per-table retention policy (aggregate + pseudonymize usage ledger
   after N months; checkpoint TTL; WorkOS audit retention setting); legal-hold review
   dates.
8. **Hygiene:** pin `minio/mc`, SHA-pin GitHub Actions, make pip-audit/npm-audit
   blocking, remove vestigial `WANDB_API_KEY`/`JINA_API_KEY` slots, close
   memory-reflection S3/S4 findings.
