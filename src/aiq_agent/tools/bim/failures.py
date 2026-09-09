"""The ways the two BIM tools fail, said once.

Every text here is read by the agent, not by a person, so each says what to DO:
retry with different arguments, do not retry at all, or tell the user. The
distinction between "the arguments were wrong" and "nothing could be read" is
the whole point — every 4xx used to arrive as an outage, which ends a turn on a
typo with the agent told to say nothing about the building
(``docs/roadmap/ifc-review-findings.md``).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass

from aiq_agent.knowledge.bim_query import BimQueryRejectedError
from aiq_agent.knowledge.bim_query import BimQueryUnavailableError
from aiq_agent.knowledge.ifc_spatial_client import ModelTooLargeError
from aiq_agent.knowledge.ifc_spatial_client import SpatialEngineUnavailableError
from aiq_agent.knowledge.ifc_spatial_client import SpatialToolError

#: No project on this conversation, so there is no model to address. "Do not
#: retry" is the operative half: no argument can fix it, and without being told
#: so the agent retries until its tool budget runs out.
NO_PROJECT_TEXT = (
    "Error: this conversation is not attached to a project, so no BIM model can be selected. "
    "Do not retry — no argument to this tool can fix it. Tell the user (in German) that the "
    "question refers to a building model and that they need to open the conversation inside the "
    "project the model belongs to. Do not state anything about the building."
)

NO_ORG_TEXT = "Error: organization unknown for this session — the BIM model cannot be read. Do not retry."

#: Nothing was looked at. "Could not look" is not "looked and found nothing".
UNAVAILABLE_TEXT = (
    "Error: das Modell konnte gerade nicht gelesen werden (der Modelldienst ist nicht erreichbar). "
    "Do NOT state anything about the building's geometry; tell the user the model could not be read."
)

QUERY_UNAVAILABLE_TEXT = (
    "Error: the BIM model could not be queried right now (the model service is "
    "unavailable). Do NOT state anything about the building's contents; tell the user "
    "the model could not be read."
)

#: This deployment has no geometry engine. Not a fact about the building either.
ENGINE_UNAVAILABLE_TEXT = (
    "Error: geometric measurement is not available in this deployment (the spatial engine is not "
    "installed). Metadata questions can still be answered with ifc_query. Do NOT estimate the number."
)


def rejected_text(reason: str) -> str:
    """The arguments were wrong, and that is fixable in this same turn."""
    return (
        f"Error: the request was rejected — {reason}. This is a problem with the arguments, not "
        "with the model. Correct them and call the tool again. Do NOT state anything about the "
        "building on the strength of this."
    )


def unrunnable_text(reason: str) -> str:
    """The call could not be MADE — distinct from ``decidable: false``, which is an answer.

    A wrong KIND (asking a wall for its clear opening width) means the id is
    right and the operator is not; sending the agent back to ``find_elements``
    for that would loop. The engine's message names the operator to use.
    """
    if "Fehler im Aufruf" in reason:
        return (
            f"Error: {reason}. The GlobalId is fine — the OPERATOR is wrong for this kind of "
            "element. Do not look the id up again; use the operator named above."
        )
    return (
        f"Error: {reason}. This is a problem with the arguments, not with the building — "
        "check the GlobalId with operation='find_elements' and call again."
    )


def too_large_text(model_bytes: int | None, limit_bytes: int) -> str:
    """A model this worker cannot hold — a fact about the FILE, not an outage, so waiting does not help."""
    size = f"{model_bytes / (1024 * 1024):.0f} MB" if model_bytes else "Dieses Modell"
    limit = f"{limit_bytes // (1024 * 1024)} MB"
    return (
        f"Error: das Modell ({size}) ist zu groß für die geometrische Auswertung auf diesem Server "
        f"(Grenze {limit}). Das ist eine Aussage über die DATEI, kein Ausfall — Warten hilft nicht. "
        "Dem Nutzer sagen: entweder das Modell nach Bauteil oder Bauabschnitt getrennt exportieren, "
        "oder einen größeren Auswerte-Server anfordern. Metadaten-Fragen (Bauteillisten, "
        "Property-Werte, Zählungen) sind mit ifc_query weiterhin beantwortbar — die laufen über den "
        "extrahierten Index und nicht über die Datei. Keine Maße schätzen."
    )


@dataclass(frozen=True)
class Failure:
    """One exception a tool body catches: how loud to log it, what the trace calls it, what the agent reads."""

    exception: type[BaseException]
    level: int
    outcome: str
    text: Callable[[BaseException], str]


class FailureTable:
    """The ordered exception → :class:`Failure` mapping of one tool.

    Ordered because a subclass (``ModelTooLargeError``) must be matched before
    its base; ``exceptions`` is what the ``except`` clause takes.
    """

    def __init__(self, *failures: Failure) -> None:
        self._failures = failures
        self.exceptions: tuple[type[BaseException], ...] = tuple(failure.exception for failure in failures)

    def describe(self, exc: BaseException) -> Failure:
        return next(failure for failure in self._failures if isinstance(exc, failure.exception))


def _constant(text: str) -> Callable[[BaseException], str]:
    return lambda _exc: text


QUERY_FAILURES = FailureTable(
    Failure(BimQueryRejectedError, logging.INFO, "rejected", lambda exc: rejected_text(str(exc))),
    Failure(BimQueryUnavailableError, logging.WARNING, "service_unavailable", _constant(QUERY_UNAVAILABLE_TEXT)),
)

MEASURE_FAILURES = FailureTable(
    Failure(BimQueryRejectedError, logging.INFO, "rejected", lambda exc: rejected_text(str(exc))),
    Failure(
        ModelTooLargeError,
        logging.INFO,
        "model_too_large",
        lambda exc: too_large_text(exc.model_bytes, exc.limit_bytes),  # type: ignore[attr-defined]
    ),
    Failure(BimQueryUnavailableError, logging.WARNING, "service_unavailable", _constant(UNAVAILABLE_TEXT)),
    Failure(SpatialEngineUnavailableError, logging.WARNING, "engine_unavailable", _constant(ENGINE_UNAVAILABLE_TEXT)),
    Failure(SpatialToolError, logging.INFO, "rejected", lambda exc: unrunnable_text(str(exc))),
)
