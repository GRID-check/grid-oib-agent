# The Langfuse contract

**Langfuse is Grid's observability platform** ([ADR-0089](../adr/0089-langfuse-is-the-observability-platform-and-everything-is-observable.md)).
Everything the product does with a model, every agent step and every quality
check lands there, and we improve the product from what it shows. This page is
the contract: what every trace carries, which scores exist, what Langfuse
itself is configured with, and what a change must do to keep all of it true.

We are actively working on this. If you find something the product does that
Langfuse does not show, it is a bug. Fix it or file it, and add it to the open
list in [`langfuse-audit-2026-10.md`](langfuse-audit-2026-10.md).

For the people reading the data rather than producing it (business analysts,
the Fachbereich): [`analyst-guide.md`](analyst-guide.md).

## What every trace carries

| Field in Langfuse | Where it comes from | Values |
|---|---|---|
| Trace name | `trace_context.trace_name_for_root` (NAT runs), `observed_generation` (auxiliary calls) | `chat-turn`, `research-job`, `conversation-title`, `project-summary`, `consistency-check`, `skill-review`, `lesson-distill`, `feedback-digest` |
| Environment | `APP_ENV`, coerced to Langfuse's alphabet | `production`, … |
| Release | `GRID_GIT_SHA`, the image's commit | the commit hash |
| Session | the conversation id (NAT sets `session.id`) | one session per chat |
| User | the verified WorkOS subject, only with `GRID_TRACE_IDENTITY_ATTRIBUTES=true` | WorkOS user id |
| Observation type | `nat.span.kind` mapped by `trace_context.observation_type` | `agent` (the turn), `generation` (a model call), `tool`, `retriever` (`retrieve.*`), `chain`, `embedding`, `guardrail`, `evaluator` |
| Prompt | `PromptLinkProcessor`, generations only | `piloti-system-static` and its version |
| Usage and cost | `UsageAttributeProcessor` (NAT), `observed_generation` (auxiliary) | input, output, cached and reasoning tokens; the provider's cost when it reports one |

### A chat turn's root observation

The root (`chat-turn`, type `agent`) is the turn as the reader got it: the
question as input, **the answer text as output**, and the outcome
(`observability/turn_outcome.py`). A failed turn's root is level `ERROR` with
the wire's error code; a turn the asker stopped is `WARNING`.

Trace metadata on the root:

| Key | Meaning |
|---|---|
| `turn_outcome` | `answered`, `refused`, `handed_off`, `cancelled`, `error` |
| `answer_route` | `meta`, `shallow`, `deep`, `error` |
| `answer_confidence`, `answer_confidence_capped` | what the reader saw, and which guard lowered it |
| `answer_sources`, `answer_cards`, `answer_card_types`, `answer_chars` | what the answer contained |
| `citations_removed`, `quotes_verbatim`, `quotes_not_found` | verification outcome, as counts |
| `research_truncated`, `handed_off_to_run`, `skills_activated`, `reasoning_effort` | how the turn ran |
| `error_code` | on a failed turn |
| `usage_llm_calls`, `usage_prompt_tokens`, `usage_completion_tokens`, `usage_total_tokens`, `usage_cost_usd`, `usage_cost_source`, `usage_error` | the turn's whole spend (`usage_rollup`) |
| `answer_dialect` | block census and repairs by kind |
| `ifc_op`, `ifc_outcome`, `ifc_model`, … | what a building-model tool did (`tools/bim/trace.py`) |
| `organization_id`, `project_id` | the tenant, only with identity attributes on |

Tags, the trace list's fast filter: `outcome:<…>`, `route:<…>`,
`confidence:<…>`, `capped:<…>`, `citations-removed`, `quote-not-found`,
`research-truncated`, `handed-off`, `error:<code>`, `feature:ifc`,
`feature:<auxiliary feature>`, `surface:auxiliary`, and `org:<id>` with
identity attributes on. Tags are labels, never ids or text, with the one
exception of the tenant tag.

## Scores

Every score Grid, a reviewer or a judge writes is declared once in
`aiq_agent.observability.langfuse_scores.SCORE_DEFINITIONS`. A test fails when
a name is written but not declared, or declared but not listed here.

