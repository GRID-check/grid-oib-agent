"""The rendered prompt, pinned: two files and a store, one string.

The static half lives in `piloti_static.md` so it can be managed in Langfuse,
and `piloti.j2` holds the dynamic half. The seam between them is bytes: a stray
newline there is a different prefix, which costs every tenant their provider
prompt-cache hit on every turn and shows up as latency rather than as a
failure. So the first test renders both halves with pinned inputs and compares
the result, byte for byte, with the committed fixture.

The fixture is a GOLDEN FILE, not a claim about any past version. A deliberate
prompt edit changes it, and the diff is what review reads; an accidental one
fails a test instead of shipping. Regenerate with:

    PYTHONPATH=src .venv/bin/python -c "
    from tests.aiq_agent.agents.piloti.test_static_prompt_split import regenerate
    regenerate()"
"""

from __future__ import annotations

import asyncio
import contextvars
from pathlib import Path

import pytest

from aiq_agent.agents.piloti import prompt as prompt_module
from aiq_agent.agents.piloti.prompt import PROMPTS_DIR
from aiq_agent.agents.piloti.prompt import STATIC_PROMPT_FILE
from aiq_agent.agents.piloti.prompt import STATIC_PROMPT_NAME
from aiq_agent.agents.piloti.prompt import bundled_static_block
from aiq_agent.agents.piloti.prompt import record_static_prompt_metadata
from aiq_agent.agents.piloti.prompt import render_static_block
from aiq_agent.agents.piloti.prompt import resolve_static_block
from aiq_agent.agents.piloti.prompt import stamp_static_prompt_for_turn
from aiq_agent.agents.piloti.prompt import system_prompt_template
from aiq_agent.common.prompt_store import PromptStore
from aiq_agent.common.prompt_store import ResolvedPrompt
from aiq_agent.common.prompt_utils import render_prompt_template
from aiq_agent.observability import langfuse_trace_attributes as lta

FIXTURE = Path(__file__).parent / "fixtures" / "piloti_prompt_rendered.txt"


#: The render inputs the fixture was produced with. `answer_envelope_schema`
#: and `document_inventory` are pinned to placeholders on purpose: this test is
#: about the TEMPLATE, and injecting the real envelope schema would make it fail
#: whenever `cards/models.py` changes, which is somebody else's contract.
PINNED = dict(
    answer_envelope_schema="<<ENVELOPE SCHEMA>>",
    document_inventory="<<DOCUMENT INVENTORY>>",
    current_datetime="2026-01-02",
    tools=[{"name": "search_documents"}, {"name": "write_file"}, {"name": "move_document"}, {"name": "create_task"}],
    user_info={"name": "Test User", "email": "test@example.invalid"},
    drafting_enabled=True,
    already_read_block="<<ALREADY READ>>",
    org_instructions="<<ORG INSTRUCTIONS>>",
    focus_file_name="Einreichplan.pdf",
    focus_shelf_label="<<SHELF>>",
    oib_applicability="<<OIB APPLICABILITY>>",
    parcel_note="<<PARCEL NOTE>>",
    platform_lessons="<<PLATFORM LESSONS>>",
    project_context={"name": "Testprojekt"},
    skills_block="<<SKILLS>>",
)


def _forget_what_resolving_recorded() -> None:
    """The prompt link and the fallback identity are PROCESS state; contributions are the turn's."""
    lta.reset_prompt_link()
    lta.reset_contributions()


@pytest.fixture(autouse=True)
def _clean_trace_state():
    """Resolving writes both; neither may leak into the next test."""
    _forget_what_resolving_recorded()
    yield
    _forget_what_resolving_recorded()


def _render(static_text: str) -> str:
    """The two-pass render, with the pinned inputs instead of the injected ones."""
    block = render_prompt_template(static_text, **PINNED).rstrip("\n")
    return render_prompt_template(system_prompt_template(), static_block=block, **PINNED)


def regenerate() -> None:
    """Rewrite the golden file from the committed prompt files."""
    committed = (PROMPTS_DIR / STATIC_PROMPT_FILE).read_text(encoding="utf-8")
    FIXTURE.write_text(_render(committed), encoding="utf-8")


