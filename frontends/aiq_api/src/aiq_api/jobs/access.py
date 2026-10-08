"""AIQ-owned async job access control helpers."""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.engine import Connection

from aiq_agent.auth import Principal
from aiq_agent.auth import get_current_principal
from aiq_agent.common.db_utils import ensure_schema
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_HEADER
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_SIG_HEADER
from aiq_agent.project_context import GridRequestContext

_job_access_schema_initialized: set[str] = set()

_JOB_ACCESS_INDEX_SQL = "CREATE INDEX IF NOT EXISTS idx_job_access_owner ON job_access(owner_auth_type, owner_subject)"
_JOB_ACCESS_PROJECT_INDEX_SQL = (
    "CREATE INDEX IF NOT EXISTS idx_job_access_owner_project ON job_access(owner_subject, project_collection)"
)
_JOB_ACCESS_SELECT_SQL = text(
    "SELECT job_id, owner_auth_type, owner_subject, owner_email, conversation_id, project_collection, "
    "organization_id, created_at "
    "FROM job_access WHERE job_id = :job_id"
)
_JOB_ACCESS_DELETE_SQL = text("DELETE FROM job_access WHERE job_id = :job_id")
_JOB_ACCESS_CLEANUP_SQL = text(
    "DELETE FROM job_access WHERE job_id NOT IN (SELECT job_id FROM job_info WHERE is_expired IS NOT TRUE)"
)
_JOB_INFO_DELETE_SQL = text("DELETE FROM job_info WHERE job_id = :job_id")
_JOB_EVENTS_DELETE_SQL = text("DELETE FROM job_events WHERE job_id = :job_id")

# Terminal (non-active) job statuses. Mirrors nat's JobStatus terminal set
# (SUCCESS/FAILURE/INTERRUPTED); hard-coded here — as it already is in
# jobs/submit.py and routes/jobs.py — to keep this module free of the heavy nat
# import on the admission hot path.
_TERMINAL_STATUSES = ("SUCCESS", "FAILURE", "INTERRUPTED")


def _is_postgres(db_url: str) -> bool:
    return db_url.startswith("postgres")


def ensure_job_access_table(db_url: str) -> None:
    """Create the AIQ-owned job access table if it does not exist."""
    _ensure_job_access_schema(db_url)


def create_job_access(
    job_id: str,
    principal: Principal,
    db_url: str,
    conversation_id: str | None = None,
    project_collection: str | None = None,
    organization_id: str | None = None,
) -> None:
    """Persist the verified owner for a newly created job."""
    _ensure_job_access_schema(db_url)
    with _job_access_connection(db_url) as conn:
        conn.execute(
            _job_access_upsert_sql(db_url),
            _principal_params(job_id, principal, conversation_id, project_collection, organization_id),
        )
        conn.commit()


def get_job_access(job_id: str, db_url: str) -> dict[str, Any] | None:
    """Return job access metadata for a job."""
    _ensure_job_access_schema(db_url)
    with _job_access_connection(db_url) as conn:
        row = conn.execute(_JOB_ACCESS_SELECT_SQL, {"job_id": job_id}).mappings().first()
        return dict(row) if row is not None else None


async def get_job_project_collection(job_id: str, db_url: str) -> str | None:
    """The collection of the project this run was COMMISSIONED in, or None.

    Recorded once, at submit time, from the request that started the run — so
    unlike anything the report request carries it cannot be re-chosen later.

    ## Why the report route needs it

    A deep-research report is filed into a project as a document, and the cover
    sheet it is filed with names the project, the Standort, the Bundesland and
    the Gebäudeklasse. Bundesland is on that sheet because a compliance
    statement without it is not checkable: it says which Bauordnung the report
    was checked against.

    The BFF used to take that project from the report REQUEST — and where the
    request named none, from the caller's stored ``active_project_id``. Both are
    properties of the reader at the moment they open a tab, not of the run. So a
    run started in a project-less chat could be filed into whatever project the
    reader last had open, and a run reopened from history while a different
    project was active could be filed there: in both cases a report researched
    under one Bauordnung, carrying a cover sheet asserting another, marked
    „KI-generiert" and shaped for an Einreichung.

    Returning it here lets the destination be DERIVED from the run instead of
    checked against a request, which is what makes the wrong pairing
    unrepresentable rather than merely detected.

    ## Why it is separate from ``authorize_job_access``

    That function returns the JOB, and a dozen callers destructure it. It also
    skips the access read entirely when ``REQUIRE_AUTH`` is false, and this
    answer has to be the same in both modes: filing runs on deployments where
    auth is off, and a report filed into the wrong project is no less wrong
    there. So this is its own read, on a path that runs once per report view
    rather than per poll.

    None is a truthful answer, not a failure: a run submitted before the column
    existed, or from a chat with no project, has no commissioning project, and
    the caller must treat that as "do not file" rather than as "file anywhere".
    """
    loop = asyncio.get_running_loop()
    access = await loop.run_in_executor(None, get_job_access, job_id, db_url)
    if access is None:
        return None
    collection = access.get("project_collection")
    return collection if isinstance(collection, str) and collection else None


