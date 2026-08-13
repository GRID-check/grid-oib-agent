"""What models asked the spatial surface for and did not get — as a report.

The ledger at ``AIQ_CAPABILITY_GAP_LOG`` (default ``/tmp/aiq-capability-gaps.jsonl``)
collects one kind of row: a caller asked for a name this surface does not have.
Not a refusal about somebody's export, not a wrong GlobalId — a missing feature.
This renders it as a ranked table you can paste into an issue.

Run with::

    uv run python scripts/capability_gaps_report.py
    uv run python scripts/capability_gaps_report.py --path /var/log/aiq/gaps.jsonl

Deliberately a report and not a filing. There is somebody's notifications on the
other end of an issue, and a surface that opens one automatically the first time
a model invents a word is a spam generator. This produces the body; a person
decides whether it is worth one.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from aiq_agent.agents.bim.capability_gaps import ledger_path  # noqa: E402
from aiq_agent.agents.bim.capability_gaps import render_report  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--path", type=Path, default=None, help="ledger to read (default: AIQ_CAPABILITY_GAP_LOG)")
    arguments = parser.parse_args()

    target = arguments.path or ledger_path()
    print(f"# Quelle: {target}\n", file=sys.stderr)
    print(render_report(arguments.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
