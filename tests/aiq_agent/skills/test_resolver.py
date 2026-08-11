"""Org skill resolution: cache, shadowing, grid-agents filtering, fail-open."""

from __future__ import annotations

from unittest import mock

import pytest

from aiq_agent.common import cache as shared_cache
from aiq_agent.skills.models import Skill
from aiq_agent.skills.resolver import SkillResolver

BUILTIN = (
    Skill(name="calc", description="Base calculator.", body="body-1", origin="platform", collection="research"),
    Skill(name="report", description="Base report writer.", body="body-2", origin="platform", collection="synthesis"),
)


@pytest.fixture(autouse=True)
def _reset_cache():
    shared_cache.reset_local_store()
    yield
    shared_cache.reset_local_store()


@pytest.fixture
def resolver(monkeypatch: pytest.MonkeyPatch) -> SkillResolver:
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")
    resolver = SkillResolver(agent="shallow_researcher")
    resolver._builtin_by_name = {s.name: s for s in BUILTIN}
    return resolver


def _row(name: str, **extra: object) -> dict[str, object]:
    return {"name": name, "description": f"{name} org skill.", "body": f"body-{name}", **extra}


def test_builtin_only_without_org(resolver: SkillResolver) -> None:
    assert {s.name for s in resolver.resolve(None)} == {"calc", "report"}


def test_org_rows_shadow_builtin_by_name(resolver: SkillResolver) -> None:
    with mock.patch.object(
        resolver,
        "_fetch_org_skills",
        return_value=[_row("calc", metadata={"grid-agents": "shallow_researcher"}), _row("org-only")],
    ):
        resolved = resolver.resolve("org-1")
    assert {s.name: s for s in resolved}["calc"].origin == "org"
    assert "org-only" in {s.name for s in resolved}
    assert resolver.builtin[0].origin == "platform"


def test_invalid_org_row_is_dropped(resolver: SkillResolver) -> None:
    with mock.patch.object(
        resolver,
        "_fetch_org_skills",
        return_value=[_row("bad name!"), _row("UPPERCASE"), _row("valid-org")],
    ):
        resolved = resolver.resolve("org-1")
    assert "valid-org" in {s.name for s in resolved}
    assert "bad name!" not in {s.name for s in resolved}


def test_grid_agents_filter_applies_to_builtin_and_org(resolver: SkillResolver) -> None:
    smart = Skill(
        name="smart",
        description="Deep only.",
        body="b",
        origin="platform",
        metadata={"grid-agents": "deep_research_agent"},
    )
    resolver._builtin_by_name["smart"] = smart
    with mock.patch.object(
        resolver,
        "_fetch_org_skills",
        return_value=[_row("org-deep", metadata={"grid-agents": "deep_research_agent"})],
    ):
        resolved = resolver.resolve("org-1")
    assert "smart" not in {s.name for s in resolved}
    assert "org-deep" not in {s.name for s in resolved}


def test_grid_execution_chat_excludes_deep_research(resolver: SkillResolver) -> None:
    chat_only = Skill(
        name="chat-only", description="chat.", body="b", origin="platform", metadata={"grid-execution": "chat"}
    )
    resolver._builtin_by_name["chat-only"] = chat_only
    deep = SkillResolver(agent="deep_research_agent")
    deep._builtin_by_name = dict(resolver._builtin_by_name)
    assert "chat-only" not in {s.name for s in deep.resolve(None)}
    assert "chat-only" in {s.name for s in resolver.resolve(None)}


def test_fetch_failure_fails_open_to_builtins(resolver: SkillResolver) -> None:
    with mock.patch.object(resolver, "_fetch_org_skills", side_effect=RuntimeError("boom")):
        assert {s.name for s in resolver.resolve("org-1")} == {"calc", "report"}


def test_missing_token_fails_open(resolver: SkillResolver, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN")
    assert {s.name for s in resolver.resolve("org-1")} == {"calc", "report"}


def test_result_is_cached_in_shared_cache(resolver: SkillResolver) -> None:
    calls = 0

    def fake_fetch(org: str) -> list[dict[str, object]]:
        nonlocal calls
        calls += 1
        return [_row("org-only")]

    with mock.patch.object(resolver, "_fetch_org_skills", side_effect=fake_fetch):
        resolver.resolve("org-cached")
        resolver.resolve("org-cached")
        resolver.resolve("org-cached")
    assert calls == 1
    # Different org => different cache key.
    with mock.patch.object(resolver, "_fetch_org_skills", side_effect=fake_fetch):
        resolver.resolve("org-other")
    assert calls == 2


def test_cache_tty_default_is_60(resolver: SkillResolver, monkeypatch: pytest.MonkeyPatch) -> None:
    from aiq_agent.skills.resolver import _cache_ttl_seconds

    assert _cache_ttl_seconds() == 60.0
    monkeypatch.setenv("GRID_SKILLS_CACHE_TTL_SECONDS", "120")
    assert _cache_ttl_seconds() == 120.0
    monkeypatch.setenv("GRID_SKILLS_CACHE_TTL_SECONDS", "0")
    assert _cache_ttl_seconds() == 60.0
    monkeypatch.setenv("GRID_SKILLS_CACHE_TTL_SECONDS", "junk")
    assert _cache_ttl_seconds() == 60.0
