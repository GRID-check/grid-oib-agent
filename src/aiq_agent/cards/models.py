# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Pydantic models for Grid response cards."""

from typing import Annotated
from typing import Literal

from pydantic import BaseModel
from pydantic import Field
from pydantic import TypeAdapter


class SummaryCard(BaseModel):
    """A concise overview of the answer for the user."""

    type: Literal["summary"]
    title: str = Field(min_length=1, description="Short title for the summary card")
    content: str | None = Field(default=None, description="One-paragraph summary")
    key_points: list[str] | None = Field(default=None, description="Bullet points highlighting key facts")


class LegalBasisCard(BaseModel):
    """A legal norm, regulation, or OIB Richtlinie that grounds the answer."""

    type: Literal["legal_basis"]
    law: str = Field(min_length=1, description="Name of the law, regulation, or OIB Richtlinie")
    article: str | None = Field(default=None, description="Relevant article or paragraph number")
    section: str | None = Field(default=None, description="Relevant section or chapter")
    summary: str | None = Field(default=None, description="Plain-language summary of the legal relevance")
    original_text: str | None = Field(default=None, description="Literal excerpt from the source, if available")


GridCard = SummaryCard | LegalBasisCard

# Discriminated-union adapter. ``grid_card_adapter`` is the canonical public name;
# ``_grid_card_adapter`` is retained as a backwards-compatible alias.
grid_card_adapter = TypeAdapter(Annotated[GridCard, Field(discriminator="type")])
_grid_card_adapter = grid_card_adapter

__all__ = [
    "GridCard",
    "LegalBasisCard",
    "SummaryCard",
    "grid_card_adapter",
    "validate_cards",
]


def validate_cards(raw: list[dict]) -> list[dict]:
    """Validate a list of raw card dicts and return the validated dicts."""
    return [_grid_card_adapter.validate_python(item).model_dump(exclude_none=True) for item in raw]
