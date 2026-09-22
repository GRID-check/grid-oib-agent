"""What this process is, in one line, at startup — the Python half.

The BFF twin is ``frontends/ui/src/lib/boot.ts``; read its header for why this
exists at all. In short: a pilot reported that a feature did not work, and
nobody could say which build they were running or whether that feature was
switched on for them, because three of the four gates default to ``false`` —
so "broken" and "never enabled" look identical from outside.

The line's SHAPE is deliberately identical on both services::

    [boot] sha=<sha> skills=<bool> collaboration=<bool> enforceFlags=<bool> agentDocs=<bool>

so one ``grep '^\\[boot\\]'`` over a pod log answers the question for the whole
deployment, and the two tiers' answers can be compared without re-reading two
formats. ``tests/test_startup_banner.py`` pins the format against the same
table the TypeScript spec uses.

**The flags are the values THIS process can see, and that is the point.** The
four variables are set on the frontend and skill-scheduler containers and are
*not* passed to ``aiq-agent`` (``deploy/compose/docker-compose.coolify.yaml``),
so this tier prints the defaults. That is not a bug in the line, it is the line
doing its job: a boot log that showed the BFF's values here would be inventing
them. Which service a value came from is the first thing a flag investigation
needs, so each service reports its own.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

logger = logging.getLogger(__name__)

#: What the line says when nothing stamped a commit into the image.
UNKNOWN_SHA = "unknown"

#: Spellings that turn a default-ON gate off. Same set the TypeScript
#: ``optOut`` accepts, and the same set ``agentAuthoredDocumentsEnvEnabled``
#: has always accepted — a deployment that writes ``off`` must not get ``on``
#: from one tier and ``off`` from the other.
_FALSEY = frozenset({"false", "0", "no", "off"})


@dataclass(frozen=True)
class BootFlags:
    """The effective value of each gate, not the raw environment string."""

    skills: bool
    collaboration: bool
    enforce_flags: bool
    agent_docs: bool


def _opt_in(raw: str | None) -> bool:
    """A dark-launched gate: only the exact string ``true`` turns it on."""
    return (raw or "").strip().lower() == "true"


def _opt_out(raw: str | None) -> bool:
    """A default-ON gate: unset means on, only an explicit falsey word is off."""
    value = (raw or "").strip().lower()
    return value == "" or value not in _FALSEY


def deployed_sha(env: dict[str, str] | None = None) -> str:
    """The commit this image was built from, or ``unknown``.

    ``GRID_GIT_SHA`` is stamped as a build arg and re-exported as an env var by
    ``deploy/Dockerfile``. There is no ``.git`` in the image, so this is the
    only place the answer can come from.
    """
    source = os.environ if env is None else env
    return (source.get("GRID_GIT_SHA") or "").strip() or UNKNOWN_SHA


def boot_flags(env: dict[str, str] | None = None) -> BootFlags:
    """The four gates as this process would decide them."""
    source = os.environ if env is None else env
    return BootFlags(
        skills=_opt_in(source.get("GRID_SKILLS_ENABLED")),
        collaboration=_opt_in(source.get("GRID_COLLABORATION_ENABLED")),
        enforce_flags=_opt_in(source.get("GRID_ENFORCE_FEATURE_FLAGS")),
        agent_docs=_opt_out(source.get("GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED")),
    )


def format_boot_line(sha: str, flags: BootFlags) -> str:
    """The boot line itself — one line, fixed key order, greppable."""
    # Lower-cased booleans on purpose: Python's ``True`` and JavaScript's
    # ``true`` would otherwise make one grep into two.
    return (
        f"[boot] sha={sha}"
        f" skills={str(flags.skills).lower()}"
        f" collaboration={str(flags.collaboration).lower()}"
        f" enforceFlags={str(flags.enforce_flags).lower()}"
        f" agentDocs={str(flags.agent_docs).lower()}"
    )


def boot_line(env: dict[str, str] | None = None) -> str:
    """:func:`format_boot_line` for this process's environment."""
    return format_boot_line(deployed_sha(env), boot_flags(env))


def log_boot_line() -> str:
    """Emit the boot line and return it (so a caller can assert on it)."""
    line = boot_line()
    logger.info("%s", line)
    return line
