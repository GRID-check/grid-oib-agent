# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate the canonical Grid card JSON Schema from the Pydantic models.

The Pydantic models in :mod:`aiq_agent.cards.models` are the single source of
truth for the Grid response-card schema. This script renders their JSON Schema
to ``shared/cards/schemas.json`` so the frontend (Zod) and any other consumer
can be generated from the same definition.

Run with::

    uv run python scripts/generate_card_schema.py
"""

import json
from pathlib import Path

from aiq_agent.cards.models import grid_card_adapter

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "shared" / "cards" / "schemas.json"


def generate() -> dict:
    """Return the JSON Schema for the Grid card discriminated union."""
    return grid_card_adapter.json_schema()


def write(path: Path = SCHEMA_PATH) -> Path:
    """Write the generated schema to ``path`` with deterministic LF formatting."""
    schema = generate()
    contents = json.dumps(schema, indent=2, sort_keys=True) + "\n"
    # Force LF newlines so the output is identical across platforms.
    path.write_text(contents, encoding="utf-8", newline="\n")
    return path


if __name__ == "__main__":
    written = write()
    print(f"Wrote Grid card JSON Schema to {written}")
