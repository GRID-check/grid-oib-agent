"""The run summary states each Plan decision and its reason.

A skipped job reads as passed, so a summary that shows the wrong tier as
running, or hides why a push diffed against the root commit, misleads exactly
the reader who opened it to find out why something did not run.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
IMAGES = [
    {"name": "backend", "hash": "b" * 16},
    {"name": "frontend", "hash": "f" * 16},
]


@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("plan_summary", ROOT / "ci" / "plan_summary.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_a_push_names_its_diff_base_and_the_reason(mod):
    text = mod.render(
        {
            "EVENT": "push",
            "BASE": "a" * 40,
            "BASE_REASON": "no green push run is an ancestor of HEAD; diffing against the root commit",
            "TIERS": json.dumps({"backend": "true", "frontend": "false"}),
            "BUILD": json.dumps(IMAGES[:1]),
            "IMAGES": json.dumps(IMAGES),
            "PINS": "[]",
        }
    )

    assert "Diffed against `aaaaaaaaaaaa`: no green push run is an ancestor of HEAD" in text
    assert "| backend | yes |" in text and "| frontend | no |" in text
    assert f"| backend | `inputs-{'b' * 16}` | build and push |" in text
    assert f"| frontend | `inputs-{'f' * 16}` | nothing to build |" in text
    assert text.endswith("scanned by trivy: none.\n")


def test_a_pull_request_builds_without_pushing_and_lists_its_pins(mod):
    text = mod.render(
        {
            "EVENT": "pull_request",
            "BASE": "c" * 40,
            "TIERS": json.dumps({"infra": "true"}),
            "BUILD": json.dumps(IMAGES[1:]),
            "IMAGES": json.dumps(IMAGES),
            "PINS": json.dumps(["langfuse/langfuse@sha256:1"]),
        }
    )

    assert "the whole PR, every push" in text
    assert "| infra | yes |" in text and "| backend | no |" in text
    assert "| frontend | `inputs-ffffffffffffffff` | build (pushes nothing) |" in text
    assert "`langfuse/langfuse@sha256:1`" in text


def test_a_reused_run_says_why_nothing_runs_instead_of_a_table_of_noes(mod):
    text = mod.render({"EVENT": "push", "BASE": "d" * 40, "BASE_REASON": "x", "REUSED": "true"})

    assert "**Reused.**" in text and "| Tier |" not in text
