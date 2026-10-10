"""Per-turn context: gathered, fail-open where the callee says so, and the stage
facts captured whatever else failed."""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Iterator

import pytest

from aiq_agent.knowledge.restricted_use import RestrictedUse
from aiq_agent.knowledge.restricted_use import bind_restricted_use
from aiq_agent.knowledge.restricted_use import reset_restricted_use
from aiq_agent.project_context import GridRequestContext
from aiq_agent.stages import TurnFacts
from aiq_agent.stages.flags import TurnFlags
from aiq_agent.turn import context as context_mod
from aiq_agent.turn.context import load_turn_context
from aiq_agent.turn.context import settle_restriction
from aiq_agent.turn.context import thread_id_for_turn
from aiq_agent.turn.context import turn_identity
from aiq_agent.turn.context import user_info_from_principal
from aiq_agent.turn.context_client import ContextBlocks
from aiq_agent.turn.context_client import TurnContextError


def _request(**fields) -> GridRequestContext:
    return GridRequestContext(**fields)


@contextlib.contextmanager
def bound_use(drawable=(), confined=False) -> Iterator[RestrictedUse]:
    """A turn's restricted use (ADR-0088), bound in the test's own context and reset after."""
    use = RestrictedUse(
        organization_id="org",
        user_id="user_asker",
        conversation_id="c1",
        project_id="p1",
        drawable=set(drawable),
        confined=confined,
    )
    token = bind_restricted_use(use)
    try:
        yield use
    finally:
        reset_restricted_use(token)


@pytest.fixture
def stubs(monkeypatch):
    """The three round-trips, replaced by stubs a test can shape."""
    calls: dict[str, object] = {
        "lessons": "LESSONS",
        "digest": "LIVE",
        "stages": frozenset({"follow_ups"}),
        "deep_research_allowed": True,
        "tasks_allowed": True,
    }

    def lessons(_conversation_id):
        return calls["lessons"]

    def digest(*, project_id, organization_id, query, restricted_collections=(), user_id=None):
        calls["digest_args"] = (project_id, organization_id, query)
        calls["digest_restricted"] = list(restricted_collections)
        calls["digest_user"] = user_id
        value = calls["digest"]
        if isinstance(value, Exception):
            raise value
        return value

    async def turn_flags(*, organization_id, memory_reflection_enabled, project_id=None):
        calls["stages_args"] = (organization_id, memory_reflection_enabled)
        calls["flags_project"] = project_id
        return TurnFlags(
            enabled_stages=calls["stages"],
            deep_research_allowed=calls["deep_research_allowed"],
            tasks_allowed=calls["tasks_allowed"],
        )

    monkeypatch.setattr(context_mod, "get_platform_lessons_digest", lessons)
    monkeypatch.setattr(context_mod, "fetch_memory_digest", digest)
    monkeypatch.setattr(context_mod, "resolve_turn_flags", turn_flags)
    monkeypatch.setattr(context_mod, "get_user_message_id_from_context", lambda: "msg-1")
    return calls


