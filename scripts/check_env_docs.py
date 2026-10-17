#!/usr/bin/env python3

"""Every environment variable the queue workers read has a row in the env reference.

``AGENTS.md`` asks for a row in ``docs/deployment/environment-variables.md`` for
every variable a change adds, and nothing checked it, so an operator tuning a
worker found the knob only by reading its source. This checks the files that
claim, heartbeat, reap and purge (``SCOPE``); a wider scope joins once it passes.

A Python read is a literal passed to ``os.environ``/``getenv``, to an
``*_env``/``_flag`` reader, or assigned to an ``*_ENV`` constant. A JavaScript or
TypeScript read is ``env.NAME`` or ``env['NAME']``. A row is a table line that
starts ``| `NAME` |``.

Usage: python scripts/check_env_docs.py. Exit code 0 when every name has a row.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

DOC = Path("docs/deployment/environment-variables.md")

SCOPE = (
    "frontends/aiq_api/src/aiq_api/jobs/*.py",
    "src/aiq_agent/knowledge/ingest_*.py",
    "frontends/ui/workers/*.js",
    "frontends/ui/purger/*.js",
    "frontends/ui/scheduler/*.js",
    "frontends/ui/src/lib/jobs-queue/*.ts",
    "frontends/ui/src/lib/mail-import/*.ts",
    "frontends/ui/src/lib/inbound-mail/*.ts",
)

#: Read but not ours to document: the container runtime sets it.
NOT_OURS = frozenset({"HOSTNAME"})

_NAME = r"([A-Z][A-Z0-9_]*)"
PY_READ = re.compile(rf"""(?:environ\.get\(|environ\[|getenv\(|_env\(|_flag\()\s*["']{_NAME}["']""")
PY_CONST = re.compile(rf"""^\s*\w*_ENV\s*=\s*["']{_NAME}["']""", re.MULTILINE)
JS_READ = re.compile(rf"""\benv(?:\.{_NAME}|\[['"]{_NAME}['"]\])""")
DOC_ROW = re.compile(rf"^\|\s*`{_NAME}`\s*\|", re.MULTILINE)


def names_read(path: str, source: str) -> set[str]:
    """The environment variables ``source`` (the file at ``path``) reads."""
    if path.endswith(".py"):
        return set(PY_READ.findall(source)) | set(PY_CONST.findall(source))
    return {dotted or indexed for dotted, indexed in JS_READ.findall(source)}


def undocumented(sources: dict[str, str], doc: str) -> dict[str, list[str]]:
    """Each name read in ``sources`` with no row in ``doc``, with the files that read it."""
    rows = set(DOC_ROW.findall(doc))
    missing: dict[str, list[str]] = {}
    for path, source in sorted(sources.items()):
        for name in sorted(names_read(path, source) - rows - NOT_OURS):
            missing.setdefault(name, []).append(path)
    return missing


def _scoped_files() -> list[str]:
    listed = subprocess.run(["git", "ls-files", "--", *SCOPE], capture_output=True, text=True, check=True)
    return [path for path in listed.stdout.split() if ".spec." not in path and not path.endswith(".d.ts")]


def main() -> int:
    sources = {path: Path(path).read_text(encoding="utf-8") for path in _scoped_files()}
    missing = undocumented(sources, DOC.read_text(encoding="utf-8"))
    for name, paths in missing.items():
        print(f"{name} is read by {', '.join(paths)} and has no row in {DOC}", file=sys.stderr)
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
