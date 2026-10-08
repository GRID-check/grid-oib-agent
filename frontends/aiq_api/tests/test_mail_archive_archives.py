"""The open-archive cache: an archive in use is never closed under its reader."""

from __future__ import annotations

import threading

import pytest

from aiq_api.mail_archive import archives


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
    archives.reset_open_archives()
    yield opened
    archives.reset_open_archives()


def test_an_archive_is_reused_by_key(fake_open):
    with archives.use_archive("k1", "u1", 10) as first:
        pass
    with archives.use_archive("k1", "u2", 10) as second:
        assert second is first
    assert len(fake_open) == 1


def test_eviction_passes_over_an_archive_in_use_and_its_last_holder_closes_it(fake_open):
    with archives.use_archive("held", "u", 10) as held:
        for key in ("a", "b", "c"):
            with archives.use_archive(key, "u", 10):
                pass
        assert held.closed is False
    # Past capacity and released: the next eviction may now take it.
    with archives.use_archive("d", "u", 10):
        pass
    assert sum(1 for archive in fake_open if not archive.closed) <= archives.MAX_OPEN


def test_idle_archives_are_closed_after_the_idle_window(fake_open, monkeypatch):
    with archives.use_archive("k", "u", 10) as archive:
        pass
    archives._close_idle(archives.time.monotonic() + archives.IDLE_SECONDS + 1)
    assert archive.closed is True
