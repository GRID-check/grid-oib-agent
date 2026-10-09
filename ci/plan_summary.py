"""Write the Plan job's decisions to the run summary, as Markdown on stdout.

Every other job in ci.yml runs or skips on the Plan job's answers, and a skipped
job reads as passed. So the run page states those answers and the reason for
each: which commit the change was diffed against and why, whether a green pull
request run was reused, which tiers run, which images are built and which are
re-tagged, which pins trivy scans. A reviewer asking "why did the backend not
run?" reads it here instead of in a step log.

Reads the Plan job's step outputs from the environment (ci.yml passes them):
EVENT, BASE, BASE_REASON, REUSED, TIERS (JSON object), BUILD, IMAGES, PINS
(JSON lists).
"""

from __future__ import annotations

import json
import os
import sys

TIER_ORDER = ("backend", "frontend", "web", "infra", "packages", "sast")


def _short(sha: str) -> str:
    return f"`{sha[:12]}`" if sha else "none"


def render(env: dict[str, str]) -> str:
    event = env.get("EVENT", "")
    reused = env.get("REUSED") == "true"
    tiers = json.loads(env.get("TIERS") or "{}")
    build = {entry["name"] for entry in json.loads(env.get("BUILD") or "[]")}
    images = json.loads(env.get("IMAGES") or "[]")
    pins = json.loads(env.get("PINS") or "[]")

    lines = ["## Plan", ""]
    if event == "pull_request":
        base = _short(env.get("BASE", ""))
        lines.append(f"Diffed against the pull request's base, {base}: the whole PR, every push.")
    else:
        reason = env.get("BASE_REASON") or "no reason recorded"
        lines.append(f"Diffed against {_short(env.get('BASE', ''))}: {reason}.")
    lines.append("")

    if reused:
        lines.append(
            "**Reused.** A green pull request run already tested this exact tree on a green parent, "
            "so every check skips."
        )
    else:
        lines += ["| Tier | Runs |", "|---|---|"]
        lines += [f"| {tier} | {'yes' if tiers.get(tier) == 'true' else 'no'} |" for tier in TIER_ORDER]
    lines.append("")

    if images:
        verb = "build (pushes nothing)" if event == "pull_request" else "build and push"
        lines += ["| Image | Content tag | This run |", "|---|---|---|"]
        for entry in images:
            action = verb if entry["name"] in build else "nothing to build"
            lines.append(f"| {entry['name']} | `inputs-{entry['hash']}` | {action} |")
        lines.append("")

    lines.append(
        "Image pins added or moved, scanned by trivy: " + (", ".join(f"`{pin}`" for pin in pins) if pins else "none.")
    )
    return "\n".join(lines) + "\n"


def main() -> int:
    sys.stdout.write(render(dict(os.environ)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
