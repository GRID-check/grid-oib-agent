"""The cache: content-addressed, single-flight, bounded by entries.

The property under test in every case is that the cache cannot serve a model
that belongs to different bytes, and cannot read the same bytes twice at the
same time. Both failures are invisible in a unit that only checks the returned
value: the first hands back the wrong building with a plausible answer attached,
and the second only shows up as memory on the day the model is 150 MB.
"""

from __future__ import annotations

import threading
from pathlib import Path

import pytest
from ifc_spatial.cache import SpatialCache
from ifc_spatial.cache import hash_bytes
from ifc_spatial.cache import hash_file
from ifc_spatial.model import SpatialModel

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
SMALL = FIXTURES / "haus-mit-raeumen.ifc"
OTHER = FIXTURES / "geschossdecke-und-fenster.ifc"


def test_the_key_is_the_content_and_not_the_name(tmp_path: Path) -> None:
    original = SMALL.read_bytes()
    copy = tmp_path / "ganz-anders-benannt.ifc"
    copy.write_bytes(original)
    assert hash_file(SMALL) == hash_file(copy) == hash_bytes(original)

    cache = SpatialCache()
    first = cache.load(SMALL)
    second = cache.load(copy)
    # Same bytes under two names is one model, without anybody comparing paths.
    assert first is second
    assert cache.stats["misses"] == 1


def test_an_edited_file_is_a_guaranteed_miss(tmp_path: Path) -> None:
    """The failure a name-keyed cache eventually produces and cannot be talked
    out of: serving the graph of the file as it used to be."""
    path = tmp_path / "modell.ifc"
    path.write_bytes(SMALL.read_bytes())
    cache = SpatialCache()
    before = cache.load(path)

    text = path.read_text(encoding="utf-8", errors="surrogateescape")
    path.write_text(text.replace("Wohnzimmer", "Wohnkueche", 1), encoding="utf-8", errors="surrogateescape")

    after = cache.load(path)
    assert after is not before
    assert cache.stats["misses"] == 2


def test_two_concurrent_opens_run_one_read() -> None:
    """Single-flight, and it matters more here than for a graph.

    Two concurrent opens of one model would run two geometry passes and hold two
    full tessellations at the same instant, which is precisely when memory is
    tightest. That is not a rare race — it is a user double-clicking, a retry
    landing on the same replica, or an agent firing two tool calls at one
    building.
    """
    cache = SpatialCache()
    gate = threading.Barrier(4)
    results: list[SpatialModel] = []
    lock = threading.Lock()

    def worker() -> None:
        gate.wait(timeout=30)
        model = cache.load(SMALL)
        with lock:
            results.append(model)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert len(results) == 4
    # One object, so one read of the file and one of everything that hangs off
    # it — the tessellation, the OCCT tree, the contact map.
    assert all(model is results[0] for model in results)
    stats = cache.stats
    assert stats["misses"] == 1, "a second read started"
    assert stats["hits"] == 3, "the coalesced callers were not counted as hits"
    assert stats["entries"] == 1


def test_a_failed_read_does_not_poison_the_hash(tmp_path: Path) -> None:
    """Leaving a failed read in the in-flight table would turn one transient
    failure — a truncated upload — into a permanent one for those exact bytes."""
    broken = tmp_path / "kaputt.ifc"
    broken.write_text("ISO-10303-21; das ist keine IFC-Datei", encoding="utf-8")
    cache = SpatialCache()
    with pytest.raises(Exception):
        cache.load(broken)
    with pytest.raises(Exception):
        cache.load(broken)
    assert cache.stats["entries"] == 0
    # And the good file still loads through the same cache.
    assert cache.load(SMALL) is not None


def test_the_lid_is_an_entry_count_and_evicts_oldest_first() -> None:
    cache = SpatialCache(max_entries=1)
    first = cache.load(SMALL)
    cache.load(OTHER)
    assert cache.stats["entries"] == 1
    assert cache.has(hash_file(SMALL)) is False
    assert cache.has(hash_file(OTHER)) is True

    # Evicted means "must be read again", never "wrong answer": the same bytes
    # still produce an equivalent model.
    again = cache.load(SMALL)
    assert again is not first
    assert cache.stats["misses"] == 3


def test_never_evicts_the_entry_it_just_admitted() -> None:
    """A cache that can evict what it just stored re-reads the same file on
    every call — same cost, plus the hashing, plus a stats line claiming a cache
    exists."""
    cache = SpatialCache(max_entries=1)
    model = cache.load(SMALL)
    assert cache.get(hash_file(SMALL)) is model


def test_bytes_and_path_reach_the_same_model() -> None:
    cache = SpatialCache()
    from_path = cache.load(SMALL)
    from_bytes = cache.load_bytes(SMALL.read_bytes())
    assert from_path is from_bytes
    assert cache.stats["misses"] == 1


def test_a_handle_resolves_by_abbreviated_hash() -> None:
    cache = SpatialCache()
    model = cache.load(SMALL)
    digest = hash_file(SMALL)
    assert cache.resolve(digest[:12]) is model
    # Too short to be a handle: an eight-character minimum keeps a stray word
    # from resolving to a building.
    assert cache.resolve("ab") is None
    assert cache.resolve("f" * 40) is None


def test_asking_about_the_cache_does_not_change_what_it_evicts() -> None:
    cache = SpatialCache()
    cache.load(SMALL)
    before = cache.stats
    assert cache.has(hash_file(SMALL)) is True
    assert cache.stats == before, "has() was counted as a use"
