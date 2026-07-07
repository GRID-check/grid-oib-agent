"""Tests for request-context header getters in aiq_agent.project_context."""

from aiq_agent import project_context as pc


class TestMemoryReflectionFlag:
    def test_true_header_enables(self, monkeypatch):
        monkeypatch.setattr(pc, "_read_header", lambda name: "true")
        assert pc.get_memory_reflection_enabled_from_context() is True

    def test_case_insensitive(self, monkeypatch):
        monkeypatch.setattr(pc, "_read_header", lambda name: "TRUE")
        assert pc.get_memory_reflection_enabled_from_context() is True

    def test_false_header_disables(self, monkeypatch):
        monkeypatch.setattr(pc, "_read_header", lambda name: "false")
        assert pc.get_memory_reflection_enabled_from_context() is False

    def test_absent_header_fails_closed(self, monkeypatch):
        monkeypatch.setattr(pc, "_read_header", lambda name: None)
        assert pc.get_memory_reflection_enabled_from_context() is False

    def test_reads_the_expected_header(self, monkeypatch):
        seen = {}

        def fake(name):
            seen["name"] = name
            return "true"

        monkeypatch.setattr(pc, "_read_header", fake)
        pc.get_memory_reflection_enabled_from_context()
        assert seen["name"] == pc.MEMORY_REFLECTION_FEATURE_HEADER
