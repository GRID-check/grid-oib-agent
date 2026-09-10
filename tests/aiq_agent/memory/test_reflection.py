"""Tests for the async post-answer memory-reflection stage."""

import asyncio
import dataclasses
import threading

import pytest

from aiq_agent.common import AgentGroup
from aiq_agent.knowledge.project_memory import VALID_CONFIDENCES
from aiq_agent.knowledge.project_memory import VALID_KINDS
from aiq_agent.memory import reflection as R
from aiq_agent.stages import TurnFacts
from aiq_agent.stages import registry as stage_registry
from aiq_agent.stages import schedule_post_answer_stages
from aiq_agent.stages.memory_reflection import MEMORY_REFLECTION


class _FakeResponse:
    def __init__(self, content: str) -> None:
        self.content = content


class _FakeLLM:
    """Minimal stand-in for a LangChain chat model: records the prompt, returns canned text."""

    def __init__(self, content: str) -> None:
        self._content = content
        self.calls: list = []
        self.bind_kwargs: dict | None = None

    def bind(self, **kwargs):
        # Mirror a LangChain chat model: binding response_format returns a
        # runnable that still resolves to the canned content on ainvoke.
        self.bind_kwargs = kwargs
        return self

    async def ainvoke(self, messages):
        self.calls.append(messages)
        return _FakeResponse(self._content)


class _ProviderError(Exception):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class _NestedStatus:
    """An SDK error that carries its status on ``response``, not on itself."""

    def __init__(self, status_code: int) -> None:
        self.response = type("_Response", (), {"status_code": status_code})()


class _RejectingLLM:
    """A model whose provider refuses the bound ``response_format`` with a 400."""

    def __init__(self, content: str, *, status_code: int = 400, nested: bool = False) -> None:
        self._content = content
        self._status_code = status_code
        self._nested = nested
        self.bound_calls = 0
        self.plain_calls = 0

    def bind(self, **kwargs):
        outer = self

        class _Bound:
            async def ainvoke(self, messages):
                outer.bound_calls += 1
                if outer._nested:
                    error = _ProviderError("response_format is not supported", 0)
                    error.status_code = None
                    error.response = _NestedStatus(outer._status_code).response
                    raise error
                raise _ProviderError("response_format is not supported", outer._status_code)

        return _Bound()

    async def ainvoke(self, messages):
        self.plain_calls += 1
        return _FakeResponse(self._content)


def _sanitize(raw, **kwargs):
    kwargs.setdefault("has_project", True)
    return R._sanitize_findings(raw, **kwargs)


class TestBuildUserPrompt:
    """The reflection prompt must cap the (growing) memory digest, like it already
    caps the query and answer, so the background LLM call's token cost stays
    bounded as project memory accumulates."""

    def test_large_digest_is_truncated(self):
        # Filler digit absent from the prompt template, so counting it isolates
        # exactly the digest's contribution.
        digest = "9" * (R._MAX_DIGEST_CHARS + 5000)
        prompt = R._build_user_prompt("q", "a", digest)
        assert "… (project memory truncated)" in prompt
        assert prompt.count("9") == R._MAX_DIGEST_CHARS

    def test_small_digest_passes_through_untruncated(self):
        prompt = R._build_user_prompt("q", "a", "short memory")
        assert "short memory" in prompt
        assert "truncated" not in prompt

    def test_no_digest_uses_placeholder(self):
        prompt = R._build_user_prompt("q", "a", None)
        assert "(no project memory recorded yet)" in prompt


class TestFindingVocabulary:
    """The wire schema spells its enums out; the client owns the same vocabulary.
    Nothing checks the two against each other at import, so a rename on either
    side would just start dropping findings — pin them."""

    def test_kinds_match_the_write_clients_vocabulary(self):
        assert set(R._ReflectionFinding.model_fields["kind"].annotation.__args__) == VALID_KINDS

    def test_confidences_match_the_write_clients_vocabulary(self):
        assert set(R._ReflectionFinding.model_fields["confidence"].annotation.__args__) == VALID_CONFIDENCES


