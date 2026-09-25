#!/usr/bin/env python3

"""Bring a Langfuse version of the platform prompt into review.

Why this exists
---------------

The platform prompt — the static half of Piloti's system prompt — has git as
its source of truth (ADR-0060 (a)):
``src/aiq_agent/agents/piloti/prompts/piloti_static.md`` is what review reads,
what a process renders when prompt management is off or Langfuse unreachable,
and what ``scripts/prompts_push.py`` publishes to Langfuse. Labels there carry
experiments, and the fleet reads the label it is configured for through
``src/aiq_agent/common/prompt_store.py``.

An edit made in Langfuse is therefore not yet part of the prompt. This script
writes the version under a label into the committed file, so the edit becomes
a diff somebody reviews and commits; ``prompts_push.py`` refuses to publish
over such an edit until it has.

Usage
-----

::

    task prompts:pull                  # the `production` label
    task prompts:pull -- --label staging

Needs ``LANGFUSE_PUBLIC_KEY``, ``LANGFUSE_SECRET_KEY`` and (self-hosted)
``LANGFUSE_HOST``. Without them it exits 2 and says so, rather than writing
nothing and reporting success.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any
from typing import Protocol

REPO_ROOT = Path(__file__).resolve().parents[1]
FALLBACK_FILE = REPO_ROOT / "src/aiq_agent/agents/piloti/prompts/piloti_static.md"
#: The wire name. Shared with ``agents/piloti/prompt.py::STATIC_PROMPT_NAME``.
PROMPT_NAME = "piloti-system-static"

EXIT_OK = 0
EXIT_ABSENT = 1
EXIT_UNCONFIGURED = 2


class PromptApi(Protocol):
    """The one SDK method the pull and the push read with, so a test fake is four lines."""

    def get_prompt(self, name: str, *, label: str, cache_ttl_seconds: int, type: str) -> Any: ...


def fetch_version(client: PromptApi, *, name: str = PROMPT_NAME, label: str = "production") -> Any | None:
    """The labelled version as Langfuse returns it, or None when Langfuse has no such prompt.

    ``cache_ttl_seconds=0`` because both callers are one-shot CLIs: a cached
    answer would be a version the store happened to fetch a minute ago. A
    missing prompt is None; anything else propagates, because "could not reach
    Langfuse" must not be written into the prompt file, or read by the push as
    "no version yet", as if it were an answer.
    """
    from langfuse.api import NotFoundError

    try:
        return client.get_prompt(name, label=label, cache_ttl_seconds=0, type="text")
    except NotFoundError:
        return None


def fetch_text(client: PromptApi, *, name: str = PROMPT_NAME, label: str = "production") -> str | None:
    """The text of the labelled version, or None when Langfuse has no such prompt."""
    text = getattr(fetch_version(client, name=name, label=label), "prompt", None)
    return text if isinstance(text, str) else None


def write_fallback(text: str, path: Path | None = None) -> bool:
    """Write the prompt file, and say whether it changed.

    Exactly one trailing newline, because every text file here ends with one
    and the store strips trailing newlines at the render seam anyway — so this
    normalization can never move a byte the model sees.

    ``path`` defaults to the module's ``FALLBACK_FILE`` at CALL time rather
    than in the signature, so the constant stays the one place the location is
    written down.
    """
    path = FALLBACK_FILE if path is None else path
    normalized = text.rstrip("\n") + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == normalized:
        return False
    path.write_text(normalized, encoding="utf-8")
    return True


def build_client() -> PromptApi | None:
    """A Langfuse client for the CLI, or None when the credentials are absent.

    ``tracing_enabled=False`` for the same reason the store does it: this
    script has no traces to send, and a client that registers a tracer provider
    is a surprise nobody asked a one-shot command for.
    """
    from aiq_agent.common.prompt_store import HOST_ENV
    from aiq_agent.common.prompt_store import PUBLIC_KEY_ENV
    from aiq_agent.common.prompt_store import SECRET_KEY_ENV

    public_key = os.environ.get(PUBLIC_KEY_ENV, "").strip()
    secret_key = os.environ.get(SECRET_KEY_ENV, "").strip()
    if not public_key or not secret_key:
        return None
    from langfuse import Langfuse

    return Langfuse(
        public_key=public_key,
        secret_key=secret_key,
        host=os.environ.get(HOST_ENV, "").strip() or None,
        tracing_enabled=False,
    )


def main(argv: list[str] | None = None) -> int:
    """Pull one prompt version into the committed prompt file and print what happened."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--label", default="production", help="the Langfuse label to pull (default: production)")
    parser.add_argument("--name", default=PROMPT_NAME, help="the Langfuse prompt name")
    args = parser.parse_args(argv)

    client = build_client()
    if client is None:
        print(
            "prompts_pull: LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set; the prompt file was not touched.",
            file=sys.stderr,
        )
        return EXIT_UNCONFIGURED

    text = fetch_text(client, name=args.name, label=args.label)
    if text is None:
        print(f"prompts_pull: Langfuse has no {args.label!r} version of {args.name!r}.", file=sys.stderr)
        return EXIT_ABSENT

    changed = write_fallback(text)
    state = "updated" if changed else "already current"
    print(f"prompts_pull: {FALLBACK_FILE.relative_to(REPO_ROOT)} {state} from {args.name} ({args.label}).")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
