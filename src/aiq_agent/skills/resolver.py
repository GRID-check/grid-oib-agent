"""Org skill resolution: builtin (platform) + BFF-served org skills.

The BFF internal endpoint ``GET /api/internal/skills/resolve`` (built in a
later phase) returns the org's active skill set layered over the platform
offerings; this module fetches it fail-open. Resolution discipline:

- Cached in the shared Dragonfly/Redis cache (ADR-0020) keyed by
  ``skills:{organization_id}:{agent}`` for ``GRID_SKILLS_CACHE_TTL_SECONDS``
  (default 60), so per-turn resolution does not hammer the BFF across
  replicas — exactly like ``GRID_RIS_CACHE_TTL_DAYS`` caches live law.
- Any failure (no token, timeout, non-2xx, malformed payload) degrades to the
  builtin set: skills are an additive capability and must never take chat
  down.
- Org rows with the same name as a builtin skill SHADOW it (the tenant's
  version wins), matching BYOK's "explicit org value beats deployment
  default" ordering.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from aiq_agent.common import cache as shared_cache
from aiq_agent.skills.builtin import discover_builtin_skills
from aiq_agent.skills.models import MAX_NAME_CHARS
from aiq_agent.skills.models import Skill
from aiq_agent.skills.models import SkillValidationError
from aiq_agent.skills.models import build_skill_from_payload

logger = logging.getLogger(__name__)

# @environment_variable GRID_SKILLS_CACHE_TTL_SECONDS
# @category Server
# @type int
# @required false
# Seconds an org's resolved skill set is cached before re-resolving via the
# BFF internal endpoint. Default 60. Invalid values fall back to 60.
_DEFAULT_TTL_SECONDS = 60
_REQUEST_TIMEOUT_SECONDS = 5.0

#: Agents allowed in the ``grid-agents`` metadata comma-list.
_KNOWN_AGENTS = frozenset({"shallow_researcher", "deep_research_agent"})


def _cache_ttl_seconds() -> float:
    raw = os.environ.get("GRID_SKILLS_CACHE_TTL_SECONDS")
    if not raw:
        return float(_DEFAULT_TTL_SECONDS)
    try:
        ttl = int(raw)
    except ValueError:
        return float(_DEFAULT_TTL_SECONDS)
    return float(ttl) if ttl > 0 else float(_DEFAULT_TTL_SECONDS)


def _agent_allows(skill: Skill, agent: str | None) -> bool:
    """Respect the ``grid-agents`` metadata: absent = all agents."""
    if agent is None:
        return True
    allowed = skill.metadata.get("grid-agents")
    if not allowed:
        return True
    return agent in {name.strip() for name in allowed.split(",")}


def _skill_applies_to_agent(skill: Skill, agent: str | None) -> bool:
    if not _agent_allows(skill, agent):
        return False
    execution = skill.metadata.get("grid-execution")
    if execution is None:
        return True
    if execution == "chat":
        return agent in {None, "shallow_researcher"}
    if execution == "deep-research":
        return agent == "deep_research_agent"
    return True


def _build_org_skills(payload: Any) -> list[Skill]:
    """Strictly validate the BFF skill list; drop malformed rows individually."""
    if not isinstance(payload, list):
        return []
    skills: list[Skill] = []
    for row in payload:
        if not isinstance(row, dict):
            logger.warning("Dropping malformed org skill row (not an object)")
            continue
        payload_flat = {
            "name": row.get("name"),
            "description": row.get("description"),
            "body": row.get("body"),
            "metadata": row.get("metadata") or {},
            "license": row.get("license"),
            "compatibility": row.get("compatibility"),
            "allowed_tools": row.get("allowed_tools"),
        }
        try:
            skill = build_skill_from_payload(payload_flat, origin="org")
        except SkillValidationError as exc:
            logger.warning("Dropping invalid org skill row: %s", exc)
            continue
        skills.append(skill)
    return skills


class SkillResolver:
    """Resolves the effective skill set for a run: builtin + org, shadows applied.

    Instances are cheap and reentrant; the platform set is loaded once per
    instance and the org set is served from the shared cache on the hot path.
    """

    def __init__(self, agent: str | None = None) -> None:
        self.agent = agent
        self._builtin_by_name: dict[str, Skill] | None = None

    @property
    def builtin(self) -> tuple[Skill, ...]:
        if self._builtin_by_name is None:
            self._builtin_by_name = {s.name: s for s in discover_builtin_skills()}
        return tuple(self._builtin_by_name.values())

    def resolve(self, organization_id: str | None = None) -> tuple[Skill, ...]:
        """Builtin + org skills for the current org, org rows shadowing builtins.

        Fails open to the builtin set on any fetch/validation error.
        """
        merged_by_name: dict[str, Skill] = {s.name: s for s in self.builtin}
        if organization_id:
            merged_by_name.update({s.name: s for s in self._resolve_org_skills(organization_id)})
        return tuple(skill for skill in merged_by_name.values() if _skill_applies_to_agent(skill, self.agent))

    def _resolve_org_skills(self, organization_id: str) -> tuple[Skill, ...]:
        cache_key = f"skills:{organization_id}:{self.agent or '_all'}"
        cached = shared_cache.get_json(cache_key)
        if cached is not None and isinstance(cached, list):
            known = self._known_org_names(cached)
            if known is not None:
                return self._org_skills_from_rows(cached, known)
        try:
            rows = self._fetch_org_skills(organization_id)
        except Exception as exc:  # noqa: BLE001 - fail open to builtins by design
            logger.warning("Org skill resolution failed for org %s: %s", organization_id, type(exc).__name__)
            return ()
        known = self._known_org_names(rows)
        if known is None:
            return ()
        shared_cache.set_json(cache_key, rows, _cache_ttl_seconds())
        return self._org_skills_from_rows(rows, known)

    def _known_org_names(self, rows: Any) -> set[str] | None:
        """Names a cached/remote payload REALLY carries; None when unparseable."""
        if not isinstance(rows, list):
            logger.warning("Org skill payload is not a list; ignoring")
            return None
        names: set[str] = set()
        for row in rows:
            if not isinstance(row, dict):
                logger.warning("Dropping malformed org skill row (not an object)")
                continue
            name = row.get("name")
            if not isinstance(name, str) or not (0 < len(name) <= MAX_NAME_CHARS):
                logger.warning("Dropping org skill row without a valid name")
                continue
            names.add(name)
        return names

    def _org_skills_from_rows(self, rows: list[Any], known: set[str]) -> tuple[Skill, ...]:
        return tuple(s for s in _build_org_skills(rows) if s.name in known)

    def _fetch_org_skills(self, organization_id: str) -> list[Any]:
        token = os.environ.get("GRID_INTERNAL_API_TOKEN")
        if not token:
            raise RuntimeError("GRID_INTERNAL_API_TOKEN unset; org skills unavailable")
        import httpx

        base_url = (os.environ.get("FRONTEND_INTERNAL_URL") or "http://frontend:3000").rstrip("/")
        response = httpx.get(
            f"{base_url}/api/internal/skills/resolve",
            params={"organizationId": organization_id, "agent": self.agent or ""},
            headers={"x-grid-internal-token": token},
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("skills/resolve returned a non-object payload")
        return payload.get("skills", [])
