"""A seekable, read-only file over HTTP range requests, for libpff.

libpff reads an archive the way a parser reads a local file: hundreds of small
reads at scattered offsets (the spike against the pst-extractor fixtures made
12,848 reads for a 14 MB archive). One range request per read would be a
request per page of the B-tree, so reads are served from aligned blocks kept in
a small LRU, and a request fetches a whole block. Re-reading what libpff already
looked at, which it does (the same spike read the file twice over), then costs
nothing.

The URL is presigned and expires, while an open archive outlives one request,
so :meth:`RangeFile.renew` swaps it without dropping the cache.
"""

from __future__ import annotations

import io
import threading
from collections import OrderedDict

import httpx

#: One block per request. Large enough that a message and its attachments are a
#: handful of requests, small enough that a cache of them stays bounded.
BLOCK_SIZE = 1024 * 1024

#: Blocks kept per open archive: 64 MiB.
CACHE_BLOCKS = 64


class RemoteFileError(OSError):
    """The object store did not answer a range request with the bytes asked for."""


class RangeFile(io.RawIOBase):
    """The object at ``url``, ``size`` bytes long, read through a block cache."""

    def __init__(self, url: str, size: int, client: httpx.Client) -> None:
        super().__init__()
        self._url = url
        self._size = size
        self._client = client
        self._position = 0
        self._blocks: OrderedDict[int, bytes] = OrderedDict()
        self._lock = threading.Lock()

    def renew(self, url: str) -> None:
        """Read through a fresh presigned URL for the same object from now on."""
        self._url = url

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._position

    def get_size(self) -> int:
        return self._size

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._position, io.SEEK_END: self._size}[whence]
        target = base + offset
        if target < 0:
            raise ValueError("negative seek position")
        self._position = target
        return target

    def read(self, size: int = -1) -> bytes:
        end = self._size if size < 0 else min(self._size, self._position + size)
        if self._position >= end:
            return b""
        parts = [self._slice(offset, end) for offset in _block_starts(self._position, end)]
        data = b"".join(parts)
        self._position += len(data)
        return data

    def readinto(self, buffer) -> int:  # noqa: ANN001 - the io protocol's own signature
        data = self.read(len(buffer))
        buffer[: len(data)] = data
        return len(data)

    def _slice(self, block_start: int, end: int) -> bytes:
        """The part of the block at ``block_start`` that lies in [position, end)."""
        block = self._block(block_start)
        lo = max(self._position, block_start) - block_start
        hi = min(end, block_start + len(block)) - block_start
        return block[lo:hi]

    def _block(self, start: int) -> bytes:
        with self._lock:
            cached = self._blocks.get(start)
            if cached is not None:
                self._blocks.move_to_end(start)
                return cached
        block = self._fetch(start, min(self._size, start + BLOCK_SIZE) - 1)
        with self._lock:
            self._blocks[start] = block
            while len(self._blocks) > CACHE_BLOCKS:
                self._blocks.popitem(last=False)
        return block

    def _fetch(self, first: int, last: int) -> bytes:
        response = self._client.get(self._url, headers={"Range": f"bytes={first}-{last}"})
        expected = last - first + 1
        if response.status_code != 206 or len(response.content) != expected:
            raise RemoteFileError(
                f"range {first}-{last} answered {response.status_code} with {len(response.content)} bytes"
            )
        return response.content


def _block_starts(start: int, end: int) -> range:
    """The aligned block offsets covering [start, end)."""
    first = start - start % BLOCK_SIZE
    return range(first, end, BLOCK_SIZE)
