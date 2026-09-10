"""Project Memory client — backend write access via the internal BFF endpoint.

Strict separation of concerns: the ``grid_app`` database has exactly ONE
writer, the Next.js BFF. The backend never opens a connection to it. The
``remember`` tool posts findings to the internal endpoint
``POST /api/internal/memory`` over the compose network, authenticated with a
shared service token (``GRID_INTERNAL_API_TOKEN`` set on both services).

See docs/architecture/project-memory-design.md.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from contextvars import ContextVar
from contextvars import Token
from dataclasses import dataclass

from aiq_agent.knowledge.memory_context import MemoryCarry
from aiq_agent.knowledge.memory_context import MemoryNote
from aiq_agent.knowledge.memory_context import parse_carry

logger = logging.getLogger(__name__)


class OrgMemoryDisabledError(RuntimeError):
    """The frontend refused an agent organization-scoped write on purpose.

    Raised when ``POST /api/internal/memory`` returns 403 with the
    ``ORG_MEMORY_DISABLED`` code — i.e. ``GRID_ALLOW_AGENT_ORG_MEMORY`` is not
    enabled on the frontend service (audit finding S1 default-deny). This is a
    deployment-policy denial, NOT a service-token mismatch, so callers surface
    it to the user distinctly instead of retrying.
    """


# The kinds a memory row may carry. FIVE, and `profile_graduation` is not one
# of them (ADR-0055, contract C7): no writer ever produced it, the enum guard
# below fails closed on it, and a vocabulary entry nothing writes is a shape
# every reader has to keep handling. `test_project_memory_client` pins its
# absence so re-adding it is a decision rather than a merge.
VALID_KINDS = {"decision", "constraint", "open_question", "derived_fact", "preference"}
VALID_CONFIDENCES = {"low", "medium", "high"}
VALID_SCOPES = {"project", "organization"}

_REQUEST_TIMEOUT_SECONDS = 5
# The digest read runs on the per-turn critical path, right before intent
# classification, so a slow BFF must never stall the turn for the full 5s the
# write calls allow. Keep it tight; on timeout fetch_memory_digest raises and
# the caller falls back to the frozen connection-time digest (fail-open).
# 2.5s, up from 1.5: the digest build now embeds the turn's question for
# relevance-ranked recall (the BFF gives that embed call ~1s of this budget).
# Still bounded and still fail-open to the frozen header digest — a slow BFF
# costs staleness, never the turn.
_DIGEST_TIMEOUT_SECONDS = 2.5


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse to follow redirects.

    The internal endpoint never redirects; a 3xx means an auth middleware
    intercepted the call (e.g. AuthKit sending us to a sign-in page). Following
    it would drop the POST body and the service-token header and surface a
    misleading downstream error, so fail fast with the original status instead.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(req.full_url, code, f"unexpected redirect to {newurl}", headers, fp)


_opener = urllib.request.build_opener(_NoRedirectHandler)


#: What the ``remember`` tool wrote during THIS turn, per turn. The
#: post-answer reflection stage reflects against the digest the agent saw at
#: the start of the turn, so without this a fact the tool recorded mid-turn
#: is proposed again minutes later — and lands as a second row whenever the
#: BFF's dedup gates disagree on kind or wording. Same shape as the card
#: registry: bound per turn, never module-level state (AGENTS.md).
_turn_memory_writes: ContextVar[list[str] | None] = ContextVar("turn_memory_writes", default=None)


def begin_turn_memory_log() -> tuple[Token, Token]:
    """Start recording this turn's memory writes; reset with the token.

    Two ContextVars, one token pair: what was written, and what those writes
    retired. They are begun and ended together because they are two halves of
    one fact — "this turn changed memory" — and a caller that bound only one of
    them would leave the other reading whatever the previous turn left.
    """
    return (_turn_memory_writes.set([]), _turn_memory_supersessions.set([]))


def end_turn_memory_log(token: tuple[Token, Token]) -> None:
    writes_token, supersessions_token = token
    _turn_memory_writes.reset(writes_token)
    _turn_memory_supersessions.reset(supersessions_token)


def record_turn_memory_write(content: str) -> None:
    """Note a write that landed this turn. No-op outside a turn."""
    writes = _turn_memory_writes.get()
    if writes is not None and content:
        writes.append(content)


def turn_memory_writes() -> tuple[str, ...]:
    """The contents written this turn, in order; empty outside a turn."""
    return tuple(_turn_memory_writes.get() or ())


#: Ids of the notes a write RETIRED this turn (ADR-0055, contract C4). A
#: correction is the quietest event in this system — the replaced note simply
#: vanishes from the panel — so the turn that performs one says so on its live
#: status line. Bound and reset by the same pair as the write log above,
#: which is what keeps it a per-turn fact.
_turn_memory_supersessions: ContextVar[list[str] | None] = ContextVar("turn_memory_supersessions", default=None)


def record_turn_memory_supersession(superseded_id: str) -> None:
    """Note that a write retired ``superseded_id``, and say so on the live line.

    No-op outside a turn, and that is the gate rather than an accident: the
    post-answer reflection stage writes corrections too, minutes after the
    reader stopped watching a status line, and a background task is not a place
    to push a step into a stream the answer already closed. In a turn, the
    running count is emitted — the live line REPLACES rather than accumulates
    (``common/turn_status.py``), so the reader sees one honest total and not one
    line per retirement.
    """
    retired = _turn_memory_supersessions.get()
    if retired is None or not superseded_id or superseded_id in retired:
        return
    retired.append(superseded_id)
    from aiq_agent.common.turn_status import emit_memory_superseded

    emit_memory_superseded(len(retired))


def turn_memory_supersessions() -> tuple[str, ...]:
    """Ids retired by this turn's writes, in order; empty outside a turn."""
    return tuple(_turn_memory_supersessions.get() or ())


