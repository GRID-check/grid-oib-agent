"""Tests for the async post-answer memory-reflection stage."""

import pytest

from aiq_agent.agents.project_memory import reflection as R


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


class TestSanitizeFindings:
    def test_drops_invalid_kind_and_empty_content(self):
        raw = [
            {"kind": "bogus", "content": "x"},
            {"kind": "decision", "content": ""},
            {"kind": "constraint", "content": "Facade must be brick."},
        ]
        items = R._sanitize_findings(raw, has_project=True)
        assert len(items) == 1
        assert items[0]["kind"] == "constraint"
        assert items[0]["confidence"] == "medium"  # defaulted
        assert items[0]["scope"] == "project"  # forced

    def test_org_scope_is_forced_to_project(self):
        # The autonomous stage NEVER writes org-wide memory (audit finding S1);
        # a model-proposed organization scope is coerced to project.
        raw = [{"kind": "preference", "content": "Client prefers metric drawings.", "scope": "organization"}]
        items = R._sanitize_findings(raw, has_project=True)
        assert items and items[0]["scope"] == "project"

    def test_dropped_when_no_project_in_scope(self):
        raw = [{"kind": "decision", "content": "Anything."}]
        assert R._sanitize_findings(raw, has_project=False) == []

    def test_drops_content_already_in_digest(self):
        digest = 'PROJECT_MEMORY v1\n- [decision | high | agent] "Client chose a flat roof"'
        raw = [
            {"kind": "decision", "content": "Client chose a flat roof."},  # already present
            {"kind": "constraint", "content": "Budget capped at 2M."},  # new
        ]
        items = R._sanitize_findings(raw, has_project=True, memory_digest=digest)
        assert [i["content"] for i in items] == ["Budget capped at 2M."]

    def test_caps_at_max_items(self):
        raw = [{"kind": "derived_fact", "content": f"Fact {i}."} for i in range(20)]
        items = R._sanitize_findings(raw, has_project=True)
        assert len(items) == R.MAX_NEW_ITEMS

    def test_non_list_returns_empty(self):
        assert R._sanitize_findings({"findings": []}, has_project=True) == []


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
        assert R._sanitize_findings(raw, has_project=True) == []

    def test_keeps_findings_without_pii(self):
        raw = [{"kind": "constraint", "content": "Facade must use brick cladding per client decision."}]
        items = R._sanitize_findings(raw, has_project=True)
        assert len(items) == 1

    def test_mixed_batch_drops_only_pii_entry(self):
        raw = [
            {"kind": "constraint", "content": "Budget capped at 2M."},
            {"kind": "derived_fact", "content": "Reach the owner at owner@example.com for approvals."},
        ]
        items = R._sanitize_findings(raw, has_project=True)
        assert [i["content"] for i in items] == ["Budget capped at 2M."]


class TestContentInDigest:
    def test_matches_ignoring_case_and_punctuation(self):
        assert R._content_in_digest("Client chose a flat roof.", '... "client chose a flat roof" ...')

    def test_absent_returns_false(self):
        assert not R._content_in_digest("Budget capped at 2M.", '"Client chose a flat roof"')

    def test_no_digest_returns_false(self):
        assert not R._content_in_digest("anything", None)


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

        assert ids == ["id-1"]
        assert recorded[0]["scope"] == "project"
        assert recorded[0]["project_id"] == "proj-1"
        assert recorded[0]["kind"] == "decision"
        # Reflection writes are tagged 'distillation' so the UI can tell them
        # apart from a deliberate in-turn `remember` ('agent') call.
        assert recorded[0]["provenance_type"] == "distillation"
        # The existing memory digest and the answer both reach the prompt.
        assert llm.calls, "LLM should have been invoked"

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


class TestScheduleMemoryReflection:
    @pytest.mark.asyncio
    async def test_schedules_and_runs(self, monkeypatch):
        recorded = []
        monkeypatch.setattr(R, "insert_memory_item", lambda **k: recorded.append(k) or "id-1")
        llm = _FakeLLM('{"findings": [{"kind": "decision", "content": "Chose district heating."}]}')

        task = R.schedule_memory_reflection(
            llm=llm,
            query="q",
            answer="a",
            project_id="proj-1",
            organization_id=None,
            conversation_id="c",
            memory_digest=None,
        )
        assert task is not None
        await task
        assert len(recorded) == 1

    @pytest.mark.asyncio
    async def test_no_llm_is_noop(self):
        assert (
            R.schedule_memory_reflection(
                llm=None,
                query="q",
                answer="a",
                project_id="proj-1",
                organization_id=None,
                conversation_id="c",
                memory_digest=None,
            )
            is None
        )

    @pytest.mark.asyncio
    async def test_no_scope_is_noop(self):
        assert (
            R.schedule_memory_reflection(
                llm=_FakeLLM("{}"),
                query="q",
                answer="a",
                project_id=None,
                organization_id=None,
                conversation_id="c",
                memory_digest=None,
            )
            is None
        )

    @pytest.mark.asyncio
    async def test_org_only_is_noop(self):
        # No project in scope → the project-only autonomous stage has nothing to
        # write, even when an organization is known (audit finding S1).
        assert (
            R.schedule_memory_reflection(
                llm=_FakeLLM("{}"),
                query="q",
                answer="a",
                project_id=None,
                organization_id="org-1",
                conversation_id="c",
                memory_digest=None,
            )
            is None
        )

    @pytest.mark.asyncio
    async def test_failing_task_never_raises(self, monkeypatch):
        async def boom(**kwargs):
            raise RuntimeError("llm exploded")

        monkeypatch.setattr(R, "run_memory_reflection", boom)
        task = R.schedule_memory_reflection(
            llm=_FakeLLM("{}"),
            query="q",
            answer="a",
            project_id="proj-1",
            organization_id=None,
            conversation_id="c",
            memory_digest=None,
        )
        assert task is not None
        # The guard swallows the error; awaiting the task must not raise.
        await task
        assert task.done()
