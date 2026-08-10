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


def identity_attributes_enabled() -> bool:
    """Whether to stamp per-request identity onto spans.

    Defaults to FALSE. See the module docstring — this is a privacy posture
    decision the deployment makes, not a performance toggle.
    """
    return os.environ.get(IDENTITY_ATTRIBUTES_ENV, "").strip().lower() == "true"


def langfuse_attributes_for(
    *,
    user_id: str | None,
    organization_id: str | None,
    project_id: str | None,
    conversation_id: str | None,
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
    if tags:
        attributes[TAGS_ATTRIBUTE] = tags

    return attributes


def current_langfuse_attributes() -> dict[str, Any]:
    """Read the ambient Grid request context and map it to Langfuse attributes.

    Best-effort by construction: telemetry enrichment must never be able to
    fail a turn, so every failure path returns ``{}`` and logs at DEBUG. A span
    missing its user id is a degraded trace; an exception escaping here would
    be a broken export pipeline.
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

except Exception:  # pragma: no cover - exercised only without the NAT extras
    # Mirrors the import guards in `otel_header_redaction_exporter.py`: the
    # pure mapping above stays importable (and testable) even where the NAT
    # observability extras are not installed.
    LangfuseTraceAttributeProcessor = None  # type: ignore[assignment,misc]