| Score | Type | Written by | Meaning |
|---|---|---|---|
| `user-feedback` | numeric 0–1 | BFF, on a vote | 1 helpful, 0 not. The mean is the helpful rate |
| `user-feedback-reason` | categorical | BFF, on a down-vote | `inaccurate`, `wrong_source`, `too_slow`, `other` |
| `citation-health` | boolean | agent | nothing removed, patched or flagged on this turn |
| `answer-grounded` | boolean | agent | false when sources were retrieved but no citation survived |
| `citations-removed` | numeric | agent | citations verification dropped |
| `quotes-unverified` | numeric | agent | quoted spans no passage holds |
| `retrieval-precision` | numeric 0–1 | agent | share of distinct retrieved sources the answer cited |
| `citation-fallback` | boolean | agent | the single retrieved source was appended for the model |
| `sources-empty` | boolean | agent | a lookup ran and found nothing |
| `answer-confidence` | categorical | agent | `low`, `medium`, `high` as shown |
| `confidence-capped` | categorical | agent | which guard lowered it, or `none` |
| `quotes-verbatim-rate` | numeric 0–1 | agent | checked quote lines held verbatim |
| `quotes-patched` | numeric | agent | misremembered quotes the repair corrected (ADR-0067) |
| `dialect-repairs` | numeric | agent | answer-dialect blocks repaired; 0 is a measurement |
| `card-validity` | categorical | agent | per envelope card that missed its schema: `repaired`, `dropped` |
| `review-correctness` | categorical | reviewer, in the queue | `correct`, `partly_correct`, `incorrect` |
| `review-sources` | categorical | reviewer, in the queue | `right_sources`, `missing_sources`, `wrong_sources` |
| `judge-answers-question` | numeric 0–1 | LLM judge | how directly the answer addresses the question |
| `judge-uncited-claims` | boolean | LLM judge | a normative requirement stated without `[N]` |
| `judge-clarity` | categorical | LLM judge | `clear`, `partly_clear`, `unclear` |

Agent scores are posted to `POST /api/public/scores` from a small bounded pool
(`langfuse_scores.emit_scores`); they never block or fail a turn, and a
re-post upserts the same id. The citation scores come from the same outcome
the `citation_events` ledger records, so the ledger's dashboard and Langfuse
agree.

## What Langfuse is configured with

Declared in `aiq_agent.observability.langfuse_catalog`, provisioned by:

```bash
task langfuse:provision              # check: prints what is missing or has drifted
task langfuse:provision -- --apply   # create what is missing (ask first on a shared project)
```

* **Score configs** for every score above, so Langfuse validates values and the
  annotation UI offers the categories.
* **Annotation queue `answer-review`.** Every down-voted answer's trace is added
  by the BFF (`frontends/ui/src/lib/langfuse/feedback-score.ts`). Reviewers
  record `review-correctness` and `review-sources`.
* **LLM-as-a-judge evaluators** `judge-answers-question`, `judge-uncited-claims`
  and `judge-clarity`, and the rule `chat-turn-judges` that runs them on one in
  five answered chat turns' root observations. **The rule is created disabled.**
  Enabling it sends answers to the project's evaluation model: check that the
  LLM connection uses a zero-data-retention endpoint (ADR-0074) before you do.
* **Dataset `golden-questions`**: the answer suite's questions
  (`tests/fixtures/herleitung/loop_eval_questions.yaml`) with their expected
  family, Punkt and kind, for experiments that compare prompt or model versions.

The script never changes or deletes what exists; a config that differs is
reported as drift for a person to resolve.

## When you change the product

| When you | You must |
|---|---|
| Add a model call inside a NAT run | Nothing: the exporter's processors cover it. Check the generation shows usage in Langfuse |
| Add a model call outside one (a route, a script, a worker) | Wrap it in `observed_generation("<feature>", …)` and add the feature to the trace-name table above. `test_model_calls_are_traced.py` covers `aiq_api` routes |
| Add or change a quality check | Emit a score through `langfuse_scores.emit_scores`, declare it in `SCORE_DEFINITIONS`, add its row here, run `task langfuse:provision` |
| Add a dimension an analyst should slice by | Trace metadata through `record_trace_metadata` (tools) or `turn_outcome` (turn results); a tag only if it is a low-cardinality label |
| Change a judge, the queue or the dataset | Edit `langfuse_catalog.py`, then `task langfuse:provision -- --apply` once it is merged |
| Gate something on identity | Only the user and the tenant. Labels, counts and scores are never behind `GRID_TRACE_IDENTITY_ATTRIBUTES` |

## Where the code is

| Concern | Module |
|---|---|
| Environment, release, types, trace names | `src/aiq_agent/observability/trace_context.py` |
| The processors on NAT's exporter | `src/aiq_agent/observability/langfuse_trace_attributes.py`, installed in `otel_header_redaction_exporter.py` |
| A turn's outcome on its root | `src/aiq_agent/observability/turn_outcome.py`, bound in `aiq_api/chat_socket.py` `_drive` |
| Runtime scores | `src/aiq_agent/observability/langfuse_scores.py` |
| Model calls outside NAT | `src/aiq_agent/observability/direct_trace.py` |
| Langfuse configuration as code | `src/aiq_agent/observability/langfuse_catalog.py`, `scripts/langfuse_provision.py` |
| Votes, reasons, review queue | `frontends/ui/src/lib/langfuse/feedback-score.ts` |
| Retention and erasure | `frontends/ui/workers/langfuse-traces.js` ([`deletion-pipeline.md`](../architecture/deletion-pipeline.md)) |
| Deployment | `deploy/pulumi/src/platform/langfuse.ts` ([`kubernetes.md`](../deployment/kubernetes.md) § Langfuse) |
