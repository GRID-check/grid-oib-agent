from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import math
import re
import time
from datetime import UTC
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.testclient import TestClient

from aiq_agent.auth import Principal
from aiq_api.auth.middleware import AuthMiddleware
from aiq_api.context_envelope import GridContextEnvelopeMiddleware
from aiq_api.jobs import access as job_access
from aiq_api.jobs.access import JOB_ENVELOPE_MAX_AGE_MS
from aiq_api.jobs.access import JobCaller
from aiq_api.jobs.access import authorize_job_access
from aiq_api.jobs.access import cleanup_job_access
from aiq_api.jobs.access import create_job_access
from aiq_api.jobs.access import ensure_job_access_table
from aiq_api.jobs.access import get_job_access
from aiq_api.jobs.access import get_job_project_collection
from aiq_api.jobs.access import signed_job_scope
from aiq_api.jobs.event_store import EventStore
from aiq_api.routes import jobs as jobs_routes

SECRET = "internal-test-token"  # noqa: S105  # pragma: allowlist secret

OWNER = Principal(type="jwt", sub="user-owner")
TEAMMATE = Principal(type="jwt", sub="user-teammate")


@pytest.fixture
def db_url(tmp_path):
    return f"sqlite+aiosqlite:///{tmp_path / 'test_job_access.db'}"


@pytest.fixture(autouse=True)
def clear_event_store_caches():
    EventStore._tables_initialized.clear()
    job_access._job_access_schema_initialized.clear()
    yield
    EventStore._tables_initialized.clear()
    job_access._job_access_schema_initialized.clear()


@pytest.fixture
def auth_on(monkeypatch):
    """REQUIRE_AUTH=true with the shared secret the BFF signs envelopes with."""
    monkeypatch.setenv("REQUIRE_AUTH", "true")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", SECRET)
    monkeypatch.setenv("OIB_COLLECTION_NAME", "oib_knowledge")
    monkeypatch.delenv("COLLECTION_NAME", raising=False)


