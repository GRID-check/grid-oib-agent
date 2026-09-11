"""The boot line's format, pinned on the Python side.

Same table as ``frontends/ui/tests/lib/boot.test.ts``. The two services print
the same line so one ``grep '^\\[boot\\]'`` over a deployment answers "what is
this running, and which gates are on" for both tiers at once; that only holds
if both sides agree on the format down to the casing of ``true``, which is what
these cases assert. The cases are duplicated rather than shared through a
fixture on purpose — a fixture would pin the format to itself, and what needs
pinning is the *rendered line*, which is what an operator actually greps.
"""

from __future__ import annotations

import logging

import pytest

from aiq_api.startup_banner import UNKNOWN_SHA
from aiq_api.startup_banner import boot_flags
from aiq_api.startup_banner import boot_line
from aiq_api.startup_banner import deployed_sha
from aiq_api.startup_banner import format_boot_line
from aiq_api.startup_banner import log_boot_line

# (name, env, expected line) — byte-identical to the TypeScript spec's table.
CASES = [
    (
        "an unstamped image with nothing configured — the compose defaults",
        {},
        "[boot] sha=unknown skills=false collaboration=false enforceFlags=false agentDocs=true",
    ),
    (
        "a published image with every gate on",
        {
            "GRID_GIT_SHA": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",  # pragma: allowlist secret
            "GRID_SKILLS_ENABLED": "true",
            "GRID_COLLABORATION_ENABLED": "true",
            "GRID_ENFORCE_FEATURE_FLAGS": "true",
            "GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED": "true",
        },
        "[boot] sha=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c "  # pragma: allowlist secret
        "skills=true collaboration=true enforceFlags=true agentDocs=true",
    ),
    (
        "filing withdrawn fleet-wide — the one gate that is off by being SET",
        {"GRID_GIT_SHA": "abc1234", "GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED": "false"},
        "[boot] sha=abc1234 skills=false collaboration=false enforceFlags=false agentDocs=false",
    ),
    (
        "the other falsey spellings agentAuthoredDocumentsEnvEnabled accepts",
        {"GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED": "OFF"},
        "[boot] sha=unknown skills=false collaboration=false enforceFlags=false agentDocs=false",
    ),
    (
        'an opt-in gate is not turned on by "1" — only the exact word true',
        {"GRID_SKILLS_ENABLED": "1", "GRID_COLLABORATION_ENABLED": "yes"},
        "[boot] sha=unknown skills=false collaboration=false enforceFlags=false agentDocs=true",
    ),
    (
        "whitespace and case, as an env_file or a copy-paste produces them",
        {"GRID_GIT_SHA": "  deadbeef  ", "GRID_ENFORCE_FEATURE_FLAGS": " TRUE "},
        "[boot] sha=deadbeef skills=false collaboration=false enforceFlags=true agentDocs=true",
    ),
    (
        "an empty GRID_GIT_SHA is an unstamped image, not an empty sha",
        {"GRID_GIT_SHA": ""},
        "[boot] sha=unknown skills=false collaboration=false enforceFlags=false agentDocs=true",
    ),
]


@pytest.mark.parametrize(("name", "env", "expected"), CASES, ids=[c[0] for c in CASES])
def test_the_line_renders_the_same_as_the_bff_does(name: str, env: dict, expected: str) -> None:
    assert boot_line(env) == expected
    assert format_boot_line(deployed_sha(env), boot_flags(env)) == expected


def test_an_unstamped_image_is_named_rather_than_left_blank() -> None:
    # "sha=" in a log reads as a truncation; "unknown" reads as the fact.
    assert deployed_sha({}) == UNKNOWN_SHA
    assert f"sha={UNKNOWN_SHA}" in boot_line({})


@pytest.mark.parametrize(("name", "env", "expected"), CASES, ids=[c[0] for c in CASES])
def test_it_is_one_line_because_an_operator_greps_for_it(name: str, env: dict, expected: str) -> None:
    line = boot_line(env)
    assert "\n" not in line
    assert line.startswith("[boot] ")


def test_the_booleans_are_javascript_cased_so_one_grep_covers_both_tiers() -> None:
    # Python's repr would print `True`, which would split the one grep the
    # shared format exists to make possible.
    line = boot_line({"GRID_SKILLS_ENABLED": "true"})
    assert "skills=true" in line
    assert "True" not in line


def test_log_boot_line_emits_at_info_and_returns_what_it_logged(caplog, monkeypatch) -> None:
    monkeypatch.delenv("GRID_GIT_SHA", raising=False)
    monkeypatch.setenv("GRID_SKILLS_ENABLED", "true")

    with caplog.at_level(logging.INFO, logger="aiq_api.startup_banner"):
        line = log_boot_line()

    assert line == boot_line(dict(__import__("os").environ))
    assert any(record.getMessage() == line for record in caplog.records)


def test_build_app_prints_it_before_anything_else_registers() -> None:
    """The line is worthless if a crash during route registration precedes it.

    Reading the source rather than building the app: ``build_app`` pulls the
    whole NAT front-end stack, which this suite cannot stand up, and what
    matters here is ORDER — that ``log_boot_line()`` sits ahead of
    ``super().build_app()``, so a container that fails to come up has still
    said which build failed.
    """
    from pathlib import Path

    source = (Path(__file__).resolve().parents[1] / "src/aiq_api/plugin.py").read_text(encoding="utf-8")
    assert "log_boot_line()" in source, "plugin.py no longer emits the boot line"
    assert source.index("log_boot_line()") < source.index("app = super().build_app()")
