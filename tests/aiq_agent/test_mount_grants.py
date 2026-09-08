"""A mount grant widens exactly one turn, and only when it verifies (ADR-0054).

`open_project` is the one path by which a collection the signed scope header
never named becomes readable in the middle of a turn. Everything that keeps that
from being a scope-widening primitive for anyone who can get a sentence into a
prompt is in `knowledge/mounts.py`, and it is all checked here:

* the payload is signed with `GRID_INTERNAL_API_TOKEN` — the same secret and the
  same HMAC-SHA256 the request-context envelope uses — so a tampered payload or
  a wrong signature widens nothing;
* the grant expires, so a captured response cannot be replayed into a later turn;
* it names an organisation and a conversation, so a grant minted for someone
  else's turn widens nothing here;
* the registry holding it is per-TURN, so nothing it granted survives into the
  next turn in the same process.

The grants are built the way the BFF builds them (`lib/workspace/grant.ts`:
base64url of the JSON payload, hex HMAC over those exact bytes), so this file is
also the Python half of the wire contract's fixture.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import time
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.mounts import begin_turn_mounts
from aiq_agent.knowledge.mounts import end_turn_mounts
from aiq_agent.knowledge.mounts import get_turn_mounts
from aiq_agent.knowledge.mounts import register_mount_grant
from aiq_agent.knowledge.mounts import verify_mount_grant
from aiq_agent.knowledge.scoping import get_scoped_collections_from_context

_TOKEN = "shared-internal-secret"
_ORG = "org_1"
_CONVERSATION = "conv_1"


def _payload(**overrides) -> dict:
    """A grant payload in the BFF's key order, with the contract's field names."""
    payload = {
        "v": 1,
        "collection": "proj_seestadt",
        "shelf": "project",
        "projectId": "proj-uuid-1",
        "projectName": "Seestadt Baufeld D",
        "conversationId": _CONVERSATION,
        "organizationId": _ORG,
        "exp": int(time.time()) + 900,
    }
    payload.update(overrides)
    return payload


def _wire(payload: dict, *, secret: str | None = _TOKEN, sig: str | None = None) -> tuple[str, str]:
    """``(grant, sig)`` exactly as `mintMountGrant` puts them on the wire."""
    raw = json.dumps(payload)
    grant = base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")
    if sig is None:
        sig = hmac.new((secret or "").encode("utf-8"), raw.encode("utf-8"), hashlib.sha256).hexdigest()
    return grant, sig


class _Ctx:
    """The turn's identity, as `GridRequestContext.from_context()` returns it."""

    def __init__(self, organization_id: str | None = _ORG) -> None:
        self.organization_id = organization_id

    @classmethod
    def bind(cls, organization_id: str | None = _ORG):
        instance = cls(organization_id)
        return type("_Bound", (), {"from_context": staticmethod(lambda: instance)})


@pytest.fixture(autouse=True)
def _turn(monkeypatch):
    """A live turn: the shared secret, an organisation, a conversation, a registry."""
    import aiq_agent.project_context as pc

    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", _TOKEN)
    monkeypatch.setattr(pc, "GridRequestContext", _Ctx.bind())
    monkeypatch.setattr(pc, "get_conversation_id_from_context", lambda: _CONVERSATION)
    token = begin_turn_mounts()
    try:
        yield
    finally:
        end_turn_mounts(token)


def _header_scope(*collections: str):
    """Patch the collection-scope header to name *collections* (bare strings)."""
    encoded = base64.urlsafe_b64encode(json.dumps(list(collections)).encode()).decode()
    ctx = MagicMock()
    ctx.metadata.headers.get.return_value = encoded
    return patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx)


class TestAGoodGrant:
    def test_it_verifies_into_a_project_scoped_collection(self):
        mount = verify_mount_grant(*_wire(_payload()))

        assert mount is not None
        assert mount.collection == "proj_seestadt"
        assert mount.shelf is Shelf.PROJECT
        # The identity that makes a Büro citation actionable: WHICH project.
        assert mount.project_id == "proj-uuid-1"
        assert mount.project_name == "Seestadt Baufeld D"

    def test_it_widens_this_turn_s_scope(self):
        register_mount_grant(*_wire(_payload()))

        with _header_scope("oib_knowledge", "archiv_org_1"):
            scope = get_scoped_collections_from_context()

        assert [entry.collection for entry in scope] == ["oib_knowledge", "archiv_org_1", "proj_seestadt"]
        mounted = scope[-1]
        assert mounted.shelf is Shelf.PROJECT
        assert mounted.project_name == "Seestadt Baufeld D"

    def test_mounting_the_same_project_twice_costs_nothing(self):
        register_mount_grant(*_wire(_payload()))
        register_mount_grant(*_wire(_payload()))

        assert [mount.collection for mount in get_turn_mounts()] == ["proj_seestadt"]

    def test_a_mount_made_in_another_task_is_visible_to_the_turn(self):
        """The tool and the search that reads what it mounted run in different
        asyncio tasks, and a task gets a COPY of the context — so a registry
        REBOUND per mount would verify, log, and widen nothing."""

        async def _mount_then_read():
            await asyncio.create_task(asyncio.to_thread(register_mount_grant, *_wire(_payload())))
            return get_turn_mounts()

        assert [mount.collection for mount in asyncio.run(_mount_then_read())] == ["proj_seestadt"]


