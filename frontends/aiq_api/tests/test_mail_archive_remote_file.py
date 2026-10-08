"""The range-reading file libpff opens a staged archive through.

The object store is an ``httpx.MockTransport`` serving ranges of an in-memory
blob, so these pin what is requested (aligned blocks, once each while cached)
and what a read returns across block boundaries.
"""

from __future__ import annotations

import io

import httpx
import pytest

from aiq_api.mail_archive import remote_file
from aiq_api.mail_archive.remote_file import RangeFile
from aiq_api.mail_archive.remote_file import RemoteFileError

BLOB = bytes(range(256)) * 40  # 10,240 bytes


@pytest.fixture(autouse=True)
def small_blocks(monkeypatch):
    monkeypatch.setattr(remote_file, "BLOCK_SIZE", 1024)
    monkeypatch.setattr(remote_file, "CACHE_BLOCKS", 3)


def _store(requests: list[str], blob: bytes = BLOB, status: int = 206) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        header = request.headers["range"]
        requests.append(header)
        first, last = (int(part) for part in header.removeprefix("bytes=").split("-"))
        return httpx.Response(status, content=blob[first : last + 1])

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_a_read_across_a_block_boundary_returns_the_exact_bytes():
    requests: list[str] = []
    file = RangeFile("http://store/archive.pst", len(BLOB), _store(requests))

    file.seek(1000)
    assert file.read(100) == BLOB[1000:1100]
    assert requests == ["bytes=0-1023", "bytes=1024-2047"]
    assert file.tell() == 1100


def test_a_block_already_read_is_served_from_the_cache():
    requests: list[str] = []
    file = RangeFile("http://store/archive.pst", len(BLOB), _store(requests))

    file.read(10)
    file.seek(500)
    file.read(10)
    assert requests == ["bytes=0-1023"]


def test_the_cache_is_bounded_and_evicts_the_least_recently_used_block():
    requests: list[str] = []
    file = RangeFile("http://store/archive.pst", len(BLOB), _store(requests))

    for offset in (0, 1024, 2048, 3072):
        file.seek(offset)
        file.read(1)
    file.seek(0)
    file.read(1)
    assert requests[-1] == "bytes=0-1023"
    assert len(requests) == 5


def test_the_last_block_is_short_and_a_read_past_the_end_is_empty():
    requests: list[str] = []
    file = RangeFile("http://store/archive.pst", len(BLOB), _store(requests))

    assert file.seek(-40, io.SEEK_END) == len(BLOB) - 40
    assert file.read(100) == BLOB[-40:]
    assert requests == ["bytes=9216-10239"]
    assert file.read(10) == b""


def test_a_renewed_url_is_used_for_the_next_fetch():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        first, last = (int(p) for p in request.headers["range"].removeprefix("bytes=").split("-"))
        return httpx.Response(206, content=BLOB[first : last + 1])

    file = RangeFile("http://store/a?sig=1", len(BLOB), httpx.Client(transport=httpx.MockTransport(handler)))
    file.read(1)
    file.renew("http://store/a?sig=2")
    file.seek(5000)
    file.read(1)
    assert seen == ["http://store/a?sig=1", "http://store/a?sig=2"]


def test_a_store_that_ignores_the_range_is_an_error_not_a_wrong_byte():
    file = RangeFile("http://store/archive.pst", len(BLOB), _store([], status=200))

    with pytest.raises(RemoteFileError):
        file.read(10)