class TestSanitizeFindings:
    def test_drops_invalid_kind_and_empty_content(self):
        raw = [
            {"kind": "bogus", "content": "x"},
            {"kind": "decision", "content": ""},
            {"kind": "constraint", "content": "Facade must be brick."},
        ]
        items = _sanitize(raw)
        assert len(items) == 1
        assert items[0].kind == "constraint"
        assert items[0].confidence == "medium"  # defaulted

    def test_folds_case_and_whitespace_in_the_enums(self):
        """A reply that came back without native structured output writes what it
        pleases; ``"Decision"`` is the same value, not a different one."""
        raw = [{"kind": " Decision ", "content": "Flat roof chosen.", "confidence": "HIGH"}]
        items = _sanitize(raw)
        assert (items[0].kind, items[0].confidence) == ("decision", "high")

    def test_an_out_of_vocabulary_confidence_defaults_to_medium(self):
        raw = [{"kind": "decision", "content": "Flat roof chosen.", "confidence": "very sure"}]
        assert _sanitize(raw)[0].confidence == "medium"

    def test_a_model_proposed_scope_is_ignored(self):
        # The autonomous stage NEVER writes org-wide memory (audit finding S1),
        # so it carries no scope at all — an extra key the model invents is not
        # a reason to drop an otherwise good finding either.
        raw = [{"kind": "preference", "content": "Client prefers metric drawings.", "scope": "organization"}]
        items = _sanitize(raw)
        assert len(items) == 1
        assert not hasattr(items[0], "scope")

    def test_dropped_when_no_project_in_scope(self):
        raw = [{"kind": "decision", "content": "Anything."}]
        assert _sanitize(raw, has_project=False) == []

    def test_content_is_truncated_to_the_cap(self):
        raw = [{"kind": "decision", "content": "x" * (R._MAX_CONTENT_CHARS + 100)}]
        assert len(_sanitize(raw)[0].content) == R._MAX_CONTENT_CHARS

    def test_drops_content_already_in_digest(self):
        digest = 'PROJECT_MEMORY v1\n- [decision | high | agent] "Client chose a flat roof"'
        raw = [
            {"kind": "decision", "content": "Client chose a flat roof."},  # already present
            {"kind": "constraint", "content": "Budget capped at 2M."},  # new
        ]
        items = _sanitize(raw, memory_digest=digest)
        assert [i.content for i in items] == ["Budget capped at 2M."]

    def test_keeps_a_correction_that_contradicts_a_digest_entry(self):
        """A correction is NOT a restatement. The digest guard drops findings already
        present in memory; a finding that negates one must still get through, or
        memory can never be updated once a project fact changes."""
        digest = (
            "PROJECT_MEMORY v1\n"
            '- [derived_fact | high | unverified] "Für Bergsteiggasse ist OIB-RL 2.1 nicht '
            'anwendbar (betriebsanlage=false)"'
        )
        raw = [
            {
                "kind": "derived_fact",
                "content": "Für Bergsteiggasse ist OIB-RL 2.1 anwendbar (betriebsanlage=true).",
                "confidence": "high",
            }
        ]

        items = _sanitize(raw, memory_digest=digest)

        assert [i.content for i in items] == ["Für Bergsteiggasse ist OIB-RL 2.1 anwendbar (betriebsanlage=true)."]

    def test_passes_through_a_supersedes_quote_present_in_the_digest(self):
        """The correction has to RETIRE what it corrects, or the stale entry stays
        live next to it and a later turn may read either one."""
        digest = (
            "PROJECT_MEMORY v1\n"
            '- [derived_fact | high | unverified] "OIB-RL 2.1 ist für dieses Projekt nicht anwendbar"'
        )
        raw = [
            {
                "kind": "derived_fact",
                "content": "OIB-RL 2.1 ist für dieses Projekt anwendbar (betriebsanlage=true).",
                "confidence": "high",
                "supersedes": "OIB-RL 2.1 ist für dieses Projekt nicht anwendbar",
            }
        ]

        items = _sanitize(raw, memory_digest=digest)

        assert items[0].supersedes == "OIB-RL 2.1 ist für dieses Projekt nicht anwendbar"

    def test_drops_a_supersedes_quote_that_is_not_in_the_digest(self):
        """A supersede quote retires a real row, so a hallucinated or paraphrased
        one must not reach the resolver — the finding is still recorded, it just
        doesn't get to archive anything."""
        digest = 'PROJECT_MEMORY v1\n- [decision | high | unverified] "Client chose a flat roof"'
        raw = [
            {
                "kind": "constraint",
                "content": "Budget capped at 2M.",
                "confidence": "medium",
                "supersedes": "An entry that was never in this project's memory",
            }
        ]

        items = _sanitize(raw, memory_digest=digest)

        assert [i.content for i in items] == ["Budget capped at 2M."]
        assert items[0].supersedes == ""

    def test_drops_a_truncated_supersedes_quote(self):
        """A quote must name one COMPLETE digest entry. A partial quote passes a
        substring check but the frontend's ≥0.7 Jaccard resolver would still
        resolve it — retiring an entry the model never actually quoted."""
        digest = 'PROJECT_MEMORY v1\n- [decision | high | unverified] "Client chose a flat roof"'
        raw = [
            {
                "kind": "decision",
                "content": "Client switched to a pitched roof.",
                "confidence": "high",
                "supersedes": "Client chose a flat",
            }
        ]

        items = _sanitize(raw, memory_digest=digest)

        assert [i.content for i in items] == ["Client switched to a pitched roof."]
        assert items[0].supersedes == ""

    def test_accepts_a_quote_that_only_differs_in_punctuation_and_case(self):
        """Verbatim is checked on the normalized entry, so re-wrapping or a lost
        quote character does not cost the model a legitimate correction."""
        digest = 'PROJECT_MEMORY v1\n- [decision | high | unverified] "Client chose a flat roof"'
        raw = [
            {
                "kind": "decision",
                "content": "Client switched to a pitched roof.",
                "confidence": "high",
                "supersedes": "client chose a FLAT roof.",
            }
        ]

        items = _sanitize(raw, memory_digest=digest)

        assert items[0].supersedes == "client chose a FLAT roof."

    def test_no_supersedes_when_the_finding_replaces_nothing(self):
        raw = [{"kind": "constraint", "content": "Budget capped at 2M.", "supersedes": ""}]

        items = _sanitize(raw, memory_digest="(none)")

        assert items[0].supersedes == ""

    def test_caps_at_max_items(self):
        raw = [{"kind": "derived_fact", "content": f"Fact {i}."} for i in range(20)]
        assert len(_sanitize(raw)) == R.MAX_NEW_ITEMS

    def test_the_cap_counts_what_survived_the_filters(self):
        """A dropped finding must not cost a real one its slot: the cap used to be
        applied to the raw list, so five PII entries in front of a good one meant
        the good one was never even looked at."""
        raw = [{"kind": "derived_fact", "content": f"Reach owner{i}@example.com."} for i in range(R.MAX_NEW_ITEMS)]
        raw.append({"kind": "constraint", "content": "Budget capped at 2M."})

        items = _sanitize(raw)

        assert [i.content for i in items] == ["Budget capped at 2M."]

    def test_non_list_returns_empty(self):
        assert _sanitize({"findings": []}) == []

    def test_entries_that_are_not_objects_are_dropped(self):
        assert _sanitize(["Client chose a flat roof.", None, 7]) == []


