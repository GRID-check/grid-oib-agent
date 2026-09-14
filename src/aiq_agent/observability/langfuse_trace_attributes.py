"""Stamp Langfuse trace attributes onto NAT spans (ADR-0044).

Langfuse groups observations into traces and then attributes those traces to a
*session* and a *user*. Without those two identifiers a deployment's traces are
a flat, anonymous list: you can see that a retrieval took 4s and cost €0.02,
but not whose conversation it belonged to or what else happened in that
conversation. Session/user attribution is most of what distinguishes Langfuse
from the live span view the Aspire dashboard already provides, so wiring it is
the difference between "traces reach Langfuse" and "the app is integrated with
Langfuse".

WHAT WE GET FOR FREE, and therefore do not do here. Verified against the
installed NAT, not assumed:

* ``session.id`` — ``nat.observability.exporter.span_exporter`` already sets it
  from ``Context.conversation_id`` at span creation, and Langfuse maps
  ``session.id`` natively. This module still sets ``langfuse.session.id``,
  because that is the attribute Langfuse checks *first* and pinning it makes
  the mapping explicit rather than dependent on an upstream detail — but it
  only ever sets it when there is a value, so it can never blank out NAT's.
* ``input.value`` / ``output.value`` — NAT emits the OpenInference attribute
  names, which Langfuse reads as the observation input/output.

WHAT IS MISSING WITHOUT THIS MODULE: the user and the tenant. NAT has no
concept of either; they arrive on the Grid ``X-Grid-*`` request headers
(``project_context.py``), which nothing was projecting onto spans.

## Why a Processor and not a resource attribute

Resource attributes are per-PROCESS. User and organization are per-REQUEST, and
one agent process serves every tenant, so the only correct place is a
per-span hook. NAT's processing pipeline is exactly that hook, and NAT's own
``SpanHeaderRedactionProcessor`` reads request headers the same way.

Context propagation into that pipeline is real rather than hoped-for:
``SpanExporter._process_end_event`` calls ``_create_export_task`` synchronously
while still inside the request, and ``asyncio.create_task`` snapshots the
current ``contextvars`` context for the new task. The processor therefore
observes the request's headers even though it runs on a different task.

The cost — parsing the header envelope once per span — is paid on that export
task, never on the turn the user is waiting for.

## Why this is off by default

Attaching a user id to telemetry changes what the trace store *is*: ADR-0029
accepted that traces carry user CONTENT, on the reasoning that the store is
gated to platform operators. Making every span attributable to a named
individual is a further step, and it should arrive with the product decision
that needs it rather than by default. So availability follows the house rule —
``GRID_TRACE_IDENTITY_ATTRIBUTES`` is injected by the deployment only when the
Langfuse tier is deployed. An Aspire-only stack is byte-identical to before.
"""

import contextvars
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

#: Env flag the deployment sets when the Langfuse tier is on (ADR-0044).
IDENTITY_ATTRIBUTES_ENV = "GRID_TRACE_IDENTITY_ATTRIBUTES"

#: Langfuse's trace-level attribute names. It also accepts `user.id`/`session.id`,
#: but the `langfuse.`-prefixed spellings take precedence in its OTel mapping,
#: so they are the ones to write when we mean to be authoritative.
USER_ID_ATTRIBUTE = "langfuse.user.id"
SESSION_ID_ATTRIBUTE = "langfuse.session.id"
TAGS_ATTRIBUTE = "langfuse.trace.tags"
METADATA_PREFIX = "langfuse.trace.metadata."


#: Per-turn facts a TOOL contributed, merged into the attributes below.
#:
#: Copy-on-write: writers always ``ContextVar.set`` a NEW dict rather than
#: mutating the one they read. ``asyncio.create_task`` snapshots the var's
#: OBJECT reference, not the dict's contents, so an in-place ``update``/``append``
#: after a span ended would still bleed into that span's export task — and, worse,
#: into a concurrent job sharing the same dict object. A fresh dict per write
#: keeps each snapshot frozen at what was known when the task was created.
#: Per-job lifecycle (bind fresh at job start, reset in ``finally``) lives with
#: the runner — see ``DeepResearcherAgent.run`` — the way ``cards/registry.py``
#: and ``common/citation_verification.py`` bind per turn.
_CONTRIBUTED: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "grid_langfuse_contributed", default=None
)


