"""The commit-time check for invisible characters (scripts/check_hidden_unicode.py)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_hidden_unicode.py"


@pytest.fixture(scope="module")
def checker():
    spec = importlib.util.spec_from_file_location("check_hidden_unicode", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_a_zero_width_space_is_reported_with_its_position(checker):
    assert checker.find_hidden("first\nab\u200bc\n") == [(2, 3, 0x200B)]


def test_a_byte_order_mark_is_allowed_only_at_the_start_of_a_file(checker):
    assert checker.find_hidden("\ufeffBauteil,U-Wert\n") == []
    assert checker.find_hidden("Bauteil\ufeff,U-Wert\n") == [(1, 8, 0xFEFF)]


def test_bidi_overrides_are_reported(checker):
    assert checker.find_hidden("safe\u202etxt.exe") == [(1, 5, 0x202E)]


def test_zero_width_joiner_is_left_alone_for_emoji_and_indic_text(checker):
    assert checker.find_hidden("family \U0001f468\u200d\U0001f469") == []


def test_main_fails_on_a_hit_and_names_the_escape(checker, tmp_path, capsys):
    source = tmp_path / "source.ts"
    source.write_text("const key = 'a\u200bb'\n", encoding="utf-8")

    assert checker.main([str(source)]) == 1
    out = capsys.readouterr().out
    assert "source.ts:1:" in out
    assert "\\u200B" in out


def test_main_passes_clean_files_and_skips_binary_and_non_utf8(checker, tmp_path):
    clean = tmp_path / "clean.md"
    clean.write_text("plain text\n", encoding="utf-8")
    binary = tmp_path / "image.bin"
    binary.write_bytes(b"\x00\x200b")
    latin1 = tmp_path / "legacy.txt"
    latin1.write_bytes("Gebäude \u200b".encode("cp1252", errors="replace") + b"\xe4")

    assert checker.main([str(clean), str(binary), str(latin1)]) == 0
