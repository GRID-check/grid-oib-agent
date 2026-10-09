"""`POST /v1/ingest` carries the office's upload screening into the job (and the queue).

The BFF sends ``screening`` for an organization that configured terms or
detectors; the job screens the locally extracted text against it before any
model call (``knowledge_layer.llamaindex.screening``). These pin the crossing:
the request model's bounds, that ``_job_config`` copies a non-empty policy as
plain data and drops an empty one, that it survives the durable queue's
payload, and that the per-file outcome reaches the status response. The job
side is ``tests/knowledge_layer_tests/test_upload_screening_ingestion.py``.
"""

from __future__ import annotations

from datetime import datetime
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient
from knowledge_layer.llamaindex import screening as job_screening
from pydantic import ValidationError

from aiq_agent.knowledge.base import PreparedIngestJob
from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import set_active_ingestor
from aiq_agent.knowledge.schema import FileProgress
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState
from aiq_api.jobs import ingest_dispatch
from aiq_api.models import requests as request_models
from aiq_api.models.requests import IngestRequest
from aiq_api.models.requests import ScreeningPolicy
from aiq_api.routes.ingest import DeferredObjectDownload
from aiq_api.routes.ingest import _job_config
from aiq_api.routes.ingest import add_ingest_routes

_FILE_REF = "http://seaweedfs.test/bucket/doc/gehalt.pdf?X-Amz-Signature=abc"
_POLICY = {"content_terms": ["Gehaltsabrechnung", "Honorarvereinbarung"], "detectors": ["iban", "at_svnr"]}


def _request(**extra) -> IngestRequest:
    return IngestRequest(file_ref=_FILE_REF, collection="proj_1", **extra)


class TestScreeningPolicy:
    def test_terms_are_stripped_and_empty_ones_dropped(self):
        policy = ScreeningPolicy(content_terms=["  Gehaltsabrechnung ", "", "   ", "Honorar"])
        assert policy.content_terms == ["Gehaltsabrechnung", "Honorar"]

    @pytest.mark.parametrize("term", ["X", " Y ", "x" * 81])
    def test_a_term_out_of_bounds_is_refused(self, term):
        with pytest.raises(ValidationError):
            ScreeningPolicy(content_terms=[term])

    def test_the_bounds_are_the_ones_the_job_applies(self):
        # Two copies of one rule in two tiers; this is what holds them together.
        assert request_models.SCREENING_MAX_TERMS == job_screening.MAX_TERMS
        assert request_models.SCREENING_MIN_TERM_CHARS == job_screening.MIN_TERM_CHARS
        assert request_models.SCREENING_MAX_TERM_CHARS == job_screening.MAX_TERM_CHARS

    def test_at_most_two_hundred_terms(self):
        ScreeningPolicy(content_terms=[f"Begriff {n}" for n in range(200)])
        with pytest.raises(ValidationError):
            ScreeningPolicy(content_terms=[f"Begriff {n}" for n in range(201)])

    def test_an_unknown_detector_is_refused(self):
        with pytest.raises(ValidationError):
            ScreeningPolicy(detectors=["passport"])

    def test_an_extra_field_is_refused(self):
        with pytest.raises(ValidationError):
            ScreeningPolicy(content_terms=["Gehalt"], filename_terms=["Lohn"])

    def test_both_lists_default_to_empty(self):
        policy = ScreeningPolicy()
        assert (policy.content_terms, policy.detectors, policy.is_empty) == ([], [], True)