def snapshot_contributions() -> dict[str, Any] | None:
    """A frozen copy of the current turn's contributions, or None.

    Copies both levels (the metadata dict and the tags list) so the caller
    holds no live reference: later ``record_trace_metadata``/``add_trace_tag``
    calls replace the ContextVar value and must never rewrite this snapshot.
    """
    current = _CONTRIBUTED.get()
    if current is None:
        return None
    try:
        return {
            "metadata": dict(current.get("metadata", {})),
            "tags": list(current.get("tags", [])),
        }
    except Exception:
        logger.debug("Failed to snapshot Langfuse trace contributions", exc_info=True)
        return None


def begin_trace_contributions() -> contextvars.Token:
    """Bind a fresh contribution dict for one job/turn; reset it in ``finally``.

    Follows the ``cards/registry.py`` token discipline: the caller holds the
    token and passes it to :func:`end_trace_contributions`, which restores
    whatever was bound before. Starting fresh (rather than inheriting) is what
    keeps a reused Dask worker process from handing job N's tags to job N+1
    across tenants.
    """
    return _CONTRIBUTED.set({"metadata": {}, "tags": []})


def end_trace_contributions(token: contextvars.Token) -> None:
    """Restore the contribution binding saved by :func:`begin_trace_contributions`."""
    _CONTRIBUTED.reset(token)


def record_trace_metadata(**pairs: Any) -> None:
    """Attach facts about what a tool actually did to this turn's traces.

    The gap this closes is specific and, for one feature, total. Everything
    expensive in a research turn happens in THIS process, where NAT traces it
    span by span. The IFC tools are the exception: their work happens in the
    BFF, which exports OTel *logs* and no traces at all, so `ifc_query` reaches
    Langfuse as one opaque span of N milliseconds. An operator looking at a
    slow or wrong answer cannot see which model was read, which operation ran,
    or whether the answer covered the whole building — none of which is
    recoverable from the duration.

    Best-effort like everything else here: a failure to record telemetry must
    never fail the turn that was producing it.

    Copy-on-write: builds a NEW dict and sets it, so an export task that
    snapshotted the previous dict keeps seeing exactly what was known when its
    span ended.
    """
    try:
        current = _CONTRIBUTED.get()
        metadata = dict(current.get("metadata", {})) if current else {}
        tags = list(current.get("tags", [])) if current else []
        metadata.update({key: value for key, value in pairs.items() if value is not None})
        _CONTRIBUTED.set({"metadata": metadata, "tags": tags})
    except Exception:
        logger.debug("Failed to record Langfuse trace metadata", exc_info=True)


def add_trace_tag(tag: str) -> None:
    """Tag this turn's traces, e.g. so every turn that read a model is findable.

    Tags are Langfuse's fast filter in the trace list, which is the same reason
    the organization is written as one. "Show me the turns that touched a
    building model" is otherwise a metadata scan.

    Copy-on-write like :func:`record_trace_metadata`: sets a new dict so a
    concurrent researcher holding the previous snapshot never observes this
    append.
    """
    try:
        current = _CONTRIBUTED.get()
        metadata = dict(current.get("metadata", {})) if current else {}
        tags = list(current.get("tags", [])) if current else []
        if tag not in tags:
            tags.append(tag)
        _CONTRIBUTED.set({"metadata": metadata, "tags": tags})
    except Exception:
        logger.debug("Failed to add a Langfuse trace tag", exc_info=True)


def reset_contributions() -> None:
    """Drop what this turn contributed. Test-only; src/ uses the token pair.

    Production code binds per job/turn via :func:`begin_trace_contributions`
    and restores via :func:`end_trace_contributions` in ``finally``, so a
    reused Dask worker cannot hand job N's tags to job N+1. This helper stays
    for tests that need a blank slate without holding a token.
    """
    _CONTRIBUTED.set(None)


