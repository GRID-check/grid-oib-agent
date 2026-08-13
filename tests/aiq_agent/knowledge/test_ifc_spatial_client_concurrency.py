"""What happens when two turns reach the spatial engine at the same moment.

``ifc_measure`` runs its blocking work through ``asyncio.to_thread``, so every
module global in :mod:`aiq_agent.knowledge.ifc_spatial_client` is touched by
real worker threads. Two of them were touched without the lock the module
already owns, and both were reproduced before they were fixed:

  - ``_engine`` tested ``_TOOLS is None`` outside ``_LOCK`` and built the cache
    and the tool table outside it too. Four threads arriving together on a cold
    process built FOUR tool tables; three callers walked away holding one that
    was not the module's, so every model they opened was invisible to the next
    operator call;
  - ``open_model`` released the lock between deciding to rebuild the table and
    registering the handle that rebuild produced. A parse that took seconds
    while three other turns landed registered its handle into a table that had
    never seen its model.

The second one is the expensive one, because of how it FAILS. The handle is
listed as open and the operator raises ``SpatialToolError``, which
``measure_register`` renders as an argument mistake — so the agent is told the
architect's GlobalId is wrong, about a building it opened correctly, and it
never happens twice in a row.

Nothing here needs a network: the models are the repository's own fixtures and
the source identity is seeded straight into the spill table.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import pytest

FIXTURES = Path("packages/ifc-spatial/test/fixtures").resolve()
#: Four different buildings, because the failure is about a table sized for two.
MODELS = {
    "a": FIXTURES / "Ifc4_SampleHouse.ifc",
    "b": FIXTURES / "geschossdecke-und-fenster.ifc",
    "c": FIXTURES / "haus-mit-raeumen.ifc",
    "d": FIXTURES / "einheiten-fuss.ifc",
}


@pytest.fixture()
def engine():
    pytest.importorskip("ifc_spatial.tools", reason="the spatial engine is not installed")
    from aiq_agent.knowledge import ifc_spatial_client

    missing = [str(p) for p in MODELS.values() if not p.is_file()]
    if missing:
        pytest.skip(f"fixtures are not in this checkout: {missing}")

    ifc_spatial_client.reset_cache_for_tests()
    yield ifc_spatial_client
    ifc_spatial_client.reset_cache_for_tests()


def _seed(client: Any) -> None:
    """Give every identity a spill file that already exists.

    The download is not what this file is about, and routing four models through
    a test HTTP server would only add a second failure mode to a test whose
    subject is a lock.
    """
    client._engine()
    for key, path in MODELS.items():
        client._PATH_BY_SOURCE[f"etag:{key}"] = str(path)


def _source(key: str) -> dict[str, Any]:
    return {"resolved": True, "model": {"modelId": key}, "source": {"etag": key}}


def test_a_cold_process_builds_one_engine_no_matter_how_many_turns_arrive(engine, monkeypatch) -> None:
    """The docstring on ``_engine`` claimed a lock the code did not take.

    Reproduced with four threads and a ``create_tools`` slowed to 150 ms: four
    tables, and three of the four callers holding one the module had already
    replaced.
    """
    import ifc_spatial.tools as tools_module

    real = tools_module.create_tools
    built: list[Any] = []

    def slow(cache: Any = None) -> Any:
        time.sleep(0.15)
        table = real(cache)
        built.append(table)
        return table

    monkeypatch.setattr(tools_module, "create_tools", slow)

    got: list[tuple[Any, Any]] = []
    threads = [threading.Thread(target=lambda: got.append(engine._engine())) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)

    assert len(built) == 1
    # Every caller holds the table and the cache the module holds — a caller
    # holding its own is a caller whose models nothing else can see.
    assert all(tools is engine._TOOLS for _, tools in got)
    assert all(cache is engine._CACHE for cache, _ in got)
    assert len({id(tools) for _, tools in got}) == 1


def test_a_table_rebuild_cannot_land_between_a_parse_and_its_registration(engine, monkeypatch) -> None:
    """The reproduction, staged so it is not a race the test can lose.

    One turn's parse is held open while three others run. Without the open lock
    the third of those rebuilds the table and clears ``_OPEN_HANDLES``, the held
    turn then registers its handle into the cleared list, and the handle is
    listed as open while resolving in nothing.

    The assertion is the invariant, not the sequence: **a handle listed in
    ``_OPEN_HANDLES`` resolves.** Being evicted later is fine and expected —
    ``MAX_RESIDENT_MODELS`` is 2 — but then it is not listed.
    """
    import ifc_spatial.tools as tools_module

    _seed(engine)
    engine.open_model(_source("a"))
    engine.open_model(_source("b"))
    assert len(engine._OPEN_HANDLES) == engine.MAX_RESIDENT_MODELS

    real_call = tools_module.call
    parsed = threading.Event()
    release = threading.Event()

    def instrumented(tools: Any, name: str, args: dict[str, Any]) -> Any:
        result = real_call(tools, name, args)
        if name == "open_model" and threading.current_thread().name == "langsam":
            # A 150 MB model is genuinely seconds of C++ inside this call. The
            # event only makes that duration deterministic.
            parsed.set()
            release.wait(20)
        return result

    monkeypatch.setattr(tools_module, "call", instrumented)

    failures: list[BaseException] = []

    def slow_turn() -> None:
        try:
            engine.open_model(_source("c"))
        except BaseException as exc:  # noqa: BLE001 — reported, not swallowed
            failures.append(exc)

    def other_turns() -> None:
        try:
            parsed.wait(20)
            for key in ("d", "a", "b"):
                engine.open_model(_source(key))
        except BaseException as exc:  # noqa: BLE001
            failures.append(exc)

    threads = [
        threading.Thread(target=slow_turn, name="langsam"),
        threading.Thread(target=other_turns, name="andere"),
    ]
    for thread in threads:
        thread.start()
    # Long enough for the other turns to have rebuilt the table, if they can.
    time.sleep(1.5)
    release.set()
    for thread in threads:
        thread.join(60)

    assert not failures, failures
    monkeypatch.undo()

    unresolvable = []
    for handle in list(engine._OPEN_HANDLES):
        try:
            engine.call_spatial_tool(handle, "briefing", {})
        except Exception as exc:  # noqa: BLE001
            unresolvable.append((handle[:12], str(exc)))
    assert not unresolvable, f"handles listed as open that resolve in no table: {unresolvable}"


def test_the_second_question_about_one_building_does_not_queue_behind_another_parse(engine, monkeypatch) -> None:
    """The open lock must not be paid by the case that made the cache worth having.

    A conversation asks ten questions about one building. If the already-open
    check moved inside the open lock, every one of them would wait out whatever
    parse happened to be running — seconds, to answer from a dictionary.
    """
    import ifc_spatial.tools as tools_module

    _seed(engine)
    known = engine.open_model(_source("a"))

    release = threading.Event()
    parsing = threading.Event()
    real_call = tools_module.call

    def instrumented(tools: Any, name: str, args: dict[str, Any]) -> Any:
        result = real_call(tools, name, args)
        if name == "open_model" and threading.current_thread().name == "langsam":
            parsing.set()
            release.wait(20)
        return result

    monkeypatch.setattr(tools_module, "call", instrumented)
    blocker = threading.Thread(target=lambda: engine.open_model(_source("b")), name="langsam")
    blocker.start()
    try:
        assert parsing.wait(20)
        started = time.perf_counter()
        assert engine.open_model(_source("a")) == known
        assert time.perf_counter() - started < 1.0
    finally:
        release.set()
        blocker.join(60)