class TestByteIdentity:
    def test_the_two_halves_render_the_committed_prompt(self):
        committed = (PROMPTS_DIR / STATIC_PROMPT_FILE).read_text(encoding="utf-8")

        assert _render(committed) == FIXTURE.read_text(encoding="utf-8")

    def test_the_seam_carries_no_whitespace_of_its_own(self):
        """
        The KV-cache boundary marker used to eat the blank lines between the
        halves; `{{ static_block }}` plus the marker has to eat exactly the same
        ones. A test on the joint alone, so a failure says WHERE rather than
        just that 46 KB differ.
        """
        rendered = _render("STATIC HALF\n\n")

        assert "STATIC HALF## Context" in rendered

    def test_the_static_half_is_where_the_cacheable_text_lives(self):
        """
        The split is only worth anything if the static file really is static:
        one Jinja variable (the envelope schema, rendered from the models) and
        no conditionals. A `{% if %}` that drifted up here would be re-rendered
        per turn inside a block the whole design assumes is constant.
        """
        committed = (PROMPTS_DIR / STATIC_PROMPT_FILE).read_text(encoding="utf-8")

        assert "{%" not in committed
        assert committed.count("{{") == 1
        assert "{{ answer_envelope_schema }}" in committed


class TestTheRulesThePolishMustNotInvert:
    """Wordings whose meaning flips on one verb, asserted on the rendered text.

    `angenommen` closes a point. A polish pass once turned "do not propose it
    again" into "and propose something else", which reads as an instruction to
    make a further proposal on the very point the user just settled.
    """

    def test_an_accepted_proposal_reads_as_settled(self):
        rendered = FIXTURE.read_text(encoding="utf-8")

        assert "That point is settled, and a further proposal is about something else." in rendered
        assert "and propose something else" not in rendered


class TestStoreSeam:
    def test_the_bundled_file_is_the_fallback_and_names_itself(self):
        bundled = bundled_static_block()

        assert bundled.is_fallback is True
        assert bundled.name == "git:prompts/piloti_static.md"
        assert len(bundled.version) == 7
        assert bundled.text == (PROMPTS_DIR / STATIC_PROMPT_FILE).read_text(encoding="utf-8")

    def test_the_render_uses_the_stores_text_rather_than_the_file(self, monkeypatch):
        """
        The seam itself: with a version being served, the bytes above the
        boundary are Langfuse's and the bytes below are still the template's.
        """
        served = _FakeStore(ResolvedPrompt(text="MANAGED STATIC HALF", name=STATIC_PROMPT_NAME, version="12"))
        monkeypatch.setattr(prompt_module, "prompt_store", lambda: served)

        resolved = resolve_static_block()
        rendered = render_prompt_template(system_prompt_template(), static_block=resolved.text, **PINNED)

        assert served.asked == [STATIC_PROMPT_NAME]
        assert rendered.startswith("MANAGED STATIC HALF## Context")
        assert "## Available Tools" in rendered

    def test_the_fallback_handed_to_the_store_is_the_bundled_text(self, monkeypatch):
        served = _FakeStore(None)
        monkeypatch.setattr(prompt_module, "prompt_store", lambda: served)

        resolve_static_block()

        assert served.fallbacks[0].text == bundled_static_block().text

    def test_a_disabled_store_renders_the_bundled_prompt(self, monkeypatch):
        """The default path, stated as a test: no flag, no network, same bytes."""
        monkeypatch.setattr(prompt_module, "prompt_store", lambda: PromptStore(enabled=False))

        assert resolve_static_block() == bundled_static_block()

    def test_the_rendered_static_block_is_cached_per_distinct_text(self):
        """
        Rendering 33 KB of Jinja on every turn to substitute one variable is
        waste; re-rendering it when a new version arrives is not. The cache key
        is the text, so both hold without anyone remembering to invalidate.
        """
        render_static_block.cache_clear()
        first = render_static_block("A {{ answer_envelope_schema }}")
        again = render_static_block("A {{ answer_envelope_schema }}")
        other = render_static_block("B {{ answer_envelope_schema }}")

        assert first is again
        assert other != first
        assert render_static_block.cache_info().hits == 1