class TestLoadTurnContext:
    async def test_composes_the_live_digest_into_the_project_context(self, stubs):
        request = _request(project_id="p1", organization_id="org", project_context="PROFILE", project_memory="FROZEN")

        context = await load_turn_context(request, conversation_id="c1", query_text="Wie hoch?", resolve_stages=True)

        assert context.project_context == "PROFILE\n\nLIVE"
        assert context.platform_lessons == "LESSONS"
        assert stubs["digest_args"] == ("p1", "org", "Wie hoch?")
        # The project rides along, so a closed one withdraws research (ADR-0090).
        assert stubs["flags_project"] == "p1"
        facts = context.stage_facts
        assert (facts.conversation_id, facts.ws_parent_id, facts.organization_id, facts.project_id) == (
            "c1",
            "msg-1",
            "org",
            "p1",
        )
        assert facts.memory_digest == "LIVE"
        assert facts.enabled_stages == frozenset({"follow_ups"})

    async def test_a_failed_digest_fetch_keeps_the_header_digest_and_still_captures_the_stage_facts(self, stubs):
        """The old code wrapped the digest AND the stage facts in one try:
        one failure dropped both. The facts are the stages' only input."""
        stubs["digest"] = RuntimeError("GRID_INTERNAL_API_TOKEN is not configured")
        request = _request(project_id="p1", organization_id="org", project_memory="FROZEN", bundesland="wien")

        context = await load_turn_context(request, conversation_id="c1", query_text="q", resolve_stages=True)

        assert context.project_context == "FROZEN"
        assert context.stage_facts.organization_id == "org"
        assert context.stage_facts.memory_digest == "FROZEN"
        assert context.stage_facts.bundesland == "wien"
        assert context.stage_facts.enabled_stages == frozenset({"follow_ups"})

    async def test_a_bug_in_the_digest_fetch_drops_the_context_instead_of_faking_it(self, stubs, caplog):
        """Two rules meet here and both hold.

        ``_live_memory_digest`` catches only the transport failures it names,
        so a BUG is never quietly degraded to the frozen header digest — an
        answer written against a digest that silently was not fetched is wrong
        in the way nobody can see. And the turn is one member of the setup
        gather, so the bug costs the LIVE CONTEXT, not the reader's answer: it
        surfaces as an empty context plus the traceback in the log.
        """
        stubs["digest"] = TypeError("a bug, not a transport failure")

        context = await load_turn_context(
            _request(project_id="p1", project_memory="FROZEN"),
            conversation_id="c1",
            query_text="q",
            resolve_stages=False,
        )

        assert context.project_context is None
        assert context.platform_lessons is None
        assert context.stage_facts == TurnFacts()
        assert "Project-context load failed" in caplog.text
        assert "a bug, not a transport failure" in caplog.text

    async def test_no_project_and_no_org_means_no_fetch_and_the_header_value(self, stubs):
        context = await load_turn_context(
            _request(project_memory="FROZEN"), conversation_id="c1", query_text="q", resolve_stages=False
        )
        assert "digest_args" not in stubs
        assert context.project_context == "FROZEN"

    async def test_no_stage_has_a_model_but_the_capability_half_is_still_resolved(self, stubs):
        """The round-trip used to be skipped here, when its only answer was the
        stage set. It now also carries whether deep research may be OFFERED,
        which is per-org and decides something on every turn — so the call is
        made and only the stage half is discarded."""
        stubs["deep_research_allowed"] = False

        context = await load_turn_context(
            _request(organization_id="org"), conversation_id="c1", query_text="q", resolve_stages=False
        )

        assert stubs["stages_args"] == ("org", False)
        assert context.stage_facts.enabled_stages == frozenset()
        assert context.deep_research_allowed is False

    async def test_no_organization_resolves_nothing_and_keeps_the_permissive_defaults(self, stubs):
        """Without a tenant there is nothing to evaluate against: the BFF would
        answer with the same defaults, so the turn does not pay for the ask."""
        context = await load_turn_context(
            _request(project_id="p1"), conversation_id="c1", query_text="q", resolve_stages=True
        )

        assert "stages_args" not in stubs
        assert context.stage_facts.enabled_stages == frozenset()
        assert context.deep_research_allowed is True

    async def test_a_withdrawn_flag_reaches_the_turn(self, stubs):
        stubs["deep_research_allowed"] = False

        context = await load_turn_context(
            _request(organization_id="org"), conversation_id="c1", query_text="q", resolve_stages=True
        )

        assert context.deep_research_allowed is False

    async def test_the_two_capabilities_are_withdrawn_independently(self, stubs):
        """Skills stay in chat and tasks do not: the product asked for exactly
        this split, so the two flags must not collapse into one."""
        stubs["tasks_allowed"] = False

        context = await load_turn_context(
            _request(organization_id="org"), conversation_id="c1", query_text="q", resolve_stages=True
        )

        assert context.tasks_allowed is False
        assert context.deep_research_allowed is True

    async def test_a_failed_context_load_leaves_deep_research_allowed(self, stubs):
        """The whole-context fail-open must not withdraw a capability: a dead
        branch costs the live context, never the reader's deep research."""
        stubs["digest"] = TypeError("a bug, not a transport failure")

        context = await load_turn_context(
            _request(project_id="p1", organization_id="org"),
            conversation_id="c1",
            query_text="q",
            resolve_stages=True,
        )

        assert context.project_context is None
        assert context.deep_research_allowed is True

    async def test_the_three_round_trips_overlap(self, monkeypatch):
        """Gathered, not sequential: three 50 ms waits take ~50 ms, not ~150."""

        def slow_lessons(_cid):
            time.sleep(0.05)

        def slow_digest(**_kw):
            time.sleep(0.05)

        async def slow_flags(**_kw):
            await asyncio.sleep(0.05)
            return TurnFlags(enabled_stages=frozenset())

        monkeypatch.setattr(context_mod, "get_platform_lessons_digest", slow_lessons)
        monkeypatch.setattr(context_mod, "fetch_memory_digest", slow_digest)
        monkeypatch.setattr(context_mod, "resolve_turn_flags", slow_flags)
        started = time.perf_counter()
        # An organization, so the flag round-trip actually runs and there are
        # three waits to overlap rather than two.
        await load_turn_context(
            _request(project_id="p1", organization_id="org"),
            conversation_id="c1",
            query_text="q",
            resolve_stages=True,
        )
        assert time.perf_counter() - started < 0.12


