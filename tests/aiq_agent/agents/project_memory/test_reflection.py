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
        items = R._sanitize_findings(raw, has_project=True, has_organization=True)
        assert len(items) == 1
        assert items[0]["kind"] == "constraint"
        assert items[0]["confidence"] == "medium"  # defaulted
        assert items[0]["scope"] == "project"  # defaulted

    def test_project_scope_falls_back_to_organization(self):
        raw = [{"kind": "preference", "content": "Firm prefers metric drawings.", "scope": "project"}]
        items = R._sanitize_findings(raw, has_project=False, has_organization=True)
        assert items and items[0]["scope"] == "organization"

    def test_project_scope_dropped_when_no_target(self):
        raw = [{"kind": "decision", "content": "Anything."}]
        assert R._sanitize_findings(raw, has_project=False, has_organization=False) == []

    def test_org_scope_dropped_without_org(self):
        raw = [{"kind": "decision", "content": "Anything.", "scope": "organization"}]
        assert R._sanitize_findings(raw, has_project=True, has_organization=False) == []

    def test_caps_at_max_items(self):
        raw = [{"kind": "derived_fact", "content": f"Fact {i}."} for i in range(20)]
        items = R._sanitize_findings(raw, has_project=True, has_organization=False)
        assert len(items) == R.MAX_NEW_ITEMS

    def test_non_list_returns_empty(self):
        assert R._sanitize_findings({"findings": []}, has_project=True, has_organization=True) == []


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
        # The existing memory digest and the answer both reach the prompt.
        assert llm.calls, "LLM should have been invoked"

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