def job_exists(job_id: str, db_url: str) -> bool:
    """Return True if a job with this ID already exists (job_access OR job_info row).

    Used by the submit path to reject caller-supplied job IDs that collide with
    an existing job: both NAT's job_info write and the ``job_access`` upsert are
    unconditional, so without this check a re-submitted ID would rewrite the
    original job's ownership (hijack) and a failed re-submission would delete
    the original job via ``rollback_job_submission``.
    """
    from sqlalchemy import inspect

    _ensure_job_access_schema(db_url)
    with _job_access_connection(db_url) as conn:
        row = conn.execute(text("SELECT 1 FROM job_access WHERE job_id = :job_id"), {"job_id": job_id}).first()
        if row is not None:
            return True
        # job_info is created lazily by NAT's JobStore; on a fresh database it
        # may not exist yet (same guard as _find_research_runs).
        if inspect(conn.engine).has_table("job_info"):
            row = conn.execute(text("SELECT 1 FROM job_info WHERE job_id = :job_id"), {"job_id": job_id}).first()
            return row is not None
    return False


def delete_job_access(job_id: str, db_url: str) -> int:
    """Delete job access metadata for a specific job."""
    _ensure_job_access_schema(db_url)
    with _job_access_connection(db_url) as conn:
        result = conn.execute(_JOB_ACCESS_DELETE_SQL, {"job_id": job_id})
        conn.commit()
        return result.rowcount or 0


def cleanup_job_access(db_url: str, conn: Connection | None = None) -> int:
    """Delete access rows for expired or missing jobs.

    With ``conn``, ``job_access`` must already exist (``ensure_job_access_table``): the
    schema is created on a connection of its own, which would wait for the locks ``conn`` holds.
    """
    _ensure_job_access_schema(db_url)
    if conn is not None:
        result = conn.execute(_JOB_ACCESS_CLEANUP_SQL)
        return result.rowcount or 0

    with _job_access_connection(db_url) as owned_conn:
        result = owned_conn.execute(_JOB_ACCESS_CLEANUP_SQL)
        owned_conn.commit()
        return result.rowcount or 0


def expire_terminal_jobs(
    db_url: str,
    delete_grace_seconds: int,
    conn: Connection | None = None,
) -> tuple[int, int]:
    """Age out finished ``job_info`` rows so the table stays bounded.

    Two phases, both preserving the single most-recent finished job so an idle
    deployment always shows its last run:

    1. **Mark** terminal rows ``is_expired = true`` once ``updated_at +
       expiry_seconds`` has passed (the per-row expiry NAT itself honors). It
       is the only job_info expiry, in both execution modes (ADR-0082 A1: the
       job-events housekeeping route runs it). Marking re-arms the
       access/event cleanup, which keys off ``is_expired``.
    2. **Delete** rows past BOTH their own expiry and ``delete_grace_seconds``
       (job_events + job_access + job_info together) so the table is actually
       bounded, not merely flagged. Requiring the expiry too means a grace set
       shorter than a job's expiry never deletes that job early.

    Runs on the caller's connection (under its advisory lock) without committing
    when ``conn`` is given, else opens and commits its own. Returns
    ``(marked, deleted)``.
    """
    if conn is not None:
        return _expire_terminal_jobs(conn, db_url, delete_grace_seconds)
    with _job_access_connection(db_url) as owned_conn:
        marked, deleted = _expire_terminal_jobs(owned_conn, db_url, delete_grace_seconds)
        owned_conn.commit()
        return marked, deleted


