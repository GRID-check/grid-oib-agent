"""Workflow-configuration introspection for the BFF.

``GET /v1/config/llm-defaults`` reports which model each named LLM in the
loaded workflow YAML uses. The org model-config UI shows these as the
"workflow default" per agent group (ADR-0014) so admins can see what they are
overriding — and what a reset returns to.

Reachable only over the compose network in practice (the middleware already
distinguishes internal callers); additionally guarded with the shared
``GRID_INTERNAL_API_TOKEN`` when one is configured, mirroring the BFF's
internal endpoints. Model names are not secrets — the guard is consistency,
not confidentiality.
"""

import hmac
import logging
import os
from collections.abc import Mapping
from typing import Any

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Request

logger = logging.getLogger(__name__)


def _token_ok(request: Request) -> bool:
    expected = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not expected:
        # Dev/anonymous deployments run without the shared token; the
        # middleware's internal-caller classification is the remaining guard.
        return True
    provided = request.headers.get("x-grid-internal-token") or ""
    return hmac.compare_digest(provided, expected)


def add_config_info_routes(router: APIRouter, llm_configs: Mapping[str, Any]) -> None:
    """Register the llm-defaults route over the loaded workflow config."""

    defaults = {
        name: getattr(config, "model_name", None) or getattr(config, "model", None)
        for name, config in llm_configs.items()
    }

    # Which endpoint each LLM actually talks to. The BFF's first-boot seeding of
    # `platform_model_defaults` needs this: a platform default only replaces the
    # model id, never the base URL (see `override_model`), so seeding an
    # OpenRouter id into a deployment whose `llms:` point at Kimi or NVIDIA would
    # send an unknown model to that provider on every request. Reporting the base
    # URL lets the BFF refuse to seed rather than guess from the shape of a model
    # id. Not secret — the same host names are in the config file and the docs.
    base_urls = {name: getattr(config, "base_url", None) for name, config in llm_configs.items()}

    # The ingestion VLM is env-configured (AIQ_VLM_MODEL), not a `llms:` entry,
    # so surface its resolved default under a stable synthetic `vlm` key. The
    # org model-config UI's `ingest_vlm` group maps to this via configLlmRefs so
    # it too shows a "workflow default" (and what a reset returns to).
    try:
        from knowledge_layer.llamaindex.adapter import resolve_vlm_credential

        vlm_cred = resolve_vlm_credential()
        if vlm_cred.model:
            defaults.setdefault("vlm", vlm_cred.model)
        # The VLM sits on its own credential plane (AIQ_VLM_BASE_URL), which is
        # routinely a different provider from the `llms:` block — the shipped
        # default routes to NVIDIA while the chat models route to OpenRouter. Its
        # base URL is reported separately for exactly that reason.
        if vlm_cred.base_url:
            base_urls.setdefault("vlm", vlm_cred.base_url)
    except Exception:  # pragma: no cover - display-only; never block the endpoint
        logger.warning("Could not resolve VLM default model for llm-defaults", exc_info=True)

    @router.get("/v1/config/llm-defaults")
    async def llm_defaults(request: Request) -> dict[str, Any]:
        if not _token_ok(request):
            raise HTTPException(status_code=403, detail="Forbidden")
        return {"llms": defaults, "baseUrls": base_urls}