class TestImportance:
    """Importance is elicited from the same structured call and stored as salience."""

    def test_is_carried_through_as_an_integer(self):
        raw = [{"kind": "decision", "content": "Flat roof chosen.", "importance": 9}]
        assert _sanitize(raw)[0].importance == 9

    def test_defaults_to_the_neutral_midpoint_when_absent(self):
        # The fallback path never shows the model the field, so a missing rating
        # must leave the finding neutral rather than drop it.
        raw = [{"kind": "decision", "content": "Flat roof chosen."}]
        assert _sanitize(raw)[0].importance == R._NEUTRAL_IMPORTANCE

    @pytest.mark.parametrize("value", [0, -3, 99, "not a number", None])
    def test_an_unusable_rating_never_drops_the_finding(self, value):
        raw = [{"kind": "decision", "content": "Flat roof chosen.", "importance": value}]
        items = _sanitize(raw)
        assert len(items) == 1
        assert 1 <= items[0].importance <= 10

    @pytest.mark.asyncio
    async def test_reaches_the_write_as_a_salience_in_zero_to_one(self, monkeypatch):
        recorded = []
        monkeypatch.setattr(R, "insert_memory_item", lambda **k: recorded.append(k) or "id-1")
        llm = _FakeLLM('{"findings": [{"kind": "decision", "content": "Flat roof.", "importance": 8}]}')

        await R.run_memory_reflection(
            llm=llm,
            query="q",
            answer="a",
            project_id="proj-1",
            organization_id=None,
            conversation_id="c",
            memory_digest=None,
        )

        assert recorded[0]["salience"] == 0.8


