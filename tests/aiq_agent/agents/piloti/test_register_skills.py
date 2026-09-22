"""Piloti register: skill wiring (resolver → allowlist → runtime → tools).

Covers the seam between the skills engine and the agent registration: the
per-run resolution + allowlist narrowing + ``use_skill`` tool folding +
``skills_block``/``skills_activated`` propagation declared in
``ResearchAgentConfig``. The engine itself (model/resolver/runtime) is
tested under ``tests/aiq_agent/skills/``.
"""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

import aiq_agent.agents.piloti.register as register_module
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.register import ResearchAgentConfig
from aiq_agent.agents.piloti.register import research_agent


@tool
def web_search_tool(query: str) -> str:
    """Search the web."""
    return f"results: {query}"


class _FakeBuilder:
    def __init__(self, tools_by_name):
        self._tools_by_name = tools_by_name
        self.get_tools_calls = []

    async def get_tools(self, tool_names, wrapper_type):
        self.get_tools_calls.append(list(tool_names))
        return [self._tools_by_name[n] for n in tool_names if n in self._tools_by_name]

    async def get_llm(self, ref, wrapper_type):
        return MagicMock()


def _make_agent_stub():
    """PilotiAgent replacement whose .run echoes the input state.

    Records the tools each constructed instance was given so the test can
    assert the ``use_skill`` tool was folded into (only) the research-turn
    build.
    """

    def _factory(*args, **kwargs):
        agent = MagicMock()
        agent.run = AsyncMock(side_effect=lambda state, turn=None: state)
        agent.build_tools = kwargs.get("tools")
        agent.init_kwargs = kwargs
        built.append(agent)
        return agent

    built: list = []
    _factory.built = built
    return _factory


async def _get_run_fn(config, builder):
    gen = research_agent.__wrapped__(config, builder)
    function_info = await gen.__anext__()
    return function_info.single_fn, gen


def _skill(name: str):
    skill = MagicMock()
    skill.name = name
    return skill


def _skill_runtime(resolved, *, activated=()):
    """A stand-in runtime.

    ``activated`` is what the model actually opened this run. It defaults to
    nothing, which is the honest default now that a turn can only be OFFERED a
    skill: a catalog the model read past activates none of it.
    """
    runtime = MagicMock()
    runtime.prompt_block.return_value = "## Verfügbare Skills"
    runtime.build_tools.return_value = [MagicMock(name="use_skill")]
    runtime.activated = list(activated)
    runtime.skills = tuple(resolved)
    runtime.hidden_activated = ()
    runtime.inlined = ()
    runtime.record_applied = MagicMock(return_value=())
    return runtime


@pytest.mark.asyncio
async def test_research_turn_resolves_allows_and_folds_skill_tool():
    """skills_enabled research turn: resolve → allowlist → runtime → use_skill tool.

    The rebuilt agent must carry the ``use_skill`` tool; the pre-rendered
    skills block must land on the state before ``run()`` and the activation
    list must be lifted onto the result.
    """
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=True,
    )
    resolved = (_skill("forecast-analysis"), _skill("data-table-analysis"))
    runtime = _skill_runtime(resolved, activated=["forecast-analysis"])
    stub = _make_agent_stub()

    with (
        patch.object(register_module, "PilotiAgent", stub),
        patch.object(register_module, "get_organization_id_from_context", return_value="org-1"),
        patch.object(register_module, "SkillRuntime", return_value=runtime) as RuntimeCls,
        patch.object(register_module, "SkillResolver") as ResolverCls,
    ):
        resolver = ResolverCls.return_value
        resolver.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)

        state = ResearchAgentState(messages=[HumanMessage(content="/forecast-analysis für das Projekt?")])
        result = await run_fn(state)

        ResolverCls.assert_called_once_with(agent="researcher")
        resolver.resolve.assert_called_once_with("org-1")
        # The catalog and nothing else: the runtime takes no list of names.
        RuntimeCls.assert_called_once_with(skills=resolved, inline_max_body_chars=2400, inline_budget_chars=16000)

        # The turn got both the search tool and use_skill; the agent itself
        # was built once, at boot, with the search tool only.
        assert len(stub.built) == 1
        turn = stub.built[0].run.await_args.kwargs["turn"]
        assert [getattr(t, "name", None) for t in turn.tools][0] == "web_search_tool"
        assert len(turn.tools) == 2
        assert state.skills_block == "## Verfügbare Skills"
        assert result.skills_activated == ["forecast-analysis"]
        await gen.aclose()