# ---------------------------------------------------------------------------
# Usage attribution: input/output/total (+cost) onto generation observations
# ---------------------------------------------------------------------------
#
# Production showed empty ``usageDetails``/``costDetails`` on every
# generation observation. The provider numbers DO enter the process:
# OpenRouter's ``usage`` object (prompt/completion/total + ``cost`` +
# cached/reasoning details) arrives on every chat completion and
# ``GridCostTracker`` records it to ``llm_usage_events``. It never reaches
# the spans Langfuse renders, through two drops:
#
# 1. NAT's ``LangchainProfilerHandler.on_llm_end`` reads ONLY LangChain's
#    normalized ``message.usage_metadata`` (no cost field exists on its
#    ``TokenUsageBaseModel`` at all), and the span exporter forwards only
#    ``llm.token_count.prompt/completion/total``. The OpenRouter object —
#    the only place ``cost`` lives — survives solely inside the span's
#    ``nat.metadata`` JSON (``chat_responses[].message.response_metadata``).
# 2. The turn's terminal ``ChatResponse`` is built with an empty
#    ``Usage()`` (see ``aiq_agent.common._create_chat_response``), so even
#    the API-level generation object carries no totals.
#
# This processor closes drop 1 at export time, where every LLM span passes
# regardless of which handler built it (NAT's stock handler on chat turns,
# ``SpanClosingProfilerHandler`` on async jobs): it mirrors the counts into
# the ``gen_ai.usage.*`` namespace Langfuse's OTel ingestion maps to
# ``usageDetails``, pins the model so Langfuse can infer ``costDetails``
# from its own model price table, and — when the provider object is present
# in the span metadata — ingests the OpenRouter-reported cost verbatim.
#
# No client-side price table is consulted: the only ``PricingRegistry`` in
# this repo (``aiq_agent.tokenomics.pricing``) is eval-only, built from the
# ``tokenomics.pricing`` section of an eval YAML that is never deployed.
# Per-span cost computation against a deployed table is the follow-up; until
# then spans carry usage (+model for server-side inference, +verbatim cost
# when the provider reported one) and per-turn dollars land on the trace
# via ``aiq_agent.observability.usage_rollup``.

#: OTel GenAI semconv usage keys Langfuse maps to ``usageDetails`` (it
#: normalizes cache buckets server-side, so these stay provider-verbatim).
GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens"
GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens"
#: The model a generation ran on — what Langfuse matches against its model
#: price table to infer ``costDetails`` when no cost is ingested.
GEN_AI_REQUEST_MODEL = "gen_ai.request.model"
#: Flat Langfuse-style keys, stored verbatim (no server normalization), so
#: their buckets must already be exclusive — see ``usage_observation_attributes``.
OBSERVATION_USAGE_DETAILS = "langfuse.observation.usage_details"
OBSERVATION_COST_DETAILS = "langfuse.observation.cost_details"
OBSERVATION_MODEL_NAME = "langfuse.observation.model.name"


def identity_attributes_enabled() -> bool:
    """Whether to stamp per-request identity onto spans.

    Defaults to FALSE. See the module docstring — this is a privacy posture
    decision the deployment makes, not a performance toggle.
    """
    return os.environ.get(IDENTITY_ATTRIBUTES_ENV, "").strip().lower() == "true"


def _as_count(value: Any) -> int:
    """A token count as a non-negative int; anything else is 0."""
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _find_provider_usage(node: Any, depth: int = 0) -> dict[str, Any] | None:
    """First OpenRouter-shaped usage object under ``node``, or None.

    A bounded recursive scan (not a fixed path) because the span metadata
    serializer normalizes shapes across NAT versions while the provider key
    names (``prompt_tokens``/``completion_tokens``) are stable. Depth-capped
    so a pathological payload cannot recurse.
    """
    if depth > 6 or node is None:
        return None
    if isinstance(node, dict):
        prompt = node.get("prompt_tokens")
        completion = node.get("completion_tokens")
        if isinstance(prompt, int | float) and isinstance(completion, int | float):
            return node
        for value in node.values():
            found = _find_provider_usage(value, depth + 1)
            if found is not None:
                return found
        return None
    if isinstance(node, list):
        for value in node:
            found = _find_provider_usage(value, depth + 1)
            if found is not None:
                return found
    return None


