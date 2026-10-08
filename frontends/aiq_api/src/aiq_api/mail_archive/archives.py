"""Open archives, kept for the next slice.

Opening an archive reads its header and B-tree roots, and a slice of the BFF's
import asks for a page of messages and then each of their attachments: a dozen
requests against the same archive within seconds. Each would otherwise reopen
it and refill the block cache. So an archive stays open between requests,
keyed by its storage key, for a few minutes after its last use, and at most
:data:`MAX_OPEN` of them per process. A replica that never saw the archive
simply opens it; nothing depends on landing on the same one.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from dataclasses import dataclass

import httpx

from .reader import Archive
from .reader import open_archive
from .remote_file import RangeFile

MAX_OPEN = 2
IDLE_SECONDS = 300

#: In-network object store requests: no proxy, generous read time for a cold block.
_CLIENT = httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0), trust_env=False)


@dataclass
class _Open:
    archive: Archive
    file: RangeFile
    size: int
    used_at: float


_open: OrderedDict[str, _Open] = OrderedDict()
_lock = threading.Lock()


def archive_for(key: str, url: str, size: int) -> Archive:
    """The open archive stored at ``key``, read through ``url`` from now on."""
    with _lock:
        _close_idle(time.monotonic())
        entry = _open.get(key)
        if entry is not None and entry.size == size:
            entry.file.renew(url)
            entry.used_at = time.monotonic()
            _open.move_to_end(key)
            return entry.archive
    remote = RangeFile(url, size, _CLIENT)
    archive = open_archive(remote)
    with _lock:
        raced = _open.get(key)
        if raced is not None and raced.size == size:
            # Another request opened it meanwhile; keep theirs, drop ours.
            archive.close()
            return raced.archive
        _open[key] = _Open(archive=archive, file=remote, size=size, used_at=time.monotonic())
        evicted = [_open.popitem(last=False)[1] for _ in range(len(_open) - MAX_OPEN)]
    if raced is not None:
        evicted.append(raced)
    for entry in evicted:
        _close(entry)
    return archive


def reset_open_archives() -> None:
    """Close every open archive. For tests, and for nothing else."""
    with _lock:
        while _open:
            _, entry = _open.popitem(last=False)
            _close(entry)


def _close_idle(now: float) -> None:
    for key in [key for key, entry in _open.items() if now - entry.used_at > IDLE_SECONDS]:
        _close(_open.pop(key))


def _close(entry: _Open) -> None:
    # Taking the archive's own lock waits out a read still running on it.
    with entry.archive.lock:
        entry.archive.close()
