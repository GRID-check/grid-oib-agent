"""The report endpoint hands back the run's Grid cards, not only its prose.

Module under test: ``frontends/aiq_api/src/aiq_api/routes/jobs.py``
    GET /v1/jobs/async/job/{job_id}/report

These are ROUTE-level rather than model-level on purpose. The gap this closes
was never that ``JobReportResponse`` lacked a field it could hold — it was that
the handler read ``output["report"]`` and dropped ``output["cards"]`` sitting
next to it in the same blob, so the filed PDF's „Rechtsgrundlagen" section had
nothing to render. A test that constructs the model proves the field exists; only
a request through the handler proves the runner's cards reach the caller.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aiq_agent.auth import Principal

LEGAL_BASIS_CARD = {
    "type": "legal_basis",
    "title": "OIB-Richtlinie 2",
    "lane": "oib",
    "original_text": "Die Anforderungen an das Brandverhalten ...",
}
VERDICT_CARD = {"type": "verdict_header", "title": "Zulässig", "verdict": "REI 90"}


@pytest.fixture
def report_app(tmp_path, monkeypatch):
    """A minimal app carrying the async job routes and a stub job store.

    The job store is the seam these tests drive: ``authorize_job_access`` reads
    the job through it, and the handler reads ``job.output`` — the same jsonb the
    runner writes on success.
    """
    import aiq_api.routes.jobs as jobs_routes

    monkeypatch.setattr(jobs_routes, "_start_periodic_cleanup", MagicMock())

    async def _no_op_reaper(*_args, **_kwargs):
        return None

    monkeypatch.setattr(jobs_routes, "_reap_ghost_jobs", _no_op_reaper)
    monkeypatch.setenv("REQUIRE_AUTH", "false")
    monkeypatch.setattr(jobs_routes, "require_verified_principal", lambda: Principal(type="jwt", sub="user-1"))

    job_store = MagicMock()
    job_store.get_job = AsyncMock(return_value=None)

    worker = SimpleNamespace(
        _dask_available=True,
        _job_store=job_store,
        _scheduler_address="tcp://localhost:8786",
        _db_url=f"sqlite+aiosqlite:///{tmp_path / 'test_job_report_cards.db'}",
        _config_file_path="config.yml",
        _log_level=20,
        _use_dask_threads=False,
        _front_end_config=SimpleNamespace(expiry_seconds=86400),
    )
    return SimpleNamespace(app=FastAPI(), builder=MagicMock(), worker=worker, job_store=job_store)


async def _fetch_report(report_app, output) -> dict:
    """Register the routes over a job whose stored output is ``output``."""
    import aiq_api.routes.jobs as jobs_routes

    report_app.job_store.get_job.return_value = SimpleNamespace(job_id="job-1", output=output)
    await jobs_routes.register_job_routes(report_app.app, report_app.builder, report_app.worker)
    with TestClient(report_app.app) as client:
        response = client.get("/v1/jobs/async/job/job-1/report")
    assert response.status_code == 200
    return response.json()


@pytest.mark.asyncio
async def test_report_response_carries_the_runs_cards(report_app):
    """The whole point: cards the runner persisted come back with the report."""
    body = await _fetch_report(
        report_app,
        json.dumps({"report": "# Bericht\n\nText.", "cards": [VERDICT_CARD, LEGAL_BASIS_CARD]}),
    )

    assert body["report"] == "# Bericht\n\nText."
    assert body["cards"] == [VERDICT_CARD, LEGAL_BASIS_CARD]


@pytest.mark.asyncio
async def test_cards_are_returned_verbatim_and_unfiltered(report_app):
    """Every type, in the runner's order.

    Filtering to the one type the PDF reads today would make this response
    disagree with the socket and the conversation row about the same run, and
    order is render order (``_POST_HOC_ORDERING``) — so neither is this route's
    to change.
    """
    body = await _fetch_report(
        report_app,
        json.dumps({"report": "# Bericht", "cards": [LEGAL_BASIS_CARD, VERDICT_CARD]}),
    )

    assert [card["type"] for card in body["cards"]] == ["legal_basis", "verdict_header"]
    assert body["cards"][0]["original_text"] == LEGAL_BASIS_CARD["original_text"]


@pytest.mark.asyncio
async def test_report_without_cards_reports_none(report_app):
    """A run that produced no cards is not a run with an empty card list.

    ``legalBasisSection`` prints nothing at all rather than an empty heading, and
    it reaches that state from an absent value — so absent is what it gets.
    """
    body = await _fetch_report(report_app, json.dumps({"report": "# Bericht"}))

    assert body["has_report"] is True
    assert body["cards"] is None


@pytest.mark.asyncio
async def test_cards_are_withheld_when_there_is_no_report(report_app):
    """No report means nothing for these to be the cards of."""
    body = await _fetch_report(report_app, json.dumps({"cards": [LEGAL_BASIS_CARD]}))

    assert body["has_report"] is False
    assert body["cards"] is None


@pytest.mark.parametrize("stored", ["not-a-list", 5, {"type": "legal_basis"}])
@pytest.mark.asyncio
async def test_a_malformed_cards_value_never_costs_the_report(report_app, stored):
    """The report is what the user waited minutes for; cards are an enhancement.

    A blob written by an older worker, or corrupted, must degrade to "no cards"
    and never to a 500 or a validation error on the way out. The number is not
    padding: it is the value that is not iterable at all, so a narrowing that
    only filtered the items would raise instead of degrading.
    """
    body = await _fetch_report(report_app, json.dumps({"report": "# Bericht", "cards": stored}))

    assert body["report"] == "# Bericht"
    assert body["cards"] is None


@pytest.mark.asyncio
async def test_a_list_that_holds_no_usable_card_reads_as_no_cards(report_app):
    """An empty list is not the same message as "none", and the consumer wants "none".

    `legalBasisSection` reaches "print no heading" from an absent value; handing
    it `[]` asks it to mean the same thing by a second route.
    """
    body = await _fetch_report(report_app, json.dumps({"report": "# Bericht", "cards": ["junk", None]}))

    assert body["cards"] is None


@pytest.mark.asyncio
async def test_unusable_card_entries_are_dropped_individually(report_app):
    """Per-card, like ``validate_cards``: one bad entry never costs the batch."""
    body = await _fetch_report(
        report_app,
        json.dumps({"report": "# Bericht", "cards": [LEGAL_BASIS_CARD, "junk", None]}),
    )

    assert body["cards"] == [LEGAL_BASIS_CARD]


@pytest.mark.asyncio
async def test_output_stored_as_a_dict_is_read_the_same_way(report_app):
    """``job.output`` is a str on some stores and an already-parsed dict on others.

    The handler branches on that before it reads either key, so cards must
    survive both branches or the field would work on one deployment only.
    """
    body = await _fetch_report(report_app, {"report": "# Bericht", "cards": [LEGAL_BASIS_CARD]})

    assert body["cards"] == [LEGAL_BASIS_CARD]


# ---------------------------------------------------------------------------
# The project the run was commissioned in
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_report_carries_the_project_the_run_was_commissioned_in(report_app, monkeypatch):
    """The destination is a property of the RUN, not of the request that reads it.

    Filing used to take its project from the report request, and where the
    request named none, from the reader's stored ``active_project_id``. Both
    describe whoever opened a tab. The cover sheet the report is filed with
    names the Bundesland — which says which Bauordnung the report was checked
    against — so a report researched in one project and filed into another is a
    compliance document asserting the wrong law.
    """
    # Patched on the SOURCE module: `routes/jobs.py` imports it inside
    # `register_job_routes` to keep heavy imports off module load, so the name
    # is bound when the routes are registered — which `_fetch_report` does after
    # this line.
    from aiq_api.jobs import access

    async def _commissioned_in(job_id, db_url):
        assert job_id == "job-1"
        return "proj_wien"

    monkeypatch.setattr(access, "get_job_project_collection", _commissioned_in)
    body = await _fetch_report(report_app, json.dumps({"report": "# Bericht"}))

    assert body["project_collection"] == "proj_wien"


@pytest.mark.asyncio
async def test_a_run_with_no_project_reports_none_rather_than_a_guess(report_app, monkeypatch):
    """None means "do not file", never "file anywhere".

    A run started from a chat outside any project has no commissioning project.
    That is the case the old fallback filled in from the reader's preferences,
    silently, with no filing disclosure ever having been shown.
    """
    from aiq_api.jobs import access

    async def _no_project(job_id, db_url):
        return None

    monkeypatch.setattr(access, "get_job_project_collection", _no_project)
    body = await _fetch_report(report_app, json.dumps({"report": "# Bericht"}))

    assert body["project_collection"] is None


@pytest.mark.asyncio
async def test_a_poll_with_no_report_yet_pays_for_no_access_read(report_app, monkeypatch):
    """The common case on this route is "not finished yet".

    There is nothing to file, so there is no destination to look up, and this
    route is polled for the whole length of a run that costs minutes.
    """
    from aiq_api.jobs import access

    calls = []

    async def _counted(job_id, db_url):
        calls.append(job_id)
        return "proj_wien"

    monkeypatch.setattr(access, "get_job_project_collection", _counted)
    body = await _fetch_report(report_app, json.dumps({"status": "running"}))

    assert body["has_report"] is False
    assert body["project_collection"] is None
    assert calls == []
