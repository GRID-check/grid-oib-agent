---
status: accepted
date: 2026-09-30
decision-makers: product owner, Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Zero data retention is the default, enforced at one OpenRouter seam

## Context and Problem Statement

[ADR-0014](0014-org-runtime-model-configuration.md) gave an organization a
Zero-Data-Retention switch: when on, OpenRouter routes its requests only to
endpoints that keep neither prompt nor response (`provider.zdr: true`,
`data_collection: deny`). An audit on 2026-09-30 found the switch honoured on
the chat answer and almost nowhere else. Each call site applied it by hand, and
most never learned to:

- the async job worker, which runs every deep-research job and scheduled research, never applied it;
- embeddings (every document chunk and every query), the cross-encoder and the LLM judge (the
  question plus sixty passages per search), drawing captions and page OCR on upload, document
  summaries, conversation titles, project summaries, consistency checks, skill review and the
  card-repair model all went out unpinned;
- the cross-tenant pipelines (feedback digest, lesson distill, tag backfill) carried several
  tenants' text with no pin at all;
- a failed lookup of the setting, a missing `GRID_INTERNAL_API_TOKEN`, or a model that could not be
  copied each switched the pin off silently;
- the BFF let `PUT /api/organization/settings` switch it off without `org:models:manage`, and a
  version rollback skipped the ZDR model check.

The default reranker (`cohere/rerank-v3.5`) has no ZDR endpoint at all, and the
default chat and embedding models are served by both ZDR (Azure) and non-ZDR
(OpenAI direct) endpoints, so an unpinned request could land on either.

## Decision Drivers

* The customer-facing promise is "no provider keeps our data"; a setting that holds for one call
  in ten is worse than none, because it is believed.
* Every new call site must get the pin without its author remembering it.
* A privacy control must fail closed: a refused request is recoverable, a leaked one is not.
* EU hosting is wanted where it is available, without making a model unusable where it is not.

## Considered Options

* Keep ZDR opt-in and fix each call site.
* ZDR on by default, applied at one seam every call site goes through, with a test that fails the
  build when one does not.
* Require EU in-region processing (`eu.openrouter.ai`) for everyone.

## Decision Outcome

Chosen option: "ZDR on by default, applied at one seam", because it is the only
option under which the next call site is correct by construction.

- **Default on.** An organization is ZDR unless an admin explicitly switched it off
  (`settings.zdrOnly === false`); switching it off asks for an explicit acknowledgement. Model
  pickers show ZDR-capable models only unless the organization opted out, and a platform default
  without a ZDR endpoint cannot be saved.
- **One seam.** `src/aiq_agent/common/openrouter.py` owns host detection, the pin
  (`DataPolicy.apply`), the organization's policy (`data_policy_for`), and one adapter per
  call-site shape: `pin_chat_model`, `ResolvedCredential.request_body`, `openai_client`,
  `pinned_http_client`, and `data_policy_scope` for detached work such as an ingest job.
- **Two kinds of model.** A model the organization chooses (agent groups, the ingest vision
  override, BYOK) follows its policy. A model the platform fixes (embeddings, reranker, decision
  model, `summary_llm`, `rerank_llm`, `card_repair_llm`) and every cross-tenant pipeline is always
  pinned (`PLATFORM_FIXED`); each of them has a ZDR endpoint, so pinning costs nothing. The default
  reranker moves to `qwen/qwen3-reranker-8b` (Fireworks, ZDR). Decisions (ADR-0064) no longer skip
  ZDR organizations: Jev's one endpoint is ZDR, so they are pinned instead.
- **Fail closed.** An unreadable setting, a missing internal token or a lookup error pins; a model
  that cannot carry the pin raises instead of sending.
- **EU preferred, not required.** Every pinned request carries `provider.order` with the EU
  endpoint slugs first (`OPENROUTER_PREFERRED_PROVIDERS`), fallbacks allowed.

### Consequences

* Good, because every outbound model request is pinned unless an organization deliberately opted
  out, and the next call site cannot forget it without failing CI.
* Good, because the fail-open paths that switched the control off quietly are gone.
* Bad, because a model without a ZDR endpoint now fails for every organization that did not opt
  out. An org that picked one before this change sees refused requests in that agent group until
  an admin picks another; the org model card lists the affected groups and chat names the cause.
* Bad, because the reranker model changed. Retrieval order is not identical to the Cohere one, and
  the answer suite is the before/after.
* Bad, because a BFF outage now pins every organization for its duration, opted-out ones
  included; a model without a ZDR endpoint is refused while it lasts.
* Bad, because EU is a preference: embeddings, the reranker and the decision model have no EU
  endpoint today. Guaranteed in-region processing needs `eu.openrouter.ai`, which is an OpenRouter
  Business/Enterprise contract, not a code change.
* Neutral: web search sends the query to Tavily, which is not a model provider and is outside
  this control. The settings copy says so.

### Confirmation

- `tests/aiq_agent/common/test_openrouter_call_sites.py` scans `src/`, `sources/`,
  `frontends/aiq_api/src/` and `scripts/` and fails when a module builds a model client by hand or
  posts to a model endpoint without an adapter; its allowlist names the files that send no tenant
  content, with the reason.
- `tests/aiq_agent/common/test_openrouter.py` pins the fail-closed resolution, the EU order and
  each adapter; the route tests assert the outgoing body.
- The BFF specs cover the default-on read, the refused settings bypass, rollback under ZDR and the
  platform-default save check.
- Nothing checks that a platform-fixed model configured by environment variable has a ZDR
  endpoint; a wrong one fails every call loudly. `docs/deployment/environment-variables.md` says so.

## More Information

- The audit that produced this: the PR that introduced this record.
- OpenRouter: https://openrouter.ai/docs/guides/features/zdr and
  https://openrouter.ai/docs/guides/features/sovereign-ai.
- The live ZDR endpoint list: `GET https://openrouter.ai/api/v1/endpoints/zdr`.
