#!/usr/bin/env python3

"""Refresh the bundled fallback prompt from the version Langfuse is serving.

Why this exists
---------------

The platform prompt — the static half of Piloti's system prompt — is authored
and versioned in **Langfuse**. The fleet pulls it at render time through
``src/aiq_agent/common/prompt_store.py``; nothing in this repository pushes to
it, and a prompt change is a change made in Langfuse, not a commit.

``src/aiq_agent/agents/piloti/prompts/piloti_static.md`` is the **bundled
fallback**: what a process renders when prompt management is off, when the
credentials are absent, when Langfuse is unreachable, or when it has no such
prompt. It is allowed to lag the live version, and it is expected to — an image
that has been running for a month has a month-old fallback in it.

This script is how a maintainer stops it lagging too far: it writes the current
production version into that file so the change can be committed as a fresh
fallback. There is no check, no gate and no CI job. A file that differs from
Langfuse is not a failure; it is what a fallback is.

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
    """The one SDK method this script uses, so a test fake is four lines."""

    def get_prompt(self, name: str, *, label: str, cache_ttl_seconds: int, type: str) -> Any: ...


def fetch_text(client: PromptApi, *, name: str = PROMPT_NAME, label: str = "production") -> str | None:
    """The text of the labelled version, or None when Langfuse has no such prompt.

    ``cache_ttl_seconds=0`` because this is a one-shot CLI: a cached answer
    would write a version the store happened to fetch a minute ago. A missing
    prompt is None; anything else propagates, because "could not reach
    Langfuse" must not be written into the fallback as if it were content.
    """
    from langfuse.api import NotFoundError

    try:
        prompt = client.get_prompt(name, label=label, cache_ttl_seconds=0, type="text")
    except NotFoundError:
        return None
    text = getattr(prompt, "prompt", None)
    return text if isinstance(text, str) else None


def write_fallback(text: str, path: Path | None = None) -> bool:
    """Write the fallback file, and say whether it changed.

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
    """Pull one prompt into the fallback file and print what happened."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--label", default="production", help="the Langfuse label to pull (default: production)")
    parser.add_argument("--name", default=PROMPT_NAME, help="the Langfuse prompt name")
    args = parser.parse_args(argv)

    client = build_client()
    if client is None:
        print(
            "prompts_pull: LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set; the fallback was not touched.",
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