class TestTurnIdentity:
    def test_the_conversation_id_is_the_thread(self):
        assert thread_id_for_turn("conv-1") == "conv-1"

    def test_a_missing_conversation_gets_a_fresh_thread(self):
        first, second = thread_id_for_turn(None), thread_id_for_turn("")
        assert first and second and first != second

    def test_user_info_is_none_when_anonymous(self, monkeypatch):
        monkeypatch.setattr(context_mod, "get_current_principal", lambda: None)
        assert user_info_from_principal() is None

    def test_user_info_carries_name_and_email(self, monkeypatch):
        class Principal:
            name = "Anna"
            email = "anna@example.com"

        monkeypatch.setattr(context_mod, "get_current_principal", lambda: Principal())
        assert user_info_from_principal() == {"name": "Anna", "email": "anna@example.com"}


class TestBffTurnContext:
    async def test_context_is_read_fresh_each_turn_without_legacy_memory_fetch(self, stubs, monkeypatch):
        blocks = [ContextBlocks("PROFILE", "MEMORY", "POLICY"), ContextBlocks("NEW PROFILE", None, "NEW POLICY")]
        calls = []

        def fetch(request, *, query):
            calls.append((request.envelope_header, request.envelope_signature, query))
            return blocks[len(calls) - 1]

        monkeypatch.setattr(context_mod, "fetch_turn_context", fetch)
        request = _request(
            organization_id="org",
            user_id="user",
            project_id="513",
            context_transport="bff",
            envelope_header="original signed capsule",
            envelope_signature="original signature",
            project_context="STALE PROFILE",
            project_memory="STALE MEMORY",
            org_instructions="STALE POLICY",
        )
        first = await load_turn_context(request, conversation_id="conv_text", query_text="first", resolve_stages=True)
        stubs["tasks_allowed"] = False
        stubs["lessons"] = "NEW LESSONS"
        second = await load_turn_context(request, conversation_id="conv_text", query_text="next", resolve_stages=True)

        assert first.project_context == "PROFILE\n\nMEMORY"
        assert first.org_instructions == "POLICY"
        assert first.platform_lessons == "LESSONS"
        assert first.tasks_allowed is True
        assert first.stage_facts.memory_digest == "MEMORY"
        assert second.project_context == "NEW PROFILE"
        assert second.org_instructions == "NEW POLICY"
        assert second.platform_lessons == "NEW LESSONS"
        assert second.tasks_allowed is False
        assert second.stage_facts.memory_digest is None
        assert second.stage_facts.organization_id == "org"
        assert second.stage_facts.project_id == "513"
        assert second.stage_facts.conversation_id == "conv_text"
        assert calls == [
            ("original signed capsule", "original signature", "first"),
            ("original signed capsule", "original signature", "next"),
        ]
        assert "digest_args" not in stubs

    async def test_empty_bff_context_is_authoritative_not_stale_header_fallback(self, stubs, monkeypatch):
        monkeypatch.setattr(context_mod, "fetch_turn_context", lambda *_a, **_kw: ContextBlocks(None, None, None))
        context = await load_turn_context(
            _request(
                context_transport="bff",
                project_context="STALE PROFILE",
                project_memory="STALE MEMORY",
                org_instructions="STALE POLICY",
            ),
            conversation_id="conv_text",
            query_text="q",
            resolve_stages=False,
        )
        assert (context.project_context, context.org_instructions, context.stage_facts.memory_digest) == (
            None,
            None,
            None,
        )
        assert context.platform_lessons == "LESSONS"
        assert "digest_args" not in stubs

    async def test_the_reference_catalog_reaches_the_turn(self, stubs, monkeypatch):
        catalog = "- Wohnbau Graz (id p1): 2019, GK 4"
        monkeypatch.setattr(
            context_mod,
            "fetch_turn_context",
            lambda *_a, **_kw: ContextBlocks(None, None, None, reference_projects=catalog),
        )
        context = await load_turn_context(
            _request(context_transport="bff", organization_id="org"),
            conversation_id="conv_text",
            query_text="q",
            resolve_stages=False,
        )
        assert context.reference_projects == catalog

    async def test_advisory_lessons_still_fail_open_in_bff_mode(self, stubs, monkeypatch):
        def fail(_cid):
            raise RuntimeError("lessons unavailable")

        monkeypatch.setattr(context_mod, "get_platform_lessons_digest", fail)
        monkeypatch.setattr(
            context_mod, "fetch_turn_context", lambda *_a, **_kw: ContextBlocks("PROFILE", None, "POLICY")
        )
        context = await load_turn_context(
            _request(context_transport="bff", organization_id="org"),
            conversation_id="conv_text",
            query_text="q",
            resolve_stages=True,
        )
        assert context.project_context == "PROFILE"
        assert context.org_instructions == "POLICY"
        assert context.platform_lessons is None
        assert context.stage_facts.enabled_stages == frozenset({"follow_ups"})

    @pytest.mark.parametrize(
        "failure",
        [
            TurnContextError("unauthenticated", status=401),
            TurnContextError("forbidden", status=403),
            TurnContextError("unavailable", status=503),
            TurnContextError("network error"),
            TurnContextError("malformed response"),
            TypeError("unexpected bug"),
        ],
    )
    async def test_required_context_failures_cannot_be_swallowed(self, stubs, monkeypatch, failure):
        def fail(*_a, **_kw):
            raise failure

        monkeypatch.setattr(context_mod, "fetch_turn_context", fail)
        with pytest.raises(type(failure)) as error:
            await load_turn_context(
                _request(context_transport="bff", organization_id="org", project_context="STALE"),
                conversation_id="conv_text",
                query_text="q",
                resolve_stages=True,
            )
        assert error.value is failure
        assert "digest_args" not in stubs

    async def test_bff_fetch_runs_in_existing_setup_gather(self, stubs, monkeypatch):
        started = asyncio.Event()
        release = asyncio.Event()

        async def lessons(_cid):
            started.set()
            await release.wait()
            return "LESSONS"

        def fetch(*_a, **_kw):
            return ContextBlocks("PROFILE", "MEMORY", "POLICY")

        async def flags(*_a, **_kw):
            await started.wait()
            release.set()
            return TurnFlags(enabled_stages=frozenset())

        monkeypatch.setattr(context_mod, "_platform_lessons", lessons)
        monkeypatch.setattr(context_mod, "fetch_turn_context", fetch)
        monkeypatch.setattr(context_mod, "_turn_flags", flags)
        context = await asyncio.wait_for(
            load_turn_context(
                _request(context_transport="bff"), conversation_id="conv_text", query_text="q", resolve_stages=False
            ),
            timeout=1,
        )
        assert context.project_context == "PROFILE\n\nMEMORY"