class TestReflectionSystemPrompt:
    """The stage sees existing memory and is told not to restate it. That rule alone
    reads as "this topic is covered, skip it" when the turn actually OVERTURNS an
    entry — so corrections have to be called out explicitly."""

    def test_separates_restatements_from_corrections(self):
        assert "RESTATEMENTS, not CORRECTIONS" in R.REFLECTION_SYSTEM_PROMPT

    def test_instructs_to_record_corrections(self):
        prompt = R.REFLECTION_SYSTEM_PROMPT
        assert "CORRECTIONS ARE THE MOST VALUABLE THING YOU RECORD" in prompt
        assert "no longer holds" in prompt
        assert "Never skip a correction because its topic already appears in memory" in prompt

    def test_instructs_to_retire_the_entry_it_corrects(self):
        prompt = R.REFLECTION_SYSTEM_PROMPT
        assert "RETIRE WHAT YOU CORRECT" in prompt
        assert "VERBATIM into `supersedes`" in prompt
        # Bounded on purpose: `supersedes` archives a row, so "related" is not enough.
        assert "must leave `supersedes` as an empty string" in prompt

    def test_every_required_field_is_named_in_the_example(self):
        """The example is the whole contract on the fallback path, where nothing
        enforces the schema. ``importance`` used to be missing from it, so every
        finding on that path landed at the neutral midpoint."""
        required = R.ReflectionOutput.model_json_schema()["$defs"]["_ReflectionFinding"]["required"]
        example = R.REFLECTION_SYSTEM_PROMPT[R.REFLECTION_SYSTEM_PROMPT.index('{"findings"') :]
        for field in required:
            assert f'"{field}"' in example

    def test_supersedes_is_part_of_the_structured_output_contract(self):
        """Strict json_schema output requires every field to be declared, or the
        model has no sanctioned way to return a correction target."""
        assert "supersedes" in R._ReflectionFinding.model_fields
        assert "supersedes" in R.ReflectionOutput.model_json_schema()["$defs"]["_ReflectionFinding"]["required"]


