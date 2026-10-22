"""The open-archive cache: a held archive is never closed under its reader; a hit is only the URL's own object."""

from __future__ import annotations

import threading
from urllib.parse import parse_qs

import httpx
import pytest

from aiq_api.mail_archive import archives
from aiq_api.mail_archive.remote_file import RemoteFileError


class FakeArchive:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.closed = False

    def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def fake_open(monkeypatch):
    opened: list[FakeArchive] = []

    def open_archive(_file):
        archive = FakeArchive()
        opened.append(archive)
        return archive

    monkeypatch.setattr(archives, "open_archive", open_archive)
    monkeypatch.setattr(archives, "_ensure_janitor", lambda: None)
    monkeypatch.setattr(archives, "_CLIENT", _store())
    archives.reset_open_archives()
    yield opened
    archives.reset_open_archives()


STORE = "http://seaweedfs:8333"

#: The signatures the fake store honours; anything else is a 403, as SigV4 answers.
VALID_SIGNATURES = {"1", "2"}

#: The URLs the fake store was asked for, in order.
store_requests: list[str] = []


def _store() -> httpx.Client:
    store_requests.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        store_requests.append(str(request.url))
        signature = parse_qs(request.url.query.decode()).get("X-Amz-Signature", [""])[0]
        if signature not in VALID_SIGNATURES:
            return httpx.Response(403)
        first, last = (int(part) for part in request.headers["range"].removeprefix("bytes=").split("-"))
        return httpx.Response(206, content=b"x" * (last - first + 1))

    return httpx.Client(transport=httpx.MockTransport(handler))


def url(path: str, signature: str = "1") -> str:
    return f"{STORE}/{path}?X-Amz-Signature={signature}"


def test_an_archive_is_reused_for_a_fresh_url_of_the_same_object(fake_open):
    with archives.use_archive(url("staging/org_a/a.pst", "1"), 10) as first:
        pass
    with archives.use_archive(url("staging/org_a/a.pst", "2"), 10) as second:
        assert second is first
    assert len(fake_open) == 1


def test_a_url_for_another_object_never_reaches_an_open_archive(fake_open):
    # The cross-tenant read the caller-stated key allowed: same size, another object.
    with archives.use_archive(url("staging/org_a/a.pst"), 10) as theirs:
        pass
    with archives.use_archive(url("staging/org_b/b.pst"), 10) as mine:
        assert mine is not theirs
    assert len(fake_open) == 2


def test_the_object_is_the_origin_and_path_without_the_signature():
    assert archives.object_of(url("bucket/k.pst", "abc")) == f"{STORE}/bucket/k.pst"
    assert archives.object_of("http://other:8333/bucket/k.pst?sig=1") != archives.object_of(url("bucket/k.pst"))
    assert archives.object_of("HTTP://SeaweedFS:8333/bucket/k.pst?sig=2") == f"{STORE}/bucket/k.pst"


def test_eviction_passes_over_an_archive_in_use_and_its_last_holder_closes_it(fake_open):
    with archives.use_archive(url("held"), 10) as held:
        for key in ("a", "b", "c"):
            with archives.use_archive(url(key), 10):
                pass
        assert held.closed is False
    # Past capacity and released: the next eviction may now take it.
    with archives.use_archive(url("d"), 10):
        pass
    assert sum(1 for archive in fake_open if not archive.closed) <= archives.MAX_OPEN


def test_idle_archives_are_closed_after_the_idle_window(fake_open, monkeypatch):
    with archives.use_archive(url("k"), 10) as archive:
        pass
    archives._close_idle(archives.time.monotonic() + archives.IDLE_SECONDS + 1)
    assert archive.closed is True


def test_a_caller_naming_another_offices_key_gets_its_own_object_through_the_route(fake_open, monkeypatch):
    """C2's finding: the cache was keyed by the caller's ``key``, so a token holder could send another
    office's storage key with a presigned URL to any object of its own and be served that office's
    open archive. Through the route, the second request must open its own object."""
    from fastapi import APIRouter
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from aiq_api.mail_archive.reader import MessagePage
    from aiq_api.routes import mail_archive as route

    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "token")
    monkeypatch.setenv("SEAWEED_ENDPOINT", STORE)
    monkeypatch.setattr(FakeArchive, "page", lambda self, start, limit: MessagePage((), None, 0), raising=False)
    router = APIRouter()
    route.add_mail_archive_routes(router)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    victim_key = "grid-documents/org/o1/mail-import/i1/archive.pst"

    for path in ("grid-documents/org/o1/mail-import/i1/archive.pst", "grid-documents/org/o2/mail-import/i9/mine.pst"):
        response = client.post(
            "/v1/mail-archive/messages",
            json={"archive": {"key": victim_key, "url": url(path), "size": 10}, "start": 0},
            headers={"x-grid-internal-token": "token"},
        )
        assert response.status_code == 200

    assert len(fake_open) == 2


@pytest.mark.parametrize("unproven", [f"{STORE}/staging/org_a/a.pst", url("staging/org_a/a.pst", "forged")])
def test_a_url_the_store_does_not_honour_never_reaches_an_open_archive(fake_open, unproven):
    """Naming the object is not holding a right to it: an unsigned or forged URL
    for an open archive's path gets nothing from the cache, and the archive goes
    on reading through the URL it had, so its other holders lose nothing."""
    with archives.use_archive(url("staging/org_a/a.pst", "1"), 10) as theirs:
        pass

    with pytest.raises(RemoteFileError), archives.use_archive(unproven, 10):
        pytest.fail("an unproven URL was handed the open archive")

    entry = archives._open[archives.object_of(unproven)]
    assert entry.file._url == url("staging/org_a/a.pst", "1")
    assert entry.holders == 0
    with archives.use_archive(url("staging/org_a/a.pst", "2"), 10) as again:
        assert again is theirs
    assert len(fake_open) == 1
