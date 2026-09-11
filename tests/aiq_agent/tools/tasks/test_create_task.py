"""``create_task``: what goes on the wire, what is refused, and what the reader sees.

The properties under test are the seam's, not the model's: the signed bytes leave
unchanged, a run with no acting person delegates nothing, an unknown kind is
refused before anything is posted, and the success sentence says the work is
QUEUED rather than done — which is the sentence this whole tool exists to make
true.
"""

from __future__ import annotations

import pytest

from aiq_agent.tools.tasks import register as task_tools
from aiq_agent.tools.tasks.client import DelegationError

from .conftest import ACCEPTED
from .conftest import ENVELOPE_HEADER
from .conftest import ENVELOPE_SIG
from .conftest import PROJECT
from .conftest import bind_context
from .conftest import envelope
from .conftest import raiser
from .conftest import responder
from .conftest import task_cards


class TestTheWire:
    """What the tool posts, and whose identity it posts under."""

    async def test_it_posts_a_create_with_the_project_kind_and_goal(self, monkeypatch, calls) -> None:
        responder(monkeypatch, ACCEPTED, calls)
        await task_tools.run_create_task("einreichcheck", "Mach den Einreichcheck bis Freitag")

        payload, _ = calls[0]
        assert payload["op"] == "create"
        assert payload["projectId"] == PROJECT
        assert payload["kind"] == "einreichcheck"
        assert payload["goal"] == "Mach den Einreichcheck bis Freitag"

    async def test_it_echoes_the_envelope_unchanged(self, monkeypatch, calls) -> None:
        """Echo, never sign. The BFF reads the acting person out of THESE bytes."""
        responder(monkeypatch, ACCEPTED, calls)
        await task_tools.run_create_task("einreichcheck", "Prüf das")

        _, envelope = calls[0]
        assert envelope.header == ENVELOPE_HEADER
        assert envelope.signature == ENVELOPE_SIG

    async def test_a_due_date_is_forwarded_and_an_empty_one_is_omitted(self, monkeypatch, calls) -> None:
        responder(monkeypatch, ACCEPTED, calls)
        await task_tools.run_create_task("einreichcheck", "Prüf das", "2026-09-18")
        assert calls[0][0]["due"] == "2026-09-18"

        await task_tools.run_create_task("einreichcheck", "Prüf das", "   ")
        # Absent, not empty: the BFF's schema is strict and `""` is not a date.
        assert "due" not in calls[1][0]

    async def test_the_goal_is_collapsed_and_bounded(self, monkeypatch, calls) -> None:
        responder(monkeypatch, ACCEPTED, calls)
        await task_tools.run_create_task("document", "  Schreib   den\n  Aktenvermerk  ")
        assert calls[0][0]["goal"] == "Schreib den Aktenvermerk"

        await task_tools.run_create_task("document", "x" * (task_tools.MAX_GOAL_CHARS + 50))
        assert len(calls[1][0]["goal"]) == task_tools.MAX_GOAL_CHARS