@pytest.mark.asyncio
async def test_the_catalog_is_announced_before_the_llm_runs():
    """The `offered` event fires at wiring time, not after the answer.

    Everything about skills used to leave the process as ``skills_activated[]``
    on the TERMINAL frame — i.e. after the answer the skill shaped. This asserts
    the seam: the register announces the catalog while it is still assembling
    the run, before a single token is generated.
    """
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=True,
    )
    resolved = (_skill("forecast-analysis"),)
    runtime = _skill_runtime(resolved, activated=["forecast-analysis"])
    announced = []

    with (
        patch.object(register_module, "PilotiAgent", _make_agent_stub()),
        patch.object(register_module, "get_organization_id_from_context", return_value="org-1"),
        patch.object(register_module, "SkillRuntime", return_value=runtime),
        patch.object(register_module, "SkillResolver") as ResolverCls,
        patch.object(register_module, "emit_skills_offered", side_effect=lambda rt: announced.append(rt)),
    ):
        ResolverCls.return_value.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)
        await run_fn(ResearchAgentState(messages=[HumanMessage(content="run forecast-analysis")]))

        assert announced == [runtime]
        await gen.aclose()


@pytest.mark.asyncio
async def test_a_turn_without_skills_announces_nothing():
    """Silence is the correct report for a turn with no skills in it."""
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=True,
    )
    announced = []

    with (
        patch.object(register_module, "PilotiAgent", _make_agent_stub()),
        patch.object(register_module, "get_organization_id_from_context", return_value="org-1"),
        patch.object(register_module, "SkillResolver") as ResolverCls,
        patch.object(register_module, "emit_skills_offered", side_effect=lambda rt: announced.append(rt)),
    ):
        ResolverCls.return_value.resolve.return_value = ()

        run_fn, gen = await _get_run_fn(config, builder)
        state = ResearchAgentState(messages=[HumanMessage(content="hallo")])
        await run_fn(state)

        assert announced == []
        await gen.aclose()


@pytest.mark.asyncio
async def test_a_mentioned_skill_is_offered_like_any_other():
    """The `/name` invocation is TEXT, and the runtime is given the catalog.

    Nothing on the state says which skill the user typed: the mention is in the
    message, the model reads it there, and the same `use_skill` tool answers it.
    So the register's job is the same on this turn as on any other.
    """
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=True,
    )
    resolved = (_skill("forecast-analysis"),)
    runtime = _skill_runtime(resolved, activated=["forecast-analysis"])

    with (
        patch.object(register_module, "PilotiAgent", _make_agent_stub()),
        patch.object(register_module, "get_organization_id_from_context", return_value="org-1"),
        patch.object(register_module, "SkillRuntime", return_value=runtime) as RuntimeCls,
        patch.object(register_module, "SkillResolver") as ResolverCls,
    ):
        resolver = ResolverCls.return_value
        resolver.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)

        state = ResearchAgentState(messages=[HumanMessage(content="/forecast-analysis und jetzt?")])
        result = await run_fn(state)

        ResolverCls.assert_called_once_with(agent="researcher")
        RuntimeCls.assert_called_once_with(skills=resolved, inline_max_body_chars=2400, inline_budget_chars=16000)
        assert result.skills_activated == ["forecast-analysis"]
        await gen.aclose()


@pytest.mark.asyncio
async def test_skills_disabled_skips_resolution():
    """skills_enabled=False: engine is never consulted, tool set unchanged."""
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=False,
    )

    with (
        patch.object(register_module, "PilotiAgent", _make_agent_stub()),
        patch.object(register_module, "SkillResolver") as ResolverCls,
    ):
        run_fn, gen = await _get_run_fn(config, builder)

        state = ResearchAgentState(messages=[HumanMessage(content="run forecast-analysis")])
        await run_fn(state)

        ResolverCls.assert_not_called()
        await gen.aclose()


@pytest.mark.asyncio
async def test_allowlist_narrows_resolved_set():
    """skill_allowlist restricts which resolved skills reach the runtime."""
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=True,
        skill_allowlist=["forecast-analysis"],
    )
    resolved = (_skill("forecast-analysis"), _skill("data-table-analysis"))
    runtime = _skill_runtime((resolved[0],))
    runtime.prompt_block.return_value = "## Verfügbare Skills"

    with (
        patch.object(register_module, "PilotiAgent", _make_agent_stub()),
        patch.object(register_module, "get_organization_id_from_context", return_value="org-1"),
        patch.object(register_module, "SkillRuntime", return_value=runtime) as RuntimeCls,
        patch.object(register_module, "SkillResolver") as ResolverCls,
    ):
        resolver = ResolverCls.return_value
        resolver.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)
        state = ResearchAgentState(messages=[HumanMessage(content="question")])
        await run_fn(state)

        resolver.resolve.assert_called_once_with("org-1")
        RuntimeCls.assert_called_once_with(skills=(resolved[0],), inline_max_body_chars=2400, inline_budget_chars=16000)
        await gen.aclose()