class TestPromptLink:
    """
    A prompt LINK names a prompt Langfuse holds, and nothing else may wear it.
    Langfuse's ingestion declares `promptVersion` an int and rejects the whole
    generation event that carries anything else, so the bundled fallback's
    `git:` name and blob hash cost every GENERATION observation in the trace
    while the rest of it arrives looking healthy. The fallback is named in the
    trace METADATA instead, where free-form values are safe.
    """

    def test_resolving_records_the_version_the_traces_will_name(self, monkeypatch):
        served = _FakeStore(ResolvedPrompt(text="MANAGED", name=STATIC_PROMPT_NAME, version="12"))
        monkeypatch.setattr(prompt_module, "prompt_store", lambda: served)

        resolve_static_block()

        assert lta.current_prompt_attributes() == {
            lta.OBSERVATION_PROMPT_NAME: STATIC_PROMPT_NAME,
            lta.OBSERVATION_PROMPT_VERSION: 12,
        }

    def test_a_fallback_render_is_no_link_and_is_named_in_the_trace_metadata(self, monkeypatch):
        """
        A fleet running on its bundled prompt must still be visible in the
        trace list rather than indistinguishable from one serving the live
        version — otherwise a Langfuse outage reads as "the new version did
        nothing". The metadata is what carries that now.
        """
        monkeypatch.setattr(prompt_module, "prompt_store", lambda: PromptStore(enabled=False))

        resolve_static_block()
        record_static_prompt_metadata()

        assert lta.current_prompt_attributes() == {}
        assert lta.snapshot_contributions()["metadata"] == {
            "prompt_name": "git:prompts/piloti_static.md",
            "prompt_version": bundled_static_block().version,
        }

    async def test_the_stamp_returns_the_bytes_the_prompt_opens_with(self, monkeypatch):
        """
        The stamp's return names the provider cache's stable prefix, so it
        must be exactly what the rendered system prompt STARTS with: the
        template's first line is `{{ static_block }}`, and a byte of drift
        between the two would key every turn on the whole prompt again.
        """
        monkeypatch.setattr(prompt_module, "prompt_store", lambda: PromptStore(enabled=False))

        static = await stamp_static_prompt_for_turn()
        rendered = render_prompt_template(system_prompt_template(), static_block=static, **PINNED)

        assert static and rendered.startswith(static)

    async def test_the_turn_stamp_names_what_this_turn_resolved(self, monkeypatch):
        """
        The identity is process state and the stamp is per turn, so the stamp
        must follow a resolution made for this turn and not the one before:
        a process that served a version and has since fallen back names the
        fallback on this turn's trace, not nothing.
        """
        served = _FakeStore(ResolvedPrompt(text="MANAGED", name=STATIC_PROMPT_NAME, version="12"))
        monkeypatch.setattr(prompt_module, "prompt_store", lambda: served)
        resolve_static_block()
        monkeypatch.setattr(prompt_module, "prompt_store", lambda: PromptStore(enabled=False))

        await stamp_static_prompt_for_turn()

        assert lta.current_prompt_attributes() == {}
        assert lta.snapshot_contributions()["metadata"]["prompt_name"] == "git:prompts/piloti_static.md"

    async def test_another_turn_s_transition_does_not_rename_this_turn_s_fallback(self, monkeypatch):
        """
        The fallback identity rides the same per-turn record as the link, so
        a served version resolved in another turn between this turn's resolve
        and its stamp neither erases this turn's fallback nor replaces it.
        """
        token = lta.begin_turn_prompt_link()
        try:
            monkeypatch.setattr(prompt_module, "prompt_store", lambda: PromptStore(enabled=False))
            await asyncio.to_thread(resolve_static_block)

            def _other_turn() -> None:
                other = lta.begin_turn_prompt_link()
                served = _FakeStore(ResolvedPrompt(text="MANAGED", name=STATIC_PROMPT_NAME, version="12"))
                monkeypatch.setattr(prompt_module, "prompt_store", lambda: served)
                resolve_static_block()
                lta.end_turn_prompt_link(other)

            contextvars.copy_context().run(_other_turn)
            record_static_prompt_metadata()

            assert lta.current_prompt_attributes() == {}
            assert lta.snapshot_contributions()["metadata"]["prompt_name"] == "git:prompts/piloti_static.md"
        finally:
            lta.end_turn_prompt_link(token)

    def test_falling_back_stops_the_process_naming_the_version_it_served(self, monkeypatch):
        """
        Langfuse goes down mid-life and the store mutes it for the TTL window.
        A link left behind from the version that was serving would name it on
        generations it never produced, which is a wrong number rather than a
        missing one.
        """
        served = _FakeStore(ResolvedPrompt(text="MANAGED", name=STATIC_PROMPT_NAME, version="12"))
        monkeypatch.setattr(prompt_module, "prompt_store", lambda: served)
        resolve_static_block()

        monkeypatch.setattr(prompt_module, "prompt_store", lambda: PromptStore(enabled=False))
        resolve_static_block()

        assert lta.current_prompt_attributes() == {}