def test_turn_identity_is_the_parsed_request_in_ledger_shape():
    request = _request(organization_id="org", user_id="u", project_id="p")
    assert turn_identity(request, "conv") == {
        "organization_id": "org",
        "user_id": "u",
        "project_id": "p",
        "conversation_id": "conv",
    }


class TestRestrictedMemoryInTheLiveDigest:
    """ADR-0087, ADR-0088: the live digest serves restricted memory only for the
    restricted collections the turn's VERIFIED envelope carries and the turn may
    draw on, with the signed asker the BFF admits them for."""

    _SCOPE = ["oib_knowledge", "proj_p1", "proj_p1_r0123456789ab", "s_c1"]

    async def test_a_signed_scope_passes_its_restricted_collections(self, stubs):
        request = _request(
            project_id="p1",
            organization_id="org",
            user_id="user_asker",
            collection_scope=self._SCOPE,
            envelope_header="signed",
        )
        await load_turn_context(request, conversation_id="c1", query_text="q", resolve_stages=False)
        assert stubs["digest_restricted"] == ["proj_p1_r0123456789ab"]
        assert stubs["digest_user"] == "user_asker"

    async def test_only_the_collections_the_turn_may_draw_on_pass(self, stubs):
        """Shared since the socket was signed: the BFF said no to this folder, so its notes are not asked for."""
        request = _request(
            project_id="p1", organization_id="org", collection_scope=self._SCOPE, envelope_header="signed"
        )
        with bound_use(drawable=()):
            await load_turn_context(request, conversation_id="c1", query_text="q", resolve_stages=False)
        assert stubs["digest_restricted"] == []

    async def test_an_unsigned_scope_passes_none(self, stubs):
        """The raw-header fallback has nothing vouching for it."""
        request = _request(project_id="p1", organization_id="org", collection_scope=self._SCOPE)
        await load_turn_context(request, conversation_id="c1", query_text="q", resolve_stages=False)
        assert stubs["digest_restricted"] == []

    async def test_an_open_scope_passes_none(self, stubs):
        request = _request(
            project_id="p1", organization_id="org", collection_scope=["proj_p1"], envelope_header="signed"
        )
        await load_turn_context(request, conversation_id="c1", query_text="q", resolve_stages=False)
        assert stubs["digest_restricted"] == []