@pytest.mark.asyncio
async def test_a_name_the_allowlist_dropped_is_simply_not_in_the_catalog():
    """A skill the deployment does not allow never reaches the runtime.

    It is not an error and not a refusal: the model is offered what resolved,
    and a name it read in the message that is not there comes back from
    ``use_skill`` as "unknown skill", with the available names listed.
    """
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skill_allowlist=["forecast-analysis"],
    )
    resolved = (_skill("forecast-analysis"), _skill("mystery-skill"))
    runtime = _skill_runtime(resolved[:1])

    with (
        patch.object(register_module, "PilotiAgent", _make_agent_stub()),
        patch.object(register_module, "get_organization_id_from_context", return_value="org-1"),
        patch.object(register_module, "SkillRuntime", return_value=runtime) as RuntimeCls,
        patch.object(register_module, "SkillResolver") as ResolverCls,
    ):
        resolver = ResolverCls.return_value
        resolver.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)
        await run_fn(ResearchAgentState(messages=[HumanMessage(content="/mystery-skill bitte")]))

        RuntimeCls.assert_called_once_with(skills=(resolved[0],), inline_max_body_chars=2400, inline_budget_chars=16000)
        await gen.aclose()


@pytest.mark.asyncio
async def test_the_turn_config_reserves_nothing_on_top_of_the_budget():
    """One ceiling, and it is the number the config's traced floors measure.

    The register used to add one iteration per standard skill, because the
    deployment forced those skills and the turn had to pay for calls nobody
    asked for. Nothing is forced now, so there is nothing to compensate: a
    ``use_skill`` call is the model's own and is charged like a search.
    """
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=True,
        max_tool_iterations=7,
    )
    resolved = (_skill("piloti-voice"), _skill("piloti-cards"))
    runtime = _skill_runtime(resolved)
    stub = _make_agent_stub()

    with (
        patch.object(register_module, "PilotiAgent", stub),
        patch.object(register_module, "get_organization_id_from_context", return_value="org-1"),
        patch.object(register_module, "SkillRuntime", return_value=runtime),
        patch.object(register_module, "SkillResolver") as ResolverCls,
    ):
        ResolverCls.return_value.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)
        await run_fn(ResearchAgentState(messages=[HumanMessage(content="Wie tief?")]))

        assert stub.built[-1].init_kwargs["max_tool_iterations"] == 7
        assert "reserved_tool_iterations" not in stub.built[-1].init_kwargs
        turn = stub.built[-1].run.await_args.kwargs["turn"]
        assert not hasattr(turn, "reserved_tool_iterations")
        await gen.aclose()


@pytest.mark.asyncio
async def test_only_what_was_delivered_is_reported_as_used(caplog):
    """`skills_activated` is the answer's provenance, so it carries deliveries only.

    The register lifts ``SkillRuntime.activated`` onto the result and the
    frontend renders it as "what shaped this answer". A skill the model read
    past in the catalog shaped nothing — and that is not a failure to log
    either: the catalog is an offer, and declining one is the mechanism
    working.
    """
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ResearchAgentConfig(llm="research_llm", tools=["web_search_tool"], skills_enabled=True)
    resolved = (_skill("piloti-voice"), _skill("piloti-cards"))
    runtime = _skill_runtime(resolved, activated=["piloti-voice"])

    with (
        patch.object(register_module, "PilotiAgent", _make_agent_stub()),
        patch.object(register_module, "get_organization_id_from_context", return_value="org-1"),
        patch.object(register_module, "SkillRuntime", return_value=runtime),
        patch.object(register_module, "SkillResolver") as ResolverCls,
    ):
        ResolverCls.return_value.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)
        result = await run_fn(ResearchAgentState(messages=[HumanMessage(content="Wie tief?")]))

        assert result.skills_activated == ["piloti-voice"]
        assert not [m for m in caplog.messages if "never loaded" in m]
        await gen.aclose()


