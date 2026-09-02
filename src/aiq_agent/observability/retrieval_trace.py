"""One named observation per knowledge search: what was picked (ADR-0044).

Everything expensive in a research turn already reaches Langfuse span by span,
but the single question an operator asks of a wrong or weak answer — *which
documents did the agent pick, and what did it skip?* — was answerable only by
reading the tool's formatted output text. The `knowledge_search` FUNCTION span
carries the excerpts as prose; the query, the collections searched, the
candidate budget and the per-chunk picks (file, page, score, shelf) had no
structured home. An empty result was indistinguishable from a turn that never
searched at all.

This module emits ONE balanced NAT step pair per search, named
``retrieve.<tool>`` (e.g. ``retrieve.knowledge_search``), so it:

* flows through the same exporter pipeline as every other span and therefore
  gets session/user attribution (ADR-0044), redaction policy (ADR-0029) and
  Langfuse mapping for free;
* nests under the calling tool's FUNCTION span in the trace tree;
* carries METADATA ONLY — chunk ids, file names, pages, scores, shelves. No
  chunk text rides on it, so it adds no content beyond what ADR-0029 already
  accepts, and if an operator enables redaction it is redacted together with
  everything else (`input.value`/`output.value` are in the default
  `redaction_attributes`). That is by design: the operator's choice removes
  the picking record along with the prose, never leaves one behind.

Mechanics mirror `aiq_agent.common.turn_status.push_custom_step`: a
FUNCTION_START/FUNCTION_END pair sharing one UUID, pushed through the real
`IntermediateStepManager`, so span-stack bookkeeping stays exactly balanced.
Fail-open by contract — telemetry must never take a turn down.
"""

import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)

#: Hard ceiling on picks recorded per search, independent of the platform's
#: admin-tunable top_k. A pathological setting must not be able to balloon one
#: observation into megabytes of JSON.
PICK_LIMIT = 50


def _compact(value: Any) -> dict[str, Any]:
    """Drop None values so an absent fact is absent rather than null."""
    return {key: val for key, val in value.items() if val is not None}


def _shelf_of(entry: Any) -> str | None:
    """The shelf a scoped collection stated, tolerating plain strings."""
    shelf = getattr(entry, "shelf", None)
    if shelf is None:
        return None
    return getattr(shelf, "value", None) or str(shelf)


def collection_of(entry: Any) -> str | None:
    """The collection name of a scoped-collection entry."""
    name = getattr(entry, "collection", None)
    return None if name is None else str(name)


def build_retrieval_input(
    *,
    query: str,
    retrieval_query: str | None,
    collections: list[Any],
    candidate_k: int,
    top_k: int,
    reranked: bool,
    dropped_by_floor: int,
    requery_queries: list[str] | None = None,
) -> dict[str, Any]:
    """What the search asked for — the half that explains WHY these picks.

    Pure, so tests can pin the shape without a NAT context.
    """
    payload: dict[str, Any] = {
        "query": query,
        "retrieval_query": retrieval_query,
        "collections": [
            _compact({"collection": collection_of(entry), "shelf": _shelf_of(entry)}) for entry in collections
        ],
        "candidate_k": candidate_k,
        "top_k": top_k,
        "reranked": reranked,
        # The relevance floor is the only stage that can empty an otherwise
        # non-empty result, so its toll belongs next to the picks.
        "dropped_by_floor": dropped_by_floor,
        # The alternative formulations the retrieval loop fanned out to after
        # judging the first pool insufficient. Absent on a one-shot search, so
        # "how often does the loop fire, and on which questions" is a query
        # over the traces rather than a guess.
        "requery_queries": list(requery_queries) if requery_queries else None,
    }
    return _compact(payload)


def build_retrieval_output(*, chunks: list[Any]) -> dict[str, Any]:
    """The picks themselves — ids and scores, never chunk text.

    Accepts anything shaped like ``aiq_agent.knowledge.schema.Chunk``
    (attribute access); fields the backend did not populate stay absent.
    """
    picked = []
    for chunk in chunks[:PICK_LIMIT]:
        metadata = getattr(chunk, "metadata", None) or {}
        score = getattr(chunk, "score", None)
        picked.append(
            _compact(
                {
                    "chunk_id": getattr(chunk, "chunk_id", None),
                    "file": getattr(chunk, "file_name", None),
                    "page": getattr(chunk, "page_number", None),
                    "score": round(score, 4) if score is not None else None,
                    "collection": metadata.get("collection"),
                    "shelf": metadata.get("shelf"),
                    "doc_class": metadata.get("doc_class"),
                }
            )
        )
    return {"picked": picked}


def emit_retrieval_span(*, tool_name: str, search_input: dict[str, Any], picks: dict[str, Any]) -> None:
    """Push ONE balanced custom FUNCTION step recording the search's outcome.

    Input carries the query/budget side, output the picks, mirroring how every
    other span renders input/output in Langfuse. Never raises.
    """
    try:
        from nat.builder.context import Context
        from nat.data_models.intermediate_step import IntermediateStepPayload
        from nat.data_models.intermediate_step import IntermediateStepType
        from nat.data_models.intermediate_step import StreamEventData

        body_input = json.dumps(search_input, ensure_ascii=False, separators=(",", ":"))
        body_output = json.dumps(picks, ensure_ascii=False, separators=(",", ":"))
        step_name = f"retrieve.{tool_name}"
        step_id = str(uuid.uuid4())
        manager = Context.get().intermediate_step_manager
        started = False
        try:
            manager.push_intermediate_step(
                IntermediateStepPayload(
                    UUID=step_id,
                    event_type=IntermediateStepType.FUNCTION_START,
                    name=step_name,
                    data=StreamEventData(input=body_input),
                )
            )
            started = True
        except Exception:  # noqa: BLE001
            logger.debug("Retrieval pick START not emitted", exc_info=True)
        finally:
            if started:
                try:
                    # Same UUID, immediately: closes the span this call opened so the next
                    # real END still pops exactly one frame (see push_custom_step).
                    manager.push_intermediate_step(
                        IntermediateStepPayload(
                            UUID=step_id,
                            event_type=IntermediateStepType.FUNCTION_END,
                            name=step_name,
                            data=StreamEventData(input=body_input, output=body_output),
                        )
                    )
                except Exception:  # noqa: BLE001
                    logger.debug("Retrieval pick END not emitted", exc_info=True)
    except Exception:  # noqa: BLE001 - telemetry must never take a turn down
        logger.debug("Retrieval pick span not emitted", exc_info=True)
