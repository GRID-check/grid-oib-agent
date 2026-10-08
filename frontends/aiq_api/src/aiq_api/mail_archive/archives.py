"""Open archives, kept for the next slice.

Opening an archive reads its header and B-tree roots, and a slice of the BFF's
import asks for a page of messages and then each of their attachments: a dozen
requests against the same archive within seconds. Each would otherwise reopen
it and refill the block cache. So an archive stays open between requests,
keyed by its storage key, for a few minutes after its last use, and at most
:data:`MAX_OPEN` idle ones per process. A replica that never saw the archive
simply opens it; nothing depends on landing on the same one.

An archive in use is never closed under its reader: :func:`use_archive` holds a
count, eviction passes over a held archive, and the last holder closes one that
was evicted meanwhile. Idle archives are closed by a janitor thread, so a
replica that stops being asked does not keep their block caches (64 MiB each).
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

import httpx

from .reader import Archive
from .reader import open_archive
from .remote_file import RangeFile

MAX_OPEN = 2
IDLE_SECONDS = 300
JANITOR_SECONDS = 60

#: In-network object store requests: no proxy, generous read time for a cold block.
_CLIENT = httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0), trust_env=False)


@dataclass
class _Open:
    archive: Archive
    file: RangeFile
    size: int
    used_at: float
    holders: int = 0
    #: Dropped from the cache while held; the last holder closes it.
    evicted: bool = False


_open: OrderedDict[str, _Open] = OrderedDict()
_lock = threading.Lock()
_janitor: threading.Thread | None = None


@contextmanager
def use_archive(key: str, url: str, size: int) -> Iterator[Archive]:
    """The archive stored at ``key``, read through ``url``, held open for the block."""
    entry = _acquire(key, url, size)
    try:
        with entry.archive.lock:
            entry.file.clear_error()
            yield entry.archive
    finally:
        _release(entry)


def reset_open_archives() -> None:
    """Close every open archive. For tests, and for nothing else."""
    with _lock:
        entries = list(_open.values())
        _open.clear()
    for entry in entries:
        entry.archive.close()


def _acquire(key: str, url: str, size: int) -> _Open:
    with _lock:
        entry = _open.get(key)
        if entry is not None and entry.size == size:
            entry.file.renew(url)
            entry.holders += 1
            _open.move_to_end(key)
            return entry
    remote = RangeFile(url, size, _CLIENT)
    opened = _Open(archive=open_archive(remote), file=remote, size=size, used_at=time.monotonic(), holders=1)
    with _lock:
        raced = _open.get(key)
        if raced is not None and raced.size == size:
            # Another request opened it meanwhile; keep theirs, drop ours.
            raced.holders += 1
            dropped, entry = opened, raced
        else:
            dropped, entry = None, opened
            _open[key] = opened
        closable = _evict_over_capacity()
        if raced is not None and raced.size != size:
            # The key now names a different object; retire the old one.
            raced.evicted = True
            if not raced.holders:
                closable.append(raced)
    _ensure_janitor()
    if dropped is not None:
        dropped.archive.close()
    for stale in closable:
        stale.archive.close()
    return entry


def _release(entry: _Open) -> None:
    with _lock:
        entry.holders -= 1
        entry.used_at = time.monotonic()
        close = entry.evicted and entry.holders == 0
    if close:
        entry.archive.close()


def _evict_over_capacity() -> list[_Open]:
    """Drop the least recently used idle archives past :data:`MAX_OPEN`; those safe to close now. Holds ``_lock``."""
    closable: list[_Open] = []
    for key in list(_open):
        if len(_open) <= MAX_OPEN:
            break
        entry = _open[key]
        if entry.holders:
            continue
        del _open[key]
        closable.append(entry)
    return closable


def _close_idle(now: float) -> None:
    with _lock:
        idle = [key for key, entry in _open.items() if not entry.holders and now - entry.used_at > IDLE_SECONDS]
        entries = [_open.pop(key) for key in idle]
    for entry in entries:
        entry.archive.close()


def _ensure_janitor() -> None:
    global _janitor
    with _lock:
        if _janitor is not None and _janitor.is_alive():
            return
        _janitor = threading.Thread(target=_sweep_forever, name="mail-archive-janitor", daemon=True)
        _janitor.start()


def _sweep_forever() -> None:
    while True:
        time.sleep(JANITOR_SECONDS)
        _close_idle(time.monotonic())