@pytest.mark.asyncio
async def test_the_model_credential_and_zdr_lookups_overlap():
    """The three tenant lookups are independent blocking reads, so they run
    concurrently — one cold BFF round-trip stalls the turn once, not 3x."""
    import threading
    import time

    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ResearchAgentConfig(llm="research_llm", tools=["web_search_tool"], skills_enabled=False)
    in_flight = 0
    peak = 0
    lock = threading.Lock()

    def _slow_reader():
        nonlocal in_flight, peak
        with lock:
            in_flight += 1
            peak = max(peak, in_flight)
        try:
            time.sleep(0.2)
        finally:
            with lock:
                in_flight -= 1

    def _slow_overrides():
        _slow_reader()
        return {}

    def _slow_zdr():
        _slow_reader()
        return False

    with (
        patch.object(register_module, "PilotiAgent", _make_agent_stub()),
        patch.object(register_module, "get_model_overrides_from_context", side_effect=_slow_overrides),
        patch.object(register_module, "get_org_llm_credential_from_context", side_effect=_slow_reader),
        patch.object(register_module, "get_zdr_only_from_context", side_effect=_slow_zdr),
    ):
        run_fn, gen = await _get_run_fn(config, builder)
        await run_fn(ResearchAgentState(messages=[HumanMessage(content="hallo")]))
        await gen.aclose()

    assert peak == 3, "the three tenant lookups ran one after another on a single thread"


@pytest.mark.asyncio
async def test_one_bad_tenant_reader_does_not_poison_the_others():
    """Each lookup fails open on its own: a raising credential reader costs
    the credential, never the turn — and never the other two readers."""
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ResearchAgentConfig(llm="research_llm", tools=["web_search_tool"], skills_enabled=False)

    def _boom():
        raise RuntimeError("BFF down")

    with (
        patch.object(register_module, "PilotiAgent", _make_agent_stub()),
        patch.object(register_module, "get_model_overrides_from_context", return_value={"shallow_research": "x/y"}),
        patch.object(register_module, "get_org_llm_credential_from_context", side_effect=_boom),
        patch.object(register_module, "get_zdr_only_from_context", return_value=False),
    ):
        run_fn, gen = await _get_run_fn(config, builder)
        result = await run_fn(ResearchAgentState(messages=[HumanMessage(content="hallo")]))
        await gen.aclose()

    assert result.messages[-1].content == "hallo"


@pytest.mark.asyncio
async def test_the_skill_resolve_runs_off_the_event_loop():
    """A cold resolve is a blocking BFF round-trip with a 5s timeout. On the
    loop it stalled every conversation on the replica; it runs on a thread."""
    import threading

    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ResearchAgentConfig(llm="research_llm", tools=["web_search_tool"], skills_enabled=True)
    resolved = (_skill("forecast-analysis"),)
    runtime = _skill_runtime(resolved)
    resolving_threads: list[str] = []

    def resolve(_org):
        resolving_threads.append(threading.current_thread().name)
        return resolved

    with (
        patch.object(register_module, "PilotiAgent", _make_agent_stub()),
        patch.object(register_module, "get_organization_id_from_context", return_value="org-1"),
        patch.object(register_module, "SkillRuntime", return_value=runtime),
        patch.object(register_module, "SkillResolver") as ResolverCls,
    ):
        ResolverCls.return_value.resolve.side_effect = resolve
        run_fn, gen = await _get_run_fn(config, builder)
        await run_fn(ResearchAgentState(messages=[HumanMessage(content="hallo")]))
        await gen.aclose()

    assert resolving_threads and resolving_threads[0] != threading.current_thread().name


@pytest.mark.asyncio
async def test_the_envelope_names_reach_the_runtime_after_the_run():
    """``skills_applied`` on the finished state is handed to the runtime, which
    decides what it means (ADR-0063); ``skills_activated`` is read after that."""
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ResearchAgentConfig(llm="research_llm", tools=["web_search_tool"], skills_enabled=True)
    resolved = (_skill("gebaeudeklasse"),)
    runtime = _skill_runtime(resolved)

    def _accept(names):
        runtime.activated = list(names)
        return tuple(names)

    runtime.record_applied = MagicMock(side_effect=_accept)
    stub = _make_agent_stub()

    async def _run(state, turn=None):
        state.skills_applied = ["gebaeudeklasse"]
        return state

    with (
        patch.object(register_module, "PilotiAgent", stub),
        patch.object(register_module, "get_organization_id_from_context", return_value="org-1"),
        patch.object(register_module, "SkillRuntime", return_value=runtime),
        patch.object(register_module, "SkillResolver") as ResolverCls,
    ):
        ResolverCls.return_value.resolve.return_value = resolved
        run_fn, gen = await _get_run_fn(config, builder)
        stub.built[0].run = AsyncMock(side_effect=_run)
        result = await run_fn(ResearchAgentState(messages=[HumanMessage(content="Welche GK?")]))
        await gen.aclose()

    runtime.record_applied.assert_called_once_with(["gebaeudeklasse"])
    assert result.skills_activated == ["gebaeudeklasse"]
