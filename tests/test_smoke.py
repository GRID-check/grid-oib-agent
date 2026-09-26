"""The smoke's verdict: the part of `scripts/turn_census/smoke.py` a CI machine can run without a key.

A smoke that misreads its own log reports production bugs as passes, so the
reading is pinned here against log text in the exact shape `nat run` prints.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

from smoke import QUESTION  # noqa: E402
from smoke import judge  # noqa: E402

from aiq_agent.common.canned_replies import NON_ANSWER_PREFIXES  # noqa: E402
from aiq_agent.common.canned_replies import SCOPED_NO_SOURCES_MESSAGE  # noqa: E402

_SOURCES = "\n\n## Quellen\n- [1] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.1"
_ANSWER = (
    f"\x1b[32mWorkflow Result:\nDie OIB-Richtlinie 2 regelt den Brandschutz [1].{_SOURCES}\x1b[39m\n"
    "--------------------------------------------------\n"
)
_NOTHING = f"Workflow Result:\n{SCOPED_NO_SOURCES_MESSAGE}\n"
_INFO = "2026-09-25 19:18:43 - INFO     - aiq_agent.agents.piloti.conversation:679 - Conversation: Starting turn\n"
_WARNING = "2026-09-25 19:18:48 - WARNING  - knowledge_layer.llamaindex.adapter:4293 - Collection 'x' not found\n"


def test_a_clean_run_with_a_real_answer_passes():
    verdict = judge(_INFO + _WARNING + _ANSWER, corpus=True)
    assert verdict.failures == []
    assert verdict.answer.startswith("Die OIB-Richtlinie 2 regelt den Brandschutz [1].")


def test_an_error_record_fails_it_whatever_the_answer():
    # #656 in the shape it was logged: the turn recovered and answered, and it
    # still filed an issue.
    error = (
        "2026-09-12 19:43:02 - ERROR    - aiq_agent.common.callbacks:236 - "
        "[Tool Error] 1 validation error for InputArgsSchema\n"
    )
    verdict = judge(_INFO + error + _ANSWER, corpus=True)
    assert len(verdict.failures) == 1
    assert "InputArgsSchema" in verdict.failures[0]


def test_a_traceback_and_an_unawaited_coroutine_fail_it():
    traceback = "Traceback (most recent call last):\n  File \"x.py\", line 1\nKeyError: 'name'\n"
    warning = (
        "base_exporter.py:300: RuntimeWarning: coroutine '_DisabledSpanExporter.export' was never awaited\n"
        "RuntimeWarning: Enable tracemalloc to get the object allocation traceback\n"
    )
    failures = judge(_INFO + traceback + warning + warning + _ANSWER, corpus=False).failures
    assert [f.split(":", 1)[0] for f in failures] == ["traceback", "warning"]
    # Once, counted: the same warning per trace event is one finding, and
    # Python's tracemalloc hint is not a second one.
    assert failures[1].endswith("was never awaited (x2)")


def test_no_answer_fails_it():
    assert judge(_INFO + "census: timed out after 600s\n", corpus=False).failures == [
        "no answer before the census timeout"
    ]


def test_without_the_corpus_only_the_error_gate_runs_and_says_so():
    verdict = judge(_INFO + _NOTHING, corpus=False)
    assert verdict.failures == []
    assert verdict.notes and "not checked" in verdict.notes[0]


def test_with_the_corpus_every_canned_non_answer_fails():
    # Matched on the replies' own constants, not a copied phrase: a reworded
    # canned reply must not slip past the smoke the way a paraphrase could.
    for reply in NON_ANSWER_PREFIXES:
        failures = judge(f"Workflow Result:\n{reply} Brandschutz.{_SOURCES}\n", corpus=True).failures
        assert len(failures) == 1 and "canned non-answer" in failures[0], reply


def test_with_the_corpus_an_answer_without_a_knowledge_base_source_fails():
    # "Ich habe nichts zum Brandschutz gefunden" says Brandschutz and is no
    # canned reply; what it lacks is a passage from the corpus.
    paraphrase = "Workflow Result:\nIch habe nichts zum Brandschutz gefunden.\n"
    assert judge(paraphrase, corpus=True).failures == ["the corpus is ingested and the answer cites no [KB] source"]
    web_only = "Workflow Result:\nBrandschutz [1].\n\n## Quellen\n- [1] [Web] https://www.oib.or.at\n"
    assert judge(web_only, corpus=True).failures == ["the corpus is ingested and the answer cites no [KB] source"]


def test_the_brandschutz_check_belongs_to_the_default_question_only():
    off_topic = f"Workflow Result:\nDie OIB-Richtlinie 2 regelt die Raumhöhe [1].{_SOURCES}\n"
    assert judge(off_topic, corpus=True, question=QUESTION).failures == [
        "an answer about OIB-Richtlinie 2 that never says Brandschutz"
    ]
    escape_route = f"Workflow Result:\nIn GK 4 gelten 40 m Fluchtweglänge [1].{_SOURCES}\n"
    assert judge(escape_route, corpus=True, question="Welche Fluchtweglänge gilt in GK 4?").failures == []


def test_a_required_corpus_that_is_missing_fails_instead_of_skipping():
    # Once a snapshot is published, not restoring it is a broken restore, not
    # the bootstrap case, and must not pass as "only the ERROR gate ran".
    verdict = judge(_INFO + _ANSWER, corpus=False, require_corpus=True)
    assert verdict.failures == ["a corpus snapshot is published but none is ingested here"]
    assert verdict.notes == []
