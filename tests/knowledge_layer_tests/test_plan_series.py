"""Planstand parsing and series grouping, held to the cases the TS twin is held to.

The cases live in ``tests/fixtures/plan_series_cases.json``, shared with
``frontends/ui/src/features/documents/lib/plan-series.spec.ts``. Both sides read
the same names the same way, so the folder brief and the agent's ``list_files``
cannot disagree about which Planstand is current. Do not edit the fixture to make
a case pass here; a difference is a finding to report.
"""

import json
import re
from pathlib import Path
from typing import Any

import pytest

from sources.knowledge_layer.src.plan_series import PlanName
from sources.knowledge_layer.src.plan_series import find_plan_series
from sources.knowledge_layer.src.plan_series import parse_plan_name
from sources.knowledge_layer.src.plan_series import plan_revision_label

CASES: dict[str, Any] = json.loads(
    (Path(__file__).parents[2] / "tests" / "fixtures" / "plan_series_cases.json").read_text(encoding="utf-8")
)
PARSE_CASES: list[dict[str, Any]] = CASES["parse"]
SERIES_CASES: list[dict[str, Any]] = CASES["series"]


@pytest.mark.parametrize("case", PARSE_CASES, ids=[case["name"] for case in PARSE_CASES])
def test_parse_plan_name(case: dict[str, Any]) -> None:
    plan = parse_plan_name(case["name"])
    if case["key"] is None:
        assert plan is None
        return
    assert plan is not None
    assert plan.key == case["key"]
    assert ([plan.index.kind, plan.index.value] if plan.index is not None else None) == case["index"]
    assert plan.date == case["date"]


@pytest.mark.parametrize("case", SERIES_CASES, ids=[f"case {i}" for i in range(len(SERIES_CASES))])
def test_find_plan_series(case: dict[str, Any]) -> None:
    series = find_plan_series(
        case["files"],
        filename=lambda file: file["name"],
        created_at=lambda file: file["createdAt"],
    )
    actual = [
        {
            # The series key carries the format; the TS spec strips it the same way before comparing.
            "key": re.sub(r"\.[a-z0-9]+\Z", "", entry.key),
            "current": entry.current.item["id"],
            "older": [member.item["id"] for member in entry.older],
        }
        for entry in series
    ]
    assert actual == case["expect"]


def _plan(name: str) -> PlanName:
    plan = parse_plan_name(name)
    assert plan is not None
    return plan


def test_plan_revision_label_reads_as_an_office_writes_it() -> None:
    assert plan_revision_label(_plan("EG_Grundriss_Index_C_2026-08-14.pdf")) == "Index C · 14.08.2026"
    assert plan_revision_label(_plan("Lageplan_v3.pdf")) == "v3"
    assert plan_revision_label(_plan("Ansicht Nord Stand 02.09.2026.pdf")) == "02.09.2026"
