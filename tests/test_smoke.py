"""The smoke's verdict and its socket client: the parts of the smoke a CI machine can run without a key.

A smoke that misreads its own log or its own frames reports production bugs as
passes, so the reading is pinned here: log records in the exact shape the
server writes them, and socket frames in the exact shape the server sent them
on 2026-09-26 (a step, a clarifier's prompt, a COMPLETE answer with its
Quellen).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import served  # noqa: E402
from smoke import QUESTION  # noqa: E402
from smoke import judge  # noqa: E402
from smoke import startup_notes  # noqa: E402

from aiq_agent.common.canned_replies import NON_ANSWER_PREFIXES  # noqa: E402
from aiq_agent.common.canned_replies import SCOPED_NO_SOURCES_MESSAGE  # noqa: E402

_SOURCES = "\n\n## Quellen\n- [1] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.1"
_ANSWER = f"Die OIB-Richtlinie 2 regelt den Brandschutz [1].{_SOURCES}"
_INFO = "2026-09-25 19:18:43 - INFO     - aiq_agent.agents.piloti.conversation:679 - Conversation: Starting turn\n"
_WARNING = "2026-09-25 19:18:48 - WARNING  - knowledge_layer.llamaindex.adapter:4293 - Collection 'x' not found\n"
_NEVER_RETRIEVED = "2026-09-26 16:44:31 - ERROR    - asyncio:1886 - Task exception was never retrieved\n"


def test_a_clean_run_with_a_real_answer_passes():
    verdict = judge(_INFO + _WARNING, answer=_ANSWER, corpus=True)
    assert verdict.failures == []


def test_an_error_record_fails_it_whatever_the_answer():
    # #656 in the shape it was logged: the turn recovered and answered, and it
    # still filed an issue.
    error = (
        "2026-09-12 19:43:02 - ERROR    - aiq_agent.common.callbacks:236 - "
        "[Tool Error] 1 validation error for InputArgsSchema\n"
    )
    verdict = judge(_INFO + error, answer=_ANSWER, corpus=True)
    assert len(verdict.failures) == 1
    assert "InputArgsSchema" in verdict.failures[0]


def test_a_cancelled_turn_that_leaks_fails_it():
    # What the served smoke logged against the socket handler before #769:
    # the answers were fine, the teardown of the cancelled turn was not.
    verdict = judge(_INFO + _NEVER_RETRIEVED * 3, answer=_ANSWER, corpus=True)
    assert verdict.failures == [f"logged at ERROR: {_NEVER_RETRIEVED.strip()} (x3)"]


def test_a_traceback_and_an_unawaited_coroutine_fail_it():
    traceback = "Traceback (most recent call last):\n  File \"x.py\", line 1\nKeyError: 'name'\n"
    warning = (
        "base_exporter.py:300: RuntimeWarning: coroutine '_DisabledSpanExporter.export' was never awaited\n"
        "RuntimeWarning: Enable tracemalloc to get the object allocation traceback\n"
    )
    failures = judge(_INFO + traceback + warning + warning, answer=_ANSWER, corpus=False).failures
    assert [f.split(":", 1)[0] for f in failures] == ["traceback", "warning"]
    # Once, counted: the same warning per trace event is one finding, and
    # Python's tracemalloc hint is not a second one.
    assert failures[1].endswith("was never awaited (x2)")


def test_no_answer_and_a_follow_up_that_never_completed_fail_it():
    assert judge(_INFO, answer="", corpus=False, follow_up_completed=False).failures == [
        "the turn sent after a cancel never completed",
        "no answer",
    ]


def test_what_the_backend_logs_while_starting_is_a_note_not_a_failure():
    # It runs without its BFF, and the internal-API check rightly says so.
    boot = (
        "2026-09-26 16:43:30 - ERROR    - aiq_agent.knowledge.project_memory:381 - "
        "Cannot verify the internal API: GRID_INTERNAL_API_TOKEN is not configured\n"
    )
    notes = startup_notes(_INFO + boot)
    assert len(notes) == 1 and "GRID_INTERNAL_API_TOKEN" in notes[0]


def test_without_the_corpus_only_the_error_gate_runs_and_says_so():
    verdict = judge(_INFO, answer=SCOPED_NO_SOURCES_MESSAGE, corpus=False)
    assert verdict.failures == []
    assert verdict.notes and "not checked" in verdict.notes[0]


def test_with_the_corpus_every_canned_non_answer_fails():
    # Matched on the replies' own constants, not a copied phrase: a reworded
    # canned reply must not slip past the smoke the way a paraphrase could.
    for reply in NON_ANSWER_PREFIXES:
        failures = judge("", answer=f"{reply} Brandschutz.{_SOURCES}", corpus=True).failures
        assert len(failures) == 1 and "canned non-answer" in failures[0], reply


def test_with_the_corpus_an_answer_without_a_knowledge_base_source_fails():
    # "Ich habe nichts zum Brandschutz gefunden" says Brandschutz and is no
    # canned reply; what it lacks is a passage from the corpus.
    missing = ["the corpus is ingested and the answer cites no [KB] source"]
    assert judge("", answer="Ich habe nichts zum Brandschutz gefunden.", corpus=True).failures == missing
    web_only = "Brandschutz [1].\n\n## Quellen\n- [1] [Web] https://www.oib.or.at"
    assert judge("", answer=web_only, corpus=True).failures == missing


def test_the_brandschutz_check_belongs_to_the_default_question_only():
    off_topic = f"Die OIB-Richtlinie 2 regelt die Raumhöhe [1].{_SOURCES}"
    assert judge("", answer=off_topic, corpus=True, question=QUESTION).failures == [
        "an answer about OIB-Richtlinie 2 that never says Brandschutz"
    ]
    escape_route = f"In GK 4 gelten 40 m Fluchtweglänge [1].{_SOURCES}"
    assert judge("", answer=escape_route, corpus=True, question="Welche Fluchtweglänge gilt in GK 4?").failures == []


def test_a_required_corpus_that_is_missing_fails_instead_of_skipping():
    # Once a snapshot is published, not restoring it is a broken restore, not
    # the bootstrap case, and must not pass as "only the ERROR gate ran".
    verdict = judge(_INFO, answer=_ANSWER, corpus=False, require_corpus=True)
    assert verdict.failures == ["a corpus snapshot is published but none is ingested here"]
    assert verdict.notes == []


# --- The socket client, on frames in the shape the server sent them -----------

_STEP = {
    "type": "system_intermediate_message",
    "id": "46a50b8c",
    "parent_id": "root",
    "conversation_id": "c",
    "content": {"name": "Function Start: <workflow>", "payload": "**Function Input:**"},
    "status": "in_progress",
}


def _complete(parent_id: str, text: str) -> dict:
    return {
        "type": "system_response_message",
        "id": "research_response",
        "parent_id": parent_id,
        "conversation_id": "c",
        "content": {"text": text},
        "status": "complete",
    }


def _prompt(parent_id: str, options: list[dict]) -> dict:
    return {
        "type": "system_interaction_message",
        "id": "prompt-1",
        "parent_id": parent_id,
        "conversation_id": "c",
        "content": {"input_type": "radio", "text": "**Schwerpunkt**: Was möchtest du wissen?", "options": options},
    }


def test_a_turn_takes_its_steps_and_only_its_own_answer():
    turn = served.Turn(message_id="m2")
    served.read_frame(turn, _STEP)
    served.read_frame(turn, _complete("m1", "the cancelled turn's closing frame"))
    assert not turn.completed
    served.read_frame(turn, _complete("m2", _ANSWER))
    assert turn.completed and turn.answer == _ANSWER
    assert turn.steps == [{"name": "Function Start: <workflow>", "payload": "**Function Input:**"}]


def test_a_clarifying_question_is_answered_with_the_first_option_as_the_ui_does():
    turn = served.Turn(message_id="m1")
    reply = served.clarification_reply(turn, _prompt("m1", [{"id": "a", "label": "Inhalt und Aufbau", "value": "a"}]))
    frame = json.loads(reply)
    assert frame["type"] == "user_interaction_message" and frame["parent_id"] == "m1"
    assert frame["content"]["messages"][0]["content"][0]["text"] == "Inhalt und Aufbau"
    assert turn.clarifications == 1
    # Another turn's prompt, and a notification, need no answer.
    assert served.clarification_reply(turn, _prompt("other", [])) is None
    notification = {**_prompt("m1", []), "content": {"input_type": "notification", "text": "…"}}
    assert served.clarification_reply(turn, notification) is None


def test_a_user_message_is_the_frame_the_ui_sends():
    raw, message_id = served.user_message("Was weißt du über die OIB-Richtlinie 2?", "conv-1")
    frame = json.loads(raw)
    assert frame["id"] == message_id and frame["type"] == "user_message" and frame["schema_type"] == "chat_stream"
    text = frame["content"]["messages"][0]["content"][0]["text"]
    assert json.loads(text) == {"query": "Was weißt du über die OIB-Richtlinie 2?"}