class TestJobConfig:
    def test_a_policy_is_copied_as_plain_data(self):
        config = _job_config(_request(screening=_POLICY), "org-1", None)
        assert config["screening"] == _POLICY
        assert type(config["screening"]) is dict

    @pytest.mark.parametrize("screening", [None, {}, {"content_terms": [], "detectors": []}, {"content_terms": [" "]}])
    def test_no_policy_or_an_empty_one_is_not_screened(self, screening):
        config = _job_config(_request(screening=screening), "org-1", None)
        assert "screening" not in config

    def test_detectors_alone_are_a_policy(self):
        config = _job_config(_request(screening={"detectors": ["credit_card"]}), None, None)
        assert config["screening"] == {"content_terms": [], "detectors": ["credit_card"]}

    def test_the_job_reads_back_what_the_route_wrote(self):
        rules = job_screening.ScreeningRules.from_config(
            _job_config(_request(screening=_POLICY), None, None)["screening"]
        )
        assert rules is not None
        assert rules.terms == ("Gehaltsabrechnung", "Honorarvereinbarung")
        assert rules.detectors == ("iban", "at_svnr")


def test_the_policy_survives_the_durable_queue(monkeypatch):
    monkeypatch.setenv("SEAWEED_ENDPOINT", "http://seaweedfs.test")
    monkeypatch.delenv("GRID_JOB_PAYLOAD_KEK", raising=False)
    config = _job_config(_request(screening=_POLICY), "org-1", None)
    prepared = PreparedIngestJob(
        job_id="job-1",
        status=IngestionJobStatus(
            job_id="job-1",
            submitted_at=datetime(2026, 10, 1, 9, 0, 0),
            total_files=1,
            collection_name="proj_1",
            backend="llamaindex",
        ),
        file_paths=[DeferredObjectDownload(_FILE_REF)],
        collection_name="proj_1",
        config=config,
    )

    decoded = ingest_dispatch.decode(ingest_dispatch.encode(prepared))

    assert decoded.config["screening"] == _POLICY


# =============================================================================
# Through the route
# =============================================================================


@pytest.fixture
def mock_ingestor():
    ingestor = MagicMock()
    ingestor.backend_name = "test"
    ingestor.submit_job.return_value = "job_scr_1"
    set_active_ingestor(ingestor)
    yield ingestor
    clear_active_ingestor()


@pytest.fixture
def app(mock_ingestor, monkeypatch):
    monkeypatch.setenv("SEAWEED_PUBLIC_ENDPOINT", "http://seaweedfs.test")
    monkeypatch.setenv("SEAWEED_ENDPOINT", "http://seaweedfs.test")
    app = FastAPI()
    router = APIRouter()
    add_ingest_routes(router)
    app.include_router(router)
    return app


async def _ingest(app, body: dict) -> httpx.Response:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post("/v1/ingest", json=body)


@pytest.mark.asyncio
async def test_the_route_hands_the_policy_to_the_job(app, mock_ingestor):
    response = await _ingest(app, {"file_ref": _FILE_REF, "collection": "proj_1", "screening": _POLICY})

    assert response.status_code == 202
    assert mock_ingestor.submit_job.call_args.kwargs["config"]["screening"] == _POLICY


@pytest.mark.asyncio
async def test_the_route_refuses_a_malformed_policy(app, mock_ingestor):
    response = await _ingest(
        app, {"file_ref": _FILE_REF, "collection": "proj_1", "screening": {"detectors": ["iban"], "x": 1}}
    )

    assert response.status_code == 422
    mock_ingestor.submit_job.assert_not_called()


def test_the_file_outcome_is_on_the_status_response():
    status = IngestionJobStatus(
        job_id="job-1",
        status=JobState.FAILED,
        submitted_at=datetime(2026, 10, 1, 9, 0, 0),
        collection_name="proj_1",
        backend="llamaindex",
        file_details=[
            FileProgress(file_name="a.pdf", status=FileStatus.FAILED, screening="quarantined"),
            FileProgress(file_name="b.pdf", status=FileStatus.SUCCESS),
        ],
    )

    dumped = status.model_dump(mode="json")

    assert [detail["screening"] for detail in dumped["file_details"]] == ["quarantined", None]
    # A row stored before the field existed still reads.
    del dumped["file_details"][0]["screening"]
    assert IngestionJobStatus.model_validate(dumped).file_details[0].screening is None
