"""A stage's runtime switch is a WIRE CONTRACT, so both ends must agree on it.

Which post-answer stages run for an organization is decided by the BFF and read
by the backend per turn (`GET /api/internal/stages` → `resolve_enabled_stages`).
The backend declares each stage's `id`, `flag_slug` and `env_default`; the BFF's
`POST_ANSWER_STAGE_FLAGS` decides on exactly those three values. Nothing checks
that they are the same three values.

Drift is silent in both directions, and both directions have already been
described in a comment asking the next person to keep the sets in step —
`feature-flags.ts` says "a stage the backend declares but this registry omits can
never be switched on". This is that comment, enforced, the same way
`test_agent_group_parity` enforces the `AgentGroup` mirror:

- a stage the backend declares and the BFF omits is never in the served set, so
  it is `disabled / flag_off` on every turn forever, with nothing logged and no
  way for an operator to switch it on;
- a slug that differs between the two ends means the WorkOS flag an operator
  turns on is not the flag that gets evaluated;
- an `env_default` that differs means the documented environment variable is not
  the one that is read.

Parsed rather than exported, for the same reason as the agent-group mirror: a
generated file would be one more thing to keep in sync, and a mismatch here is a
one-line fix on whichever side is behind.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from aiq_agent.stages import iter_stages

_MIRROR = Path("frontends/ui/src/lib/workos/feature-flags.ts")
_REGISTRY = Path("frontends/ui/src/lib/authz/feature-flags.ts")


@pytest.fixture(scope="module")
def mirror_source() -> str:
    if not _MIRROR.is_file():
        pytest.skip("frontend not present in this checkout")
    return _MIRROR.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def registry_source() -> str:
    if not _REGISTRY.is_file():
        pytest.skip("frontend not present in this checkout")
    return _REGISTRY.read_text(encoding="utf-8")


def _registry_slugs(registry: str) -> dict[str, str]:
    """``{key: slug}`` from the ``FEATURE_FLAGS`` registry object."""
    block = re.search(r"export const FEATURE_FLAGS = \{(.*?)\n\}", registry, re.DOTALL)
    assert block, "the FEATURE_FLAGS registry was not found"
    return dict(re.findall(r"^\s+(\w+): '([^']+)',", block.group(1), re.MULTILINE))


def _mirrored_stages(source: str, registry: str) -> dict[str, tuple[str, str]]:
    """``{id: (flag, envVar)}`` from the BFF's stage-flag registry.

    ``flag`` is written as a constant reference (``MEMORY_REFLECTION_FLAG``), so
    the constant's own declaration is resolved to its slug — otherwise this would
    compare a slug against a variable name and pass over nothing. The constant is
    either a literal or a key of the ``FEATURE_FLAGS`` registry, which is the one
    place slugs are written; both forms are followed to the slug.
    """
    slugs = dict(re.findall(r"^export const (\w+_FLAG) = '([^']+)'", source, re.MULTILINE))
    keys = _registry_slugs(registry)
    for name, key in re.findall(r"^export const (\w+_FLAG) = FEATURE_FLAGS\.(\w+)", source, re.MULTILINE):
        assert key in keys, f"{name} names FEATURE_FLAGS.{key}, which the registry does not declare"
        slugs[name] = keys[key]
    block = re.search(
        r"POST_ANSWER_STAGE_FLAGS:\s*readonly PostAnswerStageFlag\[\]\s*=\s*\[(.*?)\n\]", source, re.DOTALL
    )
    assert block, "the POST_ANSWER_STAGE_FLAGS registry was not found in the frontend mirror"
    entries = re.findall(
        r"id:\s*'([^']+)',\s*\n\s*flag:\s*([\w']+),\s*\n\s*envVar:\s*'([^']+)'",
        block.group(1),
    )
    return {stage_id: (slugs.get(flag, flag.strip("'")), env) for stage_id, flag, env in entries}


def test_every_declared_stage_can_be_switched_on(mirror_source: str, registry_source: str):
    assert set(_mirrored_stages(mirror_source, registry_source)) == {spec.id for spec in iter_stages()}


def test_each_stage_is_gated_by_the_slug_and_env_var_it_declares(mirror_source: str, registry_source: str):
    mirrored = _mirrored_stages(mirror_source, registry_source)
    assert {spec.id: (spec.flag_slug, spec.env_default) for spec in iter_stages()} == mirrored


def test_the_mirror_actually_parses(mirror_source: str, registry_source: str):
    """Guards the guard: a regex that stopped matching would compare two empty
    collections and pass over nothing at all."""
    assert len(_registry_slugs(registry_source)) >= 5
    mirrored = _mirrored_stages(mirror_source, registry_source)
    assert len(mirrored) >= 2
    assert all(flag and env for flag, env in mirrored.values())