def extract_provider_usage(metadata_json: Any) -> dict[str, int | float] | None:
    """Provider token counts (+cost) out of a span's serialized metadata.

    Reads the OpenRouter ``usage`` object NAT keeps inside ``nat.metadata``
    (``chat_responses[].message.response_metadata.token_usage``): the only
    span-side carrier of ``cost`` and of cached/reasoning detail. Returns the
    counts with ``cost_usd`` (or None when the provider reported no cost), or
    None when no usage object is present. Pure, so tests pin it without a span.
    """
    if not isinstance(metadata_json, str) or not metadata_json:
        return None
    try:
        import json

        payload = json.loads(metadata_json)
    except Exception:
        return None
    try:
        usage = _find_provider_usage(payload)
        if usage is None:
            return None
        prompt_details = usage.get("prompt_tokens_details") or {}
        completion_details = usage.get("completion_tokens_details") or {}
        raw_cost = usage.get("cost")
        return {
            "prompt_tokens": _as_count(usage.get("prompt_tokens")),
            "completion_tokens": _as_count(usage.get("completion_tokens")),
            "total_tokens": _as_count(usage.get("total_tokens")),
            "cached_tokens": _as_count(prompt_details.get("cached_tokens")),
            "reasoning_tokens": _as_count(completion_details.get("reasoning_tokens")),
            "cost_usd": float(raw_cost) if isinstance(raw_cost, int | float) else None,  # type: ignore[dict-item]
        }
    except Exception:
        logger.debug("Failed to extract provider usage from span metadata", exc_info=True)
        return None


def extract_span_token_counts(attributes: dict[str, Any]) -> dict[str, int] | None:
    """The ``llm.token_count.*`` counts NAT's exporter already set, or None.

    The fallback when the provider object is absent from the metadata (older
    traces, stripped payloads): token-only, no cached/reasoning/cost split.
    None when all three are zero — absent usage stays absent rather than
    rendering as a real measurement of zero tokens.
    """
    prompt = _as_count(attributes.get("llm.token_count.prompt"))
    completion = _as_count(attributes.get("llm.token_count.completion"))
    total = _as_count(attributes.get("llm.token_count.total"))
    if prompt <= 0 and completion <= 0 and total <= 0:
        return None
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": total}


