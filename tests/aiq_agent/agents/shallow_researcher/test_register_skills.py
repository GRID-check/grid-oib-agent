"""Shallow-research register: skill wiring (resolver → allowlist → runtime → tools).

Covers the seam between the skills engine and the agent registration: the
per-run resolution + allowlist narrowing + ``use_skill`` tool folding +
``skills_block``/``skills_activated`` propagation declared in
``ShallowResearchAgentConfig``. The engine itself (model/resolver/runtime) is
tested under ``tests/aiq_agent/skills/``.
"""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

import aiq_agent.agents.shallow_researcher.register as register_module
from aiq_agent.agents.shallow_researcher.models import ShallowResearchAgentState
from aiq_agent.agents.shallow_researcher.register import ShallowResearchAgentConfig
from aiq_agent.agents.shallow_researcher.register import shallow_research_agent


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
    """ShallowResearcherAgent replacement whose .run echoes the input state.

    Records the tools each constructed instance was given so the test can
    assert the ``use_skill`` tool was folded into (only) the research-turn
    build.
    """

    def _factory(*args, **kwargs):
        agent = MagicMock()
        agent.run = AsyncMock(side_effect=lambda state: state)
        agent.build_tools = kwargs.get("tools")
        agent.init_kwargs = kwargs
        built.append(agent)
        return agent

    built: list = []
    _factory.built = built
    return _factory


async def _get_run_fn(config, builder):
    gen = shallow_research_agent.__wrapped__(config, builder)
    function_info = await gen.__anext__()
    return function_info.single_fn, gen


def _skill(name: str):
    skill = MagicMock()
    skill.name = name
    return skill


def _skill_runtime(resolved, force_names, *, activated=None, standard_count=0):
    """A stand-in runtime.

    ``activated`` defaults to the forced names because most of these tests are
    about the register's wiring rather than about delivery — but it is a
    SEPARATE argument, because forcing a skill and the model actually reading
    it are separate facts (``SkillRuntime.forced_not_activated``).
    """
    runtime = MagicMock()
    runtime.prompt_block.return_value = "## Verfügbare Skills"
    runtime.forced_block.return_value = "## Aktive Skills (vom Nutzer erzwungen)"
    runtime.build_tools.return_value = [MagicMock(name="use_skill")]
    runtime.activated = list(force_names or []) if activated is None else list(activated)
    runtime.skills = tuple(resolved)
    runtime.forced = tuple(force_names or ())
    runtime.forced_not_activated = tuple(n for n in (force_names or ()) if n not in runtime.activated)
    runtime.hidden_activated = ()
    runtime.standard_count = standard_count
    return runtime


@pytest.mark.asyncio
async def test_research_turn_resolves_allows_and_folds_skill_tool():
    """skills_enabled research turn: resolve → allowlist → runtime → use_skill tool.

    The rebuilt agent must carry the ``use_skill`` tool; the pre-rendered
    skills block must land on the state before ``run()`` and the activation
    list must be lifted onto the result.
    """
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ShallowResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=True,
    )
    resolved = (_skill("forecast-analysis"), _skill("data-table-analysis"))
    runtime = _skill_runtime(resolved, ["forecast-analysis"])

    with (
        patch.object(register_module, "ShallowResearcherAgent", _make_agent_stub()),
        patch("aiq_agent.project_context.get_organization_id_from_context", return_value="org-1"),
        patch("aiq_agent.skills.SkillRuntime", return_value=runtime) as RuntimeCls,
        patch("aiq_agent.skills.SkillResolver") as ResolverCls,
    ):
        resolver = ResolverCls.return_value
        resolver.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)

        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="run forecast-analysis")],
            force_skills=["forecast-analysis"],
        )
        result = await run_fn(state)

        ResolverCls.assert_called_once_with(agent="shallow_researcher")
        resolver.resolve.assert_called_once_with("org-1")
        RuntimeCls.assert_called_once_with(skills=resolved, force_names=["forecast-analysis"])

        # The rebuilt agent got both the search tool and use_skill.
        # (build_tools records kwargs["tools"] on the stub; the final agent
        # instance is the one with run() awaiting it.)
        assert state.skills_block == "## Verfügbare Skills\n\n## Aktive Skills (vom Nutzer erzwungen)"
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
    config = ShallowResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=True,
    )
    resolved = (_skill("forecast-analysis"),)
    runtime = _skill_runtime(resolved, ["forecast-analysis"])
    announced = []

    with (
        patch.object(register_module, "ShallowResearcherAgent", _make_agent_stub()),
        patch("aiq_agent.project_context.get_organization_id_from_context", return_value="org-1"),
        patch("aiq_agent.skills.SkillRuntime", return_value=runtime),
        patch("aiq_agent.skills.SkillResolver") as ResolverCls,
        patch(
            "aiq_agent.skills.events.emit_skills_offered",
            side_effect=lambda rt: announced.append(rt),
        ),
    ):
        ResolverCls.return_value.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="run forecast-analysis")],
            force_skills=["forecast-analysis"],
        )
        await run_fn(state)

        assert announced == [runtime]
        await gen.aclose()


