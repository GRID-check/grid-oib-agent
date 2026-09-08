"""The mounts client: one HTTP answer to one refusal the model can act on.

Companion to ``tests/aiq_agent/test_mount_grants.py``, which covers the grant.
This is the other half of ``knowledge/mounts.py``: the call to the BFF's
internal mounts twin, and the mapping from what it answered to a coarse code —
the contract both the German prose and the UI's mount notice are built from.

The mapping is where a wrong refusal comes from. Two DIFFERENT conflicts share
the 409: the cap (too many projects in view) and the exclusion (mounting would
shut a participant of a shared conversation out, spec AC-8). Reading one as the
other tells the user to unmount something that is not in the way.
"""

from __future__ import annotations

import io
import json
import urllib.error

import pytest

from aiq_agent.knowledge import mounts


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _http_error(status: int, body: dict | None = None) -> urllib.error.HTTPError:
    payload = json.dumps(body or {}).encode("utf-8")
    return urllib.error.HTTPError("http://bff/x", status, "conflict", {}, io.BytesIO(payload))


@pytest.fixture
def _endpoint(monkeypatch):
    """The internal endpoint, stubbed. Yields what it was asked, and lets a test
    hand back a body or an error."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    state: dict = {"body": {}, "error": None, "captured": {}}

    class _Opener:
        def open(self, request, timeout=None):  # noqa: ANN001
            state["captured"] = {
                "url": request.full_url,
                "method": request.get_method(),
                "payload": json.loads(request.data.decode("utf-8")),
                "headers": dict(request.headers),
                "timeout": timeout,
            }
            if state["error"] is not None:
                raise state["error"]
            return _FakeResponse(json.dumps(state["body"]).encode("utf-8"))

    monkeypatch.setattr(mounts, "_opener", _Opener())
    return state


def _mount(**overrides):
    kwargs = {
        "conversation_id": "conv_1",
        "project_id": "proj-uuid-1",
        "organization_id": "org_1",
        "user_id": "user_1",
        "membership_id": "om_1",
    }
    kwargs.update(overrides)
    return mounts.request_mount(**kwargs)


class TestTheCall:
    def test_it_asks_as_the_user_and_says_the_agent_mounted_it(self, _endpoint):
        _endpoint["body"] = {
            "mount": {"projectId": "proj-uuid-1", "projectName": "Seestadt Baufeld D"},
            "grant": {"grant": "g", "sig": "s"},
        }

        outcome = _mount()

        assert isinstance(outcome, mounts.MountGranted)
        assert (outcome.project_id, outcome.project_name) == ("proj-uuid-1", "Seestadt Baufeld D")
        assert (outcome.grant, outcome.sig) == ("g", "s")
        captured = _endpoint["captured"]
        assert captured["url"].endswith("/api/internal/conversations/conv_1/mounts")
        assert captured["method"] == "POST"
        # The identity the endpoint authorizes ON — never the service's own.
        assert captured["payload"] == {
            "projectId": "proj-uuid-1",
            "organizationId": "org_1",
            "mountedBy": "agent",
            "userId": "user_1",
            "organizationMembershipId": "om_1",
        }

    def test_without_the_shared_token_it_never_calls(self, monkeypatch):
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)

        assert _mount() == mounts.MountRefused(mounts.REFUSAL_UNAVAILABLE)

    def test_a_mount_without_a_grant_is_not_readable_this_turn(self, _endpoint):
        """The row exists, so the next turn's scope header will carry it; THIS
        turn cannot read it and must not pretend otherwise."""
        _endpoint["body"] = {"mount": {"projectId": "proj-uuid-1", "projectName": "Seestadt"}}

        assert _mount() == mounts.MountRefused(mounts.REFUSAL_UNAVAILABLE)

    def test_a_transport_failure_is_a_refusal_not_an_exception(self, _endpoint):
        _endpoint["error"] = urllib.error.URLError("connection refused")

        assert _mount() == mounts.MountRefused(mounts.REFUSAL_UNAVAILABLE)


class TestTheRefusalMapping:
    def test_the_cap_carries_its_number_and_the_projects_in_view(self, _endpoint):
        _endpoint["error"] = _http_error(
            409, {"code": "WORKSPACE_MOUNT_CAP", "cap": 5, "mounted": ["Seestadt", "Krems", "  "]}
        )

        outcome = _mount()

        assert outcome == mounts.MountRefused(mounts.REFUSAL_CAP, cap=5, mounted=("Seestadt", "Krems"))

    def test_an_exclusion_is_not_the_cap(self, _endpoint):
        _endpoint["error"] = _http_error(
            409,
            {"code": "WORKSPACE_MOUNT_WOULD_EXCLUDE", "excluded": ["Anna Meier", "Bernd Huber"]},
        )

        outcome = _mount()

        assert outcome == mounts.MountRefused(mounts.REFUSAL_WOULD_EXCLUDE, excluded=("Anna Meier", "Bernd Huber"))
        assert outcome.cap is None

    def test_an_unreadable_conflict_body_still_refuses(self, _endpoint):
        """Every 409 was the cap before the exclusion existed, and a body this
        client cannot read must not become a mount."""
        _endpoint["error"] = urllib.error.HTTPError("http://bff/x", 409, "conflict", {}, io.BytesIO(b"not json"))

        assert _mount() == mounts.MountRefused(mounts.REFUSAL_CAP)

    @pytest.mark.parametrize(
        ("status", "code"),
        [
            (403, mounts.REFUSAL_NO_ACCESS),
            # 404 is DENIAL as well as absence: the endpoint answers a project
            # the caller may not read the same way it answers one that does not
            # exist (spec MT-4).
            (404, mounts.REFUSAL_NOT_FOUND),
            (400, mounts.REFUSAL_UNAVAILABLE),
            (500, mounts.REFUSAL_UNAVAILABLE),
        ],
    )
    def test_each_status_maps_to_one_coarse_code(self, _endpoint, status, code):
        _endpoint["error"] = _http_error(status)

        assert _mount().code == code

    def test_a_redirect_names_the_auth_proxy_in_the_log(self, _endpoint, caplog):
        """A 302 here means an auth middleware is intercepting /api/internal/*,
        which looks exactly like an outage unless the log says otherwise."""
        import logging

        _endpoint["error"] = _http_error(302)

        with caplog.at_level(logging.ERROR, logger=mounts.logger.name):
            assert _mount().code == mounts.REFUSAL_UNAVAILABLE

        assert any("unauthenticatedPaths" in record.getMessage() for record in caplog.records)