class TestSanitizeFindingsPii:
    """Audit finding S4: reflection must not persist PII/secret-shaped content."""

    @pytest.mark.parametrize(
        "content",
        [
            "Contact the client at jane.doe@example.com about the facade.",
            "Client's phone number is +43 664 1234567.",
            "Project account IBAN is AT611904300234573201.",
            "Client SSN on file is 123-45-6789.",
            "The API key for the shared drive is sk_live_abcdef.",
            "Vom Kunden genannte Sozialversicherungsnummer: 1234 010180.",
        ],
    )
    def test_drops_pii_shaped_content(self, content):
        raw = [{"kind": "derived_fact", "content": content}]
        assert _sanitize(raw) == []

    def test_keeps_findings_without_pii(self):
        raw = [{"kind": "constraint", "content": "Facade must use brick cladding per client decision."}]
        assert len(_sanitize(raw)) == 1

    def test_mixed_batch_drops_only_pii_entry(self):
        raw = [
            {"kind": "constraint", "content": "Budget capped at 2M."},
            {"kind": "derived_fact", "content": "Reach the owner at owner@example.com for approvals."},
        ]
        items = _sanitize(raw)
        assert [i.content for i in items] == ["Budget capped at 2M."]


class TestContentInDigest:
    def test_matches_ignoring_case_and_punctuation(self):
        assert R._content_in_digest("Client chose a flat roof.", R._normalize('... "client chose a flat roof" ...'))

    def test_absent_returns_false(self):
        assert not R._content_in_digest("Budget capped at 2M.", R._normalize('"Client chose a flat roof"'))

    def test_no_digest_returns_false(self):
        assert not R._content_in_digest("anything", "")