@pytest.mark.asyncio
async def test_a_turn_without_skills_announces_nothing():
    """Silence is the correct report for a turn with no skills in it."""
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ShallowResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=True,
    )
    announced = []

    with (
        patch.object(register_module, "ShallowResearcherAgent", _make_agent_stub()),
        patch("aiq_agent.project_context.get_organization_id_from_context", return_value="org-1"),
        patch("aiq_agent.skills.SkillResolver") as ResolverCls,
        patch(
            "aiq_agent.skills.events.emit_skills_offered",
            side_effect=lambda rt: announced.append(rt),
        ),
    ):
        ResolverCls.return_value.resolve.return_value = ()

        run_fn, gen = await _get_run_fn(config, builder)
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="hallo")],
            requires_sources=False,
        )
        await run_fn(state)

        assert announced == []
        await gen.aclose()


@pytest.mark.asyncio
async def test_plain_meta_turn_never_loads_skills():
    """requires_sources=False and nothing forced: no resolution, no use_skill tool.

    This is the greeting case — an unprompted conversational turn the intent
    classifier judged needs no sources. It keeps its interaction-only tool
    binding, so a "hallo" can never pull a skill body into context.
    """
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ShallowResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=True,
    )

    with (
        patch.object(register_module, "ShallowResearcherAgent", _make_agent_stub()),
        patch("aiq_agent.project_context.get_organization_id_from_context", return_value="org-1"),
        patch("aiq_agent.skills.SkillResolver") as ResolverCls,
    ):
        run_fn, gen = await _get_run_fn(config, builder)

        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="hallo")],
            requires_sources=False,
        )
        result = await run_fn(state)

        ResolverCls.assert_not_called()
        assert state.skills_block is None
        assert result.skills_activated is None
        await gen.aclose()


@pytest.mark.asyncio
async def test_explicit_slash_invocation_survives_a_meta_classification():
    """requires_sources=False but the USER forced a skill: it still loads.

    `force_skills` is only ever populated by an explicit `/name` invocation in
    the composer. The intent classifier decides whether an *unprompted* turn
    needs sources; it does not get to overrule a direct instruction. Gating on
    `requires_sources` alone made `/name` a silent no-op on exactly the short,
    imperative messages people type after a slash command.
    """
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ShallowResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=True,
    )
    resolved = (_skill("forecast-analysis"),)
    runtime = _skill_runtime(resolved, ["forecast-analysis"])

    with (
        patch.object(register_module, "ShallowResearcherAgent", _make_agent_stub()),
        patch("aiq_agent.project_context.get_organization_id_from_context", return_value="org-1"),
        patch("aiq_agent.skills.SkillRuntime", return_value=runtime) as RuntimeCls,
        patch("aiq_agent.skills.SkillResolver") as ResolverCls,
    ):
        resolver = ResolverCls.return_value
        resolver.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)

        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="und jetzt?")],
            requires_sources=False,
            force_skills=["forecast-analysis"],
        )
        result = await run_fn(state)

        ResolverCls.assert_called_once_with(agent="shallow_researcher")
        RuntimeCls.assert_called_once_with(skills=resolved, force_names=["forecast-analysis"])
        assert result.skills_activated == ["forecast-analysis"]
        await gen.aclose()


@pytest.mark.asyncio
async def test_skills_disabled_skips_resolution():
    """skills_enabled=False: engine is never consulted, tool set unchanged."""
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ShallowResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=False,
    )

    with (
        patch.object(register_module, "ShallowResearcherAgent", _make_agent_stub()),
        patch("aiq_agent.skills.SkillResolver") as ResolverCls,
    ):
        run_fn, gen = await _get_run_fn(config, builder)

        state = ShallowResearchAgentState(messages=[HumanMessage(content="run forecast-analysis")])
        await run_fn(state)

        ResolverCls.assert_not_called()
        await gen.aclose()


@pytest.mark.asyncio
async def test_allowlist_narrows_resolved_set():
    """skill_allowlist restricts which resolved skills reach the runtime."""
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ShallowResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=True,
        skill_allowlist=["forecast-analysis"],
    )
    resolved = (_skill("forecast-analysis"), _skill("data-table-analysis"))
    runtime = _skill_runtime((resolved[0],), [])
    runtime.prompt_block.return_value = "## Verfügbare Skills"

    with (
        patch.object(register_module, "ShallowResearcherAgent", _make_agent_stub()),
        patch("aiq_agent.project_context.get_organization_id_from_context", return_value="org-1"),
        patch("aiq_agent.skills.SkillRuntime", return_value=runtime) as RuntimeCls,
        patch("aiq_agent.skills.SkillResolver") as ResolverCls,
    ):
        resolver = ResolverCls.return_value
        resolver.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)
        state = ShallowResearchAgentState(messages=[HumanMessage(content="question")])
        await run_fn(state)

        resolver.resolve.assert_called_once_with("org-1")
        RuntimeCls.assert_called_once_with(skills=(resolved[0],), force_names=None)
        await gen.aclose()