def _internal_base_url() -> str:
    url = os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    return url.rstrip("/")


def _error_code(exc: urllib.error.HTTPError) -> str | None:
    """Best-effort ``code`` field from a JSON error envelope, tolerating non-JSON.

    The internal API's error responses are ``{"error": ..., "code": ...}`` (see
    ``lib/api/handler.ts``). Returns the machine-readable code or ``None`` when
    the body is empty, unreadable, or not the expected JSON shape.
    """
    try:
        raw = exc.read()
    except Exception:  # noqa: BLE001 — body may already be consumed / unreadable
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    code = data.get("code")
    return code if isinstance(code, str) else None


VALID_PROVENANCES = {"agent", "distillation"}


@dataclass(frozen=True)
class MemoryDigest:
    """The turn-start memory read: the text the model sees, and what is in it.

    ``digest`` is what it always was — the bounded block composed into the
    prompt, ``None`` when there is no active memory. The other three are
    contract C2 (ADR-0055): the SAME selection the digest text was built from,
    reported as data so the reader can be told what the model was told. They are
    a record of what was READ and carry no claim that the answer used any of it.

    All three degrade to empty against a BFF that does not send them yet, which
    is what lets this ship before the endpoint half does.
    """

    digest: str | None = None
    carry: MemoryCarry = MemoryCarry()


def fetch_memory_digest(
    *,
    project_id: str | None,
    organization_id: str | None,
    query: str | None = None,
) -> MemoryDigest | None:
    """Fetch the CURRENT core-memory digest via the internal BFF endpoint.

    The digest normally rides the ``x-grid-project-memory`` header set on the WS
    upgrade, but that header is frozen for the connection's life — memory written
    mid-session never reaches the agent until a reconnect. Calling this at the
    start of a turn re-serves the up-to-date digest.

    Returns a :class:`MemoryDigest`, or ``None`` when there is nothing to ask
    about (no project and no organization). A successful call with no active
    memory comes back as a ``MemoryDigest`` whose ``digest`` is ``None`` — a
    valid empty result, and distinct from "we did not ask".

    Raises RuntimeError on configuration problems and urllib errors on transport
    failures, so the caller can fall back to the frozen header digest instead of
    dropping memory entirely. Blocking; call via ``asyncio.to_thread``.
    """
    if not project_id and not organization_id:
        return None

    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise RuntimeError("GRID_INTERNAL_API_TOKEN is not configured")

    params = {}
    if project_id:
        params["projectId"] = project_id
    if organization_id:
        params["organizationId"] = organization_id
    if query and query.strip():
        # This turn's question. With it the BFF ranks recall by relevance
        # instead of serving the twenty most recently touched notes; without it
        # the digest is exactly what it was before. Bounded here as well as
        # there — a caller must not be able to post a transcript as a param.
        params["query"] = query.strip()[:2000]
    query_string = urllib.parse.urlencode(params)

    request = urllib.request.Request(
        f"{_internal_base_url()}/api/internal/memory/digest?{query_string}",
        headers={"X-Grid-Internal-Token": token},
        method="GET",
    )

    with _opener.open(request, timeout=_DIGEST_TIMEOUT_SECONDS) as response:
        body = json.loads(response.read().decode("utf-8"))
    if not isinstance(body, dict):
        return MemoryDigest()
    digest = body.get("digest")
    return MemoryDigest(
        digest=digest if isinstance(digest, str) and digest.strip() else None,
        # Absent on a BFF that has not shipped C2 yet: an empty carry, which
        # renders as no marker rather than as a marker claiming zero notes.
        carry=parse_carry(body),
    )


