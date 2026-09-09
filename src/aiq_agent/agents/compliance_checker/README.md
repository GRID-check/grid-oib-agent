# Compliance Checker (OIB Soll-Ist-Abgleich)

Backlog **T4-3**: a fixed-shape pipeline for a full OIB compliance check, the
structured alternative to walking six Richtlinien through open-ended research.
Every LLM call is one structured request/response and code decides every
retrieval; there is no tool-calling loop. The call count is one per Richtlinie
in scope plus one per batch of applicable requirements.

**Status: callable from chat.** Registered as `compliance_check_agent`,
configured as `compliance_check` in `configs/config_oib_openrouter.yml`, and on
`shallow_research_agent`'s tool list. A live shakedown against a real model is
still pending.

## Pipeline

`run_compliance_check` (`agent.py`) runs one `_check_richtlinie` per Richtlinie
in scope, gathered, so no Richtlinie waits for another. Only the LLM calls share
the `max_concurrency` semaphore; retrievals run unbounded.

| Stage | Retrieval (`knowledge_search`, tool-free) | LLM | Output |
|---|---|---|---|
| 1 Requirement profile | 2 queries, base OIB corpus only (`REGULATION_SHELVES`) | 1 strict-JSON call | `RequirementProfile` |
| 2 Evidence check | 1 query per Richtlinie + 1 per batch, the user's own documents only — archive, project and session shelves, never the OIB corpus (`EVIDENCE_SHELVES`) | 1 strict-JSON call per batch of `requirement_batch_size` | `EvidenceBatchResult` |
| 3 Matrix + report | none | none | `ComplianceMatrix`, German Markdown |

The shelf restriction rides on the knowledge tool's turn-shelf context variable
(`_restrict_scope_to_turn`), set in a copied context that ends with each
retrieval task. Because that helper falls back to every shelf when the
restriction would empty the scope, `register.project_documents_in_scope()`
checks the request's collection scope first: with no project and no upload,
Stage 2 is skipped and every applicable requirement is reported as
`nicht_geprueft` with that reason.

Failures are typed, never swallowed: a Richtlinie whose profile failed, a
retrieval that raised, or an evidence batch that failed or omitted a
requirement all become a `nicht_geprueft` row with the reason and a line under
`## Hinweise` in the report. `kein_nachweis` is reserved for the LLM's own
verdict that the documents are silent.

The gap list is ordered by `(status, confidence)`: `nicht_erfuellt` before
`kein_nachweis` before `teilweise`, higher confidence first within a status.
There is no numeric risk score.

## Contracts

`models.py` holds everything. `RequirementProfile`/`RequirementItem` and
`EvidenceBatchResult`/`EvidenceFinding` are sent to the LLM as strict
`json_schema` structured output and therefore use `field_validator` instead of
`Field(ge=..., le=..., min_length=..., pattern=...)`;
`tests/aiq_agent/agents/compliance_checker/test_models.py` walks their schemas
to keep it that way. The rest is pipeline input/output built in Python.

## Request

`build_request` takes the project context from the request headers. An explicit
`richtlinien` from the tool call is used untouched; otherwise the configured
default is narrowed by `aiq_agent.common.applicability` from the project's
confirmed intake facts (verdict `required`, `likely` or `check` keeps a
Richtlinie). The same facts become `project_descriptors`, rendered as the
Projektmerkmale block of the Stage 1 prompt.

## Agent group

`AgentGroup.COMPLIANCE_CHECK` (`compliance_check`) is the override point for
`compliance_llm`, independent of `deep_research`.
