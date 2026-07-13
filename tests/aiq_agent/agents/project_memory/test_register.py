"""Tests for the ``remember`` tool's honest failure handling.

Drives the inner ``_remember`` function (the one yielded as a NAT
``FunctionInfo``) with ``insert_memory_item`` mocked, so the tool's user-facing
result strings can be asserted without a real internal API.
"""

from unittest.mock import MagicMock

import pytest

import aiq_agent.knowledge.project_memory as pm
import aiq_agent.project_context as pc
from aiq_agent.agents.project_memory.register import ProjectMemoryRememberConfig
from aiq_agent.agents.project_memory.register import project_memory_remember


def _patch_context(monkeypatch, *, project_id="p1", organization_id="o1", conversation_id="c1"):
    monkeypatch.setattr(pc, "get_project_id_from_context", lambda: project_id)
    monkeypatch.setattr(pc, "get_organization_id_from_context", lambda: organization_id)
    monkeypatch.setattr(pc, "get_conversation_id_from_context", lambda: conversation_id)


async def _remember(monkeypatch, insert, **kwargs):
    """Enter the NAT registration, call _remember once, return its string result."""
    monkeypatch.setattr(pm, "insert_memory_item", insert)
    params = {"kind": "derived_fact", "content": "The roof load is 2 kN/m2.", "scope": "project"}
    params.update(kwargs)
    async with project_memory_remember(ProjectMemoryRememberConfig(), MagicMock()) as info:
        # NAT wraps the inner fn behind a pydantic input schema; call it the same
        # way the framework does — with a validated input model instance.
        return await info.single_fn(info.input_schema(**params))


@pytest.mark.asyncio
async def test_success_path_reports_recorded(monkeypatch):
    _patch_context(monkeypatch)
    insert = MagicMock(return_value="item-1")
    result = await _remember(monkeypatch, insert)
    assert result == "Recorded derived_fact in project memory."
    assert insert.called


@pytest.mark.asyncio
async def test_org_memory_disabled_returns_honest_message(monkeypatch):
    _patch_context(monkeypatch)
    insert = MagicMock(side_effect=pm.OrgMemoryDisabledError("disabled"))
    result = await _remember(monkeypatch, insert)
    assert "NOT saved" in result
    assert "organization memory panel" in result
    # Must not claim it was noted, and must tell the model not to retry.
    assert "Do not retry" in result


@pytest.mark.asyncio
async def test_generic_failure_returns_not_saved_message(monkeypatch):
    _patch_context(monkeypatch)
    insert = MagicMock(side_effect=RuntimeError("boom"))
    result = await _remember(monkeypatch, insert)
    assert "NOT saved" in result
    # The generic path is distinct from the org-deny path.
    assert "organization memory panel" not in result


@pytest.mark.asyncio
async def test_unknown_project_returns_none_result(monkeypatch):
    _patch_context(monkeypatch)
    insert = MagicMock(return_value=None)
    result = await _remember(monkeypatch, insert)
    assert result == "Error: unknown project — nothing recorded."
