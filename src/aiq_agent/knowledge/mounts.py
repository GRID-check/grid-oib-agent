"""Projects a Büro turn mounted while it ran — the grant, and the turn registry.

A Büro conversation starts with no project. When the question needs one, the
agent calls ``open_project`` (``agents/workspace/register.py``), the BFF checks
``project:chat`` for the ACTING USER and writes the mount row, and it hands back
a signed **grant**: the one statement this process will accept as "this
collection may be read for the rest of this turn" (ADR-0054).

Three things a reader must not have to infer:

* **The grant is the authorization, not the tool call.** Nothing here asks the
  BFF anything. :func:`register_mount_grant` verifies an HMAC the BFF minted
  with ``GRID_INTERNAL_API_TOKEN`` — the SAME secret and the same
  constant-time comparison the request-context envelope uses
  (``project_context.GridRequestContext.from_envelope``) — and refuses anything
  else. An unsigned, tampered, expired or foreign grant widens nothing and says
  so in the log. There is no new trust boundary: a caller who could forge this
  could already forge the envelope.
* **A mount lives for ONE turn in this process.** The registry is a
  ``ContextVar`` created and reset per turn, like ``cards/registry.py`` and the
  citation registry (`src/aiq_agent/AGENTS.md`): module-level state here would
  leak one tenant's project into the next turn's scope. The DURABLE half of a
  mount is the BFF's ``conversation_mounts`` row, which reaches the next turn
  the normal way — as an entry on the signed collection-scope header, after the
  BFF re-authorizes it. That re-authorization is the revocation path; this
  module never remembers anything past the turn that earned it.
* **A mount widens a ceiling, it does not aim the search.** What
  :func:`register_mount_grant` adds is unioned onto the turn's scope by
  ``knowledge/scoping.py``; the composer's focus can still narrow it
  (``knowledge_layer.register._restrict_scope_to_turn``).

See docs/adr/0054-workspace-chat-mounts-projects-on-demand.md and
docs/technical-reference/collection-scoping.md.
"""

from __future__ import annotations

import base64
import contextvars
import hashlib
import hmac
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.project_memory import _DIGEST_TIMEOUT_SECONDS
from aiq_agent.knowledge.project_memory import _internal_base_url
from aiq_agent.knowledge.project_memory import _opener
from aiq_agent.knowledge.scoping import ScopedCollection

logger = logging.getLogger(__name__)

#: Grant payload version this process understands. A grant stating anything else
#: is refused rather than read leniently: the payload is an authorization, and a
#: version we do not know is a payload we cannot claim to have checked.
GRANT_VERSION = 1

#: The one shelf a grant may name. A mount brings a PROJECT into view; a grant
#: claiming `archiv` or `base` would be widening a shelf mounting has no
#: business touching.
GRANT_SHELF = Shelf.PROJECT


class TurnMounts:
    """The mounts one turn has earned, in the order it earned them.

    A MUTABLE registry behind the ContextVar, exactly like ``CardRegistry`` —
    and for the same reason, which is not stylistic. ``open_project`` and the
    retrieval that reads what it mounted run in different asyncio TASKS, and a
    task gets a COPY of the context: a ``ContextVar.set`` inside the tool's task
    would be invisible to the search that follows it, so the mount would verify,
    log, and then widen nothing. Binding one object per turn and mutating it is
    what makes the widening visible to the whole turn while still dying with it.
    """

    def __init__(self) -> None:
        self._mounts: list[ScopedCollection] = []

    def add(self, mount: ScopedCollection) -> bool:
        """Add *mount* unless its collection is already in view; True when added."""
        if any(existing.collection == mount.collection for existing in self._mounts):
            return False
        self._mounts.append(mount)
        return True

    def snapshot(self) -> tuple[ScopedCollection, ...]:
        return tuple(self._mounts)

    def __len__(self) -> int:
        return len(self._mounts)

    def clear(self) -> None:
        """Drop every mount (call at a turn boundary)."""
        self._mounts.clear()


