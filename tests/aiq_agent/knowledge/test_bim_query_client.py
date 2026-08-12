"""The BIM query client, and the one distinction it exists to draw.

An unavailable service is nothing the agent can do anything about; a rejected
query is a mistake it can correct and retry. Everything here is about keeping
those two apart — and about the tenant data that must not travel out of an
error body while doing it.
"""

from __future__ import annotations

import io
import json
import urllib.error
from typing import Any

import pytest

from aiq_agent.knowledge.bim_query import BimQueryRejectedError
from aiq_agent.knowledge.bim_query import BimQueryUnavailableError
from aiq_agent.knowledge.bim_query import _rejection_message
from aiq_agent.knowledge.bim_query import run_bim_query


def http_error(status: int, body: Any) -> urllib.error.HTTPError:
    """A urllib error carrying a JSON body, the way the BFF sends one."""
    payload = json.dumps(body).encode("utf-8") if body is not None else b"not json"
    return urllib.error.HTTPError(
        "http://frontend:3000/api/internal/bim/query",
        status,
        "Bad Request",
        {},  # type: ignore[arg-type]
        io.BytesIO(payload),
    )


class TestTheMessageAnAgentSeesWhenAQueryIsRefused:
    def test_reads_the_key_the_envelope_actually_carries(self):
        # `errorResponse` in lib/api/handler.ts emits {error, code, details}.
        # This used to read `message`, a key the BFF has never sent, so every
        # 4xx degraded to a bare status and the correctable text was lost.
        error = http_error(400, {"error": "gt/gte/lt/lte need a numeric value", "code": "BAD_REQUEST"})
        assert _rejection_message(error) == "gt/gte/lt/lte need a numeric value"

    def test_names_the_key_the_schema_did_not_recognise(self):
        # The top-level text for a schema failure is the generic "Invalid
        # request body"; the actionable half — WHICH key — is in the issues.
        error = http_error(
            400,
            {
                "error": "Invalid request body",
                "code": "BAD_REQUEST",
                "details": [
                    {
                        "code": "unrecognized_keys",
                        "path": ["query", "filter"],
                        "message": "Unrecognized key(s) in object: 'storey'",
                    }
                ],
            },
        )
        message = _rejection_message(error)
        assert "Invalid request body" in message
        assert "query.filter" in message
        assert "'storey'" in message

    def test_carries_at_most_three_issues_and_stays_short(self):
        # An agent's context is not a place to paste a validation dump.
        error = http_error(
            400,
            {
                "error": "Invalid request body",
                "details": [
                    {"path": ["query", f"f{index}"], "message": "Required"} for index in range(20)
                ],
            },
        )
        message = _rejection_message(error)
        assert message.count("Required") == 3
        assert len(message) <= 350

    def test_never_repeats_a_value_the_caller_sent(self):
        # A value in a property filter is a value out of the tenant's model.
        # Only `path` and `message` are read — never `received`/`input`.
        error = http_error(
            400,
            {
                "error": "Invalid request body",
                "details": [
                    {
                        "code": "invalid_type",
                        "path": ["query", "filter", "properties", 0, "value"],
                        "message": "Expected number, received string",
                        "received": "Brandabschnitt Nord — Bauteil 4711",
                        "input": "Brandabschnitt Nord — Bauteil 4711",
                    }
                ],
            },
        )
        assert "Brandabschnitt" not in _rejection_message(error)

    def test_falls_back_to_the_status_when_the_body_says_nothing(self):
        assert _rejection_message(http_error(422, {})) == "the query was refused (422)"
        assert _rejection_message(http_error(400, None)) == "the query was refused (400)"

    def test_ignores_a_body_that_is_not_an_object(self):
        assert _rejection_message(http_error(400, ["nope"])) == "the query was refused (400)"


class TestWhichErrorTheCallerGets:
    @pytest.fixture(autouse=True)
    def _token(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")

    def _raise(self, monkeypatch, error: Exception) -> None:
        def opener(_request, timeout=None):  # noqa: ANN001, ARG001
            raise error

        monkeypatch.setattr("aiq_agent.knowledge.bim_query._opener", type("O", (), {"open": staticmethod(opener)})())

    def test_a_correctable_400_is_a_rejection(self, monkeypatch):
        self._raise(monkeypatch, http_error(400, {"error": "groupBy \"property\" needs groupProperty {set, name}"}))
        with pytest.raises(BimQueryRejectedError) as caught:
            run_bim_query(organization_id="org", project_id="p", query={"op": "aggregate"})
        assert "groupProperty" in str(caught.value)

    @pytest.mark.parametrize("status", [401, 403, 429, 500, 503])
    def test_everything_else_is_unavailable(self, monkeypatch, status):
        # An auth failure, a rate limit and a dead service are not things the
        # agent can fix by rewriting its arguments, and telling it otherwise
        # invites a retry loop against a service that is already refusing.
        self._raise(monkeypatch, http_error(status, {"error": "nope"}))
        with pytest.raises(BimQueryUnavailableError):
            run_bim_query(organization_id="org", project_id="p", query={"op": "overview"})

    def test_a_missing_service_token_never_reaches_the_network(self, monkeypatch):
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        with pytest.raises(BimQueryUnavailableError):
            run_bim_query(organization_id="org", project_id="p", query={"op": "overview"})
