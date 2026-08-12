"""Content-addressed model cache.

A port of ``packages/ifc-spatial/src/cache.ts`` and the ``SpatialCache`` at the
foot of ``model.ts``, merged into one class because on this engine there is only
one thing to cache. The TS package has two — a kilobyte-scale graph and a
megabyte-scale geometry index — and bounds them separately. IfcOpenShell holds
the file, the tessellations, the OCCT tree and the contact map behind a single
:class:`~ifc_spatial.model.SpatialModel`, so there is one lifetime and one lid.

## Why the key is the content and not the path

The premise is "just send the file": a host hands over bytes and gets a model
back, with no upload table and no lifecycle to keep in step. That premise only
survives contact with a conversation if the same bytes are never read twice — a
150 MB IFC costs seconds and several times its own size in peak memory, and an
agent that asks four questions about one building must not pay that four times.

The key is therefore the sha256 of the source bytes, not a file name, a path or
an upload id. Two consequences that are the point rather than side effects: a
re-upload of an unchanged file is a hit, and an edited file is a guaranteed
miss. Nothing here can serve a model that belongs to different bytes, which is
the failure a name-keyed cache eventually produces and cannot be talked out of.

Hashing is not free — a few hundred milliseconds for a large file — but it is an
order of magnitude below the read it decides. Measured on the sample house:
2.3 MB hashes in 2 ms against a 245 ms open, before the geometry pass that costs
another 1.6–2.4 s.

## Why the bound is an entry count and not a byte budget

The TS ``GraphCache`` carries an ``estimateBytes`` built from node and edge
counts, and its own docstring says the number "must never be reported as a
measurement". That estimate was defensible there because a graph is plain
JavaScript objects whose shape the code knows. Here it is not defensible at all:

  - the dominant terms are **outside Python**. The triangulations, the OCCT
    UB-tree and the BRep shapes live in the C++ heap behind SWIG proxies, and
    ``sys.getsizeof`` on the proxy returns the size of the pointer. A model
    measured at 351 MB RSS would be "estimated" at a few hundred kilobytes;
  - the cost is not proportional to anything countable up front. The same
    entity count produces wildly different memory depending on how curved the
    solids are, because the tessellator's chord deviation decides the triangle
    count, not the file;
  - the retained set GROWS after admission. ``SpatialModel`` is lazy: a model
    admitted after a topological question weighs almost nothing and the same
    object weighs hundreds of megabytes once someone asks for a clear height.
    A byte lid computed at admission would be wrong by the time it mattered.

An estimate that cannot be trusted is worse than an honest coarse limit, because
someone eventually puts it in a dashboard. So the lid is a count of models, kept
small on purpose — a conversation touches one building, occasionally two being
compared — and a host that needs a real memory bound should watch RSS and call
:meth:`SpatialCache.clear`, which is the only number that is actually true.

## What this cache is not

Process-local and unsynchronised. It holds no lock across processes, spans no
replica and survives no restart. It also has no tenancy: **a hash is not a
permission.** A host serving several tenants from one process must decide
whether a caller may see a building BEFORE it reaches this cache, because a
cache keyed on content happily serves anyone who can produce the same bytes.
"""

from __future__ import annotations

import atexit
import hashlib
import os
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path

from .model import SpatialModel

#: Every cache's spill table, so the interpreter can remove the files it wrote
#: even though the cache itself must not (see ``SpatialCache._temp``).
_TEMP_FILES: list[dict[str, str]] = []


@atexit.register
def _remove_spilled_files() -> None:
    for table in _TEMP_FILES:
        for path in table.values():
            try:
                os.unlink(path)
            except OSError:
                pass


#: Read size for hashing. One megabyte keeps a 150 MB file off the heap without
#: turning the hash into a syscall storm.
_CHUNK = 1 << 20


def hash_bytes(data: bytes) -> str:
    """sha256 of these bytes, hex."""
    return hashlib.sha256(data).hexdigest()


