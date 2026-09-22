"""Which stages are on for this turn.

The defect these guard: the feature header is written once, at the WebSocket
upgrade, and is then frozen for the life of the socket — so switching a stage off
did not reach an already-open tab. The evaluation is per turn now, and it falls
back to the frozen value rather than to "nothing", so a BFF blip degrades to the
previous behaviour instead of disabling every stage.
"""

import io
import json
from unittest.mock import patch

import pytest

from aiq_agent.stages import flags


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def _body(payload) -> _Response:
    return _Response(json.dumps(payload).encode("utf-8"))


@pytest.fixture(autouse=True)
def _internal_token(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")


class TestFetchEnabledStages:
    def test_reads_the_enabled_list(self):
        with patch("urllib.request.urlopen", return_value=_body({"enabled": ["memory_reflection"]})):
            assert flags.fetch_enabled_stages(organization_id="org_1") == frozenset({"memory_reflection"})

    def test_an_empty_list_means_every_stage_is_off(self):
        with patch("urllib.request.urlopen", return_value=_body({"enabled": []})):
            assert flags.fetch_enabled_stages(organization_id="org_1") == frozenset()

    def test_the_organization_is_asked_for_by_id(self):
        with patch("urllib.request.urlopen", return_value=_body({"enabled": []})) as urlopen:
            flags.fetch_enabled_stages(organization_id="org_1")
        assert "organizationId=org_1" in urlopen.call_args.args[0].full_url

    def test_a_malformed_body_raises_so_the_caller_can_fall_back(self):
        with patch("urllib.request.urlopen", return_value=_body({"stages": ["memory_reflection"]})):
            with pytest.raises(ValueError):
                flags.fetch_enabled_stages(organization_id="org_1")

    def test_no_service_token_raises_rather_than_calling_unauthenticated(self, monkeypatch):
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        with patch("urllib.request.urlopen", return_value=_body({"enabled": []})) as urlopen:
            with pytest.raises(RuntimeError):
                flags.fetch_enabled_stages(organization_id="org_1")
        assert urlopen.call_count == 0, "the endpoint was called without the service token"


class TestResolveEnabledStages:
    @pytest.mark.asyncio
    async def test_the_live_answer_wins_over_the_connection_time_value(self):
        """The whole point: 'off' has to mean off on the NEXT TURN, not on the
        next socket handshake."""
        with patch("urllib.request.urlopen", return_value=_body({"enabled": []})):
            resolved = await flags.resolve_enabled_stages(organization_id="org_1", memory_reflection_enabled=True)
        assert resolved == frozenset()

    @pytest.mark.asyncio
    async def test_a_bff_failure_degrades_to_the_connection_time_value(self):
        with patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
            resolved = await flags.resolve_enabled_stages(organization_id="org_1", memory_reflection_enabled=True)
        assert "memory_reflection" in resolved

    @pytest.mark.asyncio
    async def test_a_bff_failure_never_switches_a_disabled_stage_on(self):
        with patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
            resolved = await flags.resolve_enabled_stages(organization_id="org_1", memory_reflection_enabled=False)
        assert resolved == frozenset()


class TestFetchTurnFlags:
    """The capability half of the same call.

    It rides the stages endpoint rather than one of its own because both are
    answered per turn, in the same gather, under the same 1.5s budget.
    """

    def test_reads_the_deep_research_feature(self):
        with patch("urllib.request.urlopen", return_value=_body({"enabled": [], "features": {"deepResearch": False}})):
            assert flags.fetch_turn_flags(organization_id="org_1").deep_research_allowed is False

    def test_an_enabled_feature_reads_as_allowed(self):
        with patch("urllib.request.urlopen", return_value=_body({"enabled": [], "features": {"deepResearch": True}})):
            assert flags.fetch_turn_flags(organization_id="org_1").deep_research_allowed is True

    def test_an_older_bff_without_features_keeps_deep_research(self):
        """A mixed deployment must behave as it did before the field existed —
        withdrawal is a decision somebody made in WorkOS, not a missing key."""
        with patch("urllib.request.urlopen", return_value=_body({"enabled": ["memory_reflection"]})):
            resolved = flags.fetch_turn_flags(organization_id="org_1")
        assert resolved.deep_research_allowed is True
        assert resolved.enabled_stages == frozenset({"memory_reflection"})

    @pytest.mark.parametrize("features", [None, {}, {"deepResearch": None}, "nonsense"])
    def test_only_an_explicit_false_withdraws_it(self, features):
        with patch("urllib.request.urlopen", return_value=_body({"enabled": [], "features": features})):
            assert flags.fetch_turn_flags(organization_id="org_1").deep_research_allowed is True

    def test_the_two_capabilities_are_read_independently(self):
        """`task-automation` is its own flag. An org may keep deep research and
        lose the right to queue work, or the reverse."""
        payload = {"enabled": [], "features": {"deepResearch": True, "tasks": False}}
        with patch("urllib.request.urlopen", return_value=_body(payload)):
            resolved = flags.fetch_turn_flags(organization_id="org_1")
        assert resolved.deep_research_allowed is True
        assert resolved.tasks_allowed is False

    def test_an_older_bff_keeps_tasks_too(self):
        with patch("urllib.request.urlopen", return_value=_body({"enabled": []})):
            assert flags.fetch_turn_flags(organization_id="org_1").tasks_allowed is True

    def test_both_halves_come_from_one_request(self):
        with patch("urllib.request.urlopen", return_value=_body({"enabled": [], "features": {}})) as urlopen:
            flags.fetch_turn_flags(organization_id="org_1")
        assert urlopen.call_count == 1


class TestResolveTurnFlags:
    @pytest.mark.asyncio
    async def test_a_bff_failure_never_withdraws_deep_research(self):
        """The one that matters: a blip must not look like a withdrawn flag."""
        with patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
            resolved = await flags.resolve_turn_flags(organization_id="org_1", memory_reflection_enabled=False)
        assert resolved.deep_research_allowed is True

    @pytest.mark.asyncio
    async def test_a_bff_failure_never_withdraws_tasks(self):
        with patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
            resolved = await flags.resolve_turn_flags(organization_id="org_1", memory_reflection_enabled=False)
        assert resolved.tasks_allowed is True

    @pytest.mark.asyncio
    async def test_a_malformed_body_never_withdraws_deep_research(self):
        with patch("urllib.request.urlopen", return_value=_body({"stages": []})):
            resolved = await flags.resolve_turn_flags(organization_id="org_1", memory_reflection_enabled=True)
        assert resolved.deep_research_allowed is True
        assert "memory_reflection" in resolved.enabled_stages

    @pytest.mark.asyncio
    async def test_the_live_withdrawal_reaches_this_turn(self):
        with patch("urllib.request.urlopen", return_value=_body({"enabled": [], "features": {"deepResearch": False}})):
            resolved = await flags.resolve_turn_flags(organization_id="org_1", memory_reflection_enabled=True)
        assert resolved.deep_research_allowed is False
