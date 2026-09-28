"""Generate the canonical Grid card JSON Schema from the Pydantic models.

The Pydantic models in :mod:`aiq_agent.cards.models` are the single source of
truth for the Grid response-card schema. This script renders their JSON Schema
to ``shared/cards/schemas.json`` so the frontend (Zod) and any other consumer
can be generated from the same definition.

Run with::

    uv run python scripts/generate_card_schema.py
"""

import argparse
import json
from collections.abc import Sequence
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


def main(argv: Sequence[str] | None = None) -> None:
    """Write the schema. Takes no arguments: ``--help`` prints this, and anything else is refused.

    It used to ignore its arguments, so ``--help`` (or a typo) rewrote the
    tracked file instead of explaining itself.
    """
    parser = argparse.ArgumentParser(
        description=f"Regenerate {SCHEMA_PATH.relative_to(SCHEMA_PATH.parents[2])} from the Pydantic card models.",
        epilog="Then run `npm run generate:cards` in frontends/ui.",
    )
    parser.parse_args(argv)
    written = write()
    print(f"Wrote Grid card JSON Schema to {written}")


if __name__ == "__main__":
    main()
