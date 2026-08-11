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
    provided = request.headers.get("x-internal-token") or ""
    if not hmac.compare_digest(provided, token):
        raise HTTPException(status_code=403, detail="Forbidden")