class TestRunMemoryReflection:
    @pytest.mark.asyncio
    async def test_records_new_findings(self, monkeypatch):
        recorded = []

        def fake_insert(**kwargs):
            recorded.append(kwargs)
            return f"id-{len(recorded)}"

        monkeypatch.setattr(R, "insert_memory_item", fake_insert)
        llm = _FakeLLM(
            '{"findings": [{"kind": "decision", "content": "Client chose a flat roof.", '
            '"confidence": "high", "scope": "project"}]}'
        )

        ids = await R.run_memory_reflection(
            llm=llm,
            query="Should we do a flat or pitched roof?",
            answer="You decided on a flat roof for the top storey.",
            project_id="proj-1",
            organization_id="org-1",
            conversation_id="conv-1",
            memory_digest="(none)",
        )

        # What it wrote, not merely how much: the id, the kind and the words —
        # the post-answer stage puts these on the wire, and the chip renders them.
        assert ids == [{"id": "id-1", "kind": "decision", "content": "Client chose a flat roof."}]
        assert recorded[0]["scope"] == "project"
        assert recorded[0]["project_id"] == "proj-1"
        assert recorded[0]["kind"] == "decision"
        # Reflection writes are tagged 'distillation' so the UI can tell them
        # apart from a deliberate in-turn `remember` ('agent') call.
        assert recorded[0]["provenance_type"] == "distillation"
        # The existing memory digest and the answer both reach the prompt.
        assert llm.calls, "LLM should have been invoked"

    @pytest.mark.asyncio
    async def test_records_a_correction_with_its_supersede_target(self, monkeypatch):
        """End to end: a turn that overturns an existing entry writes the corrected
        finding AND tells the frontend which entry it replaces."""
        recorded = []

        def fake_insert(**kwargs):
            recorded.append(kwargs)
            return "id-1"

        monkeypatch.setattr(R, "insert_memory_item", fake_insert)
        digest = 'PROJECT_MEMORY v1\n- [derived_fact | high | unverified] "OIB-RL 2.1 ist nicht anwendbar"'
        llm = _FakeLLM(
            '{"findings": [{"kind": "derived_fact", "content": "OIB-RL 2.1 ist anwendbar '
            '(betriebsanlage=true).", "confidence": "high", '
            '"supersedes": "OIB-RL 2.1 ist nicht anwendbar"}]}'
        )

        ids = await R.run_memory_reflection(
            llm=llm,
            query="Doch, es ist eine Betriebsanlage.",
            answer="Dann ist OIB-RL 2.1 sehr wohl anwendbar.",
            project_id="proj-1",
            organization_id="org-1",
            conversation_id="conv-1",
            memory_digest=digest,
        )

        assert [item["id"] for item in ids] == ["id-1"]
        assert recorded[0]["supersedes_content"] == "OIB-RL 2.1 ist nicht anwendbar"

    @pytest.mark.asyncio
    async def test_ordinary_finding_carries_no_supersede_target(self, monkeypatch):
        recorded = []
        monkeypatch.setattr(R, "insert_memory_item", lambda **k: (recorded.append(k), "id-1")[1])
        llm = _FakeLLM(
            '{"findings": [{"kind": "decision", "content": "Client chose a flat roof.", '
            '"confidence": "high", "supersedes": ""}]}'
        )

        await R.run_memory_reflection(
            llm=llm,
            query="Flat or pitched?",
            answer="You decided on a flat roof.",
            project_id="proj-1",
            organization_id="org-1",
            conversation_id="conv-1",
            memory_digest="(none)",
        )

        assert recorded[0]["supersedes_content"] is None

    @pytest.mark.asyncio
    async def test_requests_strict_json_schema_structured_output(self, monkeypatch):
        monkeypatch.setattr(R, "insert_memory_item", lambda **k: "id-1")
        llm = _FakeLLM('{"findings": [{"kind": "decision", "content": "Flat roof chosen.", "confidence": "high"}]}')

        await R.run_memory_reflection(
            llm=llm,
            query="q",
            answer="a",
            project_id="proj-1",
            organization_id="org-1",
            conversation_id="conv-1",
            memory_digest=None,
        )

        assert llm.bind_kwargs is not None, "reflection should bind a response_format"
        rf = llm.bind_kwargs["response_format"]
        assert rf["type"] == "json_schema"
        assert rf["json_schema"]["strict"] is True

    @pytest.mark.asyncio
    async def test_a_provider_that_refuses_response_format_still_records(self, monkeypatch):
        """The parameter is a preference, not a requirement: a 400 naming it drops
        to a plain call, which the fenced-JSON extractor still reads."""
        monkeypatch.setattr(R, "insert_memory_item", lambda **k: "id-1")
        llm = _RejectingLLM('```json\n{"findings": [{"kind": "decision", "content": "Flat roof."}]}\n```')

        ids = await R.run_memory_reflection(
            llm=llm,
            query="q",
            answer="a",
            project_id="proj-1",
            organization_id=None,
            conversation_id="c",
            memory_digest=None,
        )

        assert (llm.bound_calls, llm.plain_calls) == (1, 1)
        assert [item["id"] for item in ids] == ["id-1"]

    @pytest.mark.asyncio
    async def test_a_rejection_is_recognised_on_the_sdks_response_object(self, monkeypatch):
        """``openai.APIStatusError`` carries ``status_code`` itself; an httpx or
        requests error carries it on ``response``. Both are the same refusal."""
        monkeypatch.setattr(R, "insert_memory_item", lambda **k: "id-1")
        llm = _RejectingLLM('{"findings": [{"kind": "decision", "content": "Flat roof."}]}', nested=True)

        ids = await R.run_memory_reflection(
            llm=llm,
            query="q",
            answer="a",
            project_id="proj-1",
            organization_id=None,
            conversation_id="c",
            memory_digest=None,
        )

        assert llm.plain_calls == 1
        assert [item["id"] for item in ids] == ["id-1"]

    @pytest.mark.asyncio
    async def test_a_provider_fault_is_not_retried(self, monkeypatch):
        """Retrying a timeout or a 500 without ``response_format`` doubles the cost
        of the slowest case and buys nothing — only a parameter rejection falls
        through. The stage runner owns the failure."""
        monkeypatch.setattr(R, "insert_memory_item", lambda **k: pytest.fail("should not insert"))
        llm = _RejectingLLM("{}", status_code=503)

        with pytest.raises(_ProviderError):
            await R.run_memory_reflection(
                llm=llm,
                query="q",
                answer="a",
                project_id="proj-1",
                organization_id=None,
                conversation_id="c",
                memory_digest=None,
            )

        assert llm.plain_calls == 0

    @pytest.mark.asyncio
    async def test_empty_findings_records_nothing(self, monkeypatch):
        monkeypatch.setattr(R, "insert_memory_item", lambda **k: pytest.fail("should not insert on empty findings"))
        llm = _FakeLLM('{"findings": []}')
        ids = await R.run_memory_reflection(
            llm=llm,
            query="hi",
            answer="hello",
            project_id="proj-1",
            organization_id=None,
            conversation_id="c",
            memory_digest=None,
        )
        assert ids == []

    @pytest.mark.asyncio
    async def test_unparseable_llm_output_is_safe(self, monkeypatch):
        monkeypatch.setattr(R, "insert_memory_item", lambda **k: pytest.fail("should not insert"))
        llm = _FakeLLM("I could not find anything to record, sorry!")
        ids = await R.run_memory_reflection(
            llm=llm,
            query="q",
            answer="a",
            project_id="proj-1",
            organization_id=None,
            conversation_id="c",
            memory_digest=None,
        )
        assert ids == []

    @pytest.mark.asyncio
    async def test_insert_failure_is_swallowed(self, monkeypatch):
        def boom(**kwargs):
            raise RuntimeError("memory service down")

        monkeypatch.setattr(R, "insert_memory_item", boom)
        llm = _FakeLLM('{"findings": [{"kind": "constraint", "content": "Budget capped at 2M."}]}')
        ids = await R.run_memory_reflection(
            llm=llm,
            query="q",
            answer="a",
            project_id="proj-1",
            organization_id=None,
            conversation_id="c",
            memory_digest=None,
        )
        assert ids == []  # error swallowed, nothing recorded

    @pytest.mark.asyncio
    async def test_one_failing_write_does_not_cost_the_others(self, monkeypatch):
        def flaky(**kwargs):
            if kwargs["content"] == "Second.":
                raise RuntimeError("memory service down")
            return f"id-{kwargs['content'][0]}"

        monkeypatch.setattr(R, "insert_memory_item", flaky)
        llm = _FakeLLM(
            '{"findings": [{"kind": "decision", "content": "First."}, '
            '{"kind": "decision", "content": "Second."}, '
            '{"kind": "decision", "content": "Third."}]}'
        )

        ids = await R.run_memory_reflection(
            llm=llm,
            query="q",
            answer="a",
            project_id="proj-1",
            organization_id=None,
            conversation_id="c",
            memory_digest=None,
        )

        assert [item["content"] for item in ids] == ["First.", "Third."]

    @pytest.mark.asyncio
    async def test_writes_run_concurrently_and_report_in_order(self, monkeypatch):
        """Five sequential 5s-timeout round trips inside a 45s stage budget was the
        whole batch riding on the slowest link. The frame's payload contract is
        still "in write order", so ordering survives the gather."""
        # Every write must be in flight before any of them may finish; a
        # sequential loop deadlocks the barrier and fails with BrokenBarrierError.
        in_flight = threading.Barrier(3, timeout=10)

        def blocking(**kwargs):
            in_flight.wait()
            return f"id-{kwargs['content'][0]}"

        monkeypatch.setattr(R, "insert_memory_item", blocking)
        llm = _FakeLLM(
            '{"findings": [{"kind": "decision", "content": "Alpha."}, '
            '{"kind": "decision", "content": "Beta."}, '
            '{"kind": "decision", "content": "Gamma."}]}'
        )

        ids = await asyncio.wait_for(
            R.run_memory_reflection(
                llm=llm,
                query="q",
                answer="a",
                project_id="proj-1",
                organization_id=None,
                conversation_id="c",
                memory_digest=None,
            ),
            timeout=10,
        )

        assert [item["content"] for item in ids] == ["Alpha.", "Beta.", "Gamma."]

    @pytest.mark.asyncio
    async def test_an_unknown_project_records_nothing(self, monkeypatch):
        # The client answers None when the target does not exist; that is not an
        # error and must not reach the frame as a row without an id.
        monkeypatch.setattr(R, "insert_memory_item", lambda **k: None)
        llm = _FakeLLM('{"findings": [{"kind": "constraint", "content": "Budget capped at 2M."}]}')
        ids = await R.run_memory_reflection(
            llm=llm,
            query="q",
            answer="a",
            project_id="proj-1",
            organization_id=None,
            conversation_id="c",
            memory_digest=None,
        )
        assert ids == []