class TestRestrictedMemoryOnTheCompactHandshake:
    """ADR-0087, ADR-0088 on the BFF transport: ``fetch_turn_context`` serves open
    memory only, so a turn that may draw on a restricted folder takes the live
    digest, the one that admits the folders, in its place."""

    _SCOPE = ["oib_knowledge", "proj_p1", "proj_p1_r0123456789ab", "s_c1"]

    def _bff_request(self, **overrides):
        fields = dict(
            project_id="p1",
            organization_id="org",
            user_id="user_asker",
            context_transport="bff",
            envelope_header="signed",
            envelope_signature="sig",
            collection_scope=self._SCOPE,
        )
        return _request(**{**fields, **overrides})

    async def test_a_signed_restricted_scope_takes_the_live_digest_and_keeps_the_other_blocks(self, stubs, monkeypatch):
        monkeypatch.setattr(
            context_mod, "fetch_turn_context", lambda request, *, query: ContextBlocks("PROFILE", "OPEN", "POLICY")
        )
        context = await load_turn_context(
            self._bff_request(), conversation_id="c1", query_text="q", resolve_stages=False
        )
        assert stubs["digest_restricted"] == ["proj_p1_r0123456789ab"]
        assert stubs["digest_user"] == "user_asker"
        assert context.project_context == "PROFILE\n\nLIVE"
        assert context.org_instructions == "POLICY"
        assert context.stage_facts.memory_digest == "LIVE"

    async def test_a_failed_live_digest_leaves_the_open_digest(self, stubs, monkeypatch):
        monkeypatch.setattr(
            context_mod, "fetch_turn_context", lambda request, *, query: ContextBlocks("PROFILE", "OPEN", "POLICY")
        )
        stubs["digest"] = RuntimeError("down")
        context = await load_turn_context(
            self._bff_request(), conversation_id="c1", query_text="q", resolve_stages=False
        )
        assert context.project_context == "PROFILE\n\nOPEN"

    async def test_an_open_scope_asks_no_live_digest(self, stubs, monkeypatch):
        monkeypatch.setattr(
            context_mod, "fetch_turn_context", lambda request, *, query: ContextBlocks("PROFILE", "OPEN", "POLICY")
        )
        context = await load_turn_context(
            self._bff_request(collection_scope=["proj_p1"]),
            conversation_id="c1",
            query_text="q",
            resolve_stages=False,
        )
        assert "digest_args" not in stubs
        assert context.project_context == "PROFILE\n\nOPEN"