class TestARefusedGrantWidensNothing:
    @pytest.mark.parametrize(
        ("what", "grant", "sig"),
        [
            ("no grant at all", None, None),
            ("a grant with no signature", _wire(_payload())[0], ""),
            ("a signature with no grant", "", _wire(_payload())[1]),
            ("a payload that is not base64url", "!!!not-base64!!!", "0" * 64),
            (
                # The payload edited after signing: the MAC is over the bytes,
                # so any edit is caught, including one to the collection.
                "a tampered payload",
                _wire(_payload(collection="archiv_org_1"))[0],
                _wire(_payload())[1],
            ),
            ("a wrong signature", *(_wire(_payload())[0], "a" * 64)),
            ("a signature from another secret", *_wire(_payload(), secret="not-the-shared-secret")),
            ("an expired grant", *_wire(_payload(exp=int(time.time()) - 1))),
            ("a grant with no expiry", *_wire(_payload(exp=None))),
            ("a grant for another conversation", *_wire(_payload(conversationId="conv_other"))),
            ("a grant for another organisation", *_wire(_payload(organizationId="org_other"))),
            ("an unknown payload version", *_wire(_payload(v=2))),
            # Mounting brings a PROJECT into view; a grant claiming any other
            # shelf is widening something mounting has no business touching.
            ("a grant for another shelf", *_wire(_payload(shelf="archiv"))),
            ("a grant naming no collection", *_wire(_payload(collection="  "))),
        ],
    )
    def test_it_is_refused(self, what, grant, sig):
        assert verify_mount_grant(grant, sig) is None, what
        assert register_mount_grant(grant, sig) is None, what
        assert get_turn_mounts() == ()

        with _header_scope("oib_knowledge"):
            assert [entry.collection for entry in get_scoped_collections_from_context()] == ["oib_knowledge"]

    def test_a_tamper_is_logged_loudly_and_an_expiry_is_not(self, caplog):
        """An expired grant on a slow turn is ordinary; a present-but-wrong
        signature is somebody trying to widen a turn's scope."""
        import logging

        with caplog.at_level(logging.INFO, logger="aiq_agent.knowledge.mounts"):
            verify_mount_grant(*_wire(_payload(exp=int(time.time()) - 1)))
        assert not [record for record in caplog.records if record.levelno >= logging.WARNING]

        caplog.clear()
        with caplog.at_level(logging.INFO, logger="aiq_agent.knowledge.mounts"):
            verify_mount_grant(_wire(_payload())[0], "b" * 64)
        assert [record for record in caplog.records if record.levelno >= logging.WARNING]


class TestTheRegistryIsPerTurn:
    def test_a_mount_does_not_leak_into_the_next_turn(self):
        # Turn one mounts a project. (The fixture's registry stands in for the
        # entrypoint's; the two turns below are the two the process runs.)
        first = begin_turn_mounts()
        register_mount_grant(*_wire(_payload()))
        assert [mount.collection for mount in get_turn_mounts()] == ["proj_seestadt"]
        end_turn_mounts(first)

        # Turn two, same process, same conversation: it reads what the BFF
        # signed for it, and nothing the previous turn granted itself.
        second = begin_turn_mounts()
        try:
            assert get_turn_mounts() == ()
            with _header_scope("oib_knowledge"):
                assert [entry.collection for entry in get_scoped_collections_from_context()] == ["oib_knowledge"]
        finally:
            end_turn_mounts(second)

    def test_an_unbound_registry_still_refuses_a_bad_grant(self):
        """Losing a VERIFIED grant would be the worse failure, so the module
        binds a registry lazily — a refused grant must still widen nothing."""
        assert register_mount_grant("!!!", "0" * 64) is None
