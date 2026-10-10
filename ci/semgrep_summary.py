#!/usr/bin/env python3
"""Markdown summary of a Semgrep JSON report, for $GITHUB_STEP_SUMMARY.

Usage: semgrep_summary.py <semgrep.json> <what the findings are>
"""

from __future__ import annotations

import collections
import json
import sys
from pathlib import Path

SHOWN = 50


def summary(results: list[dict], scope: str) -> str:
    lines = ["## Semgrep SAST", "", f"**{len(results)} finding(s)**: {scope}.", ""]
    if not results:
        return "\n".join(lines)
    severities = collections.Counter(r.get("extra", {}).get("severity", "INFO") for r in results)
    lines += ["| Severity | Count |", "|---|---|"]
    lines += [f"| {s} | {severities[s]} |" for s in ("ERROR", "WARNING", "INFO") if severities.get(s)]
    lines += ["", "| Rule | File | Line |", "|---|---|---|"]
    for r in results[:SHOWN]:
        rule = r.get("check_id", "").split(".")[-1]
        lines.append(f"| `{rule}` | {r.get('path', '')} | {r.get('start', {}).get('line', '')} |")
    if len(results) > SHOWN:
        lines += ["", f"...and {len(results) - SHOWN} more in the job log."]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    report = Path(argv[0])
    if not report.exists():
        print("## Semgrep SAST\n\nNo JSON output produced.")
        return 0
    print(summary(json.loads(report.read_text()).get("results", []), argv[1] if len(argv) > 1 else "findings"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
