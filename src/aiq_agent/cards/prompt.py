# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Shared prompt builder for Grid response card generation."""

import json

from aiq_agent.cards.models import GridCard
from aiq_agent.cards.models import _grid_card_adapter


def build_card_generation_prompt() -> str:
    """Build a system prompt that describes every card type from the shared schema.

    The prompt lists each card variant, its fields, and the JSON schema so the
    model can produce validated card arrays without hard-coding card types.
    """
    card_types = []
    for card_cls in GridCard.__args__:
        fields = []
        for field_name, field_info in card_cls.model_fields.items():
            if field_name == "type":
                continue
            annotation = field_info.annotation
            type_name = getattr(annotation, "__name__", str(annotation))
            desc = field_info.description or type_name
            fields.append(f"{field_name} ({desc})")

        type_line = f"- {card_cls.__name__}"
        if card_cls.__doc__:
            type_line += f": {card_cls.__doc__.strip()}"
        if fields:
            type_line += f" — fields: {', '.join(fields)}"
        card_types.append(type_line)

    schema = _grid_card_adapter.json_schema()

    return (
        "You are a structured-output assistant. Given a user question and research context, "
        "produce Grid response cards as a JSON object of the form {\"cards\": [ ...card objects... ]}.\n\n"
        "Only include a card when it adds value. Do not invent references. "
        "Use an empty array when no card adds value.\n\n"
        "Allowed card types:\n"
        + "\n".join(card_types)
        + "\n\nJSON Schema for each card:\n"
        + json.dumps(schema, indent=2, ensure_ascii=False)
        + "\n\nRespond ONLY with the JSON object — no prose, no code fences."
    )