def usage_observation_attributes(
    *,
    prompt_tokens: int,
    completion_tokens: int,
    total_tokens: int,
    cached_tokens: int = 0,
    reasoning_tokens: int = 0,
    cost_usd: int | float | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """The span attributes that land input/output/total (+cost) on a generation.

    ``gen_ai.usage.*`` carries the provider-verbatim counts (Langfuse
    normalizes cache buckets server-side on that path).
    ``langfuse.observation.usage_details`` is stored VERBATIM, so its buckets
    are exclusive here: ``input`` excludes cached tokens (which ride their own
    ``input_cached_tokens`` bucket) and ``output`` excludes reasoning tokens
    (own ``output_reasoning_tokens`` bucket) — otherwise Langfuse's
    per-bucket cost math would bill the same token twice.
    ``cost_details`` carries the provider-reported total when known; without
    it Langfuse infers cost from ``model`` + usage via its model table.
    Pure, so the mapping is testable without a span or an event loop.
    """
    import json

    exclusive_input = max(0, prompt_tokens - cached_tokens)
    exclusive_output = max(0, completion_tokens - reasoning_tokens)
    details: dict[str, Any] = {
        "input": exclusive_input,
        "output": exclusive_output,
        "total": total_tokens,
    }
    if cached_tokens > 0:
        details["input_cached_tokens"] = cached_tokens
    if reasoning_tokens > 0:
        details["output_reasoning_tokens"] = reasoning_tokens
    attributes: dict[str, Any] = {
        GEN_AI_USAGE_INPUT_TOKENS: prompt_tokens,
        GEN_AI_USAGE_OUTPUT_TOKENS: completion_tokens,
        OBSERVATION_USAGE_DETAILS: json.dumps(details, separators=(",", ":")),
    }
    if model:
        attributes[GEN_AI_REQUEST_MODEL] = model
        attributes[OBSERVATION_MODEL_NAME] = model
    if isinstance(cost_usd, int | float):
        attributes[OBSERVATION_COST_DETAILS] = json.dumps({"total": float(cost_usd)}, separators=(",", ":"))
    return attributes


def langfuse_attributes_for(
    *,
    user_id: str | None,
    organization_id: str | None,
    project_id: str | None,
    conversation_id: str | None,
    contributed: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the Langfuse attribute map for one request's identity.

    Pure, so the mapping can be tested without a NAT context, a span, or an
    event loop. Absent values are OMITTED rather than written as ``None`` or
    ``"unknown"``: Langfuse renders whatever it is given, and a trace attributed
    to the user ``"unknown"`` reads as a real user with a strange name — it
    would also group every anonymous request into one bogus session.
    """
    attributes: dict[str, Any] = {}

    if user_id:
        attributes[USER_ID_ATTRIBUTE] = user_id
    if conversation_id:
        attributes[SESSION_ID_ATTRIBUTE] = conversation_id
    if organization_id:
        attributes[f"{METADATA_PREFIX}organization_id"] = organization_id
    if project_id:
        attributes[f"{METADATA_PREFIX}project_id"] = project_id

    # Tags are Langfuse's fast filter in the trace list, so the tenant goes here
    # as well as in metadata: "show me this organization's traces" is the first
    # question anyone asks of a multi-tenant trace store, and metadata filtering
    # is a slower, less discoverable path in the UI.
    tags = [f"org:{organization_id}"] if organization_id else []

    # What a tool recorded about what it did. Namespaced under the same
    # `langfuse.trace.metadata.` prefix as the identity fields, so it is subject
    # to exactly the same redaction policy — this whole map is written ahead of
    # NAT's redaction processor and an operator listing a key in
    # `redaction_attributes` must be able to reach these too.
    for key, value in (contributed or {}).get("metadata", {}).items():
        attributes[f"{METADATA_PREFIX}{key}"] = value
    tags.extend(tag for tag in (contributed or {}).get("tags", []) if tag not in tags)

    if tags:
        attributes[TAGS_ATTRIBUTE] = tags

    return attributes


def current_langfuse_attributes() -> dict[str, Any]:
    """Read the ambient Grid request context and map it to Langfuse attributes.

    Best-effort by construction: telemetry enrichment must never be able to
    fail a turn, so every failure path returns ``{}`` and logs at DEBUG. A span
    missing its user id is a degraded trace; an exception escaping here would
    be a broken export pipeline.

    Reads contributions via :func:`snapshot_contributions` so the attribute map
    holds no live reference: a tool contributing after this call must not
    rewrite an already-built map, and an export task holding this map must not
    observe a concurrent researcher's later writes.
    """
    try:
        from aiq_agent.project_context import GridRequestContext
        from aiq_agent.project_context import get_conversation_id_from_context

        context = GridRequestContext.from_context()
        return langfuse_attributes_for(
            user_id=context.user_id,
            organization_id=context.organization_id,
            project_id=context.project_id,
            conversation_id=get_conversation_id_from_context(),
            contributed=snapshot_contributions(),
        )
    except Exception:
        logger.debug("Failed to derive Langfuse trace attributes from context", exc_info=True)
        return {}


try:
    from nat.data_models.span import Span
    from nat.observability.processor.processor import Processor

    class LangfuseTraceAttributeProcessor(Processor[Span, Span]):
        """Attach session/user/tenant attributes to every span.

        Inserted at the FRONT of the pipeline, ahead of NAT's redaction
        processor. That ordering is deliberate and is the only one that keeps
        redaction meaningful: attributes added after the redaction pass can
        never be redacted, so an operator who adds ``langfuse.user.id`` to
        ``redaction_attributes`` would be configuring something with no effect.
        Running first means these attributes are subject to exactly the same
        redaction policy as ``input.value`` and ``output.value``.
        """

        async def process(self, item: Span) -> Span:
            """Stamp the current request's identity onto one span.

            Mutates and returns the same object rather than building a copy —
            that is NAT's pipeline contract, and the redaction processor
            downstream relies on it.

            Reading the context here (rather than at span creation) is safe
            because ``SpanExporter._process_end_event`` hands this pipeline to
            ``asyncio.create_task`` while still inside the request, and
            ``create_task`` snapshots the current ``contextvars``. Never raises:
            ``current_langfuse_attributes`` absorbs its own failures, because an
            exception escaping here would stop span export for the process.
            """
            for key, value in current_langfuse_attributes().items():
                item.set_attribute(key, value)
            return item

    class UsageAttributeProcessor(Processor[Span, Span]):
        """Mirror provider usage onto generation spans in the namespaces Langfuse reads.

        NAT's exporter sets only ``llm.token_count.*`` (token-only, and zero
        whenever ``usage_metadata`` was absent), while Langfuse's OTel
        ingestion maps ``gen_ai.usage.*`` / ``langfuse.observation.*`` to
        ``usageDetails``/``costDetails`` — hence empty usage on every
        generation. This processor runs ahead of redaction and adds the
        missing namespaces from what the span already carries, preferring the
        provider object in ``nat.metadata`` (has cost + cached/reasoning)
        over the bare ``llm.token_count.*`` counts.

        Counts and the model name are not sensitive, so — unlike the identity
        processor — this one is always installed. Never raises: enrichment
        must degrade the trace, never fail the export.
        """

        async def process(self, item: Span) -> Span:
            """Stamp usage (+model, +verbatim cost when known) onto one LLM span.

            Non-LLM spans and spans with no usage anywhere pass through
            untouched: absent usage stays absent rather than rendering as a
            real measurement of zero tokens.
            """
            try:
                attributes = item.attributes or {}
                event_type = next(
                    (value for key, value in attributes.items() if key.endswith(".event_type")),
                    None,
                )
                if not isinstance(event_type, str) or not event_type.startswith("LLM"):
                    return item
                counts: dict[str, Any] | None = None
                for key, value in attributes.items():
                    if not key.endswith(".metadata") or not isinstance(value, str):
                        continue
                    counts = extract_provider_usage(value)
                    if counts is not None:
                        break
                if counts is None:
                    counts = extract_span_token_counts(attributes)
                if counts is None:
                    return item
                model = item.name or None
                for key, value in usage_observation_attributes(
                    prompt_tokens=int(counts.get("prompt_tokens") or 0),
                    completion_tokens=int(counts.get("completion_tokens") or 0),
                    total_tokens=int(counts.get("total_tokens") or 0),
                    cached_tokens=int(counts.get("cached_tokens") or 0),
                    reasoning_tokens=int(counts.get("reasoning_tokens") or 0),
                    cost_usd=counts.get("cost_usd"),
                    model=model,
                ).items():
                    item.set_attribute(key, value)
            except Exception:
                logger.debug("Failed to stamp usage attributes onto a span", exc_info=True)
            return item

except Exception:  # pragma: no cover - exercised only without the NAT extras
    # Mirrors the import guards in `otel_header_redaction_exporter.py`: the
    # pure mapping above stays importable (and testable) even where the NAT
    # observability extras are not installed.
    LangfuseTraceAttributeProcessor = None  # type: ignore[assignment,misc]
    UsageAttributeProcessor = None  # type: ignore[assignment,misc]