#: What ``search_memory`` asks for when the model does not say (contract C1).
#: Eight is the digest's own working-set size rather than a new number: a search
#: that returns twenty rows to answer "what do we know about the Keller" has
#: replaced the cap with a bigger cap instead of giving the turn a second path.
SEARCH_DEFAULT_LIMIT = 8

#: The ceiling the endpoint itself enforces. Named here because asking for more
#: returns this many anyway, so the clamp is honesty rather than defence.
SEARCH_MAX_LIMIT = 20


@dataclass(frozen=True)
class MemorySearchHit:
    """One note the recall endpoint returned, with the facts a reader curates by.

    Richer than :class:`~aiq_agent.knowledge.memory_context.MemoryNote` because
    two different readers are served: the MODEL is shown ``kind``, ``confidence``,
    ``verification`` and ``scope`` so it can weigh a note the way the digest lets
    it weigh one, while the answer marker gets the three-field note and links to
    the panel for the rest.
    """

    id: str
    kind: str
    content: str
    confidence: str = "medium"
    verification: str = ""
    pinned: bool = False
    scope: str = "project"
    updated_at: str = ""
    score: float = 0.0

    def as_note(self) -> MemoryNote:
        """The bounded three-field shape the answer marker renders."""
        return MemoryNote(id=self.id, kind=self.kind, content=self.content)


@dataclass(frozen=True)
class MemorySearchResult:
    """A recall answer: the hits, and how large the searched scope was."""

    items: tuple[MemorySearchHit, ...] = ()
    total: int = 0
    returned: int = 0


def _as_search_hit(raw: object) -> MemorySearchHit | None:
    """One wire entry to a :class:`MemorySearchHit`; ``None`` when unusable.

    Per ENTRY, not per response: a malformed row is dropped and the rest of the
    recall still reaches the turn. An entry without an id or content is unusable
    — the model could not act on it and the marker could not link to it.
    """
    if not isinstance(raw, dict):
        return None
    note_id = raw.get("id")
    content = raw.get("content")
    if not isinstance(note_id, str) or not note_id.strip():
        return None
    if not isinstance(content, str) or not content.strip():
        return None

    def _text(key: str, default: str = "") -> str:
        value = raw.get(key)
        return value.strip() if isinstance(value, str) and value.strip() else default

    score = raw.get("score")
    return MemorySearchHit(
        id=note_id.strip(),
        kind=_text("kind"),
        content=content.strip(),
        confidence=_text("confidence", "medium"),
        verification=_text("verification"),
        pinned=bool(raw.get("pinned")),
        scope=_text("scope", "project"),
        updated_at=_text("updatedAt"),
        score=float(score) if isinstance(score, (int, float)) and not isinstance(score, bool) else 0.0,
    )