def hash_file(path: str | os.PathLike[str]) -> str:
    """sha256 of this file's bytes, hex — streamed, never fully resident."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


class _Pending:
    """One read in flight, and everyone waiting on it.

    Deliberately not :class:`concurrent.futures.Future`: this cache must work
    the same way whether it is called from a thread pool, from an asyncio
    handler via ``to_thread``, or from a plain synchronous test, and an
    ``Event`` plus two slots is the only shape that does all three without
    dragging an executor into the library.
    """

    __slots__ = ("done", "model", "error")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.model: SpatialModel | None = None
        self.error: BaseException | None = None


class SpatialCache:
    """Opened models, keyed by the sha256 of their bytes."""

    def __init__(self, max_entries: int = 4) -> None:
        #: Insertion order IS the LRU order: a hit moves the key to the end, so
        #: the oldest key is always the first one iteration yields. No second
        #: structure, no timestamps to keep in step with the entries they
        #: describe.
        self._models: OrderedDict[str, SpatialModel] = OrderedDict()
        self._in_flight: dict[str, _Pending] = {}
        self._lock = threading.Lock()
        self._max_entries = max(1, max_entries)
        self._hits = 0
        self._misses = 0
        #: Temporary files this cache created for byte-sourced models.
        #:
        #: Never deleted on eviction, and that is deliberate. ``SpatialModel``
        #: holds the PATH, and IfcOpenShell reads the file again for the
        #: geometry pass and the OCCT tree — so an evicted model handed out
        #: earlier is still live in a caller's hands and still needs its file.
        #: Unlinking it would turn an eviction (a memory decision) into a broken
        #: model (a correctness one). They are cleaned up when the process ends.
        self._temp: dict[str, str] = {}
        _TEMP_FILES.append(self._temp)

    # ── introspection ───────────────────────────────────────────────────────

    @property
    def stats(self) -> dict[str, int]:
        """Counters for the process, not for a request.

        ``misses`` counts READS STARTED and ``hits`` counts calls served without
        one — including a call that joined a read already in flight. Defined
        that way because the number anyone actually wants from a cache is "how
        many times did we open an IFC", and a coalesced caller did not.
        """
        return {"hits": self._hits, "misses": self._misses, "entries": len(self._models)}

    def has(self, content_hash: str) -> bool:
        """Is this hash resident?

        Neither counted nor treated as a use: a question ABOUT the cache must
        not change what the cache would evict next, or a monitoring loop quietly
        becomes the thing that decides retention.
        """
        with self._lock:
            return content_hash in self._models

    def get(self, content_hash: str) -> SpatialModel | None:
        """The model for this hash, or ``None`` — the lookup a caller makes when
        it holds a handle and not the bytes."""
        with self._lock:
            model = self._models.get(content_hash)
            if model is None:
                self._misses += 1
                return None
            self._models.move_to_end(content_hash)
            self._hits += 1
            return model

    def resolve(self, prefix: str) -> SpatialModel | None:
        """A model by an abbreviated hash, the way a git object is addressed.

        Returns ``None`` for both "no such prefix" and "ambiguous prefix"; the
        caller distinguishes them with :meth:`hashes`, because the two need
        different German sentences and this class has no opinion about German.
        """
        key = prefix.strip().lower()
        with self._lock:
            if key in self._models:
                self._models.move_to_end(key)
                return self._models[key]
            matches = [h for h in self._models if h.startswith(key)] if len(key) >= 8 else []
        if len(matches) == 1:
            return self.get(matches[0])
        return None

    def hashes(self) -> list[str]:
        with self._lock:
            return list(self._models)

    # ── loading ─────────────────────────────────────────────────────────────

    def load(self, path: str | os.PathLike[str]) -> SpatialModel:
        """The model for this file — from the cache, from a read already
        running, or from a read this call starts. Exactly one of the three."""
        return self._load(hash_file(path), str(path), None)

    def load_bytes(self, data: bytes, *, suffix: str = ".ifc") -> SpatialModel:
        """The model for these bytes.

        The bytes are spilled to a temporary file, because ``ifcopenshell.open``
        wants a path and because the geometry iterator and the OCCT tree read
        the file again after the entity graph is in memory — a string handed to
        ``ifcopenshell.file.from_string`` would have to stay resident twice
        over, once as Python bytes and once inside the C++ reader. The spill
        happens once per content hash, so a re-upload of the same file costs
        nothing.
        """
        content = hash_bytes(data)
        with self._lock:
            existing = self._models.get(content)
            if existing is not None:
                self._models.move_to_end(content)
                self._hits += 1
                return existing
            path = self._temp.get(content)
        if path is None:
            handle, path = tempfile.mkstemp(prefix=f"ifc-spatial-{content[:12]}-", suffix=suffix)
            with os.fdopen(handle, "wb") as file:
                file.write(data)
            with self._lock:
                self._temp[content] = path
        return self._load(content, path, data)

    def _load(self, content: str, path: str, data: bytes | None) -> SpatialModel:
        with self._lock:
            resident = self._models.get(content)
            if resident is not None:
                self._models.move_to_end(content)
                self._hits += 1
                return resident
            running = self._in_flight.get(content)
            if running is not None:
                # Single-flight, and it matters more here than it does for a
                # graph: two concurrent opens of one model would run two
                # geometry passes and hold two full tessellations at the same
                # instant, which is precisely when memory is tightest. That is
                # not a rare race — it is the ordinary shape of a user
                # double-clicking, a retry landing on the same replica, or an
                # agent firing two tool calls at one building.
                self._hits += 1
                pending = running
            else:
                self._misses += 1
                pending = _Pending()
                self._in_flight[content] = pending
                running = None

        if running is not None:
            pending.done.wait()
            if pending.error is not None:
                raise pending.error
            assert pending.model is not None
            return pending.model

        try:
            model = SpatialModel(path)
        except BaseException as error:  # noqa: BLE001 — re-raised to every waiter
            pending.error = error
            with self._lock:
                # Cleared on BOTH outcomes. Leaving a failed read in the map
                # would poison the hash for the life of the process: every later
                # caller would join a read that already failed and receive its
                # error, turning one transient failure — a truncated upload, a
                # momentary allocation failure — into a permanent one for those
                # exact bytes.
                self._in_flight.pop(content, None)
            pending.done.set()
            raise
        else:
            pending.model = model
            with self._lock:
                # Admission on the success path only: a read that threw must
                # never leave a half-built model behind a cache hit.
                self._models[content] = model
                self._models.move_to_end(content)
                self._evict(keep=content)
                self._in_flight.pop(content, None)
            pending.done.set()
            return model

    def _evict(self, keep: str) -> None:
        """Evict oldest-first until the lid holds — but never the entry just
        admitted.

        A cache that can evict what it has only just stored re-reads the same
        file on every single call, which is worse than no cache: same read cost,
        plus the hashing, plus a stats line claiming a cache exists.
        """
        while len(self._models) > self._max_entries:
            oldest = next(iter(self._models))
            if oldest == keep:
                break
            self._models.pop(oldest, None)

    def clear(self) -> None:
        """Drop every retained model.

        Reads already in flight are left running and their results are still
        admitted. They are not ours to cancel — callers are waiting on them —
        and a model is valid for its hash no matter when it was asked for, so
        refusing to admit it would only guarantee the next caller re-reads the
        same file.

        ``hits`` and ``misses`` survive: they describe the process's history,
        and resetting them on a clear would hide the very re-reads a clear
        causes.
        """
        with self._lock:
            self._models.clear()


__all__ = ["SpatialCache", "hash_bytes", "hash_file"]