def _expire_terminal_jobs(conn: Connection, db_url: str, delete_grace_seconds: int) -> tuple[int, int]:
    from sqlalchemy import bindparam
    from sqlalchemy import inspect

    if not inspect(conn.engine).has_table("job_info"):
        return (0, 0)

    is_pg = _is_postgres(db_url)
    status_params: dict[str, Any] = {f"s{i}": s for i, s in enumerate(_TERMINAL_STATUSES)}
    placeholders = ", ".join(f":s{i}" for i in range(len(_TERMINAL_STATUSES)))
    # Never touch the newest finished job (matches NAT's "always keep the most
    # recent finished job"); COALESCE guards the empty-table case.
    keep_newest = (
        f"job_id <> COALESCE((SELECT job_id FROM job_info WHERE status IN ({placeholders}) "
        "ORDER BY updated_at DESC LIMIT 1), '')"
    )
    if is_pg:
        past_expiry = "updated_at < NOW() - make_interval(secs => expiry_seconds)"
        past_grace = "updated_at < NOW() - make_interval(secs => :grace)"
        not_expired = "is_expired IS NOT TRUE"
        set_expired = "is_expired = true"
    else:
        past_expiry = "datetime(updated_at, '+' || expiry_seconds || ' seconds') < datetime('now')"
        past_grace = "datetime(updated_at, '+' || :grace || ' seconds') < datetime('now')"
        not_expired = "COALESCE(is_expired, 0) = 0"
        set_expired = "is_expired = 1"

    marked = (
        conn.execute(
            # Interpolated fragments are trusted dialect literals + generated ":sN"
            # placeholders; status values are bound, so this is not injectable.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"UPDATE job_info SET {set_expired} "
                f"WHERE {not_expired} AND status IN ({placeholders}) AND {past_expiry} AND {keep_newest}"
            ),
            status_params,
        ).rowcount
        or 0
    )

    stale_ids = list(
        conn.execute(
            # Interpolated fragments are trusted dialect literals + generated ":sN"
            # placeholders; grace/status values are bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"SELECT job_id FROM job_info WHERE status IN ({placeholders}) "
                f"AND {past_grace} AND {past_expiry} AND {keep_newest}"
            ),
            {**status_params, "grace": delete_grace_seconds},
        ).scalars()
    )
    if not stale_ids:
        return (marked, 0)

    for table in ("job_events", "job_access", "job_info"):
        conn.execute(
            # Fixed table names from the literal tuple above; job ids are bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(f"DELETE FROM {table} WHERE job_id IN :ids").bindparams(bindparam("ids", expanding=True)),
            {"ids": stale_ids},
        )
    return (marked, len(stale_ids))


def rollback_job_submission(job_id: str, db_url: str) -> None:
    """Best-effort rollback when ownership persistence fails after NAT job creation.

    The submit path must not return an ownerless job ID. If job submission creates
    NAT metadata but `job_access` cannot be written, remove the partial job state.

    DESTRUCTIVE: deletes job_access, job_events AND job_info rows for the job.
    Callers must only invoke this for a job ID that was positively verified not
    to exist before this request (see ``job_exists``) — otherwise a failed
    re-submission of an existing ID would wipe the original job.
    """
    from .event_store import EventStore

    EventStore._ensure_table_exists(db_url)
    _ensure_job_access_schema(db_url)
    with _job_access_connection(db_url) as conn:
        conn.execute(_JOB_ACCESS_DELETE_SQL, {"job_id": job_id})
        conn.execute(_JOB_EVENTS_DELETE_SQL, {"job_id": job_id})
        conn.execute(_JOB_INFO_DELETE_SQL, {"job_id": job_id})
        conn.commit()


def _make_no_auth_principal(owner: str | None = None) -> Principal:
    """Synthesize a principal for deployments with auth disabled (REQUIRE_AUTH=false).

    Uses the middleware caller type as the principal type.  When an owner
    identifier is provided it becomes the subject (useful for programmatic
    job submission); otherwise the caller type is used as a stable subject.
    """
    try:
        from aiq_api.auth.middleware import get_current_user

        current_user = get_current_user()
    except Exception:
        current_user = {}

    principal_type = str(current_user.get("type") or "anonymous")
    subject = owner if owner else principal_type
    email = owner if owner and "@" in owner else None
    return Principal(type=principal_type, sub=subject, email=email)


