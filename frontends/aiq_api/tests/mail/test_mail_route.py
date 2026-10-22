"""``POST /v1/mail/read``: the internal token, the object-store gate, the fetch, and the answers."""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aiq_api.mail import limits
from aiq_api.mail.read import read_message
from aiq_api.routes import mail as route

TOKEN = "test-internal-token"
STORE = "http://seaweedfs:8333"
FILE_REF = f"{STORE}/grid-documents/org/o1/project/p1/_inbound-mail/m1/raw.eml?X-Amz-Signature=abc"
RAW = (Path(__file__).parent / "fixtures" / "outlook-reply-de.eml").read_bytes()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", TOKEN)
    monkeypatch.setenv("SEAWEED_ENDPOINT", STORE)
    monkeypatch.delenv("SEAWEED_PUBLIC_ENDPOINT", raising=False)
    fetched: list[str] = []

    async def fetch(url):
        fetched.append(url)
        return RAW

    async def read_in_process(raw):
        return read_message(raw)

    monkeypatch.setattr(route, "fetch_message", fetch)
    monkeypatch.setattr(route, "read_message_within", read_in_process)
    router = APIRouter()
    route.add_mail_routes(router)
    app = FastAPI()
    app.include_router(router)
    test_client = TestClient(app)
    test_client.fetched = fetched
    return test_client


def post(client: TestClient, body: dict, token: str | None = TOKEN) -> httpx.Response:
    headers = {"x-grid-internal-token": token} if token else {}
    return client.post("/v1/mail/read", json=body, headers=headers)


def test_a_caller_without_the_token_is_refused_before_the_body_is_looked_at(client):
    assert post(client, {"file_ref": "http://169.254.169.254/"}, token=None).status_code == 403
    assert post(client, {"file_ref": FILE_REF}, token="wrong").status_code == 403
    assert client.fetched == []


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",
        "http://seaweedfs:9333/cluster/status",
        "http://seaweedfs:8333@internal-admin:80/",
        "file:///etc/passwd",
    ],
)
def test_a_file_ref_off_the_object_store_is_refused_before_anything_is_fetched(client, url):
    response = post(client, {"file_ref": url})

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "file_ref"]
    assert client.fetched == []


def test_an_unknown_body_key_is_refused(client):
    assert post(client, {"file_ref": FILE_REF, "url": FILE_REF}).status_code == 422


def test_the_read_comes_back_in_the_wire_shape(client):
    response = post(client, {"file_ref": FILE_REF})

    assert response.status_code == 200
    body = response.json()
    assert client.fetched == [FILE_REF]
    assert body["reader_version"] == 1
    assert body["body_source"] == "plain"
    assert body["own_text"].startswith("Sehr geehrte Frau Berger,")
    assert body["quoted"][0]["header"].startswith("Von: Eva Berger")
    assert (body["unreadable"], body["unreadable_reasons"]) == (False, [])
    assert set(body) == {
        "reader_version",
        "body_source",
        "own_text",
        "own_text_truncated",
        "split",
        "signature_removed",
        "quoted",
        "quoted_truncated",
        "calendar",
        "calendar_truncated",
        "encrypted",
        "unreadable_reasons",
        "unreadable",
    }


def test_a_store_failure_is_a_502_the_job_retries(client, monkeypatch):
    async def fail(_url):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(route, "fetch_message", fail)
    response = post(client, {"file_ref": FILE_REF})

    assert response.status_code == 502
    assert FILE_REF not in response.text


def test_a_message_past_the_cap_is_unreadable_not_an_error(client, monkeypatch):
    async def too_large(_url):
        raise route.MessageTooLargeError

    monkeypatch.setattr(route, "fetch_message", too_large)
    response = post(client, {"file_ref": FILE_REF})

    assert response.status_code == 200
    assert response.json()["unreadable_reasons"] == ["message_too_large"]


def fetch_with(handler) -> bytes:
    return asyncio.run(route.fetch_message(FILE_REF, transport=httpx.MockTransport(handler)))


def test_the_fetch_reads_the_object():
    assert fetch_with(lambda request: httpx.Response(200, content=RAW)) == RAW


def test_the_fetch_follows_no_redirect():
    with pytest.raises(httpx.HTTPStatusError):
        fetch_with(lambda request: httpx.Response(302, headers={"location": "http://169.254.169.254/"}))


def test_the_fetch_stops_past_the_cap_whether_or_not_the_length_is_declared(monkeypatch):
    monkeypatch.setattr(limits, "MAX_MESSAGE_BYTES", 10)

    with pytest.raises(route.MessageTooLargeError):
        fetch_with(lambda request: httpx.Response(200, content=b"x" * 11))

    def undeclared(request):
        return httpx.Response(200, stream=httpx.ByteStream(b"x" * 11), headers={"transfer-encoding": "chunked"})

    with pytest.raises(route.MessageTooLargeError):
        fetch_with(undeclared)
