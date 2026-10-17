"""The typed quarantine verdict's producer side of ``tests/fixtures/quarantine_verdict_cases.json``.

The ingest job records why the upload screen held a file back as
``FileProgress.quarantine`` (ADR-0113), and the BFF reads it with ``verdictSchema``
(``frontends/ui/src/lib/upload-screening/quarantine.ts``), whose spec reads the
same file. Here: each verdict round-trips through the model in exactly the
fixture's shape, screening a case's pages produces exactly its verdict, the
legacy ``quarantined:`` string is the same JSON, and the job status and the
collection file list carry it as written.
"""

import dataclasses
import json
from pathlib import Path

import pytest
from knowledge_layer.llamaindex.adapter import _file_info_from_job
from knowledge_layer.llamaindex.screening import QUARANTINED_PREFIX
from knowledge_layer.llamaindex.screening import ScreeningRules
from knowledge_layer.llamaindex.screening import quarantine_error
from knowledge_layer.llamaindex.screening import screen_pages

from aiq_agent.knowledge.schema import FileProgress
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState
from aiq_agent.knowledge.schema import QuarantineVerdict

FIXTURE_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "quarantine_verdict_cases.json"
CASES = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["cases"]
SCREENED = [case for case in CASES if "screen" in case]


def _pages(screen: dict) -> list[tuple[int | None, str]]:
    pages: list[tuple[int | None, str]] = []
    for span in screen["pages"]:
        if span["from"] is None:
            pages.append((None, span["text"]))
            continue
        pages.extend((page, span["text"]) for page in range(span["from"], span["to"] + 1))
    return pages


def _screened(screen: dict):
    rules = ScreeningRules.build(screen["terms"], screen["detectors"])
    assert rules is not None
    return screen_pages(_pages(screen), rules, checked=screen["checked"])


def test_the_fixture_covers_what_the_reader_must_survive():
    verdicts = [case["verdict"] for case in CASES]
    reasons = [reason for verdict in verdicts for reason in verdict["reasons"]]
    assert any("omitted" in verdict for verdict in verdicts)
    assert any(reason.get("pages_truncated") for reason in reasons)
    assert any(reason["kind"] not in {"term", "iban", "at_svnr", "credit_card"} for reason in reasons)
    assert {verdict["checked"] for verdict in verdicts} == {"full", "partial"}
    assert any(verdict.get("after_transcription") for verdict in verdicts)
    assert len(SCREENED) >= 4


def test_a_verdict_from_the_transcript_says_so_and_one_from_the_text_layer_does_not():
    screen = SCREENED[0]["screen"]
    from_text = _screened(screen)
    from_transcript = dataclasses.replace(from_text, after_transcription=True)

    assert "after_transcription" not in from_text.to_model().model_dump()
    assert from_transcript.to_model().model_dump()["after_transcription"] is True
    legacy = json.loads(quarantine_error(from_transcript)[len(QUARANTINED_PREFIX) :])
    assert legacy["after_transcription"] is True


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_the_model_writes_the_fixture_shape(case):
    assert QuarantineVerdict.model_validate(case["verdict"]).model_dump() == case["verdict"]


@pytest.mark.parametrize("case", SCREENED, ids=[case["name"] for case in SCREENED])
def test_the_screen_produces_exactly_this_verdict(case):
    verdict = _screened(case["screen"])

    assert verdict.to_model().model_dump() == case["verdict"]


@pytest.mark.parametrize("case", SCREENED, ids=[case["name"] for case in SCREENED])
def test_the_legacy_string_is_the_same_json(case):
    error = quarantine_error(_screened(case["screen"]))

    assert error.startswith(QUARANTINED_PREFIX)
    assert json.loads(error[len(QUARANTINED_PREFIX) :]) == case["verdict"]


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_the_job_status_and_the_file_list_carry_it_as_written(case):
    verdict = QuarantineVerdict.model_validate(case["verdict"])
    detail = FileProgress(file_name="Abrechnung.pdf", status=FileStatus.FAILED, quarantine=verdict)
    job = IngestionJobStatus(
        job_id="job-1",
        status=JobState.FAILED,
        submitted_at="2026-10-17T00:00:00",
        total_files=1,
        collection_name="c",
        backend="llamaindex",
        file_details=[detail],
    )

    persisted = json.loads(job.model_dump_json())
    assert persisted["file_details"][0]["quarantine"] == case["verdict"]
    restored = IngestionJobStatus.model_validate(persisted)
    assert restored.file_details[0].quarantine == verdict
    listed = json.loads(_file_info_from_job(restored, restored.file_details[0]).model_dump_json())
    assert listed["quarantine"] == case["verdict"]


def test_a_file_the_screen_did_not_hold_carries_no_verdict():
    assert json.loads(FileProgress(file_name="Plan.pdf").model_dump_json())["quarantine"] is None