def require_verified_principal() -> Principal:
    """Return the verified request principal or raise a safe auth error.

    When auth is disabled (REQUIRE_AUTH != true), synthesizes a principal
    from the middleware caller identity so no-auth deployments can still
    access async jobs.
    """
    principal = get_current_principal()
    if principal is not None:
        return principal

    if _auth_required():
        raise HTTPException(403, "Verified principal required for async job access")

    return _make_no_auth_principal()


def _auth_required() -> bool:
    return os.environ.get("REQUIRE_AUTH", "false").lower() == "true"


def _base_collection_name() -> str:
    """Return the configured base/OIB knowledge collection name.

    Mirrors the env var precedence used elsewhere in the codebase
    (e.g. ``aiq_agent.oib_sync``): ``OIB_COLLECTION_NAME`` wins over the
    legacy ``COLLECTION_NAME``, defaulting to ``oib_knowledge``.
    """
    return os.environ.get("OIB_COLLECTION_NAME") or os.environ.get("COLLECTION_NAME") or "oib_knowledge"


def derive_project_collection(collection_scope: list[str] | None) -> str | None:
    """Extract the project collection from a request's collection scope.

    The collection scope contains the base/OIB collection, the office Archiv
    (``archiv_<org>``), the project collection, and an ``s_<conversation>``
    scoped collection. The project collection is the single remaining entry
    once those others are excluded. Returns None if no such entry exists (or
    more than one candidate remains, which indicates an ambiguous scope not
    worth guessing at).

    One derivation for both ends of a job's life: submit records its answer on
    ``job_access.project_collection``, and :func:`signed_job_scope` asks the
    same question of the scope a later request signed. Two copies could
    disagree about one scope, and a run would then be unreachable from the
    project it was commissioned in.
    """
    if not collection_scope:
        return None

    base_collection = _base_collection_name()
    candidates = [
        collection
        for collection in collection_scope
        if collection != base_collection and not collection.startswith("s_") and not collection.startswith("archiv_")
    ]
    if len(candidates) == 1:
        return candidates[0]
    return None


#: How long a signed envelope may authorize a job request, in milliseconds.
#: The BFF verifier's window, ``GRID_REQUEST_CONTEXT_MAX_AGE_MS`` in
#: ``frontends/ui/src/lib/request-context.ts``. The two must stay equal.
JOB_ENVELOPE_MAX_AGE_MS = 6 * 60 * 60 * 1000

#: What a request does to a job. A ``read`` follows it (status, stream, state,
#: report, the listing); a ``control`` steers it (cancel, write-now, documents).
JobAction = Literal["read", "control"]


@dataclass(frozen=True)
class SignedJobScope:
    """The part of a verified envelope a job is authorized against (ADR-0084).

    The BFF signs a project only after it checked ``project:chat`` on it, and a
    conversation only after it checked ``viewer`` on it. This tier cannot ask
    WorkOS who belongs to a project, so it checks that the job lies inside what
    the BFF signed instead.
    """

    organization_id: str
    project_collection: str | None
    conversation_id: str | None


@dataclass(frozen=True)
class JobCaller:
    """Who is asking for a job: the verified principal, and the scope its BFF signed."""

    principal: Principal
    scope: SignedJobScope | None = None


def signed_job_scope(
    headers: Mapping[str, str],
    principal: Principal,
    *,
    now_ms: int | None = None,
) -> SignedJobScope | None:
    """The job scope a request's signed envelope grants, or None when it grants nothing.

    Stricter than the envelope middleware, which only asks that one is present.
    An envelope that widens access past the owner must be signed (no secret, no
    grant), name an organization, speak for the user the bearer token names,
    and be inside the BFF verifier's window, counted in both directions. A
    failure on any of these is the same as no envelope: the caller keeps what
    it owns and nothing more.
    """
    secret = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not secret:
        return None
    context = GridRequestContext.from_envelope(
        headers.get(REQUEST_CONTEXT_ENVELOPE_HEADER),
        headers.get(REQUEST_CONTEXT_ENVELOPE_SIG_HEADER),
        secret,
    )
    if context is None or not context.organization_id or context.issued_at is None:
        return None
    if context.user_id != principal.sub:
        return None
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    if abs(now - context.issued_at) > JOB_ENVELOPE_MAX_AGE_MS:
        return None
    return SignedJobScope(
        organization_id=context.organization_id,
        project_collection=derive_project_collection(context.collection_scope),
        conversation_id=context.conversation_id,
    )