class TestServedTextThatDoesNotRender:
    """
    The store promises never to raise into a turn, and keeps it for the FETCH.
    The text it fetched is still a template one layer up: a prompt author who
    pastes a JSON example with ``{{`` into Langfuse, or writes ``{{ project }}``
    expecting substitution, must not take every turn on every replica down for
    as long as that version is published. The bundled file is the floor here too.
    """

    def _serve(self, monkeypatch, text: str) -> None:
        served = _FakeStore(ResolvedPrompt(text=text, name=STATIC_PROMPT_NAME, version="13"))
        monkeypatch.setattr(prompt_module, "prompt_store", lambda: served)

    def test_an_undefined_variable_in_the_served_text_serves_the_bundled_file(self, monkeypatch):
        self._serve(monkeypatch, "Hallo {{ buero_name }}")

        assert resolve_static_block() == bundled_static_block()

    def test_json_braces_in_the_served_text_serve_the_bundled_file(self, monkeypatch):
        self._serve(monkeypatch, 'Beispiel: {{"a": 1}}')

        assert resolve_static_block() == bundled_static_block()

    def test_the_trace_names_the_git_file_when_the_served_text_did_not_render(self, monkeypatch):
        self._serve(monkeypatch, "Hallo {{ buero_name }}")

        resolve_static_block()
        record_static_prompt_metadata()

        assert lta.current_prompt_attributes() == {}
        assert lta.snapshot_contributions()["metadata"]["prompt_name"] == "git:prompts/piloti_static.md"

    def test_a_served_text_that_renders_is_still_served(self, monkeypatch):
        self._serve(monkeypatch, "MANAGED {{ answer_envelope_schema }}")

        resolved = resolve_static_block()

        assert resolved.is_fallback is False
        assert resolved.version == "13"


class TestTheRoundCostIsStatedAsAFact:
    """
    The budget counts rounds, and a round costs one however many calls it holds.
    Nothing but the prompt can tell the model that, and a rewrite once cut it as
    procedure: the model then opened one document per round and ran the budget
    out before the family was read.
    """

    def test_the_prompt_says_a_round_costs_one_whatever_it_holds(self):
        rendered = FIXTURE.read_text(encoding="utf-8")

        assert "a round costs one however many calls it holds" in rendered

    def test_the_family_search_is_stated_as_the_members_opened(self):
        """
        The family branch returns each member's scope passage AND its
        Gliederung, which is what `read_passage(document=…)` returns for one of
        them. Told only that an overview needs every member opened, the model
        spent the round after the family result re-opening the same three
        documents and read back what it was already holding.
        """
        rendered = FIXTURE.read_text(encoding="utf-8")

        assert "every member the corpus holds, each with that same scope passage and Gliederung" in rendered
        assert "what is left to open is a Punkt by number" in rendered
        assert "was opened, in one round" not in rendered


class _FakeStore:
    """A store that serves one answer and records what it was asked for."""

    def __init__(self, answer: ResolvedPrompt | None):
        self.answer = answer
        self.asked: list[str] = []
        self.fallbacks: list[ResolvedPrompt] = []

    def get(self, name: str, *, fallback: ResolvedPrompt) -> ResolvedPrompt:
        self.asked.append(name)
        self.fallbacks.append(fallback)
        return self.answer or fallback
