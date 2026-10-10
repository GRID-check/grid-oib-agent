"""The ADR index check (scripts/check_adrs.py): what a "superseded by" in the index may point at."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_adrs.py"


@pytest.fixture
def checker(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("check_adrs", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "ADR_DIR", tmp_path)
    return module


def _write(directory: Path, readme_title: str, cited: str) -> Path:
    old = f"# Old\n\n**Status:** Accepted\n\nPartly superseded by {cited}.\n"
    (directory / "0010-old.md").write_text(old, encoding="utf-8")
    (directory / "0011-new.md").write_text(
        "# New\n\n**Status:** Accepted\n\nSupersedes part of ADR-0010.\n", encoding="utf-8"
    )
    readme = directory / "README.md"
    readme.write_text(
        "| ADR | Title | Status |\n|---|---|---|\n"
        f"| [0010](0010-old.md) | {readme_title} | Accepted |\n"
        "| [0011](0011-new.md) | New | Accepted |\n",
        encoding="utf-8",
    )
    return readme


def test_an_index_row_superseded_by_the_record_the_file_cites_passes(checker, tmp_path):
    errors: list[str] = []
    checker.check_superseded_refs(_write(tmp_path, "Old (partly superseded by 0011)", "ADR-0011"), errors)
    assert errors == []


def test_an_index_row_pointing_at_a_record_the_file_never_cites_fails(checker, tmp_path):
    errors: list[str] = []
    checker.check_superseded_refs(_write(tmp_path, "Old (partly superseded by 0009)", "ADR-0011"), errors)
    assert errors == ["docs/adr/README.md: 0010-old.md is superseded by 0009, which does not exist."]

    errors.clear()
    (tmp_path / "0009-other.md").write_text("# Other\n\n**Status:** Accepted\n", encoding="utf-8")
    checker.check_superseded_refs(tmp_path / "README.md", errors)
    assert errors == [
        "docs/adr/README.md: 0010-old.md is superseded by 0009 in the index, "
        "but the record itself never cites ADR-0009.",
        "docs/adr/README.md: 0010-old.md is superseded by 0009 in the index, but 0009-other.md never cites ADR-0010.",
    ]


def test_the_whole_check_reports_a_wrong_superseded_by(checker, tmp_path):
    _write(tmp_path, "Old (partly superseded by 0011)", "ADR-0012")
    errors: list[str] = []
    checker.check(errors)
    assert any("never cites ADR-0011" in error for error in errors)


def test_a_superseded_by_in_the_status_cell_is_checked_too(checker, tmp_path):
    readme = _write(tmp_path, "Old", "ADR-0011")
    rows = readme.read_text(encoding="utf-8").replace("| Old | Accepted |", "| Old | Superseded by ADR-0012 |")
    readme.write_text(rows, encoding="utf-8")
    errors: list[str] = []
    checker.check_superseded_refs(readme, errors)
    assert errors == ["docs/adr/README.md: 0010-old.md is superseded by 0012, which does not exist."]


def test_the_superseding_record_must_cite_the_one_it_supersedes(checker, tmp_path):
    readme = _write(tmp_path, "Old (partly superseded by 0011)", "ADR-0011")
    errors: list[str] = []
    checker.check_superseded_refs(readme, errors)
    assert errors == []

    (tmp_path / "0011-new.md").write_text("# New\n\n**Status:** Accepted\n", encoding="utf-8")
    checker.check_superseded_refs(readme, errors)
    assert errors == [
        "docs/adr/README.md: 0010-old.md is superseded by 0011 in the index, but 0011-new.md never cites ADR-0010."
    ]


def test_an_index_row_outside_the_table_or_out_of_order_fails(checker, tmp_path):
    readme = _write(tmp_path, "Old", "ADR-0011")
    table = readme.read_text(encoding="utf-8")
    row = "| [0011](0011-new.md) | New | Accepted |\n"
    readme.write_text("# ADRs\n" + row + "\nIntro.\n\n" + table.replace(row, ""), encoding="utf-8")
    errors: list[str] = []
    checker.index_rows(readme, errors)
    assert errors == [
        "docs/adr/README.md: the row for 0011-new.md stands outside the index table.",
        "docs/adr/README.md: the row for 0010-old.md comes after 0011; keep the index in order.",
    ]

    errors.clear()
    checker.index_rows(_write(tmp_path, "Old", "ADR-0011"), errors)
    assert errors == []
