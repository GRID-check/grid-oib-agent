"""The role this web process plays: ``chat`` or ``api`` (ADR-0082 step B).

One image, one process type per job. ``GRID_ROLE`` is the whole switch and has
no default: a process that cannot say what it is must not guess, because a
guess mounts a route set that no Deployment's Service, probe or scaler was
written for. The same variable names the two worker tiers
(``worker``, ``ingest-worker``), but those never load this front end, so this
module knows only the two roles that serve HTTP.

Read once, when the worker is built (``plugin.AIQAPIWorker.__init__``), and held
as a value from then on, so no later code re-reads the environment and answers
differently.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from enum import StrEnum


class WebRole(StrEnum):
    """What a web process serves. The values are what ``GRID_ROLE`` holds."""

    #: The chat socket and the answers running on it; scales on active turns (ADR-0080).
    CHAT = "chat"
    #: Every other HTTP route: knowledge, jobs, LLM utilities, admin, debug; scales on CPU.
    API = "api"


ROLE_ENV = "GRID_ROLE"


# @environment_variable GRID_ROLE
# @category Deployment
# @type string
# @default none
# @required true
# The process type the backend image runs as: `chat` (the chat socket), `api`
# (every other HTTP route), `worker` (research jobs) or `ingest-worker`
# (ingestion). Unset or anything else stops the process at start. `web` no
# longer exists.
def web_role(env: Mapping[str, str] | None = None) -> WebRole:
    """The web role ``GRID_ROLE`` names; raises ``ValueError`` when it is unset or not one."""
    raw = (os.environ if env is None else env).get(ROLE_ENV, "").strip().lower()
    try:
        return WebRole(raw)
    except ValueError:
        allowed = ", ".join(role.value for role in WebRole)
        raise ValueError(f"{ROLE_ENV}={raw!r} is not a web role: set it to one of {allowed}") from None
