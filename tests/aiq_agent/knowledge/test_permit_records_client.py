"""The permit-records write: path, token header, exact body, and never an exception.

Against a real local HTTP server, so the wire (JSON body, header casing, no redirect
following) is what is asserted rather than a mocked ``httpx.post``.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler
from http.server import HTTPServer

import pytest

from aiq_agent.knowledge.permit_extraction import PermitRecord
from aiq_agent.knowledge.permit_records_client import store_permit_record


class _Bff:
    """A stand-in BFF: records requests, answers with the configured status and body."""

    def __init__(self, status: int = 200, body: object = None, headers: dict[str, str] | None = None):
        self.requests: list[dict] = []
        self.status = status
        self.body = {"stored": True, "requirements": 1} if body is None else body
        self.headers = headers or {}
        bff = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - http.server's name
                length = int(self.headers.get("Content-Length", 0))
                bff.requests.append(
                    {
                        "path": self.path,
                        "token": self.headers.get("X-Grid-Internal-Token"),
                        "body": self.rfile.read(length),
                    }
                )
                payload = json.dumps(bff.body).encode() if not isinstance(bff.body, bytes) else bff.body
                self.send_response(bff.status)
                for name, value in bff.headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):  # noqa: D102 - silence the test output
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def bff(monkeypatch):
    server = _Bff()
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", server.url + "/")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret")
    yield server
    server.close()


def _record() -> PermitRecord:
    return PermitRecord.model_validate(
        {
            "kind": "bewilligung",
            "authority": "Stadtgemeinde Baden",
            "municipality": "Baden",
            "bundesland": "niederoesterreich",
            "issued_on": "2020-09-14",
            "reference": None,
            "requirements": [
                {
                    "kind": "auflage",
                    "content": "Das Brandschutzgutachten vom 3. Juli 2020 ist einzuhalten.",
                    "evidence": None,
                    "legal_basis": None,
                    "page": 1,
                }
            ],
        }
    )


def test_a_record_is_posted_to_the_contracts_path_with_the_token_and_the_exact_body(bff):
    stored = store_permit_record("org_1", "d1", "proj_1", "Baubescheid_Baden_2020.pdf", "fake/model", _record())

    assert stored is True
    request = bff.requests[0]
    assert request["path"] == "/api/internal/permit-records"
    assert request["token"] == "secret"
    assert json.loads(request["body"]) == {
        "organizationId": "org_1",
        "documentId": "d1",
        "collection": "proj_1",
        "fileName": "Baubescheid_Baden_2020.pdf",
        "model": "fake/model",
        "record": {
            "kind": "bewilligung",
            "authority": "Stadtgemeinde Baden",
            "municipality": "Baden",
            "bundesland": "niederoesterreich",
            "issuedOn": "2020-09-14",
            "reference": None,
            "requirements": [
                {
                    "kind": "auflage",
                    "content": "Das Brandschutzgutachten vom 3. Juli 2020 ist einzuhalten.",
                    "evidence": None,
                    "legalBasis": None,
                    "page": 1,
                }
            ],
        },
    }


def test_without_a_document_id_the_body_has_no_documentid_key(bff):
    stored = store_permit_record("org_1", None, "proj_1", "Baubescheid_Baden_2020.pdf", "fake/model", _record())

    assert stored is True
    body = json.loads(bff.requests[0]["body"])
    assert "documentId" not in body
    assert body["collection"] == "proj_1"
    assert body["fileName"] == "Baubescheid_Baden_2020.pdf"


def test_no_record_posts_null_and_any_200_is_success(bff):
    bff.body = {"stored": False, "requirements": 0}

    assert store_permit_record("org_1", "d1", "proj_1", "f.pdf", "m", None) is True
    assert json.loads(bff.requests[0]["body"])["record"] is None


def test_an_unknown_document_is_not_stored(bff):
    bff.body = {"stored": False, "requirements": 0}
    assert store_permit_record("org_1", "d1", "proj_1", "f.pdf", "m", _record()) is False


@pytest.mark.parametrize("status", [400, 401, 404, 500])
def test_a_refusal_is_false_and_never_raises(bff, status):
    bff.status = status
    assert store_permit_record("org_1", "d1", "proj_1", "f.pdf", "m", _record()) is False


@pytest.mark.parametrize("body", [b"not json", b"[]", b'{"stored": "yes"}'])
def test_an_unreadable_answer_is_false(bff, body):
    bff.body = body
    assert store_permit_record("org_1", "d1", "proj_1", "f.pdf", "m", _record()) is False


def test_a_redirect_is_not_followed_and_does_not_carry_the_token(bff):
    other = _Bff()
    try:
        bff.status = 307
        bff.headers = {"Location": other.url + "/elsewhere"}
        assert store_permit_record("org_1", "d1", "proj_1", "f.pdf", "m", _record()) is False
        assert other.requests == []
    finally:
        other.close()


def test_an_unreachable_bff_is_false(monkeypatch):
    server = _Bff()
    url = server.url
    server.close()
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", url)
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret")

    assert store_permit_record("org_1", "d1", "proj_1", "f.pdf", "m", _record()) is False


@pytest.mark.parametrize("missing", ["FRONTEND_INTERNAL_URL", "GRID_INTERNAL_API_TOKEN"])
def test_an_unconfigured_transport_posts_nothing(bff, monkeypatch, missing):
    monkeypatch.delenv(missing)
    assert store_permit_record("org_1", "d1", "proj_1", "f.pdf", "m", _record()) is False
    assert bff.requests == []
