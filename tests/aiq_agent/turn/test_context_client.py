"""Authenticated context transport: echo credentials, bound prompts, fail closed."""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import urllib.error
from dataclasses import replace
from unittest.mock import MagicMock

import pytest

from aiq_agent.project_context import ORG_INSTRUCTIONS_TRUNCATED_MARKER
from aiq_agent.project_context import GridRequestContext
from aiq_agent.turn import context_client as client
from aiq_agent.turn.context_client import ContextBlocks
from aiq_agent.turn.context_client import TurnContextError


@pytest.fixture
def request_context(monkeypatch) -> GridRequestContext:
    token = "test-context-token"  # noqa: S105 - local fixture only
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", token)
    raw = json.dumps(
        {
            "organizationId": "org_1",
            "userId": "user_1",
            "projectId": "513",
            "conversationId": "conv_text",
            "issuedAt": 1_757_500_000_000,
            "contextTransport": "bff",
        },
        indent=2,
    ).encode("utf-8")
    header = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    signature = hmac.new(token.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    context = GridRequestContext.from_envelope(header, signature, token)
    assert context is not None
    return context


@pytest.fixture
def opener(monkeypatch):
    response = MagicMock()
    response.__enter__.return_value = response
    response.status = 200
    response.read.return_value = json.dumps(
        {"data": {"projectContext": "PROFILE", "projectMemory": "MEMORY", "orgInstructions": "POLICY"}}
    ).encode("utf-8")
    opener = MagicMock()
    opener.open.return_value = response
    monkeypatch.setattr(client, "_opener", opener)
    return opener


def test_posts_only_query_and_echoes_signed_requester_bytes(request_context, opener, monkeypatch):
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://bff:3000/")
    blocks = client.fetch_turn_context(request_context, query="  Wie hoch?  ")
    assert blocks == ContextBlocks("PROFILE", "MEMORY", "POLICY")
    request = opener.open.call_args.args[0]
    assert request.full_url == "http://bff:3000/api/internal/turn-context"
    assert request.method == "POST"
    assert json.loads(request.data) == {"query": "Wie hoch?"}
    headers = {key.lower(): value for key, value in request.header_items()}
    assert headers == {
        "content-type": "application/json",
        "x-grid-internal-token": "test-context-token",
        "x-grid-request-context": request_context.envelope_header,
        "x-grid-request-context-sig": request_context.envelope_signature,
    }
    assert opener.open.call_args.kwargs["timeout"] == client.REQUEST_TIMEOUT_SECONDS


@pytest.mark.parametrize("query", [None, "", "  \n "])
def test_empty_query_is_omitted(request_context, opener, query):
    client.fetch_turn_context(request_context, query=query)
    assert json.loads(opener.open.call_args.args[0].data) == {}


def test_query_is_bounded_in_characters_not_utf8_bytes(request_context, opener):
    client.fetch_turn_context(request_context, query=" " + "ö" * 2500 + " ")
    assert json.loads(opener.open.call_args.args[0].data) == {"query": "ö" * 2000}


@pytest.mark.parametrize("values", [None, "", " \n "])
def test_nullable_and_empty_context_is_valid(request_context, opener, values):
    opener.open.return_value.read.return_value = json.dumps(
        {"data": {"projectContext": values, "projectMemory": values, "orgInstructions": values}}
    ).encode("utf-8")
    assert client.fetch_turn_context(request_context) == ContextBlocks(None, None, None)


def test_normalizes_each_block_using_existing_prompt_limits(request_context, opener):
    profile = "ö" * 3900 + "\n" + "x" * 500
    memory = "m" * 2900 + "\n" + "x" * 500
    instructions = "i" * 1600
    opener.open.return_value.read.return_value = json.dumps(
        {
            "data": {
                "projectContext": " " + profile + " ",
                "projectMemory": " " + memory + " ",
                "orgInstructions": " " + instructions + " ",
            }
        }
    ).encode("utf-8")
    blocks = client.fetch_turn_context(request_context)
    assert blocks.project_context == "ö" * 3900
    assert blocks.project_memory == "m" * 2900
    assert blocks.org_instructions == "i" * 1500 + "\n" + ORG_INSTRUCTIONS_TRUNCATED_MARKER


def test_a_6200_utf8_byte_profile_is_not_truncated_to_a_header_budget(request_context, opener):
    profile = "ö" * 3100
    assert len(profile.encode("utf-8")) == 6200
    opener.open.return_value.read.return_value = json.dumps(
        {"data": {"projectContext": profile, "projectMemory": None, "orgInstructions": None}},
        ensure_ascii=False,
    ).encode("utf-8")
    blocks = client.fetch_turn_context(request_context)
    assert blocks.project_context == profile
    request = opener.open.call_args.args[0]
    assert json.loads(request.data) == {}
    assert request_context.envelope_header == request.get_header("X-grid-request-context")


@pytest.mark.parametrize("status", [301, 302, 401, 403, 404, 429, 500, 503])
def test_http_errors_are_explicit_with_status(request_context, opener, status):
    opener.open.side_effect = urllib.error.HTTPError(
        "http://bff/api/internal/turn-context", status, "refused", {}, io.BytesIO(b"private server error")
    )
    with pytest.raises(TurnContextError, match=f"refused the call \\({status}\\)") as error:
        client.fetch_turn_context(request_context)
    assert error.value.status == status
    assert "private server error" not in str(error.value)


def test_non_success_response_status_is_rejected(request_context, opener):
    opener.open.return_value.status = 304
    with pytest.raises(TurnContextError) as error:
        client.fetch_turn_context(request_context)
    assert error.value.status == 304


@pytest.mark.parametrize("failure", [urllib.error.URLError("offline"), OSError("disconnected"), TimeoutError("slow")])
def test_network_failures_are_explicit(request_context, opener, failure):
    opener.open.side_effect = failure
    with pytest.raises(TurnContextError, match="could not be reached") as error:
        client.fetch_turn_context(request_context)
    assert error.value.status is None


@pytest.mark.parametrize("body", [b"<html>not JSON</html>", b"\xff", b""])
def test_malformed_json_is_an_explicit_error(request_context, opener, body):
    opener.open.return_value.read.return_value = body
    with pytest.raises(TurnContextError, match="malformed JSON"):
        client.fetch_turn_context(request_context)


@pytest.mark.parametrize("body", [None, [], {}, {"data": None}, {"data": []}, {"data": {}}, {"projectContext": "x"}])
def test_malformed_response_envelope_is_an_error(request_context, opener, body):
    opener.open.return_value.read.return_value = json.dumps(body).encode("utf-8")
    with pytest.raises(TurnContextError):
        client.fetch_turn_context(request_context)


@pytest.mark.parametrize("field", ["projectContext", "projectMemory", "orgInstructions"])
@pytest.mark.parametrize("value", [False, 123, [], {}])
def test_context_fields_must_be_string_or_null(request_context, opener, field, value):
    data = {"projectContext": None, "projectMemory": None, "orgInstructions": None}
    data[field] = value
    opener.open.return_value.read.return_value = json.dumps({"data": data}).encode("utf-8")
    with pytest.raises(TurnContextError, match=f"invalid {field}"):
        client.fetch_turn_context(request_context)


@pytest.mark.parametrize("field", ["projectContext", "projectMemory", "orgInstructions"])
def test_missing_field_is_not_a_successful_empty_context(request_context, opener, field):
    data = {"projectContext": None, "projectMemory": None, "orgInstructions": None}
    del data[field]
    opener.open.return_value.read.return_value = json.dumps({"data": data}).encode("utf-8")
    with pytest.raises(TurnContextError, match=f"omitted {field}"):
        client.fetch_turn_context(request_context)


def test_missing_token_fails_before_network(request_context, opener, monkeypatch):
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN")
    with pytest.raises(TurnContextError, match="not configured"):
        client.fetch_turn_context(request_context)
    opener.open.assert_not_called()


@pytest.mark.parametrize("missing_field", ["envelope_header", "envelope_signature"])
def test_missing_signed_credentials_fails_before_network(request_context, opener, missing_field):
    request_context = replace(request_context, **{missing_field: None})
    with pytest.raises(TurnContextError, match="signed requester credentials"):
        client.fetch_turn_context(request_context)
    opener.open.assert_not_called()


def test_redirect_handler_never_follows_redirects():
    with pytest.raises(urllib.error.HTTPError) as error:
        client._NoRedirectHandler().redirect_request(
            MagicMock(full_url="http://bff/api/internal/turn-context"),
            None,
            302,
            "Found",
            {},
            "https://other.example/secret",
        )
    assert error.value.code == 302
    assert "other.example" not in str(error.value)
