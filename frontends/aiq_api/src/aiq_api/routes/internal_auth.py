"""Shared guard for service-to-service internal endpoints.

The maintenance purge routes and the skills submit route are both reachable
only from inside the compose network (never on the AuthMiddleware external-path
allowlist) and are authenticated with the shared ``GRID_INTERNAL_API_TOKEN``.

Factored here so both route modules import one implementation rather than
copy-pasting the constant-time compare / dev-default-refusal logic. Behavior is
identical to the original ``routes.maintenance`` guard (which re-exports these
names for backwards compatibility).
"""

import hmac
import logging
import os

from fastapi import HTTPException
from fastapi import Request

logger = logging.getLogger(__name__)

# Well-known default shipped in docker-compose for local development. It must
# never authenticate anything outside a dev environment.
_DEV_DEFAULT_TOKEN = "grid-internal-dev-token"
_DEV_APP_ENVS = {"development", "dev", "local"}

#: Both spellings of the internal-token header, in the order they are tried.
#:
#: This guard read ``x-internal-token`` ONLY, while every caller in the repo —
#: the BFF's skill submit and model-config fetch, and each of the nine Python
#: clients under ``src/aiq_agent`` — sends ``x-grid-internal-token``. So the
#: routes this guard protects rejected every real request with a 403. Nothing
#: caught it because the two sides are tested separately and each test pinned
#: its own spelling, and because the ASGI envelope middleware
#: (``context_envelope._INTERNAL_TOKEN_HEADER_NAMES``) already accepts both —
#: so a request got far enough to look healthy before the route guard refused
#: it. Accepting both here matches that middleware and the sibling guard in
#: ``routes/config_info.py``.
_TOKEN_HEADERS: tuple[str, ...] = ("x-grid-internal-token", "x-internal-token")


def _require_internal_token(request: Request) -> None:
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise HTTPException(status_code=403, detail="Forbidden")
    app_env = os.environ.get("APP_ENV", "production").lower()
    if token == _DEV_DEFAULT_TOKEN and app_env not in _DEV_APP_ENVS:
        logger.error(
            "GRID_INTERNAL_API_TOKEN is the well-known dev default "
            "('%s') but APP_ENV=%s is not a dev environment - refusing to "
            "serve internal requests. Set a real token in the deployment "
            "environment.",
            _DEV_DEFAULT_TOKEN,
            app_env,
        )
        raise HTTPException(status_code=503, detail="Internal API disabled")
    # Constant-time compare: a plain != leaks the token via response timing.
    # Every candidate header is compared even after one matches, so the number
    # of comparisons does not depend on which spelling the caller used.
    matched = False
    for name in _TOKEN_HEADERS:
        provided = request.headers.get(name) or ""
        matched |= hmac.compare_digest(provided, token)
    if not matched:
        raise HTTPException(status_code=403, detail="Forbidden")
