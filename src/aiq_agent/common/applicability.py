"""Applicability engine: registry rules -> per-norm verdicts from project facts.

Single source of truth for "which norms apply to this project" (spec §6.2,
ADR-0025 Phase 4). The rules live on registry entries as ``applicability[]``
(pinned DSL: first-match-wins, ``all``/``any`` condition groups); this module
evaluates them against a flat fact dict. The TS side consumes the same rules
via codegen so the Overview UI and the backend prompts never diverge.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any
from typing import Literal

from aiq_agent.common.norm_registry import ApplicabilityCondition
from aiq_agent.common.norm_registry import ApplicabilityWhen
from aiq_agent.common.norm_registry import NormRegistry

logger = logging.getLogger(__name__)

Facts = dict[str, Any]
VerdictName = Literal["required", "likely", "check"]


@dataclass(frozen=True)
class ApplicabilityVerdict:
    """One entry's resolved verdict for a project."""

    norm_id: str
    verdict: VerdictName
    reason_de: str
    reason_en: str


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _is_defined(value: Any) -> bool:
    return value is not None and value != ""


def _values_equal(a: Any, b: Any) -> bool:
    num_a, num_b = _as_number(a), _as_number(b)
    if num_a is not None and num_b is not None:
        return num_a == num_b
    # Booleans cross the language boundary as "true"/"false" strings (profile
    # JSON keeps real booleans, the PROJECT_CONTEXT text view renders strings):
    # compare either representation against the other.
    if isinstance(a, bool) or isinstance(b, bool):
        return str(a).lower() == str(b).lower()
    return a == b


def evaluate_condition(cond: ApplicabilityCondition, facts: Facts) -> bool:
    fact = facts.get(cond.fact)
    op = cond.op
    if op == "defined":
        return _is_defined(fact)
    if op == "undefined":
        return not _is_defined(fact)
    if op == "eq":
        if not _is_defined(fact):
            return False
        return _values_equal(fact, cond.value)
    if op == "in":
        if not _is_defined(fact):
            return False
        options = cond.value if isinstance(cond.value, list) else [cond.value]
        return any(_values_equal(fact, option) for option in options)
    if op in ("gt", "gte", "lt", "lte"):
        num, want = _as_number(fact), _as_number(cond.value)
        if num is None or want is None:
            return False
        if op == "gt":
            return num > want
        if op == "gte":
            return num >= want
        if op == "lt":
            return num < want
        return num <= want
    logger.warning("applicability: unknown operator %r on fact %r", op, cond.fact)
    return False


def evaluate_when(when: ApplicabilityWhen | None, facts: Facts) -> bool:
    if when is None:
        return True
    if when.all and not all(evaluate_condition(cond, facts) for cond in when.all):
        return False
    return not (when.any and not any(evaluate_condition(cond, facts) for cond in when.any))


def resolve_applicability(registry: NormRegistry, facts: Facts) -> dict[str, ApplicabilityVerdict]:
    """First matching rule per entry wins; entries with no match are omitted."""
    verdicts: dict[str, ApplicabilityVerdict] = {}
    for entry in registry.entries:
        for rule in entry.applicability:
            if evaluate_when(rule.when, facts):
                verdicts[entry.id] = ApplicabilityVerdict(
                    norm_id=entry.id,
                    verdict=rule.verdict,
                    reason_de=rule.reason_de,
                    reason_en=rule.reason_en,
                )
                break
    return verdicts


_VERDICT_LABELS_DE = {"required": "verbindlich", "likely": "voraussichtlich anwendbar", "check": "zu prüfen"}
_VERDICT_ORDER = ("required", "likely", "check")


def render_applicability_block(registry: NormRegistry, facts: Facts) -> str | None:
    """German prompt section listing the norms applicable to the parsed project facts.

    Verdicts are grouped in authority order (verbindlich → voraussichtlich
    anwendbar → zu prüfen), one line each with the rule's German reason.
    ``None`` when no entry matches — the caller omits the section then.
    """
    verdicts = resolve_applicability(registry, facts)
    if not verdicts:
        return None
    by_id = {entry.id: entry for entry in registry.entries}
    lines = ["### Anwendbare Normen", ""]
    for verdict in _VERDICT_ORDER:
        for norm_id, result in verdicts.items():
            if result.verdict != verdict:
                continue
            entry = by_id.get(norm_id)
            label = _VERDICT_LABELS_DE[verdict]
            short = entry.short if entry else norm_id
            title = entry.title if entry else norm_id
            lines.append(f"- **{short}** ({title}) — {label}: {result.reason_de}")
    return "\n".join(lines)


def facts_from_project_context(text: str) -> Facts:
    """Parse ``- key=value`` lines from the ``confirmed:`` section of PROJECT_CONTEXT."""
    facts: Facts = {}
    in_confirmed = False
    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if line.strip() == "confirmed:":
            in_confirmed = True
            continue
        if in_confirmed and line and not line.startswith((" ", "-")) and line.rstrip().endswith(":"):
            break
        if not in_confirmed:
            continue
        stripped = line.strip()
        if not stripped.startswith("-") or "=" not in stripped:
            continue
        key, _, value = stripped[1:].partition("=")
        key = key.strip()
        value = value.strip()
        if value.startswith('"'):
            try:
                value = json.loads(value)
            except ValueError:
                pass
        else:
            num = _as_number(value)
            if num is not None:
                value = int(num) if num == int(num) else num
        facts[key] = value
    return facts
