"""The card catalog as an endpoint: what the agent can render, and how to ask for more.

``GET /v1/platform/cards`` lists every Grid card type — its purpose, its fields
(type, required, description, constraints) and a worked example where one
exists — plus the GitHub link for requesting a card, or a value on an existing
card, that the catalog does not carry yet. Grid's answers are only as rich as
this list, so "which figures can it actually show me?" is a question the product
should answer itself instead of sending someone to read
``src/aiq_agent/cards/models.py``.

Derived from the Pydantic union via :func:`aiq_agent.cards.catalog.describe_card_catalog`,
the same source the ``emit_card`` tool description and the generated frontend Zod
schema come from — a new card type shows up here without anyone maintaining a
second list.

Not on the AuthMiddleware external-path allowlist, so it is reachable only from
inside the cluster; the BFF (`/api/platform/cards`) is what serves it onward and
gates it to platform owners. It is deliberately not token-guarded on top of
that: the payload is the card SCHEMA, which every browser already receives in
the generated Zod bundle, and it carries no tenant data of any kind.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from aiq_agent.cards.catalog import describe_card_catalog

# Where a user asks for a card type, or a value on one, that Grid cannot render
# yet. The issue FORM is linked rather than the bare issue list: an enhancement
# filed through `02-enhancement.yml` arrives with the problem, the proposal and
# the affected surfaces already separated, which is the difference between a
# request that can be triaged and one that has to be chased.
REPOSITORY_URL = "https://github.com/GRID-check/grid-oib-agent"
FEATURE_REQUEST_URL = f"{REPOSITORY_URL}/issues/new?template=02-enhancement.yml&title=%5BFeature%5D%3A+"


def add_card_catalog_routes(router: APIRouter) -> None:
    """Register the read-only card-catalog route."""

    @router.get(
        "/v1/platform/cards",
        summary="Every card type the agent can render, and where to request another",
        tags=["platform"],
    )
    async def card_catalog() -> dict[str, Any]:
        catalog = describe_card_catalog()
        return {
            **catalog,
            "cardCount": len(catalog["cards"]),
            "featureRequest": {
                "repository": REPOSITORY_URL,
                "url": FEATURE_REQUEST_URL,
                "label": "Missing a card, or a value on one? Open a feature request.",
            },
        }
