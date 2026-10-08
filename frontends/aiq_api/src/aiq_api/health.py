"""``/health``: the liveness and readiness path of both web roles, and nothing else.

It names the build and the role and checks nothing. A database that blinks must
not take every pod out of rotation, so there is no ping here: the probes ask
whether the process serves, and a dependency that is down shows up on the
routes that need it. ``sha`` is the one the ``[boot]`` line prints
(``startup_banner.deployed_sha``), which is what makes a pilot report nameable
over HTTP after that line has rotated out of the logs; the BFF's own
``/api/health`` passes the body through.

NAT mounts its own ``/health`` (``{"status": "healthy"}``) in ``add_routes`` of
the ``chat`` role, and FastAPI answers with the first route that matches, so a
second handler behind it would never run. ``install_health_route`` removes
NAT's and mounts this one, leaving exactly one ``/health`` per app.
"""

from __future__ import annotations

from fastapi import FastAPI

from .roles import WebRole
from .startup_banner import deployed_sha

HEALTH_PATH = "/health"


def install_health_route(app: FastAPI, role: WebRole) -> None:
    """Make this module's handler the only ``/health`` route of ``app``."""
    app.router.routes[:] = [route for route in app.router.routes if getattr(route, "path", None) != HEALTH_PATH]

    @app.get(HEALTH_PATH, tags=["health"], summary="Health check")
    async def health() -> dict[str, str]:
        return {"status": "healthy", "sha": deployed_sha(), "role": role.value}
