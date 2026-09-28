"""„Jetzt schreiben": the reader's one lever over a running deep research."""

import asyncio

from aiq_agent.agents.deep_researcher.control import bind_write_now
from aiq_agent.agents.deep_researcher.control import reset_write_now
from aiq_agent.agents.deep_researcher.control import write_now_requested
from aiq_agent.agents.deep_researcher.finalize import _prepend_honesty_banner
from aiq_agent.common.turn_status import CUTOFF_USER_REQUESTED


def test_nothing_bound_means_nothing_requested():
    assert write_now_requested() is False


def test_the_bound_signal_is_read_and_the_binding_is_per_run():
    signal = asyncio.Event()
    token = bind_write_now(signal)
    try:
        assert write_now_requested() is False
        signal.set()
        assert write_now_requested() is True
    finally:
        reset_write_now(token)
    assert write_now_requested() is False


def test_the_banner_names_the_readers_choice_not_a_limit():
    line = _prepend_honesty_banner(
        "# Bericht", cutoff_reason=CUTOFF_USER_REQUESTED, degraded_reasons=None
    ).splitlines()[0]
    assert "auf Ihren Wunsch" in line and "unvollständig" in line
    english = _prepend_honesty_banner(
        "# Report\n\nThe escape route is compliant and the fire resistance is REI 60.",
        cutoff_reason=CUTOFF_USER_REQUESTED,
        degraded_reasons=None,
    ).splitlines()[0]
    assert "at your request" in english


def test_added_documents_are_drained_once_and_the_binding_is_per_run():
    from aiq_agent.agents.deep_researcher.control import bind_added_documents
    from aiq_agent.agents.deep_researcher.control import reset_added_documents
    from aiq_agent.agents.deep_researcher.control import take_added_documents
    from aiq_agent.common.plan_documents import PlanDocument

    assert take_added_documents() == []
    queue: list[PlanDocument] = []
    token = bind_added_documents(queue)
    try:
        queue.append(PlanDocument(name="nachtrag.pdf", title="Nachtrag"))
        assert [d.name for d in take_added_documents()] == ["nachtrag.pdf"]
        assert take_added_documents() == []
        # The list itself is left whole: it is the monitor's dedupe history
        # and the finalizer's account of every addition.
        assert [d.name for d in queue] == ["nachtrag.pdf"]
    finally:
        reset_added_documents(token)
    assert take_added_documents() == []


def test_the_report_names_the_grundlage_it_never_reached():
    from aiq_agent.agents.deep_researcher.finalize import _append_unread_grundlage

    german = _append_unread_grundlage("# Bericht\n\nDer Fluchtweg ist zulässig.", ["Einreichplan.pdf"])
    assert german.rstrip().endswith(
        "## Nicht gelesene Unterlagen\n\nDiese Unterlagen waren als Grundlage benannt "
        "und konnten nicht gelesen werden; ihr Inhalt ist oben nicht berücksichtigt:\n\n"
        "- Einreichplan.pdf"
    )
    english = _append_unread_grundlage(
        "# Report\n\nThe escape route is compliant and the fire resistance is REI 60.", ["plan.pdf"]
    )
    assert "## Documents not read" in english and english.rstrip().endswith("- plan.pdf")
    assert _append_unread_grundlage("# Bericht", []) == "# Bericht"


def test_every_addition_stays_countable_after_it_was_taken():
    from aiq_agent.agents.deep_researcher.control import all_added_documents
    from aiq_agent.agents.deep_researcher.control import bind_added_documents
    from aiq_agent.agents.deep_researcher.control import reset_added_documents
    from aiq_agent.agents.deep_researcher.control import take_added_documents
    from aiq_agent.common.plan_documents import PlanDocument

    queue = [PlanDocument(name="a.pdf")]
    token = bind_added_documents(queue)
    try:
        take_added_documents()
        queue.append(PlanDocument(name="b.pdf"))
        assert [d.name for d in all_added_documents()] == ["a.pdf", "b.pdf"]
        assert [d.name for d in take_added_documents()] == ["b.pdf"]
    finally:
        reset_added_documents(token)
    assert all_added_documents() == []


def test_a_request_is_honoured_only_once_a_batch_was_refused():
    from aiq_agent.agents.deep_researcher.control import begin_write_now_record
    from aiq_agent.agents.deep_researcher.control import end_write_now_record
    from aiq_agent.agents.deep_researcher.control import note_write_now_honoured
    from aiq_agent.agents.deep_researcher.control import write_now_honoured

    note_write_now_honoured()  # nothing recording: a no-op
    assert write_now_honoured() is False
    token = begin_write_now_record()
    try:
        assert write_now_honoured() is False
        note_write_now_honoured()
        assert write_now_honoured() is True
    finally:
        end_write_now_record(token)
    assert write_now_honoured() is False
