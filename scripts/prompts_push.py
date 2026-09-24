#!/usr/bin/env python3

"""Publish the committed platform prompt to Langfuse, or say what publishing would change.

Why this exists
---------------

ADR-0060 (a) decided the platform prompt's source of truth: **git**. The static
half lives in ``src/aiq_agent/agents/piloti/prompts/piloti_static.md``, review
reads it, and it is PUSHED to Langfuse, where labels carry experiments. Only
the pull (``task prompts:pull``) was ever built, so with prompt management on,
every change to that file — including the ones code depends on, like the
envelope's field order the answer stream reads (ADR-0066) — would reach the
fleet only if someone re-typed it into Langfuse by hand. This is the push.

What it refuses
---------------

A version under the label that was NOT published from git (no ``git`` tag:
somebody edited and promoted it in Langfuse) is never overwritten. Publishing
over it would silently discard an edit nobody reviewed; refusing turns it into
a diff a person has to bring into review first (``task prompts:pull``, commit,
push again). A file with uncommitted changes is not published either: the
version records the commit it came from, and text that is in no commit has no
reviewable origin.

Usage
-----

::

    task prompts:push                              # CHECK: what would change under `production`
    task prompts:push -- --label staging           # the same against another label
    task prompts:push -- --label staging --apply   # WRITES a new version, labelled

Checking is read-only and safe to run anywhere. ``--apply`` creates a Langfuse
version and moves the label to it, which is what the fleet serving that label
renders within ``LANGFUSE_PROMPT_CACHE_TTL_SECONDS``: run it when the code the
text belongs to is deployed, and ask before running it against ``production``.

Exit codes: 0 up to date or published; 1 CHECK found a change to publish;
2 no credentials; 3 refused (the label holds an unreviewed edit, or the file
is uncommitted).
"""

from __future__ import annotations

import argparse
import difflib
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from typing import Protocol

# The pull's constants and client, not copies: one place names the file, the
# prompt and the credentials. Imported by path so the script runs as a file.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from prompts_pull import FALLBACK_FILE  # noqa: E402
from prompts_pull import PROMPT_NAME  # noqa: E402
from prompts_pull import REPO_ROOT  # noqa: E402
from prompts_pull import build_client  # noqa: E402

EXIT_OK = 0
EXIT_WOULD_CHANGE = 1
EXIT_UNCONFIGURED = 2
EXIT_REFUSED = 3

#: The tag every version this script publishes carries. Its absence is how an
#: edit made in Langfuse is told apart from a version that came from review.
GIT_TAG = "git"


class PromptApi(Protocol):
    """The two SDK methods this script uses."""

    def get_prompt(self, name: str, *, label: str, cache_ttl_seconds: int, type: str) -> Any: ...

    def create_prompt(
        self, *, name: str, prompt: str, labels: list[str], tags: list[str], type: str, commit_message: str
    ) -> Any: ...


@dataclass(frozen=True)
class Plan:
    """What publishing would do: ``same``, ``create``, ``update`` or ``refuse``."""

    action: str
    version: int | None = None
    diff: str = ""


def committed_text(text: str) -> str:
    """The text as the store serves it: trailing newlines are not part of the prompt."""
    return text.rstrip("\n")


def current(client: PromptApi, *, name: str, label: str) -> Any | None:
    """The version under ``label``, or None when there is none."""
    from langfuse.api import NotFoundError

    try:
        return client.get_prompt(name, label=label, cache_ttl_seconds=0, type="text")
    except NotFoundError:
        return None


def plan(live: Any | None, text: str, *, label: str) -> Plan:
    """Decide, without writing, what publishing ``text`` under ``label`` means."""
    if live is None:
        return Plan("create")
    served = committed_text(getattr(live, "prompt", "") or "")
    version = getattr(live, "version", None)
    if served == committed_text(text):
        return Plan("same", version)
    diff = "".join(
        difflib.unified_diff(
            served.splitlines(keepends=True),
            committed_text(text).splitlines(keepends=True),
            fromfile=f"langfuse:{label} (v{version})",
            tofile=str(FALLBACK_FILE.relative_to(REPO_ROOT)),
        )
    )
    if GIT_TAG not in (getattr(live, "tags", None) or []):
        return Plan("refuse", version, diff)
    return Plan("update", version, diff)


def git_origin() -> tuple[str, bool]:
    """``(HEAD sha, whether the prompt file differs from it)``."""
    relative = str(FALLBACK_FILE.relative_to(REPO_ROOT))
    sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    diff = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", relative], cwd=REPO_ROOT, check=False)
    dirty = diff.returncode != 0
    return sha, dirty


def publish(client: PromptApi, text: str, *, name: str, label: str, sha: str) -> Any:
    """A new version from ``text``, labelled, tagged as coming from git, naming its commit."""
    return client.create_prompt(
        name=name,
        prompt=committed_text(text),
        labels=[label],
        tags=[GIT_TAG],
        type="text",
        commit_message=f"git {sha[:12]} {FALLBACK_FILE.relative_to(REPO_ROOT)}",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--label", default="production", help="the Langfuse label to publish to (default: production)")
    parser.add_argument("--name", default=PROMPT_NAME, help="the Langfuse prompt name")
    parser.add_argument("--apply", action="store_true", help="write the new version; without it, only check")
    args = parser.parse_args(argv)

    client = build_client()
    if client is None:
        print(
            "prompts_push: LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set; nothing was checked.",
            file=sys.stderr,
        )
        return EXIT_UNCONFIGURED

    text = FALLBACK_FILE.read_text(encoding="utf-8")
    decided = plan(current(client, name=args.name, label=args.label), text, label=args.label)
    where = f"{args.name} ({args.label})"

    if decided.action == "same":
        print(f"prompts_push: {where} v{decided.version} already serves the committed file.")
        return EXIT_OK
    if decided.action == "refuse":
        sys.stdout.write(decided.diff)
        print(
            f"prompts_push: {where} v{decided.version} was edited in Langfuse, not published from git. "
            f"Bring it into review first: task prompts:pull -- --label {args.label}, commit, then push.",
            file=sys.stderr,
        )
        return EXIT_REFUSED

    sys.stdout.write(decided.diff)
    if not args.apply:
        verb = "create" if decided.action == "create" else f"replace v{decided.version} of"
        print(f"prompts_push: would {verb} {where}. Run with --apply to publish.")
        return EXIT_WOULD_CHANGE

    sha, dirty = git_origin()
    if dirty:
        print(
            f"prompts_push: {FALLBACK_FILE.relative_to(REPO_ROOT)} has uncommitted changes; commit it first, "
            "so the version names the commit it came from.",
            file=sys.stderr,
        )
        return EXIT_REFUSED
    created = publish(client, text, name=args.name, label=args.label, sha=sha)
    print(f"prompts_push: published {where} as v{getattr(created, 'version', '?')} from {sha[:12]}.")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