_TURN_MOUNTS: contextvars.ContextVar[TurnMounts | None] = contextvars.ContextVar("grid_turn_mounts", default=None)


def begin_turn_mounts() -> contextvars.Token:
    """Bind a FRESH mount registry for this turn; returns the reset token.

    Called where the card registry is bound (the chat entrypoint, the job
    runner). Binding explicitly is what makes two turns in one process
    independent — :func:`register_mount_grant` will bind one lazily rather than
    lose a verified mount, but a lazily bound registry lives as long as whatever
    context happened to be current, which is not a turn.
    """
    return _TURN_MOUNTS.set(TurnMounts())


def end_turn_mounts(token: contextvars.Token) -> None:
    """Restore the mount registry bound before :func:`begin_turn_mounts`."""
    _TURN_MOUNTS.reset(token)


def get_turn_mounts() -> tuple[ScopedCollection, ...]:
    """The collections this turn mounted, in the order they were granted."""
    registry = _TURN_MOUNTS.get()
    return () if registry is None else registry.snapshot()


@dataclass(frozen=True)
class MountedProject:
    """A project this turn may read, as the turn knows it: id, and name if stated."""

    id: str
    name: str | None = None

    def label(self) -> str:
        """How the project is named to a model — the name, with its id beside it."""
        return f"{self.name} (id: {self.id})" if self.name else self.id


def mounted_projects() -> tuple[MountedProject, ...]:
    """Every project in view for this turn, in the order the turn learned of it.

    Two sources, one list, because a project reaches a turn two ways and a tool
    asking "may I read project X" must not care which:

    * the SCOPE the BFF signed for this turn — a project chat's own project, and
      in the office every mount persisted on the conversation, re-authorized on
      the WebSocket upgrade; and
    * the mounts this turn earned WHILE IT RAN, through ``open_project``.

    ``knowledge.scoping.get_scoped_collections_from_context`` already unions the
    second onto the first, so it is asked first and :func:`get_turn_mounts` is
    read only to cover the case it answers ``None`` for — a turn with no readable
    scope header at all, which is every CLI and test run that still mounted
    something.

    Only entries that NAME a project contribute: ``project_id`` is what a tool
    can be given as an argument and what a refusal can list back. A project-shelf
    entry from a producer that predates the identity fields (ADR-0054) carries
    none, and is invisible here rather than being guessed at from its collection
    id — the collection name is authorization, never identity.
    """
    found: dict[str, MountedProject] = {}

    def _collect(entries: object) -> None:
        for entry in entries or ():  # type: ignore[union-attr]
            project_id = getattr(entry, "project_id", None)
            if not isinstance(project_id, str) or not project_id.strip():
                continue
            key = project_id.strip()
            name = getattr(entry, "project_name", None)
            name = name.strip() if isinstance(name, str) and name.strip() else None
            existing = found.get(key)
            if existing is None:
                found[key] = MountedProject(key, name)
            elif existing.name is None and name:
                # First entry wins on order, but a name learned later still
                # improves how the project is named back to the model.
                found[key] = MountedProject(key, name)

    try:
        from aiq_agent.knowledge.scoping import get_scoped_collections_from_context

        _collect(get_scoped_collections_from_context())
    except Exception:  # pragma: no cover - defensive: a tool must not die on its scope
        logger.debug("Scope read failed while listing mounted projects", exc_info=True)
    _collect(get_turn_mounts())
    return tuple(found.values())


def _base64url_decode_text(raw: str) -> str:
    padded = raw + "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")


def _turn_identity() -> tuple[str | None, str | None]:
    """(organization id, conversation id) of the turn a grant must match."""
    from aiq_agent.project_context import GridRequestContext
    from aiq_agent.project_context import get_conversation_id_from_context

    return GridRequestContext.from_context().organization_id, get_conversation_id_from_context()


