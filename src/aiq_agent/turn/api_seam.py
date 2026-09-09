"""The ONE place the agent tier imports from the API tier.

``aiq_api`` depends on ``aiq_agent`` (it hosts the workflow); these four names
are the agent tier reaching back the other way, an inverted dependency. They
are kept together here so that undoing the inversion — injecting the callables
from the API tier at workflow build time, or moving the job submitter and the
request-identity ContextVar into ``aiq_agent.common`` — is a change to one
file. Nothing else under ``aiq_agent`` may import ``aiq_api``.

The three *callables* import late (inside each function) because
``aiq_api.jobs.submit`` pulls the job runner in, which is only wanted on the
deployments that submit jobs, and because the tests patch
``aiq_api.jobs.submit.submit_agent_job`` at the source — a late import reads the
patched name, a module-level one would not. ``AuthError`` is the exception and
imports at module level: it is a class, re-exported so ``except AuthError``
elsewhere binds the API tier's own class by identity, which is what
``test_auth_error_is_the_api_tiers_class`` pins. A lazy re-export cannot be
used in an ``except`` clause without a call.

``tests/aiq_agent/turn/test_api_seam.py`` enforces the rule above by walking
every module under ``aiq_agent`` and subtracting a named exemption list, so a
new importer anywhere in the package fails rather than going unseen.
"""

from __future__ import annotations

from typing import Any

from aiq_api.auth.errors import AuthError

__all__ = ["AuthError", "async_job_dispatch", "skip_clarifier_requested", "submit_agent_job"]


def skip_clarifier_requested() -> bool:
    """Whether the API middleware marked this request as headless.

    Covers ``X-AIQ-Mode: headless``, anonymous callers and unauthenticated
    internal callers. Outside a request the middleware's default identity
    says ``False``.
    """
    from aiq_api.auth.middleware import get_current_user

    return bool(get_current_user().get("skip_clarifier"))


def async_job_dispatch() -> str | None:
    """The backend that can run a deep-research job out of process, or ``None``."""
    from aiq_api.jobs.submit import async_job_dispatch as _dispatch

    return _dispatch()


async def submit_agent_job(**kwargs: Any) -> str:
    """Submit an agent job through the API tier's one submit path; returns the job id."""
    from aiq_api.jobs.submit import submit_agent_job as _submit

    return await _submit(**kwargs)
