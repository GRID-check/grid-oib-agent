"""Generate the chat wire v2 JSON Schema from the Pydantic models.

:mod:`aiq_agent.common.wire_v2` is the single source of truth for the chat
wire. This script renders its JSON Schema to ``shared/wire/v2.schema.json``;
``npm run generate:wire`` in ``frontends/ui`` renders that to the Zod module the
browser parses frames with. The same two-stage pipeline as the cards
(``scripts/generate_card_schema.py``), guarded by the same pre-commit hook.

Run with::

    uv run python scripts/generate_wire_schema.py
"""

import argparse
import json
from collections.abc import Sequence
from pathlib import Path

from aiq_agent.common.wire_v2 import wire_json_schema

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "shared" / "wire" / "v2.schema.json"


def render() -> str:
    """The schema file's contents: deterministic, LF, sorted keys."""
    return json.dumps(wire_json_schema(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: Sequence[str] | None = None) -> None:
    """Write the schema. Takes no arguments; anything else is refused."""
    parser = argparse.ArgumentParser(
        description=f"Regenerate {SCHEMA_PATH.relative_to(SCHEMA_PATH.parents[2])} from the Pydantic wire models.",
        epilog="Then run `npm run generate:wire` in frontends/ui.",
    )
    parser.parse_args(argv)
    SCHEMA_PATH.parent.mkdir(parents=True, exist_ok=True)
    SCHEMA_PATH.write_text(render(), encoding="utf-8", newline="\n")
    print(f"Wrote the chat wire v2 JSON Schema to {SCHEMA_PATH}")


if __name__ == "__main__":
    main()
