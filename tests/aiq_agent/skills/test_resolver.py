"""Org skill resolution: cache, shadowing, grid-agents filtering, fail-open."""

from __future__ import annotations

from unittest import mock

import pytest

from aiq_agent.common import cache as shared_cache
from aiq_agent.skills.models import Skill
from aiq_agent.skills.resolver import SkillResolver
from aiq_agent.skills.resolver import resolve_served_skills

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
        metadata={"grid-agents": "deep_researcher"},
    )
    resolver._builtin_by_name["smart"] = smart
    with mock.patch.object(
        resolver,
        "_fetch_org_skills",
        return_value=[_row("org-deep", metadata={"grid-agents": "deep_researcher"})],
    ):
        resolved = resolver.resolve("org-1")
    assert "smart" not in {s.name for s in resolved}
    assert "org-deep" not in {s.name for s in resolved}


def test_a_leftover_grid_execution_is_ignored_not_honoured(resolver: SkillResolver) -> None:
    """``grid-execution`` is gone from the model, and a stored one changes nothing.

    It used to gate availability, then it meant "what a scheduled run produces",
    and now scheduling is a property of the JOB and the key is not part of a
    skill at all. Org rows written before the change still carry it, so
    resolution must neither honour it nor choke on it: both agents see both
    values. Scoping is ``grid-agents`` and only ``grid-agents``.
    """
    for execution in ("chat", "deep-research"):
        skill = Skill(
            name=f"{execution}-mode",
            description="d.",
            body="b",
            origin="platform",
            metadata={"grid-execution": execution},
        )
        resolver._builtin_by_name[skill.name] = skill

    deep = SkillResolver(agent="deep_researcher")
    deep._builtin_by_name = dict(resolver._builtin_by_name)

    for agent_resolver in (resolver, deep):
        names = {s.name for s in agent_resolver.resolve(None)}
        assert {"chat-mode", "deep-research-mode"} <= names


def test_org_row_with_a_stored_grid_execution_still_resolves(resolver: SkillResolver) -> None:
    """The whole point of dropping validation: a stale stored key must not 404 a skill.

    Org rows are not migrated in lockstep with the code. A row still carrying
    ``grid-execution`` (or ``grid-schedulable``) has to travel the full BFF
    payload -> ``build_skill_from_payload`` path intact instead of being dropped
    as an invalid row, which is what a still-reserved key would have done.
    """
    with mock.patch.object(
        resolver,
        "_fetch_org_skills",
        return_value=[
            _row(
                "legacy-row",
                metadata={
                    "grid-execution": "deep-research",
                    "grid-schedulable": "true",
                    "grid-agents": "shallow_researcher",
                },
            )
        ],
    ):
        resolved = {s.name: s for s in resolver.resolve("org-1")}
    assert "legacy-row" in resolved
    assert resolved["legacy-row"].metadata["grid-execution"] == "deep-research"


def test_grid_agents_is_the_only_scope(resolver: SkillResolver) -> None:
    """An un-migrated org row is scoped by ``grid-agents`` alone, nothing else."""
    scheduled_report = Skill(
        name="monthly-report",
        description="d.",
        body="b",
        origin="platform",
        # A stale key from before the rename. Anyone may still invoke the skill.
        metadata={"grid-execution": "deep-research"},
    )
    deep_only = Skill(
        name="sandbox-writer",
        description="d.",
        body="b",
        origin="platform",
        metadata={"grid-execution": "deep-research", "grid-agents": "deep_researcher"},
    )
    resolver._builtin_by_name["monthly-report"] = scheduled_report
    resolver._builtin_by_name["sandbox-writer"] = deep_only

    names = {s.name for s in resolver.resolve(None)}
    assert "monthly-report" in names
    assert "sandbox-writer" not in names


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


# ---------------------------------------------------------------------------
# The BFF wire contract
# ---------------------------------------------------------------------------
#
# `_fetch_org_skills` once sent `organizationId` (camelCase) and `agent=""`,
# while the BFF's `resolveQuerySchema` requires snake_case `organization_id`
# and a NON-EMPTY optional `agent`. Both were rejected with a 400 — and because
# resolution fails open to the builtin set, the only symptom was that org
# skills never appeared anywhere. Nothing asserted the query, so nothing caught
# it. These tests assert the request itself.


class _FakeResponse:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, object]:
        return self._payload