def search_memory_notes(
    *,
    query: str,
    project_id: str | None,
    organization_id: str | None,
    limit: int = SEARCH_DEFAULT_LIMIT,
) -> MemorySearchResult | None:
    """Search long-term memory through the internal BFF endpoint (contract C1).

    ``GET /api/internal/memory/search?organizationId&projectId&q&limit`` →
    ``{"items": [...], "total": n, "returned": n}``. Same client, same service
    token and the same no-redirect opener as the digest read, because it is the
    same trust boundary: the backend never opens the app database, it asks the
    single writer.

    **Scope is stated, never chosen.** The caller passes the turn's own
    organization and — on a project turn — its project, and the endpoint decides
    what that means: a request with a project returns that project's notes plus
    the organization's, one without returns organization-scoped notes only, and
    never another project's. There is deliberately no scope parameter on this
    function for the same reason there is none on the tool above it: a knob the
    model could set is a knob that can be set wrong, and the fact that the BFF
    would refuse it is not a reason to offer it.

    Returns ``None`` — never raises — on a missing token, a transport failure, an
    HTTP error or an unreadable body. Recall is a second path to memory, not the
    turn's correctness: a search that could not run must cost the answer nothing.
    Blocking; call via ``asyncio.to_thread``.
    """
    query = (query or "").strip()
    if not query or not organization_id:
        return None

    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        logger.debug("Memory search skipped: GRID_INTERNAL_API_TOKEN is not configured")
        return None

    # A size this client cannot read as one — absent, ``None``, ``True``, zero,
    # negative, a word — is the DEFAULT and never one, the same rule
    # ``workspace_digest.clamped_limit`` states: "no particular number" is a
    # request for the ordinary answer, and answering it with a single note would
    # read, to the model, as a store with one note in it.
    if limit is None or isinstance(limit, bool):
        wanted = SEARCH_DEFAULT_LIMIT
    else:
        try:
            wanted = int(limit)
        except (TypeError, ValueError):
            wanted = SEARCH_DEFAULT_LIMIT
        if wanted < 1:
            wanted = SEARCH_DEFAULT_LIMIT
    wanted = min(wanted, SEARCH_MAX_LIMIT)

    params = {"organizationId": organization_id, "q": query[:2000], "limit": str(wanted)}
    if project_id:
        params["projectId"] = project_id

    request = urllib.request.Request(
        f"{_internal_base_url()}/api/internal/memory/search?{urllib.parse.urlencode(params)}",
        headers={"X-Grid-Internal-Token": token},
        method="GET",
    )

    try:
        with _opener.open(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        logger.warning("Memory search endpoint returned %s", exc.code)
        return None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, UnicodeDecodeError):
        logger.warning("Memory search failed", exc_info=True)
        return None

    if not isinstance(body, dict):
        logger.warning("Memory search response was not a JSON object")
        return None

    raw_items = body.get("items")
    items = tuple(
        hit
        for hit in (_as_search_hit(entry) for entry in (raw_items if isinstance(raw_items, list) else []))
        if hit is not None
    )[:wanted]
    returned = body.get("returned")
    return MemorySearchResult(
        items=items,
        total=max(0, int(body["total"])) if isinstance(body.get("total"), int) else len(items),
        returned=max(0, int(returned)) if isinstance(returned, int) else len(items),
    )


# A memory row is durable, tenant-wide within its scope, and read into every
# later prompt, so a finding that carries a person's contact details or a
# secret must not be written by EITHER writer. This guard used to live only in
# the reflection stage; the in-turn ``remember`` tool wrote whatever the model
# handed it. It sits here now, on the one path both writers share.
#
# Shapes, not meanings: an email address, a run of digits long enough to be a
# number to call, an IBAN, an SSN-shaped triple, and the handful of secret
# words a leaked credential travels with. And one carve-out that the phone
# pattern needs: a date is a run of digits with separators too, and a permit
# deadline written 12/03/2027 was being dropped as a phone number — precisely
# the class of fact a project memory exists to carry.
_DATE_SHAPE_RE = re.compile(r"(?<!\d)(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2})(?!\d)")
_PERSONAL_DATA_PATTERNS = (
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),  # email address
    re.compile(r"(?<!\d)(?:\+?\d[\d ()/-]{7,}\d)(?!\d)"),  # phone/fax-shaped digit run
    re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b"),  # IBAN
    re.compile(r"\b\d{3}-?\d{2}-?\d{4}\b"),  # SSN-shaped
    re.compile(
        r"\b(?:password|passwort|api[_ -]?key|secret|token|bearer|"
        r"sozialversicherungsnummer|steuernummer|personalausweis)\b",
        re.IGNORECASE,
    ),
)


def looks_like_personal_data(content: str) -> bool:
    """Whether a memory finding matches a coarse personal-data or secret shape.

    A denylist of shapes, not a privacy guarantee (audit S4). Dates are blanked
    before the digit-run pattern looks, so a deadline survives.
    """
    scrubbed = _DATE_SHAPE_RE.sub(" ", content or "")
    return any(pattern.search(scrubbed) for pattern in _PERSONAL_DATA_PATTERNS)


