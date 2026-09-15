"""The prompt split: the same bytes, from two files and a store.

The static half moved out of `piloti.j2` into `piloti_static.md` so it could be
managed in Langfuse. The move is only safe if it changed nothing the model sees:
a stray newline at the seam is a different prefix, which costs every tenant
their provider prompt-cache hit on every turn and shows up as latency rather
than as a failure. So the first test here renders the split template and
compares it, byte for byte, with a rendering of the ONE-FILE template as it
stood at 0e89484 — the commit before the split.

Regenerating the fixture: it is a rendering of
`git show 0e89484:src/aiq_agent/agents/piloti/prompts/piloti.j2` through
`render_prompt_template` with `PINNED` below. It is committed rather than
computed so the test needs neither git nor a repository with history.
"""

from __future__ import annotations

from pathlib import Path

from aiq_agent.agents.piloti import prompt as prompt_module
from aiq_agent.agents.piloti.prompt import PROMPTS_DIR
from aiq_agent.agents.piloti.prompt import STATIC_PROMPT_FILE
from aiq_agent.agents.piloti.prompt import STATIC_PROMPT_NAME
from aiq_agent.agents.piloti.prompt import bundled_static_block
from aiq_agent.agents.piloti.prompt import render_static_block
from aiq_agent.agents.piloti.prompt import resolve_static_block
from aiq_agent.agents.piloti.prompt import system_prompt_template
from aiq_agent.common.prompt_store import PromptStore
from aiq_agent.common.prompt_store import ResolvedPrompt
from aiq_agent.common.prompt_utils import render_prompt_template

FIXTURE = Path(__file__).parent / "fixtures" / "piloti_prompt_0e89484.txt"

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
    tidying_enabled=True,
    delegating_enabled=True,
    already_read_block="<<ALREADY READ>>",
    org_instructions="<<ORG INSTRUCTIONS>>",
    focus_file_name="Einreichplan.pdf",
    focus_shelf_label="<<SHELF>>",
    norm_doctrine="<<NORM DOCTRINE>>",
    parcel_note="<<PARCEL NOTE>>",
    platform_lessons="<<PLATFORM LESSONS>>",
    project_context={"name": "Testprojekt"},
    ris_catalog="<<RIS CATALOG>>",
    skills_block="<<SKILLS>>",
)


def _render(static_text: str) -> str:
    """The two-pass render, with the pinned inputs instead of the injected ones."""
    block = render_prompt_template(static_text, **PINNED).rstrip("\n")
    return render_prompt_template(system_prompt_template(), static_block=block, **PINNED)


class TestByteIdentity:
    def test_the_split_renders_exactly_what_the_one_file_template_rendered(self):
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
    def test_resolving_records_the_version_the_traces_will_name(self, monkeypatch):
        from aiq_agent.observability import langfuse_trace_attributes as lta

        lta.reset_prompt_link()
        served = _FakeStore(ResolvedPrompt(text="MANAGED", name=STATIC_PROMPT_NAME, version="12"))
        monkeypatch.setattr(prompt_module, "prompt_store", lambda: served)

        resolve_static_block()

        assert lta.current_prompt_attributes() == {
            lta.OBSERVATION_PROMPT_NAME: STATIC_PROMPT_NAME,
            lta.OBSERVATION_PROMPT_VERSION: "12",
        }
        lta.reset_prompt_link()

    def test_a_fallback_render_is_labelled_as_the_git_file(self, monkeypatch):
        """
        A fleet running on its bundled prompt must be visible in the trace
        list rather than indistinguishable from one serving the live version —
        otherwise a Langfuse outage reads as "the new version did nothing".
        """
        from aiq_agent.observability import langfuse_trace_attributes as lta

        lta.reset_prompt_link()
        monkeypatch.setattr(prompt_module, "prompt_store", lambda: PromptStore(enabled=False))

        resolve_static_block()

        assert lta.current_prompt_attributes()[lta.OBSERVATION_PROMPT_NAME] == "git:prompts/piloti_static.md"
        lta.reset_prompt_link()


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