def job_access_allows(access: Mapping[str, Any], caller: JobCaller, action: JobAction) -> bool:
    """Whether ``caller`` may ``action`` the job ``access`` describes (ADR-0084).

    The owner may do anything. Anyone else needs a signed scope in the job's
    organization (a row with no organization matches nobody), and then either
    the job's project, which reads and steers, or the job's conversation, which
    only reads: a viewer of a thread may follow a run in it, not stop it.
    """
    if _principal_matches_access(caller.principal, access):
        return True
    scope = caller.scope
    if scope is None:
        return False
    organization_id = access.get("organization_id")
    if not organization_id or organization_id != scope.organization_id:
        return False
    project_collection = access.get("project_collection")
    if project_collection and project_collection == scope.project_collection:
        return True
    if action != "read":
        return False
    conversation_id = access.get("conversation_id")
    return bool(conversation_id) and conversation_id == scope.conversation_id


def job_visibility_clause(caller: JobCaller) -> tuple[str, dict[str, Any]]:
    """:func:`job_access_allows` for a read, as SQL over ``job_access ja``, for the listing.

    The same three ways in, so a run the listing shows is a run its stream
    opens. A NULL column never equals a bound value, so a row with no
    organization is only ever its owner's.
    """
    clauses = ["(ja.owner_auth_type = :owner_auth_type AND ja.owner_subject = :owner_subject)"]
    params: dict[str, Any] = {
        "owner_auth_type": caller.principal.type,
        "owner_subject": caller.principal.sub,
    }
    scope = caller.scope
    shared: list[str] = []
    if scope is not None and scope.project_collection:
        shared.append("ja.project_collection = :scope_project_collection")
        params["scope_project_collection"] = scope.project_collection
    if scope is not None and scope.conversation_id:
        shared.append("ja.conversation_id = :scope_conversation_id")
        params["scope_conversation_id"] = scope.conversation_id
    if scope is not None and shared:
        clauses.append(f"(ja.organization_id = :scope_organization_id AND ({' OR '.join(shared)}))")
        params["scope_organization_id"] = scope.organization_id
    return f"({' OR '.join(clauses)})", params


async def authorize_job_access(
    job_store: Any,
    db_url: str,
    job_id: str,
    caller: JobCaller,
    action: JobAction,
) -> Any:
    """Load a job, enforcing :func:`job_access_allows` when auth is enabled.

    When REQUIRE_AUTH=false, access is not enforced: any caller may access any
    existing job. Ownership records are still written at submit time for audit
    purposes and to support enabling auth later without a data migration.

    A refusal is the same 404 as a job that does not exist, so a caller cannot
    learn which job ids are real.
    """
    job = await job_store.get_job(job_id)
    if not job:
        raise HTTPException(404, f"Job not found: {job_id}")

    if not _auth_required():
        return job

    loop = asyncio.get_running_loop()
    access = await loop.run_in_executor(None, get_job_access, job_id, db_url)
    if access is None:
        raise HTTPException(404, f"Job not found: {job_id}")

    if not job_access_allows(access, caller, action):
        raise HTTPException(404, f"Job not found: {job_id}")

    return job


def _principal_matches_access(principal: Principal, access: Mapping[str, Any]) -> bool:
    return principal.type == access.get("owner_auth_type") and principal.sub == access.get("owner_subject")


def _job_access_connection(db_url: str):
    from .event_store import EventStore

    engine = EventStore._get_or_create_sync_engine(db_url)
    return engine.connect()


def _ensure_job_access_schema(db_url: str) -> None:
    """Create or upgrade ``job_access`` in a transaction of its own, then remember it.

    Not on the caller's connection: a read path closes its connection without
    committing, which would roll the DDL back under a flag that says it is done.
    """
    if db_url in _job_access_schema_initialized:
        return
    from .event_store import EventStore

    engine = EventStore._get_or_create_sync_engine(db_url)
    ensure_schema(engine, "job_access", lambda conn: _create_job_access_schema(conn, db_url))
    _job_access_schema_initialized.add(db_url)


def _create_job_access_schema(conn: Connection, db_url: str) -> None:
    conn.execute(text(_job_access_table_sql(db_url)))
    conn.execute(text(_JOB_ACCESS_INDEX_SQL))
    # Backfill columns onto pre-existing tables BEFORE creating the
    # project_collection index below -- on a deployment where job_access
    # already existed without that column, CREATE TABLE IF NOT EXISTS is a
    # no-op and the index creation would otherwise fail with
    # "column project_collection does not exist".
    if _is_postgres(db_url):
        for statement in _job_access_add_column_statements(db_url):
            conn.execute(text(statement))
    else:
        _ensure_sqlite_job_access_columns(conn)
    conn.execute(text(_JOB_ACCESS_PROJECT_INDEX_SQL))