def insert_memory_item(
    *,
    scope: str,
    project_id: str | None,
    organization_id: str | None,
    kind: str,
    content: str,
    confidence: str = "medium",
    conversation_id: str | None = None,
    provenance_type: str = "agent",
    supersedes_content: str | None = None,
    salience: float | None = None,
    user_id: str | None = None,
    organization_membership_id: str | None = None,
    on_superseded: Callable[[str, str], None] | None = None,
) -> str | None:
    """Record one memory item via the internal BFF endpoint.

    ``provenance_type`` distinguishes how the item was captured: ``agent`` for a
    deliberate in-turn ``remember`` call, ``distillation`` for the async
    post-answer reflection stage. It lets the UI label the two differently.

    ``user_id``/``organization_membership_id`` are WHO the turn runs for, and
    they are sent on the ORGANISATION-scoped branch only. An org item lands in
    every project's digest across the tenant, so that write is authorized as the
    acting person (``org:memory:write``, spec AG-8) rather than as the service
    token; the route reads them nowhere else, and a project-scoped write is
    addressed by its project row and needs no acting user. Sending them anyway
    would put an identity on a write that does not authorize by it. A caller
    that omits them on an org write is not rejected as malformed — the route
    refuses it with the same ``ORG_MEMORY_DISABLED`` code every other policy
    denial uses, which the tool degrades into the proposal card (spec AG-9).

    ``supersedes_content`` is the verbatim content of an existing entry this
    finding makes obsolete, quoted back from the digest the caller was shown.
    It is how the agent CORRECTS memory instead of only appending to it: the
    frontend resolves the quote to an active item in the same scope, marks it
    ``superseded`` and links the new row via ``supersedes_id``. An unresolvable
    quote is ignored, and human-curated entries are never retired this way, so
    passing it is always safe — the write still happens either way.

    ``on_superseded`` is called with ``(id, content)`` of the note THIS write
    retired, when it retired one. It exists because a supersession is a stated
    event in the transcript (ADR-0055) and the reader is shown the retired
    note's own words: the route reports both, having just loaded that row, and
    a caller that wanted them later would have to ask the database for text
    somebody already held. It is a callback and not a second return value
    because the retirement is an OCCASIONAL fact about the write, and every
    caller that does not render it should not have to unpack one.

    Not the same channel as :func:`record_turn_memory_supersession`, which is
    the live status line and is a no-op outside a turn — the post-answer
    reflection stage runs after the turn's context is gone, which is exactly
    when this callback is the only way the fact reaches a reader.

    Returns the new item id, or None when the target (project/org) is unknown.
    Raises RuntimeError on configuration problems and urllib errors on
    transport failures — callers translate these into friendly tool output.
    Blocking; call via ``asyncio.to_thread`` from async code.
    """
    if scope not in VALID_SCOPES:
        raise ValueError(f"Invalid scope '{scope}'. Must be one of: {sorted(VALID_SCOPES)}")
    if kind not in VALID_KINDS:
        raise ValueError(f"Invalid kind '{kind}'. Must be one of: {sorted(VALID_KINDS)}")
    if confidence not in VALID_CONFIDENCES:
        raise ValueError(f"Invalid confidence '{confidence}'. Must be one of: {sorted(VALID_CONFIDENCES)}")
    if provenance_type not in VALID_PROVENANCES:
        provenance_type = "agent"
    if looks_like_personal_data(content):
        # Not recorded, and not an error: the caller is told nothing was
        # written, the same way it is for an unknown project.
        logger.info("Memory item not recorded: content matches a personal-data shape (scope=%s)", scope)
        return None

    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise RuntimeError("GRID_INTERNAL_API_TOKEN is not configured")

    payload: dict[str, str] = {
        "scope": scope,
        "kind": kind,
        "content": content.strip()[:2000],
        "confidence": confidence,
        "provenanceType": provenance_type,
    }
    if project_id:
        payload["projectId"] = project_id
    if organization_id:
        payload["organizationId"] = organization_id
    if conversation_id:
        payload["sourceConversationId"] = conversation_id
    if scope == "organization":
        # See the docstring: the acting identity travels on this branch alone,
        # because this is the only branch the BFF authorizes by it.
        if user_id:
            payload["userId"] = user_id
        if organization_membership_id:
            payload["organizationMembershipId"] = organization_membership_id
    if supersedes_content and supersedes_content.strip():
        payload["supersedesContent"] = supersedes_content.strip()[:2000]
    if salience is not None:
        # Write-time importance (0..1), elicited by the reflection stage. Sent
        # only when the caller rated it — the column's 0.5 default is the
        # neutral midpoint and must stay the fallback, not an explicit write.
        payload["salience"] = max(0.0, min(1.0, float(salience)))

    request = urllib.request.Request(
        f"{_internal_base_url()}/api/internal/memory",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Grid-Internal-Token": token,
        },
        method="POST",
    )

    try:
        with _opener.open(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
            item_id = body.get("item", {}).get("id")
            if item_id:
                record_turn_memory_write(content)
                # The route reports the retirement rather than deriving it from
                # the returned row (a duplicate refresh returns an EXISTING item
                # whose supersedes_id records an earlier request's work), so this
                # is the one place either writer learns that a correction landed.
                superseded_id = body.get("supersededId")
                if isinstance(superseded_id, str) and superseded_id.strip():
                    record_turn_memory_supersession(superseded_id.strip())
                    # The retired note's own words, reported beside its id. Both
                    # or neither: a present id with no content is a frontend
                    # that predates the field, and half a supersession renders
                    # as a correction the reader cannot check — so the caller is
                    # told nothing rather than something unverifiable.
                    superseded_content = body.get("supersededContent")
                    if on_superseded is not None and isinstance(superseded_content, str) and superseded_content.strip():
                        on_superseded(superseded_id.strip(), superseded_content.strip())
            return item_id
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            # Unknown project — nothing recorded, not a transport failure.
            return None
        if 300 <= exc.code < 400:
            logger.error(
                "Internal memory endpoint redirected (%s) — an auth middleware is "
                "intercepting %s/api/internal/memory. Exclude /api/internal/* from "
                "the frontend auth proxy (unauthenticatedPaths in proxy.ts).",
                exc.code,
                _internal_base_url(),
            )
        elif exc.code == 403:
            if _error_code(exc) == "ORG_MEMORY_DISABLED":
                # Expected default-deny (audit finding S1), not a misconfiguration:
                # an agent's service token may not write org-wide memory, so the
                # caller routes the user to the confirmation-card path instead.
                # Logged at INFO (the caller logs the handled outcome); set
                # GRID_ALLOW_AGENT_ORG_MEMORY=true on the frontend to let agents
                # write org-wide directly.
                logger.info(
                    "Internal memory endpoint declined an agent organization-scoped write "
                    "(403 ORG_MEMORY_DISABLED); routing to the user confirmation card"
                )
                raise OrgMemoryDisabledError("agent organization-scoped memory is disabled on the frontend") from exc
            logger.error(
                "Internal memory endpoint rejected the service token (403) — GRID_INTERNAL_API_TOKEN "
                "mismatch between the aiq-agent and frontend services (the same value must be set on both)."
            )
        elif exc.code == 503:
            logger.error(
                "Internal memory endpoint disabled (503) — GRID_INTERNAL_API_TOKEN "
                "is unset, or is the dev default in a non-dev environment "
                "(set APP_ENV=development on the frontend or configure a real token)."
            )
        else:
            logger.warning("Internal memory endpoint returned %s", exc.code)
        raise


def check_internal_api() -> bool:
    """Startup handshake against the internal API health endpoint.

    GETs ``/api/internal/health`` with the service token to make the internal
    write path's health visible AT DEPLOY TIME rather than only when the first
    ``remember`` call fails. Purely diagnostic and NON-FATAL: logs the outcome
    and never raises, so a not-yet-up (or misconfigured) frontend never blocks
    backend startup. Blocking; call via ``asyncio.to_thread`` / a background
    task. Returns ``True`` only on a confirmed 200.
    """
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        logger.error(
            "Cannot verify the internal API: GRID_INTERNAL_API_TOKEN is not configured on the "
            "aiq-agent service. The `remember` tool will not be able to write memory."
        )
        return False

    request = urllib.request.Request(
        f"{_internal_base_url()}/api/internal/health",
        headers={"X-Grid-Internal-Token": token},
        method="GET",
    )

    try:
        with _opener.open(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            response.read()
        logger.info("internal API reachable, service token accepted")
        return True
    except urllib.error.HTTPError as exc:
        if exc.code == 403:
            logger.error(
                "Internal API rejected the service token (403) — GRID_INTERNAL_API_TOKEN mismatch "
                "between the aiq-agent and frontend services (the same value must be set on both)."
            )
        elif exc.code == 503:
            logger.error(
                "Internal API disabled (503) — GRID_INTERNAL_API_TOKEN is unset on the frontend, "
                "or is the well-known dev default in a non-dev environment (set APP_ENV=development "
                "on the frontend or configure a real token)."
            )
        else:
            logger.warning("Internal API health check returned %s", exc.code)
        return False
    except (urllib.error.URLError, OSError) as exc:
        # Connection refused / DNS / timeout — the frontend may simply not be up
        # yet at backend startup. Non-fatal; the first `remember` call re-checks.
        logger.warning(
            "Internal API health check could not reach %s (%s) — the frontend may not be up yet.",
            _internal_base_url(),
            exc,
        )
        return False