class TestRefusals:
    """Every refusal happens BEFORE the call, and says nothing was created."""

    async def test_a_run_with_no_envelope_delegates_nothing(self, monkeypatch, calls) -> None:
        """A CLI run, an eval, the job worker: no signed session, so nobody to act as."""
        responder(monkeypatch, ACCEPTED, calls)
        bind_context(monkeypatch, headers={"x-grid-project-id": PROJECT}, conversation_id="conv-1")

        answer = await task_tools.run_create_task("einreichcheck", "Prüf das")
        assert "Sitzungsnachweis" in answer
        assert calls == []

    async def test_a_turn_with_no_project_delegates_nothing(self, monkeypatch, calls) -> None:
        """A task hangs off a project; a chat with none has nowhere to put one.

        The envelope is re-minted WITHOUT `projectId` rather than the raw header
        being dropped, because the envelope wins: a test that only removed
        `x-grid-project-id` would still find the project and would be asserting
        nothing.
        """
        responder(monkeypatch, ACCEPTED, calls)
        header, signature = envelope(
            {"organizationId": "org_1", "userId": "user_1", "conversationId": "conv-1", "issuedAt": 1_757_500_000_000}
        )
        bind_context(
            monkeypatch,
            headers={"x-grid-request-context": header, "x-grid-request-context-sig": signature},
            conversation_id="conv-1",
        )

        answer = await task_tools.run_create_task("einreichcheck", "Prüf das")
        assert "kein Projekt" in answer
        assert calls == []

    async def test_an_unknown_kind_is_refused_with_the_set_named(self, monkeypatch, calls) -> None:
        responder(monkeypatch, ACCEPTED, calls)
        answer = await task_tools.run_create_task("kostenschaetzung", "Rechne das durch")
        assert "keine Auftragsart" in answer
        for kind in task_tools.TASK_KINDS:
            assert kind in answer
        assert calls == []

    async def test_an_empty_goal_is_refused(self, monkeypatch, calls) -> None:
        responder(monkeypatch, ACCEPTED, calls)
        answer = await task_tools.run_create_task("einreichcheck", "   ")
        assert "Beschreibung" in answer
        assert calls == []

    async def test_a_refusal_from_the_route_says_nothing_was_created(self, monkeypatch) -> None:
        raiser(monkeypatch, DelegationError("the task API refused the call (403)", status=403))
        answer = await task_tools.run_create_task("einreichcheck", "Prüf das")
        assert "nicht angenommen" in answer


class TestWhatTheReaderSees:
    """The card and the sentence: proof of a row, and a claim that is true."""

    async def test_it_emits_one_task_created_card_from_the_routes_own_answer(
        self, monkeypatch, calls, registry
    ) -> None:
        responder(monkeypatch, ACCEPTED, calls)
        await task_tools.run_create_task("einreichcheck", "Mach den Einreichcheck bis Freitag", "2026-09-18")

        cards = task_cards(registry)
        assert len(cards) == 1
        # Every fact ON the card is the ROUTE's, not what this tier asked for, so
        # a card can never describe a task the BFF declined to create that way.
        assert cards[0]["task_id"] == "task-1"
        assert cards[0]["title"] == "Einreichcheck: Bauansuchen Haus A"
        assert cards[0]["conversation_id"] == "s_conv_2"
        assert cards[0]["due_at"] == "2026-09-18T23:59:59.999Z"
        assert cards[0]["goal"] == "Mach den Einreichcheck bis Freitag"

    async def test_the_answer_says_the_work_is_running_and_not_done(self, monkeypatch, calls) -> None:
        responder(monkeypatch, ACCEPTED, calls)
        answer = await task_tools.run_create_task("einreichcheck", "Prüf das")
        assert "angelegt" in answer
        assert "NICHT erledigt" in answer

    async def test_a_missing_card_registry_does_not_cost_the_delegation(self, monkeypatch, calls) -> None:
        """A CLI run has no card channel; the ROW is the product, the card is the announcement."""
        responder(monkeypatch, ACCEPTED, calls)
        answer = await task_tools.run_create_task("einreichcheck", "Prüf das")
        assert "Auftrag angelegt" in answer
        assert len(calls) == 1

    async def test_an_answer_with_no_task_id_emits_no_card(self, monkeypatch, calls, registry) -> None:
        responder(monkeypatch, {**ACCEPTED, "taskId": ""}, calls)
        await task_tools.run_create_task("einreichcheck", "Prüf das")
        assert task_cards(registry) == []


@pytest.mark.parametrize("kind", ["compliance_check", "einreichcheck", "document", "revision"])
async def test_every_declared_kind_is_accepted(monkeypatch, calls, kind: str) -> None:
    """The four kinds are the four engines; a fifth would be a queue with nothing to run."""
    responder(monkeypatch, {**ACCEPTED, "kind": kind}, calls)
    await task_tools.run_create_task(kind, "Tu das")
    assert calls[0][0]["kind"] == kind
