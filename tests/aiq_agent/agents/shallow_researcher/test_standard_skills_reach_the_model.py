"""The house skills, end to end: seed row → resolver → runtime → the model's input.

Piloti's writing voice and its card judgement are not features the model may
opt into. They are ``delivery: 'standard'`` rows (migrations 0053–0058), and
everything that makes them apply is a chain of five separate mechanisms, each
one covered in isolation and none of them covered together:

1. ``delivery: 'standard'`` makes ``Skill.standard`` true, which makes
   :class:`SkillRuntime` FORCE the skill — a property of the row, not a name
   list in the code, so a platform owner publishes one and it takes effect.
2. Both rows are ``grid-hidden``, so the activation is routed to the technical
   channel instead of the running line — routed, never dropped.
3. The runtime is only built when ``state.requires_sources or
   state.force_skills``, so a greeting pays none of the ~22,000 characters of
   skill prose.
4. ``force_skills`` alone is enough, even against a ``meta`` classification.
5. A skill declaring ``grid-cards`` gets those card SHAPES inlined with its
   body; one declaring none gets its bare body.

Every link has unit coverage somewhere. The chain does not, and it is the kind
of thing a refactor breaks in silence: the answer is still produced, just
without its voice, and nothing fails. So these run the REAL register wiring,
the REAL runtime and the REAL seeded rows against a scripted LLM, and assert on
the text that actually reached the model.

Only the resolver's HTTP call and the LLM are faked. No database, no network.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from aiq_agent.agents.shallow_researcher.models import ShallowResearchAgentState
from aiq_agent.agents.shallow_researcher.register import ShallowResearchAgentConfig
from aiq_agent.agents.shallow_researcher.register import shallow_research_agent
from aiq_agent.common import cache as shared_cache
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.skills.resolver import SkillResolver
from nat.builder.context import ContextState
from tests.aiq_agent.skills.seeded_skill_rows import effective_row

VOICE = "piloti-voice"
CARDS = "piloti-cards"

#: One sentence from each seeded body, chosen because it could not appear in a
#: prompt, a tool description or a model answer by accident. Their presence is
#: the only proof the BODY arrived rather than the one-line catalog entry, and
#: their absence is the token-budget guarantee on a conversational turn.
VOICE_PHRASE = "Ein Vorbehalt, der der Antwort vorausgeht, ist eine Absicherung gegen die eigene Aussage."
CARDS_PHRASE = "die Karte trägt den WERT, die Prosa trägt den SATZ."


@tool
def knowledge_search(query: str) -> str:
    """Search the knowledge base."""
    return "ein Treffer"


class _FakeBuilder:
    """The NAT builder seam: hands the register its tools and its LLM."""

    def __init__(self, llm) -> None:
        self._llm = llm

    async def get_tools(self, tool_names, wrapper_type):
        by_name = {"knowledge_search": knowledge_search}
        return [by_name[name] for name in tool_names if name in by_name]

    async def get_llm(self, ref, wrapper_type):
        return self._llm


def _scripted_llm(*responses):
    """An LLM that replies with ``responses`` in order and records every call.

    ``bind_tools`` returns the same object, so ``ainvoke.call_args_list`` holds
    the messages from every binding the run used and ``bind_tools.call_args_list``
    holds the tool sets it was given.
    """
    llm = MagicMock()
    llm.bind_tools = MagicMock(return_value=llm)
    llm.ainvoke = AsyncMock(side_effect=list(responses))
    return llm


def _loads_both_house_skills():
    """The model's first turn: obey the forced block and open both skills."""
    return AIMessage(
        content="",
        tool_calls=[
            {"name": "use_skill", "args": {"skill_name": VOICE}, "id": "call-voice"},
            {"name": "use_skill", "args": {"skill_name": CARDS}, "id": "call-cards"},
        ],
    )


def _answer():
    return AIMessage(content="1,10 m [1].\n\n## References\n[1] https://example.com")


@pytest.fixture
def bypass_citation_pipeline():
    """The chain under test is skills, not sourcing.

    The scripted answer cites nothing real, and an empty source registry would
    otherwise make ``run()`` raise ``EmptySourceRegistryError`` — which the
    register converts into a canned "nothing usable" reply, hiding whatever the
    skills wiring actually did. Same bypass ``test_agent.py`` uses.
    """
    with (
        patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
        patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as verify,
        patch("aiq_agent.agents.shallow_researcher.agent.sanitize_report") as sanitize,
    ):
        verify.side_effect = lambda content, reg, reference_sources=None: MagicMock(
            verified_report=content, removed_citations=[]
        )
        sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
        yield