def _capture_fetch_query(agent: str | None, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """Run one `_fetch_org_skills` and return the query params it put on the wire."""
    captured: dict[str, str] = {}

    def fake_get(url: str, *, params: dict[str, str], headers: dict[str, str], timeout: float):
        captured.update(params)
        captured["__url"] = url
        captured["__token_header"] = next(iter(headers))
        return _FakeResponse({"skills": []})

    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
    import httpx

    monkeypatch.setattr(httpx, "get", fake_get)
    SkillResolver(agent=agent)._fetch_org_skills("org-42")
    return captured


def test_fetch_sends_the_snake_case_organization_id(monkeypatch: pytest.MonkeyPatch) -> None:
    query = _capture_fetch_query("shallow_researcher", monkeypatch)
    assert query["organization_id"] == "org-42"
    assert "organizationId" not in query
    assert query["agent"] == "shallow_researcher"
    assert query["__url"] == "http://frontend:3000/api/internal/skills/resolve"
    assert query["__token_header"] == "x-grid-internal-token"


def test_fetch_omits_agent_entirely_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    # The BFF schema requires a non-empty string, so `agent=""` is a 400 — the
    # key must be absent, not blank.
    query = _capture_fetch_query(None, monkeypatch)
    assert "agent" not in query
    assert query["organization_id"] == "org-42"


def test_unknown_grid_agents_names_do_not_delete_the_skill(resolver: SkillResolver) -> None:
    """A typo in `grid-agents` must not silently hide a skill from every agent."""
    from aiq_agent.skills.resolver import _agent_allows

    typo = Skill(name="typo", description="d", body="b", metadata={"grid-agents": "shallow_reseacher"})
    assert _agent_allows(typo, "shallow_researcher") is True
    real = Skill(name="real", description="d", body="b", metadata={"grid-agents": "deep_researcher"})
    assert _agent_allows(real, "shallow_researcher") is False


# ---------------------------------------------------------------------------
# grid-catalog: machinery vs. offers
# ---------------------------------------------------------------------------

CURATED = Skill(
    name="fire-check",
    description="Offered to organizations.",
    body="body-3",
    origin="platform",
    collection="research",
    metadata={"grid-catalog": "curated"},
)


@pytest.fixture
def catalog_resolver(monkeypatch: pytest.MonkeyPatch) -> SkillResolver:
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")
    resolver = SkillResolver(agent="shallow_researcher")
    resolver._builtin_by_name = {s.name: s for s in (*BUILTIN, CURATED)}
    return resolver


def test_curated_builtin_is_not_always_on(catalog_resolver: SkillResolver) -> None:
    """An offer is not in always_on — the filesystem cannot say who took it up.

    The baseline this resolver starts from is the builtin directory, and the BFF
    payload can only ADD to it. A curated skill left in that baseline would
    therefore be on for every tenant no matter what any of them decided. Chat
    FILE offers may default ON, but that decision arrives through the org
    payload, never through this baseline.
    """
    assert {s.name for s in catalog_resolver.always_on} == {"calc", "report"}
    assert "fire-check" in {s.name for s in catalog_resolver.builtin}
    assert "fire-check" not in {s.name for s in catalog_resolver.resolve(None)}


def test_curated_builtin_arrives_when_the_org_switched_it_on(catalog_resolver: SkillResolver) -> None:
    """Activated, it comes down the org payload like any other row."""
    with mock.patch.object(
        catalog_resolver,
        "_fetch_org_skills",
        return_value=[_row("fire-check")],
    ):
        resolved = catalog_resolver.resolve("org-1")
    assert "fire-check" in {s.name for s in resolved}


def test_machinery_survives_a_failed_fetch(catalog_resolver: SkillResolver) -> None:
    """Fail-open means the pipeline keeps working, not that offers are guessed on."""
    with mock.patch.object(catalog_resolver, "_fetch_org_skills", side_effect=RuntimeError("down")):
        resolved = catalog_resolver.resolve("org-1")
    assert {s.name for s in resolved} == {"calc", "report"}


def test_unrecognised_catalog_value_reads_as_machinery(monkeypatch: pytest.MonkeyPatch) -> None:
    """The closed default: a typo must not expose an internal instruction as an offer."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")
    resolver = SkillResolver(agent="shallow_researcher")
    typo = Skill(
        name="typo",
        description="Meant to be curated.",
        body="b",
        origin="platform",
        collection="research",
        metadata={"grid-catalog": "curatd"},
    )
    resolver._builtin_by_name = {typo.name: typo}
    assert {s.name for s in resolver.always_on} == {"typo"}


def test_served_skills_leave_the_builtin_FILES_where_they_are(monkeypatch: pytest.MonkeyPatch) -> None:
    """``resolve_served_skills`` returns rows, not files, and the reason is delivery.

    Deep research already mounts ``skills/builtin`` into its sandbox and assigns
    collections per DeepAgents subagent, which is a finer gate than
    ``grid-agents`` can express. Handing the same files down a second channel
    would put the research skills — the ones whose instructions call
    ``execute`` — in front of the WRITER, which cannot run them.
    """
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")
    with mock.patch.object(
        SkillResolver,
        "_fetch_org_skills",
        return_value=[
            _row("piloti-voice", metadata={"grid-agents": "shallow_researcher,deep_researcher"}),
            # The BFF also re-sends machinery, stamped origin=org. The mount
            # already has the file; serving it here would put execute-skills
            # in front of the writer.
            _row("brandschutz", metadata={"grid-agents": "shallow_researcher,deep_researcher"}),
        ],
    ):
        served = resolve_served_skills("deep_researcher", "org-1")
    assert [s.name for s in served] == ["piloti-voice"]
    assert {s.origin for s in served} == {"org"}


def test_served_skills_still_honour_grid_agents(monkeypatch: pytest.MonkeyPatch) -> None:
    """One gate, read the same way for both agents."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")
    with mock.patch.object(
        SkillResolver,
        "_fetch_org_skills",
        return_value=[_row("chat-only", metadata={"grid-agents": "shallow_researcher"})],
    ):
        assert resolve_served_skills("deep_researcher", "org-1") == ()


def test_served_skills_never_raise_without_a_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """No token is the deployment's business; it must not be the run's failure."""
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    assert resolve_served_skills("deep_researcher", "org-1") == ()


def test_served_skills_swallow_a_hard_resolution_failure() -> None:
    """The last guard: a report is worth far more than the voice it is missing.

    ``resolve`` fails open on its own for a bad payload or an unreachable BFF,
    so this covers what is left — anything raising OUT of it — because the
    caller is a forty-minute research job and there is nothing here worth
    losing it over.
    """
    with mock.patch.object(SkillResolver, "resolve", side_effect=RuntimeError("boom")):
        assert resolve_served_skills("deep_researcher", "org-1") == ()