def _refuse(reason: str, detail: object = "") -> None:
    """Log a refused grant. INFO, not WARNING: an expired grant on a slow turn
    is ordinary, and only the signature mismatch below is a tamper signal."""
    logger.info("Mount grant refused (%s): %s", reason, detail)


def verify_mount_grant(grant_b64: str | None, sig: str | None) -> ScopedCollection | None:
    """Verify a wire grant against this turn; ``None`` when it may not widen it.

    Refuses, in this order: a missing half, an undecodable payload, a bad or
    missing signature (when a secret is configured), an unknown ``v``, a shelf
    other than ``project``, a blank collection, an ``exp`` that has passed, and
    an ``organizationId``/``conversationId`` that is not this turn's.

    Signature verification is SKIPPED when ``GRID_INTERNAL_API_TOKEN`` is unset —
    the same dev-only fail-open the request-context envelope documents, for the
    same reason: the token is how the two processes share a secret, and without
    one there is nothing to verify against. Every other check still applies, and
    a deployment without the token cannot reach the mounts endpoint that mints
    grants in the first place.

    Pure: it does not touch the registry. :func:`register_mount_grant` is the
    one that widens the turn.
    """
    if not grant_b64 or not sig:
        _refuse("missing grant or signature", bool(grant_b64))
        return None

    try:
        raw_json = _base64url_decode_text(grant_b64)
    except Exception:
        _refuse("payload is not base64url")
        return None

    secret = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if secret:
        expected = hmac.new(secret.encode("utf-8"), raw_json.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, sig.strip()):
            # The one WARNING here: a present-but-wrong signature is somebody
            # trying to widen a turn's scope, not a slow turn.
            logger.warning("Mount grant signature invalid; the grant widens nothing (possible tamper)")
            return None
    else:
        logger.debug("GRID_INTERNAL_API_TOKEN unset; accepting the mount grant on shape alone (dev)")

    try:
        payload: Any = json.loads(raw_json)
    except Exception:
        _refuse("payload is not JSON")
        return None
    if not isinstance(payload, dict):
        _refuse("payload is not an object", type(payload).__name__)
        return None

    if payload.get("v") != GRANT_VERSION:
        _refuse("unknown version", payload.get("v"))
        return None

    from aiq_agent.common.source_kinds import parse_shelf

    if parse_shelf(payload.get("shelf")) is not GRANT_SHELF:
        _refuse("shelf is not project", payload.get("shelf"))
        return None

    collection = payload.get("collection")
    if not isinstance(collection, str) or not collection.strip():
        _refuse("no collection named")
        return None

    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or isinstance(exp, bool):
        _refuse("no expiry stated", exp)
        return None
    if float(exp) <= time.time():
        _refuse("expired", exp)
        return None

    organization_id, conversation_id = _turn_identity()
    if not organization_id or payload.get("organizationId") != organization_id:
        # Fail-closed both ways: a grant for another tenant, and a turn with no
        # organization at all (nothing to match, so nothing may be widened).
        _refuse("organization does not match this turn", payload.get("organizationId"))
        return None
    if not conversation_id or payload.get("conversationId") != conversation_id:
        _refuse("conversation does not match this turn", payload.get("conversationId"))
        return None

    project_id = payload.get("projectId")
    project_name = payload.get("projectName")
    return ScopedCollection(
        collection.strip(),
        GRANT_SHELF,
        project_id=project_id.strip() if isinstance(project_id, str) and project_id.strip() else None,
        project_name=project_name.strip() if isinstance(project_name, str) and project_name.strip() else None,
    )


