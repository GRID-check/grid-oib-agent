"""Tests for the internal skills submit route (Agent Skills; successor of ADR-0023).

``POST /v1/internal/skills/submit`` wraps ``submit_agent_job`` for scheduled
and manual skill runs. It must:

- fail closed on the shared internal token (missing/wrong -> 403; well-known
  dev default outside a dev APP_ENV -> 503) — the maintenance.py pattern;
- reject malformed payloads (missing organization_id, invalid output enum,
  neither output nor execution, oversized input) with 422;
- select the agent type DETERMINISTICALLY from the JOB's chosen output kind:
  ``chat`` -> shallow_researcher, ``deep-research`` -> deep_researcher, with an
  explicit ``agent_type`` as the only override;
- accept the pre-rename ``execution`` spelling for one release, with ``output``
  winning when both arrive (the BFF and this service deploy separately);
- thread the forced skill names through to ``submit_agent_job`` as
  ``force_skills`` (the same path ``data_sources`` travels);
- reconstitute the skill owner's identity into the Principal, owner, and
  usage_context handed to ``submit_agent_job`` (org-scoped admission + cost
  attribution);
- map admission/duplicate errors to 429 (+ Retry-After) / 409, identically to
  the public submit route;
- stay off the AuthMiddleware external-path allowlist (internal-only).

The Dask/JobStore layer is mocked by patching ``submit_agent_job``; no builder
is registered, so per-agent data-source validation is skipped (the registry
fallback is exercised explicitly for unknown ids).
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
        "input": "Act as a building-physics advisor: check the OIB thermal requirements.",
        "skills": ["oib-thermal-check", "building-physics-advisor"],
        "output": "deep-research",
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
    from aiq_api.routes.skills import add_skill_routes

    router = APIRouter()
    add_skill_routes(router)
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
    return client.post("/v1/internal/skills/submit", json=body, headers=headers)


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
    resp = _post(client, _valid_body(input="x" * 48001))
    assert resp.status_code == 422


def test_composed_input_above_the_old_skill_body_limit_is_accepted(client, prod_token, submit_mock):
    """The input is a COMPOSED prompt now: job prompt + the attached skill body.

    Each half fits inside MAX_SKILL_BODY_LENGTH (32000) on its own, so the sum
    routinely will not. 32001 chars used to be a 422; the ceiling is 48000, and
    the prompt arrives whole rather than truncated.
    """
    composed = "j" * 16000 + "s" * 16001
    assert len(composed) == 32001
    resp = _post(client, _valid_body(input=composed))
    assert resp.status_code == 200
    assert submit_mock.await_args.kwargs["input_text"] == composed


def test_empty_input_422(client, prod_token):
    resp = _post(client, _valid_body(input=""))
    assert resp.status_code == 422


def test_bad_job_id_pattern_422(client, prod_token):
    resp = _post(client, _valid_body(job_id="bad id!"))
    assert resp.status_code == 422


def test_unknown_output_kind_422(client, prod_token):
    resp = _post(client, _valid_body(output="overnight"))
    assert resp.status_code == 422


def test_unknown_legacy_execution_value_422(client, prod_token):
    body = _valid_body(execution="overnight")
    del body["output"]
    resp = _post(client, body)
    assert resp.status_code == 422


# --- skills are optional: a job is a prompt, a skill is attached on top -----


def test_missing_skills_submits_with_no_forced_skills(client, prod_token, submit_mock):
    """A job need not have a skill at all — the prompt runs on its own."""
    body = _valid_body()
    del body["skills"]
    resp = _post(client, body)
    assert resp.status_code == 200
    assert submit_mock.await_args.kwargs["force_skills"] == []


def test_empty_skills_submits_with_no_forced_skills(client, prod_token, submit_mock):
    """An empty list is "no skill attached", not a malformed payload.

    It is forwarded as-is rather than normalised to None: everything downstream
    already treats an empty force list identically to no list
    (``SkillRuntime(force_names=[])`` iterates ``force_names or ()``, and the
    shallow register layer's wiring check is a plain truthiness test).
    """
    resp = _post(client, _valid_body(skills=[]))
    assert resp.status_code == 200
    assert submit_mock.await_args.kwargs["force_skills"] == []


# --- deterministic agent selection ----------------------------------------


def test_chat_output_selects_shallow_researcher(client, prod_token, submit_mock):
    resp = _post(client, _valid_body(output="chat", agent_type=None))
    assert resp.status_code == 200
    assert submit_mock.await_args.kwargs["agent_type"] == "shallow_researcher"


def test_deep_research_output_selects_deep_researcher(client, prod_token, submit_mock):
    resp = _post(client, _valid_body(output="deep-research", agent_type=None))
    assert resp.status_code == 200
    assert submit_mock.await_args.kwargs["agent_type"] == "deep_researcher"


def test_explicit_agent_type_overrides_the_output_default(client, prod_token, submit_mock):
    resp = _post(client, _valid_body(output="chat", agent_type="deep_researcher"))
    assert resp.status_code == 200
    assert submit_mock.await_args.kwargs["agent_type"] == "deep_researcher"


# --- the output/execution rename window ------------------------------------
#
# `execution` became `output` on both sides, but the BFF and this service
# deploy separately. For one release the route accepts either spelling, so a
# scheduled run fired by the not-yet-deployed half of the system still lands.
# These four cases are the whole tolerance: output only, execution only, both,
# neither.


def test_output_only_is_the_new_contract(client, prod_token, submit_mock):
    body = _valid_body(output="chat")
    assert "execution" not in body
    resp = _post(client, body)
    assert resp.status_code == 200
    assert submit_mock.await_args.kwargs["agent_type"] == "shallow_researcher"


def test_execution_only_still_works_during_the_deploy_window(client, prod_token, submit_mock):
    body = _valid_body(execution="chat")
    del body["output"]
    resp = _post(client, body)
    assert resp.status_code == 200
    assert submit_mock.await_args.kwargs["agent_type"] == "shallow_researcher"


def test_output_wins_when_both_are_sent(client, prod_token, submit_mock):
    resp = _post(client, _valid_body(output="chat", execution="deep-research"))
    assert resp.status_code == 200
    assert submit_mock.await_args.kwargs["agent_type"] == "shallow_researcher"


def test_neither_output_nor_execution_is_422_not_500(client, prod_token, submit_mock):
    """Both fields are Optional, so "neither" is structurally legal — and useless.

    Without the validator this reached the handler and blew up indexing the
    agent table with None: a 500 for a payload the caller simply got wrong.
    """
    body = _valid_body()
    del body["output"]
    assert "execution" not in body
    resp = _post(client, body)
    assert resp.status_code == 422
    submit_mock.assert_not_awaited()


def test_unknown_agent_type_maps_to_400(client, prod_token, submit_mock):
    resp = _post(client, _valid_body(agent_type="no_such_agent"))
    assert resp.status_code == 400
    submit_mock.assert_not_awaited()


# --- successful submit -----------------------------------------------------


def test_successful_submit_returns_job_id(client, prod_token, submit_mock):
    resp = _post(client, _valid_body())
    assert resp.status_code == 200
    assert resp.json() == {"job_id": "job-xyz"}
    submit_mock.assert_awaited_once()


def test_successful_submit_forwards_identity_scope_and_forced_skills(client, prod_token, submit_mock):
    resp = _post(client, _valid_body())
    assert resp.status_code == 200

    kwargs = submit_mock.await_args.kwargs
    assert kwargs["agent_type"] == "deep_researcher"
    assert kwargs["input_text"] == "Act as a building-physics advisor: check the OIB thermal requirements."
    # The forced skill names ride the same path data_sources travels.
    assert kwargs["force_skills"] == ["oib-thermal-check", "building-physics-advisor"]
    # Owner is the owner's email (principal.email or principal.sub).
    assert kwargs["owner"] == "creator@example.com"
    # Collection scope is forwarded verbatim; the project collection is derived
    # from it inside submit_agent_job.
    assert kwargs["collection_scope"] == ["oib_knowledge", "proj_uuid_1", "s_conv1"]
    assert kwargs["project_context"] is None
    assert kwargs["model_overrides"] == {"researcher": "openrouter/some-model"}
    # Absent from the body: no digest travels, and reflection stays off.
    assert kwargs["project_memory"] is None
    assert kwargs["memory_reflection_enabled"] is False

    # Principal is the skill owner (type "jwt" matches the WorkOS principal
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


def test_chat_output_forwards_a_single_forced_skill(client, prod_token, submit_mock):
    resp = _post(client, _valid_body(output="chat", skills=["only-one"]))
    assert resp.status_code == 200
    assert submit_mock.await_args.kwargs["force_skills"] == ["only-one"]


def test_unknown_data_source_ids_422_via_registry_fallback(client, prod_token, submit_mock, monkeypatch):
    # Ensure the registry fallback path is taken: other suites register a real
    # builder via register_job_routes, and a stale global builder would divert
    # this request into the builder-based validator (and fail on a mock await).
    from aiq_api.routes import builder_state

    monkeypatch.setattr(builder_state, "get_active_builder", lambda: None)
    resp = _post(client, _valid_body(data_sources=["no_such_source"]))
    assert resp.status_code == 422
    submit_mock.assert_not_awaited()


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


# --- middleware exposure ----------------------------------------------------


def test_route_not_on_external_allowlist():
    """The internal path must never be reachable from outside the compose net."""
    from aiq_api.auth.middleware import EXTERNAL_ALLOWED_PATHS

    path = "/v1/internal/skills/submit"
    assert path not in EXTERNAL_ALLOWED_PATHS
    # And it must not match any allowed prefix entry either.
    for allowed in EXTERNAL_ALLOWED_PATHS:
        if allowed.endswith("/"):
            assert not path.startswith(allowed)


def test_memory_digest_and_reflection_flag_are_forwarded(client, prod_token, submit_mock):
    """A scheduled run gets what a chat turn gets: the project's memory, and the
    organization's reflection flag as the BFF evaluated it."""
    body = _valid_body()
    body["project_memory"] = "PROJECT_MEMORY v1\n- Atrium ist OIB 2.3"
    body["memory_reflection_enabled"] = True
    resp = _post(client, body)
    assert resp.status_code == 200
    kwargs = submit_mock.await_args.kwargs
    assert kwargs["project_memory"] == "PROJECT_MEMORY v1\n- Atrium ist OIB 2.3"
    assert kwargs["memory_reflection_enabled"] is True
