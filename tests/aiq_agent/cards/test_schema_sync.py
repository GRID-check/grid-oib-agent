"""Drift test ensuring the committed card JSON Schema matches the Pydantic models.

``shared/cards/schemas.json`` is generated from the canonical Pydantic models via
``scripts/generate_card_schema.py``. If the models change without regenerating the
schema (or someone hand-edits the JSON), this test fails so the drift is caught in
CI before it reaches the frontend Zod generation.
"""

import importlib.util
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = REPO_ROOT / "shared" / "cards" / "schemas.json"


def _load_generator():
    """Import ``scripts/generate_card_schema.py`` without requiring a package."""
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    spec = importlib.util.spec_from_file_location(
        "scripts.generate_card_schema",
        REPO_ROOT / "scripts" / "generate_card_schema.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_committed_schema_matches_models():
    """The committed JSON Schema must equal the freshly generated one."""
    generator = _load_generator()
    generated = generator.generate()
    committed = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    assert generated == committed, (
        "shared/cards/schemas.json is out of sync with the Pydantic models. "
        "Run `uv run python scripts/generate_card_schema.py` and commit the result."
    )


def test_the_generator_explains_itself_rather_than_writing(monkeypatch, capsys):
    """``--help`` prints help and an unknown argument is refused; neither writes the tracked file."""
    import pytest

    generator = _load_generator()
    writes: list[object] = []
    monkeypatch.setattr(generator, "write", lambda *args, **kwargs: writes.append(args))
    with pytest.raises(SystemExit) as helped:
        generator.main(["--help"])
    assert helped.value.code == 0 and "usage" in capsys.readouterr().out
    with pytest.raises(SystemExit) as refused:
        generator.main(["--out", "x.json"])
    assert refused.value.code == 2
    assert writes == []