def register_mount_grant(grant_b64: str | None, sig: str | None) -> ScopedCollection | None:
    """Verify a grant and, if it holds, widen THIS TURN's scope by it.

    Returns the mounted collection, or ``None`` when the grant was refused —
    an unsigned, tampered, expired or foreign grant widens nothing. Registering
    the same collection twice is a no-op that returns the existing entry, so a
    model that calls ``open_project`` twice for one project cannot grow the
    scope or the prompt.
    """
    mount = verify_mount_grant(grant_b64, sig)
    if mount is None:
        return None
    registry = _TURN_MOUNTS.get()
    if registry is None:
        # No entrypoint bound one (a CLI run, a test, an entry path that has not
        # been taught about mounts). Losing a VERIFIED grant would be the worse
        # failure, so bind one here and say so — it lives as long as the current
        # context, which is why the entrypoints bind theirs per turn.
        logger.debug("No turn-mount registry bound; binding one for the current context")
        registry = TurnMounts()
        _TURN_MOUNTS.set(registry)
    if registry.add(mount):
        logger.info(
            "Mounted %s (project %s) for this turn; %d project(s) now in view",
            mount.collection,
            mount.project_name or mount.project_id or "unnamed",
            len(registry),
        )
    return mount


# ---------------------------------------------------------------------------
# The internal mounts endpoint — where a grant comes from
# ---------------------------------------------------------------------------

#: Refusal codes the tool's event line uses (the contract the UI's MountNotice
#: reads). Deliberately coarse: the model and the notice act on WHY the project
#: is not in view, never on the HTTP status that said so.
REFUSAL_NO_ACCESS = "no_access"
REFUSAL_CAP = "cap"
#: The mount would have shut a participant of a SHARED conversation out (spec
#: AC-8): everyone who reads the thread must be able to read what it reads, so
#: the office refuses rather than quietly answering past somebody. Its own code
#: because the answer is not the cap's — nothing needs unmounting, and the
#: honest offer is to unshare or to leave the project out.
REFUSAL_WOULD_EXCLUDE = "would_exclude"
REFUSAL_NOT_FOUND = "not_found"
REFUSAL_UNAVAILABLE = "unavailable"

#: The BFF's own code for that refusal, which is how the two 409s are told
#: apart (``mount-wire.ts``). An unrecognised 409 reads as the cap, which is
#: what every 409 was before this one existed.
_BFF_CODE_WOULD_EXCLUDE = "WORKSPACE_MOUNT_WOULD_EXCLUDE"

#: The mount call sits on the critical path of a turn the user is watching, so
#: it gets the digest client's ceiling rather than the (longer) write timeout:
#: a project that cannot be mounted in this long is a refusal the agent can
#: still answer around.
_MOUNT_TIMEOUT_SECONDS = _DIGEST_TIMEOUT_SECONDS


@dataclass(frozen=True)
class MountGranted:
    """The BFF mounted the project and signed a grant for this turn."""

    project_id: str
    project_name: str
    grant: str
    sig: str


@dataclass(frozen=True)
class MountRefused:
    """The BFF (or the transport) said no, with what the refusal has to name.

    ``cap``/``mounted`` belong to the cap refusal (the number and the projects
    already in view); ``excluded`` to the exclusion refusal (the PEOPLE, by
    name, who could not see the project). Both are lists a sentence is built
    from, which is why they travel as data rather than as prose the endpoint
    wrote: the UI renders them beside its add row and the tool renders them into
    German, from one shape.
    """

    code: str
    cap: int | None = None
    mounted: tuple[str, ...] = ()
    excluded: tuple[str, ...] = ()


