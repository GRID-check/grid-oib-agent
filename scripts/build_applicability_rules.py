#!/usr/bin/env python3
"""Generate the TypeScript applicability rules + parity fixtures from the norm registry.

The single source of truth for applicability is the norm registry's
``applicability:`` blocks (``configs/norms/<country>/registry.yml``, ADR-0025
Phase 4). This script renders them into:

- ``frontends/ui/src/lib/oib/applicability-rules.generated.ts`` — the typed
  rules consumed by the BFF applicability evaluator (first-match-wins,
  same semantics as ``aiq_agent.common.applicability.resolve_applicability``).
- ``frontends/ui/src/lib/oib/applicability-parity.generated.json`` — fixture
  profiles with the verdicts computed by the Python resolver, so the vitest
  suite can assert both engines agree bit-for-bit.

Run::

    uv run --frozen python scripts/build_applicability_rules.py          # write
    uv run --frozen python scripts/build_applicability_rules.py --check  # drift check (CI)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from aiq_agent.common.applicability import resolve_applicability
from aiq_agent.common.norm_registry import NormRegistry
from aiq_agent.common.norm_registry import load_registry

REPO_ROOT = Path(__file__).resolve().parents[1]
TS_OUT = REPO_ROOT / "frontends" / "ui" / "src" / "lib" / "oib" / "applicability-rules.generated.ts"
PARITY_OUT = REPO_ROOT / "frontends" / "ui" / "src" / "lib" / "oib" / "applicability-parity.generated.json"

_HEADER = """/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: configs/norms/<country>/registry.yml (`applicability:` blocks, ADR-0025 Phase 4).
 * Regenerate: uv run --frozen python scripts/build_applicability_rules.py
 */
"""

_TYPES = """
export type ApplicabilityOp = 'eq' | 'in' | 'defined' | 'undefined' | 'gt' | 'gte' | 'lt' | 'lte'

export interface ApplicabilityCondition {
  fact: string
  op: ApplicabilityOp
  value?: string | number | Array<string | number>
}

export interface ApplicabilityWhen {
  all?: ApplicabilityCondition[]
  any?: ApplicabilityCondition[]
}

export type ApplicabilityVerdictStatus = 'required' | 'likely' | 'check'

export interface ApplicabilityRule {
  when?: ApplicabilityWhen
  verdict: ApplicabilityVerdictStatus
  reasonDe: string
  reasonEn: string
}

export interface NormApplicability {
  normId: string
  short: string
  titleDe: string
  rules: ApplicabilityRule[]
}
"""

# Fixture profiles (fact id -> value) mirrored by the vitest parity test. Each
# profile exercises a different branch of the rule set; expected verdicts are
# computed by the Python resolver below, never hand-written here.
PARITY_PROFILES: list[tuple[str, dict[str, object]]] = [
    ("wohnen-gk2-lowrise", {"hauptnutzung": "wohnen", "gebaeudeklasse": "GK2", "fluchtniveau": "<=7m"}),
    ("hochhaus", {"hauptnutzung": "wohnen", "gebaeudeklasse": "GK5", "fluchtniveau": ">22m"}),
    ("gk5-unknown-fluchtniveau", {"hauptnutzung": "wohnen", "gebaeudeklasse": "GK5"}),
    ("lager-basement", {"hauptnutzung": "lager", "geschosse_unterirdisch": 2}),
    ("produzierend", {"hauptnutzung": "produzierend"}),
    ("buero-public", {"hauptnutzung": "buero"}),
    ("landwirtschaft", {"hauptnutzung": "landwirtschaft"}),
    (
        "wien-kleingarten",
        {"bundesland": "wien", "hauptnutzung": "wohnen", "kleingartengebiet": True},
    ),
    ("noe-kleingarten", {"bundesland": "niederoesterreich", "hauptnutzung": "wohnen", "kleingartengebiet": True}),
    ("denkmal", {"hauptnutzung": "wohnen", "denkmalschutz": True}),
    ("betriebsanlage", {"hauptnutzung": "produzierend", "betriebsanlage": True}),
    (
        "wien-stellplatz",
        {"bundesland": "wien", "hauptnutzung": "buero", "stellplatz_relevant": True},
    ),
]


def _condition_dict(cond) -> dict:
    out: dict[str, object] = {"fact": cond.fact, "op": cond.op}
    if cond.value is not None:
        out["value"] = cond.value
    return out


def _when_dict(when) -> dict | None:
    if when is None:
        return None
    out: dict[str, object] = {}
    if when.all:
        out["all"] = [_condition_dict(c) for c in when.all]
    if when.any:
        out["any"] = [_condition_dict(c) for c in when.any]
    return out


def _rules_payload(registry: NormRegistry) -> list[dict]:
    payload = []
    for entry in registry.entries:
        if not entry.applicability:
            continue
        rules = []
        for rule in entry.applicability:
            rendered: dict[str, object] = {
                "verdict": rule.verdict,
                "reasonDe": rule.reason_de,
                "reasonEn": rule.reason_en,
            }
            when = _when_dict(rule.when)
            if when:
                rendered["when"] = when
            rules.append(rendered)
        payload.append({"normId": entry.id, "short": entry.short, "titleDe": entry.title, "rules": rules})
    return payload


def render_ts(registry: NormRegistry) -> str:
    payload = json.dumps(_rules_payload(registry), indent=2, ensure_ascii=False)
    return f"{_HEADER}{_TYPES}\nexport const APPLICABILITY_RULES: NormApplicability[] = {payload}\n"


def render_parity(registry: NormRegistry) -> str:
    fixtures = []
    for name, facts in PARITY_PROFILES:
        verdicts = resolve_applicability(registry, dict(facts))
        expected = {
            norm_id: {"verdict": verdict.verdict, "reasonDe": verdict.reason_de, "reasonEn": verdict.reason_en}
            for norm_id, verdict in verdicts.items()
        }
        fixtures.append({"name": name, "facts": facts, "expected": expected})
    return json.dumps(fixtures, indent=2, ensure_ascii=False) + "\n"


def _write_if_changed(path: Path, content: str, check: bool) -> bool:
    current = path.read_text(encoding="utf-8") if path.exists() else None
    if current == content:
        return True
    if check:
        print(f"DRIFT: {path.relative_to(REPO_ROOT)} is stale — regenerate with this script", file=sys.stderr)
        return False
    path.write_text(content, encoding="utf-8", newline="\n")
    print(f"wrote {path.relative_to(REPO_ROOT)}")
    return True


def main(argv: list[str]) -> int:
    check = "--check" in argv
    registry = load_registry()
    if registry is None:
        print("norm registry unavailable — nothing to generate", file=sys.stderr)
        return 1
    ok = _write_if_changed(TS_OUT, render_ts(registry), check)
    ok = _write_if_changed(PARITY_OUT, render_parity(registry), check) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