def _served_row(name: str) -> dict[str, object]:
    """One seeded skill in the shape the BFF's ``/skills/resolve`` serves it.

    ``standard`` is the flag the BFF sets from the row's ``delivery`` column —
    the only thing that carries "this is fleet policy" across the process
    boundary. Deriving it here from the SQL rather than hardcoding ``True``
    keeps the seed at the head of the chain: a seed flipped to ``offer``
    produces a payload the backend must not force.
    """
    row = effective_row(name)
    return {
        "name": row["name"],
        "description": row["description"],
        "body": row["body"],
        "metadata": json.loads(row["metadata"]),
        "standard": row["delivery"] == "standard",
    }


@pytest.fixture(autouse=True)
def _reset_skill_cache():
    """The resolved set is cached per org in the shared store; isolate the tests."""
    shared_cache.reset_local_store()
    yield
    shared_cache.reset_local_store()


async def _run_turn(llm, state):
    """Drive the register's per-run function against the real skill resolver.

    Only two things are faked, and both are outside the chain: the LLM, and the
    resolver's HTTP call to the BFF — which is replaced with the rows the BFF
    would serve for the seeded ``platform_skills``. Everything between them is
    the real code: payload validation, the ``standard`` flag, the allowlist, the
    runtime and its forcing, ``use_skill``, the prompt render and the tool
    binding.

    Faking ``SkillResolver`` wholesale (as ``test_register_skills.py`` does, and
    rightly — it is testing the register's call, not the resolver's answer)
    would skip the row→``Skill.standard`` step, and that step is exactly where
    ``delivery: 'standard'`` stops being a word in a migration and starts being
    fleet policy.
    """
    builder = _FakeBuilder(llm)
    config = ShallowResearchAgentConfig(
        llm="research_llm",
        tools=["knowledge_search"],
        skills_enabled=True,
    )
    rows = [_served_row(VOICE), _served_row(CARDS)]

    with (
        patch("aiq_agent.project_context.get_organization_id_from_context", return_value="org-1"),
        patch.object(SkillResolver, "_fetch_org_skills", return_value=rows) as fetch,
    ):
        gen = shallow_research_agent.__wrapped__(config, builder)
        run_fn = (await gen.__anext__()).single_fn
        try:
            result = await run_fn(state)
        finally:
            await gen.aclose()
    return result, fetch


def _flat(text: str) -> str:
    """``text`` with its hard wraps flattened to single spaces.

    The seeded bodies are wrapped at roughly 80 columns, so quoting a whole
    sentence would otherwise also be asserting where the seed happens to break
    the line — and a reflow that changes nothing a reader sees would fail as if
    the voice had been dropped.
    """
    return " ".join(text.split())


def _system_prompt(llm) -> str:
    return _flat(str(llm.ainvoke.call_args_list[0][0][0][0].content))


def _everything_the_model_was_given(llm) -> str:
    """Every message content from every LLM call of the run, concatenated."""
    return _flat("\n".join(str(message.content) for call in llm.ainvoke.call_args_list for message in call[0][0]))


def _tool_results(llm) -> dict[str, str]:
    """``tool_call_id`` → content, for every ToolMessage the model was handed."""
    return {
        message.tool_call_id: str(message.content)
        for call in llm.ainvoke.call_args_list
        for message in call[0][0]
        if isinstance(message, ToolMessage)
    }


def _bound_tool_names(llm) -> set[str]:
    return {
        getattr(bound, "name", str(bound))
        for call in llm.bind_tools.call_args_list
        for bound in (call.args[0] if call.args else [])
    }