class TestMemoryReflectionAsAStage:
    """The same behaviours the bespoke scheduler used to guarantee, now going
    through the post-answer stage runner. This is the migration's own test: what
    reflection does must be unchanged, only how it is wired and bounded."""

    def _facts(self, **overrides):
        base = TurnFacts(
            conversation_id="c",
            organization_id=None,
            project_id="proj-1",
            query="q",
            answer="a",
            routing_decision="shallow",
            enabled_stages=frozenset({"memory_reflection"}),
        )
        return dataclasses.replace(base, **overrides)

    async def _run(self, facts, llm):
        tasks = schedule_post_answer_stages(facts, llms={AgentGroup.MEMORY_REFLECTION: llm})
        outcomes = await asyncio.gather(*tasks)
        return {outcome.stage_id: outcome for outcome in outcomes}

    @pytest.mark.asyncio
    async def test_schedules_and_runs(self, monkeypatch):
        recorded = []
        monkeypatch.setattr(R, "insert_memory_item", lambda **k: recorded.append(k) or "id-1")
        llm = _FakeLLM('{"findings": [{"kind": "decision", "content": "Chose district heating."}]}')

        outcomes = await self._run(self._facts(), llm)

        assert len(recorded) == 1
        assert outcomes["memory_reflection"].status == "ready"
        assert outcomes["memory_reflection"].payload == {
            "items": [{"id": "id-1", "kind": "decision", "content": "Chose district heating."}]
        }

    @pytest.mark.asyncio
    async def test_no_llm_is_noop(self):
        outcomes = await self._run(self._facts(), None)
        assert outcomes["memory_reflection"].status == "disabled"
        assert outcomes["memory_reflection"].reason == "no_llm"

    @pytest.mark.asyncio
    async def test_no_scope_is_noop(self):
        outcomes = await self._run(self._facts(project_id=None), _FakeLLM("{}"))
        assert outcomes["memory_reflection"].status == "skipped"
        assert outcomes["memory_reflection"].reason == "no_project"

    @pytest.mark.asyncio
    async def test_org_only_is_noop(self):
        # No project in scope -> the project-only autonomous stage has nothing to
        # write, even when an organization is known (audit finding S1).
        outcomes = await self._run(self._facts(project_id=None, organization_id="org-1"), _FakeLLM("{}"))
        assert outcomes["memory_reflection"].status == "skipped"
        assert outcomes["memory_reflection"].reason == "no_project"

    @pytest.mark.asyncio
    async def test_failing_pass_never_raises(self, monkeypatch):
        async def boom(**kwargs):
            raise RuntimeError("llm exploded")

        monkeypatch.setattr(R, "run_memory_reflection", boom)
        outcomes = await self._run(self._facts(), _FakeLLM("{}"))
        assert outcomes["memory_reflection"].status == "failed"
        assert outcomes["memory_reflection"].reason == "RuntimeError"

    @pytest.mark.asyncio
    async def test_a_stalled_provider_no_longer_holds_the_slot_for_minutes(self, monkeypatch):
        """The defect the primitive closes: reflection had no asyncio timeout, so
        a stalled provider held one of four concurrency slots for ~6 minutes."""

        async def never_returns(**kwargs):
            await asyncio.sleep(30)

        monkeypatch.setattr(R, "run_memory_reflection", never_returns)
        monkeypatch.setitem(
            stage_registry._STAGES, "memory_reflection", dataclasses.replace(MEMORY_REFLECTION, timeout_s=0.05)
        )
        outcomes = await self._run(self._facts(), _FakeLLM("{}"))
        assert outcomes["memory_reflection"].status == "timeout"