class TestAConfinedTurnOffersNothingTheWholeProjectReads:
    """ADR-0087, ADR-0088: a turn that may draw on a restricted folder, or whose
    conversation already drew on one, may not commission a run or hand work
    over, so it is never offered either. The BFF refuses both on its own; this
    keeps the model from proposing them. Settled after the whole setup gather
    (``settle_restriction``), because the digest and the subject can confine."""

    _SCOPE = ["oib_knowledge", "proj_p1", "proj_p1_r0123456789ab", "s_c1"]

    def _signed(self, scope=None) -> GridRequestContext:
        return _request(
            project_id="p1", organization_id="org", collection_scope=scope or self._SCOPE, envelope_header="signed"
        )

    async def _settled(self, request: GridRequestContext):
        context = await load_turn_context(request, conversation_id="c1", query_text="q", resolve_stages=True)
        return settle_restriction(context, request)

    async def test_a_drawable_restricted_collection_withdraws_deep_research_and_tasks(self, stubs):
        with bound_use(drawable={"proj_p1_r0123456789ab"}):
            context = await self._settled(self._signed())
        assert context.confined is True
        assert context.restricted_scope == ("proj_p1_r0123456789ab",)
        assert (context.deep_research_allowed, context.tasks_allowed) == (False, False)

    async def test_a_conversation_that_drew_on_one_stays_confined_with_nothing_drawable(self, stubs):
        """Everything narrowed away this turn, but the record stands: still no run, no task."""
        with bound_use(drawable=(), confined=True):
            context = await self._settled(self._signed())
        assert context.restricted_scope == ()
        assert context.confined is True
        assert (context.deep_research_allowed, context.tasks_allowed) == (False, False)

    async def test_nothing_drawable_and_nothing_recorded_is_an_open_turn(self, stubs):
        """The thread is shared with someone not cleared, and it never drew on the folder: nothing to protect."""
        with bound_use(drawable=(), confined=False):
            context = await self._settled(self._signed())
        assert context.confined is False
        assert (context.deep_research_allowed, context.tasks_allowed) == (True, True)

    async def test_restricted_memory_served_this_turn_confines_it(self, stubs):
        with bound_use(drawable=()) as use:
            use.note_recorded()  # what `fetch_memory_digest` does on `restrictedFoldersServed`
            context = await self._settled(self._signed())
        assert context.confined is True

    async def test_an_open_scope_keeps_what_the_tenant_allows(self, stubs):
        context = await self._settled(self._signed(["proj_p1"]))
        assert context.confined is False
        assert (context.deep_research_allowed, context.tasks_allowed) == (True, True)

    async def test_the_fail_open_context_stays_confined(self, stubs):
        stubs["digest"] = TypeError("a bug, not a transport failure")
        with bound_use(drawable={"proj_p1_r0123456789ab"}):
            context = await self._settled(self._signed())
        assert context.project_context is None
        assert context.confined is True
        assert (context.deep_research_allowed, context.tasks_allowed) == (False, False)