def request_mount(
    *,
    conversation_id: str,
    project_id: str,
    organization_id: str,
    user_id: str | None,
    membership_id: str | None,
) -> MountGranted | MountRefused:
    """Ask the internal mounts twin to mount *project_id*, AS THE USER.

    ``POST /api/internal/conversations/<id>/mounts`` with the acting identity in
    the body — the endpoint authorizes that user's ``project:chat``, never the
    service (ADR-0054). It creates the conversation row when the first turn is
    still in flight, and it is idempotent: re-mounting returns the same mount
    and a fresh grant, and consumes no cap.

    Never raises: every failure becomes a :class:`MountRefused`, because a tool
    that raises takes the turn down. Blocking; call via ``asyncio.to_thread``.
    """
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        logger.debug("Mount skipped: GRID_INTERNAL_API_TOKEN is not configured")
        return MountRefused(REFUSAL_UNAVAILABLE)

    payload: dict[str, str] = {
        "projectId": project_id,
        "organizationId": organization_id,
        "mountedBy": "agent",
    }
    if user_id:
        payload["userId"] = user_id
    if membership_id:
        payload["organizationMembershipId"] = membership_id

    request = urllib.request.Request(
        f"{_internal_base_url()}/api/internal/conversations/{urllib.parse.quote(conversation_id, safe='')}/mounts",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Grid-Internal-Token": token},
        method="POST",
    )

    try:
        with _opener.open(request, timeout=_MOUNT_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return _refusal_for_status(exc)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, UnicodeDecodeError):
        logger.warning("Mount request failed; the project stays out of view", exc_info=True)
        return MountRefused(REFUSAL_UNAVAILABLE)

    if not isinstance(body, dict):
        logger.warning("Mount response was not a JSON object; the project stays out of view")
        return MountRefused(REFUSAL_UNAVAILABLE)

    mount = body.get("mount") if isinstance(body.get("mount"), dict) else {}
    grant = body.get("grant") if isinstance(body.get("grant"), dict) else {}
    grant_b64 = grant.get("grant")
    sig = grant.get("sig")
    if not isinstance(grant_b64, str) or not isinstance(sig, str) or not grant_b64 or not sig:
        # A mount row without a grant cannot widen THIS turn. It is persisted, so
        # the next turn's scope header will carry it; this turn says so.
        logger.warning("Mount response carried no grant; the project is not readable in this turn")
        return MountRefused(REFUSAL_UNAVAILABLE)

    name = mount.get("projectName")
    return MountGranted(
        project_id=str(mount.get("projectId") or project_id),
        project_name=name.strip() if isinstance(name, str) and name.strip() else "",
        grant=grant_b64,
        sig=sig,
    )


def _names(raw: object) -> tuple[str, ...]:
    """The non-blank strings of a wire list; anything else contributes nothing."""
    if not isinstance(raw, list):
        return ()
    return tuple(name.strip() for name in raw if isinstance(name, str) and name.strip())


def _refusal_for_status(exc: urllib.error.HTTPError) -> MountRefused:
    """One HTTP failure to one refusal code, with the cap when the cap is why.

    404 is DENIAL AS WELL AS ABSENCE (the endpoint answers a project the caller
    may not read the same way it answers one that does not exist), which is why
    ``not_found`` never licenses "this project does not exist" in the prose the
    tool returns.
    """
    if exc.code == 409:
        detail: Any = {}
        try:
            detail = json.loads(exc.read().decode("utf-8"))
        except Exception:
            logger.debug("Mount conflict response carried no readable body", exc_info=True)
        if not isinstance(detail, dict):
            detail = {}
        if detail.get("code") == _BFF_CODE_WOULD_EXCLUDE:
            return MountRefused(REFUSAL_WOULD_EXCLUDE, excluded=_names(detail.get("excluded")))
        cap = detail.get("cap")
        return MountRefused(
            REFUSAL_CAP,
            cap=int(cap) if isinstance(cap, int) and not isinstance(cap, bool) else None,
            mounted=_names(detail.get("mounted")),
        )
    if exc.code == 403:
        return MountRefused(REFUSAL_NO_ACCESS)
    if exc.code == 404:
        return MountRefused(REFUSAL_NOT_FOUND)
    if 300 <= exc.code < 400:
        logger.error(
            "Internal mounts endpoint redirected (%s) — an auth middleware is intercepting "
            "%s/api/internal/conversations/*/mounts. Exclude /api/internal/* from the frontend "
            "auth proxy (unauthenticatedPaths in proxy.ts).",
            exc.code,
            _internal_base_url(),
        )
    else:
        logger.warning("Internal mounts endpoint returned %s", exc.code)
    return MountRefused(REFUSAL_UNAVAILABLE)