class TestAResearchTurn:
    """The turn the house skills exist for."""

    @pytest.mark.asyncio
    async def test_both_standard_skills_are_forced_and_their_prose_reaches_the_model(self, bypass_citation_pipeline):
        """If this fails, every research answer is written without Piloti's voice.

        The failure is silent by construction: the model still answers, the
        catalog still lists both skills, and only the WORDING of every answer in
        the product changes. Nothing between the ``delivery`` column and this
        assertion would notice — which is why the assertion is on the seeded
        sentences themselves rather than on a name in a list.
        """
        llm = _scripted_llm(_loads_both_house_skills(), _answer())
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Wie hoch muss das Geländer bei 12 m Absturzhöhe sein?")],
            requires_sources=True,
        )

        result, fetch = await _run_turn(llm, state)

        fetch.assert_called_once_with("org-1")
        # Forced without anyone asking: `force_skills` is empty on this turn, so
        # the ONLY thing that put these two in the forced block is their
        # `delivery: 'standard'` column.
        assert state.force_skills is None
        assert result.skills_activated == [VOICE, CARDS]

        prompt = _system_prompt(llm)
        assert "## Active skills (required for this turn)" in prompt
        assert f"- `{VOICE}`" in prompt
        assert f"- `{CARDS}`" in prompt
        # Progressive disclosure still holds: the prompt names them, it does not
        # carry them. A body in the L1 catalog would be the ~22,000 characters
        # paid on every turn that this design exists to avoid.
        assert VOICE_PHRASE not in prompt
        assert CARDS_PHRASE not in prompt

        # …and once the model opens them, the bodies are in its input.
        given = _everything_the_model_was_given(llm)
        assert VOICE_PHRASE in given
        assert CARDS_PHRASE in given

    @pytest.mark.asyncio
    async def test_the_use_skill_tool_is_the_only_way_the_bodies_travel(self, bypass_citation_pipeline):
        """A model that never calls ``use_skill`` must still not be given the bodies.

        The forced block is an instruction, not a delivery mechanism. If a
        refactor ever inlined forced bodies into the prompt "to be safe", the
        always-on cost this whole design avoids would come back and no other
        test would catch it.

        And because that is the deliberate design, the DISCLOSURE has to agree
        with it: the same turn must report that neither house skill shaped the
        answer, because neither one did.
        """
        llm = _scripted_llm(_answer())
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Wie hoch muss das Geländer sein?")],
            requires_sources=True,
        )

        result, _ = await _run_turn(llm, state)

        assert "use_skill" in _bound_tool_names(llm)
        given = _everything_the_model_was_given(llm)
        assert VOICE_PHRASE not in given
        assert CARDS_PHRASE not in given
        # The reader is told nothing shaped this answer, because nothing did.
        # `skills_activated` is what the "Skills used" panel renders as the
        # record of the answer's provenance; naming a skill whose instructions
        # never reached the model is a false statement about the answer in a
        # product sold on traceability.
        assert result.skills_activated == []


class TestAConversationalTurn:
    """The token-budget guarantee — the link with the most to lose and the least
    to show for it, because what it buys is an absence."""

    @pytest.mark.asyncio
    async def test_a_greeting_pays_for_no_skill_prose_at_all(self, bypass_citation_pipeline):
        """If this fails, every "hallo" carries both house skills' full instructions.

        Nothing breaks — the greeting is still answered — so the only symptom is
        the bill. The resolver is not consulted, no runtime is built, no
        ``use_skill`` tool is offered, and no sentence of either body is in
        front of the model.
        """
        bodies = len(effective_row(VOICE)["body"]) + len(effective_row(CARDS)["body"])
        assert bodies > 10_000, "the two house bodies are what this turn is avoiding"

        llm = _scripted_llm(AIMessage(content="Hallo! Womit kann ich helfen?"))
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="hallo")],
            requires_sources=False,
        )

        result, fetch = await _run_turn(llm, state)

        fetch.assert_not_called()
        assert state.skills_block is None
        assert result.skills_activated is None
        assert "use_skill" not in _bound_tool_names(llm)

        given = _everything_the_model_was_given(llm)
        assert VOICE_PHRASE not in given
        assert CARDS_PHRASE not in given
        assert "## Available skills" not in given
        assert "## Active skills (required for this turn)" not in given

    @pytest.mark.asyncio
    async def test_an_explicit_slash_invocation_survives_a_meta_classification(self, bypass_citation_pipeline):
        """If this fails, ``/piloti-voice`` is a silent no-op — again.

        ``force_skills`` is only ever populated by a ``/name`` in the composer.
        The intent classifier decides whether an UNPROMPTED turn needs sources;
        it does not get to overrule a direct instruction, and gating on
        ``requires_sources`` alone once made ``/name`` do nothing on exactly the
        short, imperative messages people type after a slash command.

        Two things have to hold for it to work, and only the first is obvious.
        The register must build the runtime — and the agent's meta partition,
        which strips the search tools from a conversational turn, must leave
        ``use_skill`` bound. It does, because ``use_skill`` resolves to no data
        source; adding it to the search classification would restore the no-op
        with the register looking entirely correct.
        """
        llm = _scripted_llm(
            AIMessage(
                content="",
                tool_calls=[{"name": "use_skill", "args": {"skill_name": VOICE}, "id": "call-voice"}],
            ),
            AIMessage(content="Kurz und ohne Vorrede."),
        )
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="und jetzt?")],
            requires_sources=False,
            force_skills=[VOICE],
        )

        result, fetch = await _run_turn(llm, state)

        fetch.assert_called_once_with("org-1")
        assert result.skills_activated[0] == VOICE
        assert "use_skill" in _bound_tool_names(llm)
        assert VOICE_PHRASE in _everything_the_model_was_given(llm)