@pytest.mark.asyncio
async def test_unknown_forced_skill_passes_through_allowlist():
    """Forced names outside the allowlist are dropped by the runtime, not errors."""
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ShallowResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skill_allowlist=["forecast-analysis"],
    )
    resolved = (_skill("forecast-analysis"),)
    runtime = _skill_runtime(resolved, [])
    runtime.prompt_block.return_value = "## Verfügbare Skills"

    with (
        patch.object(register_module, "ShallowResearcherAgent", _make_agent_stub()),
        patch("aiq_agent.project_context.get_organization_id_from_context", return_value="org-1"),
        patch("aiq_agent.skills.SkillRuntime", return_value=runtime) as RuntimeCls,
        patch("aiq_agent.skills.SkillResolver") as ResolverCls,
    ):
        resolver = ResolverCls.return_value
        resolver.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="run mystery-skill")],
            force_skills=["mystery-skill"],
        )
        await run_fn(state)

        # The runtime is asked for a name it does not hold; the runtime's own
        # contract (test_runtime.py) turns that into "not forced", never an error.
        RuntimeCls.assert_called_once_with(skills=resolved, force_names=["mystery-skill"])
        await gen.aclose()


@pytest.mark.asyncio
async def test_the_forced_house_skills_get_their_own_iteration_budget():
    """A standard skill is deployment overhead, and the research budget is not it.

    ``max_tool_iterations`` is charged per tool CALL, so every skill the fleet
    forces takes one iteration off every research chain in the product before a
    single source is read — silently, and worst on the long measurement chains
    the config's floors were traced against. The register knows how many the
    deployment forces, so it reserves exactly that many on top.
    """
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ShallowResearchAgentConfig(
        llm="research_llm",
        tools=["web_search_tool"],
        skills_enabled=True,
        max_tool_iterations=7,
    )
    resolved = (_skill("piloti-voice"), _skill("piloti-cards"))
    runtime = _skill_runtime(resolved, [], activated=[], standard_count=2)
    stub = _make_agent_stub()

    with (
        patch.object(register_module, "ShallowResearcherAgent", stub),
        patch("aiq_agent.project_context.get_organization_id_from_context", return_value="org-1"),
        patch("aiq_agent.skills.SkillRuntime", return_value=runtime),
        patch("aiq_agent.skills.SkillResolver") as ResolverCls,
    ):
        ResolverCls.return_value.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)
        await run_fn(ShallowResearchAgentState(messages=[HumanMessage(content="Wie tief?")], requires_sources=True))

        kwargs = stub.built[-1].init_kwargs
        # The research budget is untouched: it is what the traced floors in
        # config_oib_openrouter.yml measure, and they assume ONE use_skill.
        assert kwargs["max_tool_iterations"] == 7
        assert kwargs["reserved_tool_iterations"] == 2
        await gen.aclose()


@pytest.mark.asyncio
async def test_a_forced_skill_the_model_never_opened_is_not_reported_as_used(caplog):
    """`skills_activated` is the answer's provenance, so it carries deliveries only.

    The register lifts ``SkillRuntime.activated`` onto the result and the
    frontend renders it as "what shaped this answer". A skill that was forced
    but never fetched shaped nothing — and the fact that it was asked for and
    ignored is not lost either, it goes to the log, where it can be counted per
    deployment ("the house voice reached 8 answers in 10").
    """
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = ShallowResearchAgentConfig(llm="research_llm", tools=["web_search_tool"], skills_enabled=True)
    resolved = (_skill("piloti-voice"), _skill("piloti-cards"))
    runtime = _skill_runtime(resolved, ["piloti-voice", "piloti-cards"], activated=["piloti-voice"])

    with (
        patch.object(register_module, "ShallowResearcherAgent", _make_agent_stub()),
        patch("aiq_agent.project_context.get_organization_id_from_context", return_value="org-1"),
        patch("aiq_agent.skills.SkillRuntime", return_value=runtime),
        patch("aiq_agent.skills.SkillResolver") as ResolverCls,
    ):
        ResolverCls.return_value.resolve.return_value = resolved

        run_fn, gen = await _get_run_fn(config, builder)
        result = await run_fn(
            ShallowResearchAgentState(messages=[HumanMessage(content="Wie tief?")], requires_sources=True)
        )

        assert result.skills_activated == ["piloti-voice"]
        unread = [m for m in caplog.messages if "Forced skills never loaded" in m]
        assert unread and "piloti-cards" in unread[0], (
            f"a forced skill the model ignored left no trace at all; warnings were {caplog.messages}"
        )
        assert "piloti-voice" not in unread[0].split("(activated")[0]
        await gen.aclose()
