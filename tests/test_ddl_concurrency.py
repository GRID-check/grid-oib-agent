"""Every lazy schema creation survives the boot, where the processes that create it start together.

``CREATE TABLE IF NOT EXISTS`` is not safe under concurrency in Postgres: two
sessions that both find the table missing race on the ``pg_type`` catalog, and
the loser raises ``UniqueViolation`` (or ``DuplicateTable``). The backend starts
``chat``, ``api``, ``worker`` and ``ingest-worker`` against one database at once,
so in a real Compose boot two of them logged::

    duplicate key value violates unique constraint "pg_type_typname_nsp_index"
    DETAIL:  Key (typname, typnamespace)=(ingest_jobs, 2200) already exists.

A single process cannot show it, and SQLite has no such race. So this runs each
ensure function in separate processes, released together by a barrier, against
a database nothing has touched, and asks each of them whether it came back clean
AND whether it marked the database as ensured (the stores that fail open would
otherwise hide the lost race in a log line). It needs a real server:

    GRID_TEST_PG_URL=postgresql://postgres@127.0.0.1:5432/postgres

names a database on it that this suite may create databases from. It makes and
drops its own, and touches nothing else. Prefer the IP to ``localhost``.
"""

from __future__ import annotations

import multiprocessing
import os
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.ddl_race_worker import SITES
from tests.ddl_race_worker import worker as ensure_in_child

_SERVER = os.environ.get("GRID_TEST_PG_URL")

pytestmark = pytest.mark.skipif(not _SERVER, reason="GRID_TEST_PG_URL not set")

#: Processes that create the schema at once. A boot is four roles, and replicas.
PROCESSES = 8
#: Fresh databases per site. One race window is narrow; several make a miss unlikely.
ROUNDS = 5
_TIMEOUT_SECONDS = 120

# --------------------------------------------------------------------------
# The run: once for all sites, so the children are imported once.
# --------------------------------------------------------------------------


def _database_url(name: str) -> str:
    return make_url(_SERVER).set(database=name).render_as_string(hide_password=False)


@pytest.fixture(scope="module")
def outcomes():
    """``{site: [(url, process, error, ensured), ...]}`` for ``ROUNDS`` fresh databases per site."""
    admin = create_engine(
        make_url(_SERVER).set(drivername="postgresql+psycopg"), isolation_level="AUTOCOMMIT", poolclass=None
    )
    run = uuid.uuid4().hex[:8]
    tasks: list[tuple[str, str]] = []
    databases: list[str] = []
    with admin.connect() as conn:
        for round_ in range(ROUNDS):
            for site in SITES:
                name = f"ddl_{run}_{site}_{round_}"
                conn.execute(text(f'CREATE DATABASE "{name}"'))
                databases.append(name)
                tasks.append((site, _database_url(name)))

    # The LangGraph sites take a session lock on the direct DSN (`keyed_lock`). An advisory lock is
    # per database, so one fixed database serves them all: the creators still exclude each other.
    previous_lock_url = os.environ.get("AIQ_LOCK_DB_URL")
    os.environ["AIQ_LOCK_DB_URL"] = _SERVER
    context = multiprocessing.get_context("spawn")
    barrier, results = context.Barrier(PROCESSES), context.Queue()
    processes = [context.Process(target=ensure_in_child, args=(i, barrier, tasks, results)) for i in range(PROCESSES)]
    outcome: dict[str, list[tuple[str, int, str | None, bool]]] = {site: [] for site in SITES}
    try:
        for process in processes:
            process.start()
        for _ in range(PROCESSES * len(tasks)):
            site, url, index, error, ensured = results.get(timeout=_TIMEOUT_SECONDS)
            outcome[site].append((url, index, error, ensured))
        for process in processes:
            process.join(timeout=_TIMEOUT_SECONDS)
        yield outcome
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
        with admin.connect() as conn:
            for name in databases:
                conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()
        if previous_lock_url is None:
            os.environ.pop("AIQ_LOCK_DB_URL", None)
        else:
            os.environ["AIQ_LOCK_DB_URL"] = previous_lock_url


def _tables(url: str) -> set[str]:
    engine = create_engine(url.replace("postgresql://", "postgresql+psycopg://", 1))
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"))
            return {row[0] for row in rows}
    finally:
        engine.dispose()


@pytest.mark.parametrize("site", list(SITES))
def test_processes_that_create_the_schema_together_all_succeed(outcomes, site):
    runs = outcomes[site]
    assert len(runs) == PROCESSES * ROUNDS

    errors = sorted({error for _, _, error, _ in runs if error})
    assert not errors, f"{sum(1 for r in runs if r[2])} of {len(runs)} creations raised: {errors}"

    # A fail-open store would have logged the lost race and carried on. Its flag says it did not get the table.
    unmarked = [index for _, index, _, ensured in runs if not ensured]
    assert not unmarked, f"{len(unmarked)} of {len(runs)} creations returned without marking the database ensured"

    for url in {url for url, _, _, _ in runs}:
        assert set(SITES[site]) <= _tables(url)


def test_an_error_that_is_not_the_race_still_raises_and_leaves_nothing_behind():
    from aiq_agent.common.db_utils import ensure_schema

    admin = create_engine(make_url(_SERVER).set(drivername="postgresql+psycopg"), isolation_level="AUTOCOMMIT")
    name = f"ddl_{uuid.uuid4().hex[:8]}_error"
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_engine(_database_url(name).replace("postgresql://", "postgresql+psycopg://", 1))

    def ddl(conn):
        conn.execute(text("CREATE TABLE half_made (id INTEGER PRIMARY KEY)"))
        conn.execute(text("CREATE TABLE this is not sql"))

    try:
        with pytest.raises(Exception, match="syntax error"):
            ensure_schema(engine, "half_made", ddl)
        assert "half_made" not in _tables(_database_url(name))
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()