class TestPreferredCards:
    """``grid-cards`` is what saves the activated turn a ``describe_card``
    round-trip, and it is paid for only by the skill that declares it."""

    @pytest.mark.asyncio
    async def test_only_the_card_declaring_skill_puts_shapes_in_front_of_the_model(self, bypass_citation_pipeline):
        """If this fails, the card judgement arrives without the cards it judges.

        ``piloti-cards`` names five shapes; the model is expected to call
        ``emit_card`` with one of them directly, without asking what it looks
        like. ``piloti-voice`` names none and must get its bare body — a
        preference block appended to every skill would put the 4,000-character
        shape catalog on every activation.
        """
        seeded = json.loads(effective_row(CARDS)["metadata"])["grid-cards"].split(",")

        llm = _scripted_llm(_loads_both_house_skills(), _answer())
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Welche Gebäudeklasse gilt hier?")],
            requires_sources=True,
        )

        await _run_turn(llm, state)

        results = _tool_results(llm)
        cards_body = results["call-cards"]
        voice_body = results["call-voice"]

        assert "## Preferred cards" in cards_body
        for card_type in seeded:
            assert f'"{card_type.strip()}"' in cards_body, f"{card_type} shape was not inlined"
        # A named card type is a preference the answer may decline, never a
        # requirement — an author naming five cards must not be able to force one
        # onto an answer that has nothing to put in it.
        assert "not a requirement" in cards_body

        assert "## Preferred cards" not in voice_body
        assert _flat(voice_body) == _flat(effective_row(VOICE)["body"])


class TestHiddenIsRoutedNeverDropped:
    """``grid-hidden`` moves an activation off the running line. It must not
    move it out of the product: the reasoning view still names every skill that
    shaped the answer, which is the activation-transparency doctrine."""

    @staticmethod
    def _skill_events(context_state) -> list[dict]:
        seen: list[dict] = []

        def _on_next(step) -> None:
            payload = step.payload
            if not str(payload.event_type).endswith("START"):
                return
            body = getattr(payload.data, "input", None)
            if not isinstance(body, str):
                return
            try:
                parsed = json.loads(body)
            except ValueError:
                return
            if isinstance(parsed, dict) and parsed.get("kind") == "skill":
                seen.append({"step": payload.name, **parsed})

        context_state.event_stream.get().subscribe(_on_next)
        return seen

    @pytest.fixture
    def context_state(self):
        """The process-wide NAT ContextState, with a clean span stack per test."""
        from nat.utils.reactive.subject import Subject

        state = ContextState.get()
        state.active_span_id_stack.set(["root"])
        state._event_stream.set(Subject())
        yield state
        state.active_span_id_stack.set(["root"])
        state._event_stream.set(Subject())

    @pytest.mark.asyncio
    async def test_a_hidden_house_skill_still_announces_itself(self, bypass_citation_pipeline, context_state):
        """If this fails, the product applies a skill to every answer and never says so.

        Hidden means the live one-liner is withheld, because a house voice on
        every turn is noise there. It does NOT mean the event stops: the step is
        still pushed, still carries the skill's name and title, and still lands
        on the technical channel the reasoning view reads. A "hidden" that
        dropped the event would make an always-on instruction invisible to the
        reader — which is the one thing this feature is not allowed to be.
        """
        events = self._skill_events(context_state)
        llm = _scripted_llm(_loads_both_house_skills(), _answer())
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Wie hoch muss das Geländer sein?")],
            requires_sources=True,
        )

        result, _ = await _run_turn(llm, state)

        activations = [event for event in events if event["phase"] == "activated"]
        assert [event["name"] for event in activations] == [VOICE, CARDS]
        # One step per skill: sharing a name would collapse them into one.
        assert [event["step"] for event in activations] == [f"skill:{VOICE}", f"skill:{CARDS}"]
        for event in activations:
            assert event["channel"] == "technical"
            # No `key` is what keeps it off the live line — the same withholding
            # a titleless skill gets, and the only thing hidden changes.
            assert "key" not in event
            assert event["forced"] is True
            # Named, so the disclosure and the reasoning view have something
            # true to render. These two rows carry no `grid-title`, which is
            # the ladder's second rung (`skill-activity.ts`): the id in mono,
            # never a title synthesised from it.
            assert event["name"] in (VOICE, CARDS)

        # And the terminal frame reports them as the hidden subset, so the
        # frontend can de-emphasise without needing the metadata itself.
        assert result.skills_hidden == [VOICE, CARDS]