def _job_access_table_sql(db_url: str) -> str:
    created_at_type = (
        "TIMESTAMP WITH TIME ZONE DEFAULT NOW()" if _is_postgres(db_url) else "DATETIME DEFAULT CURRENT_TIMESTAMP"
    )
    return (
        "CREATE TABLE IF NOT EXISTS job_access ("
        "  job_id VARCHAR PRIMARY KEY,"
        "  owner_auth_type VARCHAR NOT NULL,"
        "  owner_subject VARCHAR NOT NULL,"
        "  owner_email VARCHAR,"
        "  conversation_id VARCHAR,"
        "  project_collection VARCHAR,"
        "  organization_id VARCHAR,"
        f"  created_at {created_at_type}"
        ")"
    )


def _job_access_add_column_statements(db_url: str) -> list[str]:
    """Backfill columns onto pre-existing job_access tables.

    CREATE TABLE IF NOT EXISTS only creates the table with the new columns
    when it doesn't already exist. Deployments with a pre-existing job_access
    table need these columns added explicitly. Postgres supports
    ``ADD COLUMN IF NOT EXISTS``; SQLite does not, so column additions there
    are guarded with a manual existence check (mirroring the rest of this
    module's Postgres/SQLite branching).
    """
    if _is_postgres(db_url):
        return [
            "ALTER TABLE job_access ADD COLUMN IF NOT EXISTS conversation_id VARCHAR",
            "ALTER TABLE job_access ADD COLUMN IF NOT EXISTS project_collection VARCHAR",
            "ALTER TABLE job_access ADD COLUMN IF NOT EXISTS organization_id VARCHAR",
        ]
    return []


def _ensure_sqlite_job_access_columns(conn: Connection) -> None:
    """Add missing columns to an existing SQLite job_access table.

    SQLite has no ``ADD COLUMN IF NOT EXISTS`` syntax, so existing columns
    are inspected via ``PRAGMA table_info`` before conditionally issuing
    ``ALTER TABLE ... ADD COLUMN``.
    """
    existing_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(job_access)")).fetchall()}
    if "conversation_id" not in existing_columns:
        conn.execute(text("ALTER TABLE job_access ADD COLUMN conversation_id VARCHAR"))
    if "project_collection" not in existing_columns:
        conn.execute(text("ALTER TABLE job_access ADD COLUMN project_collection VARCHAR"))
    if "organization_id" not in existing_columns:
        conn.execute(text("ALTER TABLE job_access ADD COLUMN organization_id VARCHAR"))


def _job_access_upsert_sql(db_url: str):
    postgres_upsert = (
        "INSERT INTO job_access "
        "(job_id, owner_auth_type, owner_subject, owner_email, conversation_id, project_collection, organization_id) "
        "VALUES (:job_id, :owner_auth_type, :owner_subject, :owner_email, :conversation_id, :project_collection, "
        ":organization_id) "
        "ON CONFLICT(job_id) DO UPDATE SET "
        "owner_auth_type = excluded.owner_auth_type, "
        "owner_subject = excluded.owner_subject, "
        "owner_email = excluded.owner_email, "
        "conversation_id = excluded.conversation_id, "
        "project_collection = excluded.project_collection, "
        "organization_id = excluded.organization_id"
    )
    sqlite_upsert = (
        "INSERT OR REPLACE INTO job_access "
        "(job_id, owner_auth_type, owner_subject, owner_email, conversation_id, project_collection, organization_id) "
        "VALUES (:job_id, :owner_auth_type, :owner_subject, :owner_email, :conversation_id, :project_collection, "
        ":organization_id)"
    )
    return text(postgres_upsert if _is_postgres(db_url) else sqlite_upsert)


def _principal_params(
    job_id: str,
    principal: Principal,
    conversation_id: str | None = None,
    project_collection: str | None = None,
    organization_id: str | None = None,
) -> dict[str, str | None]:
    return {
        "job_id": job_id,
        "owner_auth_type": principal.type,
        "owner_subject": principal.sub,
        "owner_email": principal.email,
        "conversation_id": conversation_id,
        "project_collection": project_collection,
        "organization_id": organization_id,
    }