def _insert_job_info(db_url: str, job_id: str, *, is_expired: bool = False) -> None:
    from sqlalchemy import text

    engine = EventStore._get_or_create_sync_engine(db_url)
    with engine.connect() as conn:
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS job_info ("
                "  job_id TEXT PRIMARY KEY,"
                "  status TEXT,"
                "  config_file TEXT,"
                "  error TEXT,"
                "  output_path TEXT,"
                "  created_at DATETIME,"
                "  updated_at DATETIME,"
                "  expiry_seconds INTEGER,"
                "  output TEXT,"
                "  is_expired BOOLEAN DEFAULT 0"
                ")"
            )
        )
        now = datetime.now(UTC).replace(tzinfo=None)
        conn.execute(
            text(
                "INSERT OR REPLACE INTO job_info "
                "(job_id, status, created_at, updated_at, expiry_seconds, is_expired) "
                "VALUES (:job_id, 'running', :ts, :ts, 3600, :is_expired)"
            ),
            {"job_id": job_id, "ts": now, "is_expired": is_expired},
        )
        conn.commit()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _envelope(
    *,
    user_id: str = TEAMMATE.sub,
    organization_id: str | None = "org-1",
    project_collection: str | None = None,
    conversation_id: str | None = None,
    issued_at: int | None | object = ...,
    secret: str | None = SECRET,
) -> dict[str, str]:
    """The headers the BFF's job proxy sends: the signed envelope over the scope it authorized."""
    scope: list[dict[str, str]] = [{"collection": "oib_knowledge", "shelf": "base"}]
    if organization_id:
        scope.append({"collection": f"archiv_{organization_id}", "shelf": "archiv"})
    if project_collection:
        scope.append({"collection": project_collection, "shelf": "project"})
    if conversation_id:
        scope.append({"collection": f"s_{conversation_id}", "shelf": "session"})
    payload: dict[str, object] = {"userId": user_id, "collectionScope": scope}
    if organization_id:
        payload["organizationId"] = organization_id
    if conversation_id:
        payload["conversationId"] = conversation_id
    stamp = _now_ms() if issued_at is ... else issued_at
    if stamp is not None:
        payload["issuedAt"] = stamp
    raw = json.dumps(payload)
    headers = {"x-grid-request-context": base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")}
    if secret:
        headers["x-grid-request-context-sig"] = hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest()
    return headers


def _seed(
    db_url: str,
    job_id: str = "job-1",
    *,
    organization_id: str | None = "org-1",
    project_collection: str | None = "proj_alpha",
    conversation_id: str | None = "conv-1",
) -> SimpleNamespace:
    _insert_job_info(db_url, job_id)
    create_job_access(
        job_id,
        OWNER,
        db_url,
        conversation_id=conversation_id,
        project_collection=project_collection,
        organization_id=organization_id,
    )
    return SimpleNamespace(job_id=job_id, status="running", created_at=None, error=None, output=None)


def _authorize(db_url: str, job, principal: Principal, headers: dict[str, str] | None, action: str):
    job_store = SimpleNamespace(get_job=AsyncMock(return_value=job))
    caller = JobCaller(principal=principal, scope=signed_job_scope(headers or {}, principal))
    return asyncio.run(authorize_job_access(job_store, db_url, job.job_id, caller, action))


def _refused(db_url: str, job, principal: Principal, headers: dict[str, str] | None, action: str) -> int:
    with pytest.raises(HTTPException) as exc:
        _authorize(db_url, job, principal, headers, action)
    return exc.value.status_code


class TestJobAccessStorage:
    def test_create_and_get_job_access(self, db_url):
        principal = Principal(type="jwt", sub="user-1", email="alice@example.com")

        create_job_access("job-1", principal, db_url)

        access = get_job_access("job-1", db_url)
        assert access is not None
        assert access["owner_auth_type"] == "jwt"
        assert access["owner_subject"] == "user-1"
        assert access["owner_email"] == "alice@example.com"

    def test_cleanup_removes_expired_and_orphaned_access_rows(self, db_url):
        ensure_job_access_table(db_url)
        principal = Principal(type="jwt", sub="user-1")
        create_job_access("live-job", principal, db_url)
        create_job_access("expired-job", principal, db_url)
        create_job_access("orphan-job", principal, db_url)

        _insert_job_info(db_url, "live-job", is_expired=False)
        _insert_job_info(db_url, "expired-job", is_expired=True)

        deleted = cleanup_job_access(db_url)

        assert deleted == 2
        assert get_job_access("live-job", db_url) is not None
        assert get_job_access("expired-job", db_url) is None
        assert get_job_access("orphan-job", db_url) is None


class TestCommissioningProject:
    """Which project a run belongs to — read from the run, never from a request.

    The report a run produces is filed into a project as a document, and its
    cover sheet names the Bundesland, which is what says which Bauordnung the
    report was checked against. Taking that project from whatever the reader's
    session or preferences happen to say produces a compliance document
    asserting the wrong law, so the answer has to come from the row written at
    submit time.
    """

    def test_reports_the_project_recorded_at_submit_time(self, db_url):
        principal = Principal(type="jwt", sub="user-1")
        create_job_access("job-1", principal, db_url, project_collection="proj_wien")

        assert asyncio.run(get_job_project_collection("job-1", db_url)) == "proj_wien"

    def test_a_run_started_outside_a_project_reports_none(self, db_url):
        # The case the old `active_project_id` fallback filled in silently: a
        # chat with no project makes no filing promise, and None has to stay
        # None all the way to the caller so it can decline to file.
        principal = Principal(type="jwt", sub="user-1")
        create_job_access("job-2", principal, db_url)

        assert asyncio.run(get_job_project_collection("job-2", db_url)) is None

    def test_an_unknown_job_reports_none_rather_than_raising(self, db_url):
        # This runs on the report path beside an authorization check that has
        # already decided whether the caller may see the job. Raising here would
        # turn "no destination" into a failed report.
        assert asyncio.run(get_job_project_collection("job-does-not-exist", db_url)) is None

    def test_an_empty_string_is_not_a_project(self, db_url):
        # The column is nullable VARCHAR and nothing constrains it, so an empty
        # string is storable. Returning it would send the caller looking up a
        # project named "", and the honest answer is the same as no project.
        principal = Principal(type="jwt", sub="user-1")
        create_job_access("job-3", principal, db_url, project_collection="")

        assert asyncio.run(get_job_project_collection("job-3", db_url)) is None


class TestAuthorizeJobAccess:
    """ADR-0084: a job is reached by its owner, or inside the scope the BFF signed."""

    @pytest.mark.parametrize("action", ["read", "control"])
    def test_owner_reaches_their_job_without_any_envelope(self, db_url, auth_on, action):
        job = _seed(db_url)

        assert _authorize(db_url, job, OWNER, None, action) is job

    @pytest.mark.parametrize("action", ["read", "control"])
    def test_same_organization_and_project_reads_and_steers(self, db_url, auth_on, action):
        job = _seed(db_url)
        headers = _envelope(project_collection="proj_alpha")

        assert _authorize(db_url, job, TEAMMATE, headers, action) is job

    def test_same_organization_other_project_is_refused(self, db_url, auth_on):
        job = _seed(db_url)

        assert _refused(db_url, job, TEAMMATE, _envelope(project_collection="proj_beta"), "read") == 404

    def test_other_organization_with_the_same_project_collection_is_refused(self, db_url, auth_on):
        # Collection names are not tenant-qualified, so the organization is what
        # keeps a colliding name in another tenant from opening this run.
        job = _seed(db_url)
        headers = _envelope(organization_id="org-2", project_collection="proj_alpha")

        assert _refused(db_url, job, TEAMMATE, headers, "read") == 404

    def test_a_row_without_an_organization_is_reached_by_its_owner_only(self, db_url, auth_on):
        job = _seed(db_url, organization_id=None)
        headers = _envelope(project_collection="proj_alpha", conversation_id="conv-1")

        assert _authorize(db_url, job, OWNER, None, "control") is job
        assert _refused(db_url, job, TEAMMATE, headers, "read") == 404

    def test_a_conversation_viewer_follows_the_run_but_cannot_steer_it(self, db_url, auth_on):
        job = _seed(db_url)
        headers = _envelope(conversation_id="conv-1")

        assert _authorize(db_url, job, TEAMMATE, headers, "read") is job
        assert _refused(db_url, job, TEAMMATE, headers, "control") == 404

    def test_another_conversation_is_refused(self, db_url, auth_on):
        job = _seed(db_url)

        assert _refused(db_url, job, TEAMMATE, _envelope(conversation_id="conv-2"), "read") == 404

    def test_a_run_without_a_project_is_not_reached_through_a_project_less_scope(self, db_url, auth_on):
        # NULL never matches: a scope that names no project must not meet a run
        # that has none.
        job = _seed(db_url, project_collection=None, conversation_id=None)

        assert _refused(db_url, job, TEAMMATE, _envelope(), "read") == 404

    @pytest.mark.parametrize("offset_ms", [-(JOB_ENVELOPE_MAX_AGE_MS + 60_000), JOB_ENVELOPE_MAX_AGE_MS + 60_000])
    def test_an_envelope_outside_the_window_grants_nothing(self, db_url, auth_on, offset_ms):
        # Past and future alike, as the BFF verifier counts it.
        job = _seed(db_url)
        headers = _envelope(project_collection="proj_alpha", issued_at=_now_ms() + offset_ms)

        assert _refused(db_url, job, TEAMMATE, headers, "read") == 404

    def test_an_envelope_inside_the_window_still_grants(self, db_url, auth_on):
        job = _seed(db_url)
        headers = _envelope(project_collection="proj_alpha", issued_at=_now_ms() - JOB_ENVELOPE_MAX_AGE_MS + 60_000)

        assert _authorize(db_url, job, TEAMMATE, headers, "read") is job

    def test_an_envelope_without_issued_at_grants_nothing(self, db_url, auth_on):
        job = _seed(db_url)
        headers = _envelope(project_collection="proj_alpha", issued_at=None)

        assert _refused(db_url, job, TEAMMATE, headers, "read") == 404

    def test_a_bad_signature_is_treated_as_no_envelope(self, db_url, auth_on):
        job = _seed(db_url)
        headers = _envelope(project_collection="proj_alpha", secret="not-the-secret")  # noqa: S106

        assert _refused(db_url, job, TEAMMATE, headers, "read") == 404
        # The owner keeps what they own whatever the envelope says.
        assert _authorize(db_url, job, OWNER, headers, "control") is job

    def test_an_envelope_minted_for_another_user_grants_nothing(self, db_url, auth_on):
        # A captured envelope does not travel with somebody else's bearer token.
        job = _seed(db_url)
        headers = _envelope(user_id="user-someone-else", project_collection="proj_alpha")

        assert _refused(db_url, job, TEAMMATE, headers, "read") == 404

    def test_without_a_shared_secret_no_envelope_grants(self, db_url, auth_on, monkeypatch):
        # An unsigned envelope is accepted elsewhere in dev; it never widens job access.
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN")
        job = _seed(db_url)
        headers = _envelope(project_collection="proj_alpha", secret=None)

        assert _refused(db_url, job, TEAMMATE, headers, "read") == 404

    def test_cross_user_without_envelope_denied_with_404(self, db_url, auth_on):
        job = _seed(db_url)

        assert _refused(db_url, job, TEAMMATE, None, "read") == 404

    def test_missing_access_row_denied_with_404(self, db_url, auth_on):
        _insert_job_info(db_url, "job-1")
        job = SimpleNamespace(job_id="job-1", status="running", created_at=None, error=None)

        assert _refused(db_url, job, OWNER, None, "read") == 404

    def test_missing_job_returns_404_before_access_check(self, db_url):
        job_store = SimpleNamespace(get_job=AsyncMock(return_value=None))

        with pytest.raises(HTTPException) as exc:
            asyncio.run(authorize_job_access(job_store, db_url, "job-1", JobCaller(principal=OWNER), "read"))

        assert exc.value.status_code == 404

    @pytest.mark.parametrize("action", ["read", "control"])
    def test_auth_off_is_unchanged_anyone_reaches_any_job(self, db_url, monkeypatch, action):
        monkeypatch.setenv("REQUIRE_AUTH", "false")
        job = _seed(db_url, organization_id=None)

        assert _authorize(db_url, job, TEAMMATE, None, action) is job


def test_the_job_envelope_window_is_the_bff_verifiers():
    """The two windows are one decision written in two languages; this holds them equal."""
    source = (Path(__file__).resolve().parents[3] / "frontends/ui/src/lib/request-context.ts").read_text()
    match = re.search(r"export const GRID_REQUEST_CONTEXT_MAX_AGE_MS = ([\d *]+)\n", source)
    assert match, "GRID_REQUEST_CONTEXT_MAX_AGE_MS moved; point this test at it"

    assert math.prod(int(factor) for factor in match.group(1).split("*")) == JOB_ENVELOPE_MAX_AGE_MS


class _TokenValidator:
    """Stands in for the WorkOS validator: the token ``tok-<sub>`` is a verified JWT for ``<sub>``."""

    def can_handle(self, token: str) -> bool:
        return token.startswith("tok-")

    async def validate(self, token: str) -> tuple[dict, None]:
        return {"type": "jwt", "sub": token.removeprefix("tok-")}, None


def _bearer(principal: Principal) -> dict[str, str]:
    return {"authorization": f"Bearer tok-{principal.sub}"}


def test_job_routes_under_auth_through_the_middleware_chain(db_url, auth_on, monkeypatch):
    """REQUIRE_AUTH=true through the middleware chain plugin.py builds, against the real job routes.

    The owner reaches the job with their envelope; a project teammate reads and
    steers it with an envelope signed for the project; a conversation viewer
    reads it but cannot steer it; another project's member gets 404. A JWT call
    with no envelope reaches only what its caller owns. A caller with no user token
    and no envelope reaches an internal route when it sends the internal token,
    and is refused without it.
    """
    monkeypatch.setenv("APP_ENV", "production")
    _seed(db_url)
    worker = SimpleNamespace(
        _db_url=db_url,
        _config_file_path="config.yml",
        _front_end_config=SimpleNamespace(expiry_seconds=86400),
    )
    app = FastAPI()
    validators = [_TokenValidator()]
    # The order plugin.py adds them in: AuthMiddleware is the outer layer.
    app.add_middleware(GridContextEnvelopeMiddleware, require_auth=True, validators=validators)
    app.add_middleware(AuthMiddleware, validators=validators, require_auth=True)
    asyncio.run(jobs_routes.register_job_routes(app, MagicMock(), worker))
    client = TestClient(app)

    def call(method: str, path: str, principal: Principal, envelope: dict[str, str] | None) -> int:
        headers = {**_bearer(principal), **(envelope or {})}
        return client.request(method, path, headers=headers).status_code

    owner_envelope = _envelope(user_id=OWNER.sub, project_collection="proj_alpha")
    project_envelope = _envelope(project_collection="proj_alpha")
    conversation_envelope = _envelope(conversation_id="conv-1")
    other_project_envelope = _envelope(project_collection="proj_beta")

    assert call("GET", "/v1/jobs/async/job/job-1", OWNER, owner_envelope) == 200
    assert call("GET", "/v1/jobs/async/job/job-1", TEAMMATE, project_envelope) == 200
    assert call("POST", "/v1/jobs/async/job/job-1/write-now", TEAMMATE, project_envelope) == 200
    assert call("GET", "/v1/jobs/async/job/job-1", TEAMMATE, conversation_envelope) == 200
    assert call("POST", "/v1/jobs/async/job/job-1/write-now", TEAMMATE, conversation_envelope) == 404
    assert call("GET", "/v1/jobs/async/job/job-1", TEAMMATE, other_project_envelope) == 404
    # No envelope, as from a frontend before ADR-0084: the owner still reaches
    # its job on the bearer alone, and nobody else does.
    assert call("GET", "/v1/jobs/async/job/job-1", OWNER, None) == 200
    assert call("GET", "/v1/jobs/async/job/job-1", TEAMMATE, None) == 404

    internal = client.get(
        "/v1/internal/jobs/job-missing/outcome",
        params={"organization_id": "org-1"},
        headers={"x-internal-token": SECRET},
    )
    no_token = client.get("/v1/internal/jobs/job-missing/outcome", params={"organization_id": "org-1"})

    # 404 from the handler ("Job not found"), so the call got past both gates.
    assert internal.status_code == 404
    assert internal.json()["detail"] == "Job not found: job-missing"
    assert no_token.status_code == 403
