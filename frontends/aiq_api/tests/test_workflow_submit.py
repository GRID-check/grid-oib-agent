"""Tests for the internal workflows submit route (ADR-0023).

``POST /v1/internal/workflows/submit`` wraps ``submit_agent_job`` for scheduled
and manual workflow runs. It must:

- fail closed on the shared internal token (missing/wrong -> 403; well-known
  dev default outside a dev APP_ENV -> 503) — the maintenance.py pattern;
- reject malformed payloads (missing organization_id, oversized input) with 422;
- reconstitute the workflow creator's identity into the Principal, owner, and
  usage_context handed to ``submit_agent_job`` (org-scoped admission + cost
  attribution), deriving the project collection from ``collection_scope``;
- map admission/duplicate errors to 429 (+ Retry-After) / 409, identically to
  the public submit route;
- stay off the AuthMiddleware external-path allowlist (internal-only).

The Dask/JobStore layer is mocked by patching ``submit_agent_job``; no builder
is registered, so per-agent data-source validation is skipped.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aiq_agent.common.job_admission import JobAdmissionError
from aiq_api.jobs.submit import DuplicateJobIdError
from aiq_api.routes.internal_auth import _DEV_DEFAULT_TOKEN

_TOKEN = "real-internal-secret"


def _valid_body(**overrides) -> dict:
    body = {
        "agent_type": "deep_researcher",
        "input": "Research the latest OIB fire-safety guidance.",
        "organization_id": "org_123",
        "user_id": "user_abc",
        "project_id": "proj-uuid-1",
        "owner_email": "creator@example.com",
        "collection_scope": ["oib_knowledge", "proj_uuid_1", "s_conv1"],
        "budget_header": "eyJyZW1haW5pbmdPcmdVc2QiOjF9",
        "model_overrides": {"researcher": "openrouter/some-model"},
    }
    body.update(overrides)
    return body


@pytest.fixture
def submit_mock(monkeypatch):
    """Patch the submit function the route imports lazily; default returns an id."""
    from aiq_api.jobs import submit as submit_module

    mock = AsyncMock(return_value="job-xyz")
    monkeypatch.setattr(submit_module, "submit_agent_job", mock)
    return mock


@pytest.fixture
def client(submit_mock):
    from aiq_api.routes.workflows import add_workflow_routes

    router = APIRouter()
    add_workflow_routes(router)
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def prod_token(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", _TOKEN)
    monkeypatch.setenv("APP_ENV", "production")


def _post(client, body, token=_TOKEN):
    headers = {} if token is None else {"x-internal-token": token}
    return client.post("/v1/internal/workflows/submit", json=body, headers=headers)


# --- token guard -----------------------------------------------------------


def test_missing_token_forbidden(client, prod_token):
    resp = _post(client, _valid_body(), token=None)
    assert resp.status_code == 403


def test_wrong_token_forbidden(client, prod_token):
    resp = _post(client, _valid_body(), token="nope")
    assert resp.status_code == 403


def test_dev_default_token_in_prod_disabled(client, monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", _DEV_DEFAULT_TOKEN)
    monkeypatch.setenv("APP_ENV", "production")
    resp = _post(client, _valid_body(), token=_DEV_DEFAULT_TOKEN)
    assert resp.status_code == 503


def test_unset_token_forbidden(client, monkeypatch):
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    resp = _post(client, _valid_body(), token="anything")
    assert resp.status_code == 403


# --- payload validation (422 before the handler / token guard) -------------


def test_missing_organization_id_422(client, prod_token):
    body = _valid_body()
    del body["organization_id"]
    resp = _post(client, body)
    assert resp.status_code == 422


def test_oversized_input_422(client, prod_token):
    resp = _post(client, _valid_body(input="x" * 32001))
    assert resp.status_code == 422


def test_empty_input_422(client, prod_token):
    resp = _post(client, _valid_body(input=""))
    assert resp.status_code == 422


def test_bad_job_id_pattern_422(client, prod_token):
    resp = _post(client, _valid_body(job_id="bad id!"))
    assert resp.status_code == 422


# --- successful submit -----------------------------------------------------


def test_successful_submit_returns_job_id(client, prod_token, submit_mock):
    resp = _post(client, _valid_body())
    assert resp.status_code == 200
    assert resp.json() == {"job_id": "job-xyz"}
    submit_mock.assert_awaited_once()


def test_successful_submit_forwards_identity_and_scope(client, prod_token, submit_mock):
    resp = _post(client, _valid_body())
    assert resp.status_code == 200

    kwargs = submit_mock.await_args.kwargs
    assert kwargs["agent_type"] == "deep_researcher"
    assert kwargs["input_text"] == "Research the latest OIB fire-safety guidance."
    # Owner is the creator's email (principal.email or principal.sub).
    assert kwargs["owner"] == "creator@example.com"
    # Collection scope is forwarded verbatim; the project collection is derived
    # from it inside submit_agent_job.
    assert kwargs["collection_scope"] == ["oib_knowledge", "proj_uuid_1", "s_conv1"]
    assert kwargs["project_context"] is None
    assert kwargs["model_overrides"] == {"researcher": "openrouter/some-model"}

    # Principal is the workflow creator (type "jwt" matches the WorkOS principal
    # they present later), so job-access ownership authz keeps working.
    principal = kwargs["principal"]
    assert principal.type == "jwt"
    assert principal.sub == "user_abc"
    assert principal.email == "creator@example.com"

    # usage_context identity keys match cost_tracking._read_identity_from_context.
    usage_context = kwargs["usage_context"]
    assert usage_context == {
        "identity": {
            "organization_id": "org_123",
            "user_id": "user_abc",
            "project_id": "proj-uuid-1",
            "conversation_id": None,
        },
        "budget_header": "eyJyZW1haW5pbmdPcmdVc2QiOjF9",
    }


def test_owner_falls_back_to_user_id_when_no_email(client, prod_token, submit_mock):
    resp = _post(client, _valid_body(owner_email=None))
    assert resp.status_code == 200
    kwargs = submit_mock.await_args.kwargs
    assert kwargs["owner"] == "user_abc"
    assert kwargs["principal"].sub == "user_abc"
    assert kwargs["principal"].email is None


# --- error mapping ---------------------------------------------------------


def test_admission_error_maps_to_429_with_retry_after(client, prod_token, submit_mock):
    submit_mock.side_effect = JobAdmissionError("Research queue is full.", retry_after_seconds=45)
    resp = _post(client, _valid_body())
    assert resp.status_code == 429
    assert resp.headers["Retry-After"] == "45"


def test_duplicate_job_id_maps_to_409(client, prod_token, submit_mock):
    submit_mock.side_effect = DuplicateJobIdError("Job ID already exists: dup-1")
    resp = _post(client, _valid_body(job_id="dup-1"))
    assert resp.status_code == 409
    assert resp.json()["detail"] == "Job ID already exists: dup-1"


def test_scheduler_not_configured_maps_to_503(client, prod_token, submit_mock):
    from aiq_api.jobs.submit import SchedulerNotConfiguredError

    submit_mock.side_effect = SchedulerNotConfiguredError("Async job submission requires NAT_DASK_SCHEDULER_ADDRESS")
    resp = _post(client, _valid_body())
    assert resp.status_code == 503


def test_unknown_agent_type_maps_to_400(client, prod_token, submit_mock):
    resp = _post(client, _valid_body(agent_type="no_such_agent"))
    assert resp.status_code == 400
    submit_mock.assert_not_awaited()


# --- middleware exposure ----------------------------------------------------


def test_route_not_on_external_allowlist():
    """The internal path must never be reachable from outside the compose net."""
    from aiq_api.auth.middleware import EXTERNAL_ALLOWED_PATHS

    path = "/v1/internal/workflows/submit"
    assert path not in EXTERNAL_ALLOWED_PATHS
    # And it must not match any allowed prefix entry either.
    for allowed in EXTERNAL_ALLOWED_PATHS:
        if allowed.endswith("/"):
            assert not path.startswith(allowed)
