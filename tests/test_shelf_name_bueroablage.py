"""The office shelf is called „Büroablage", everywhere a person or the model reads it.

Product decision of 6 Oct 2026 (docs/audit/upload-and-filing-retriage-2026-10-06.md,
Q-0): the org-wide shelf `scope = 'archiv'` is „Büroablage" in German copy and
„Office filing" in English copy. Before that it went by three names at once —
„Archiv" in the navigation, „Büroarchiv" on chips and in the prompt, „Büroablage"
in the upload code — and a fourth meaning was arriving with the Bibliothek.

The code keeps its identifiers (`archiv`, `archiv_<org>`, `/app/archiv`, the
`buero` kind). This file is the ratchet on the COPY: it scans what a reader or
the model reads and fails on the old names, so a string copied from an old
branch or an old doc cannot bring them back. The document action „Archivieren"
/ „archiviert" is a different concept and is not matched.

The second half pins the label in both runtimes, which share no schema: the
Python `buero` kind and shelf qualifier, and the German dictionary the
frontend renders the same kind and shelf with.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from aiq_agent.common.source_kinds import RETIRED_SHELF_QUALIFIERS
from aiq_agent.common.source_kinds import SHELF_QUALIFIERS
from aiq_agent.common.source_kinds import SOURCE_KINDS
from aiq_agent.common.source_kinds import Shelf

REPO_ROOT = Path(__file__).resolve().parents[1]
DICTIONARIES = REPO_ROOT / "frontends" / "ui" / "src" / "i18n" / "dictionaries"
PROMPTS = sorted((REPO_ROOT / "src" / "aiq_agent" / "agents").glob("*/prompts/*"))
BUILTIN_SKILLS = sorted((REPO_ROOT / "src" / "aiq_agent" / "skills" / "builtin").rglob("SKILL.md"))

NAME_DE = "Büroablage"
NAME_EN = "Office filing"

#: The retired compound, in any spelling a person or a model would write.
_BUEROARCHIV = re.compile(r"B(?:ü|ue|u)ro-?\s?[Aa]rchiv", re.IGNORECASE)
#: The bare shelf word. Not „Archivieren", „archiviert", „Archive" (a letter
#: follows) and not a compound like „IFC-Archiv" (a hyphen or letter precedes).
_BARE_ARCHIV = re.compile(r"(?<![\w-])Archiv(?![\wäöü])")
#: The English names the shelf had before it got one.
_EN_OLD = re.compile(r"(?i:office[- ]archive|office-wide archive)|(?<![\w/-])Archiv(?![\w])")

_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_LINE_COMMENT = re.compile(r"^\s*//.*$", re.MULTILINE)
_STRING = re.compile(r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"|`(?:[^`\\]|\\.)*`")


def _strings(source: str) -> list[str]:
    """The string literals of a dictionary module, comments removed: the copy."""
    code = _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", source))
    return [literal[1:-1] for literal in _STRING.findall(code)]


def _dictionary_files(language: str) -> list[Path]:
    # `index.ts` only imports the modules; its strings are paths.
    files = sorted(path for path in (DICTIONARIES / language).glob("*.ts") if path.name != "index.ts")
    if not files:
        pytest.skip("frontend not present in this checkout")
    return files


def _hits(files: list[Path], pattern: re.Pattern[str], *, copy_only: bool) -> list[str]:
    found = []
    for path in files:
        text = path.read_text(encoding="utf-8")
        for chunk in _strings(text) if copy_only else text.splitlines():
            if pattern.search(chunk):
                found.append(f"{path.relative_to(REPO_ROOT)}: {chunk.strip()[:120]}")
    return found


class TestTheOldNamesStayOut:
    def test_no_german_dictionary_says_buroarchiv(self):
        assert _hits(_dictionary_files("de"), _BUEROARCHIV, copy_only=True) == []

    def test_no_german_dictionary_names_the_shelf_archiv(self):
        assert _hits(_dictionary_files("de"), _BARE_ARCHIV, copy_only=True) == []

    def test_no_english_dictionary_uses_an_old_name(self):
        assert _hits(_dictionary_files("en"), _EN_OLD, copy_only=True) == []
        assert _hits(_dictionary_files("en"), _BUEROARCHIV, copy_only=True) == []

    def test_no_agent_prompt_says_buroarchiv_or_office_archive(self):
        assert PROMPTS, "no prompt files found under src/aiq_agent/agents/*/prompts"
        pattern = re.compile(rf"{_BUEROARCHIV.pattern}|office[- ]archive", re.IGNORECASE)
        assert _hits(PROMPTS, pattern, copy_only=False) == []

    def test_no_builtin_skill_says_buroarchiv(self):
        assert BUILTIN_SKILLS
        assert _hits(BUILTIN_SKILLS, _BUEROARCHIV, copy_only=False) == []

    def test_no_knowledge_tool_tells_the_model_the_old_name(self):
        """The knowledge layer's tool descriptions and refusals are read by the model.

        Every string literal that is not a docstring: what a tool says, not
        what its code says about itself.
        """
        offenders: list[str] = []
        for path in sorted((REPO_ROOT / "sources" / "knowledge_layer" / "src").rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            docstrings = {
                id(node.body[0].value)
                for node in ast.walk(tree)
                if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and node.body
                and isinstance(node.body[0], ast.Expr)
                and isinstance(node.body[0].value, ast.Constant)
            }
            for node in ast.walk(tree):
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
                    if _BUEROARCHIV.search(node.value) or re.search(r"(?<![\w-])project/Archiv\b", node.value):
                        offenders.append(f"{path.relative_to(REPO_ROOT)}: {node.value[:80]!r}")
        assert offenders == []

    def test_the_document_action_is_not_caught(self):
        # „Archivieren" (purge a document's index entries) is another concept
        # with its own word; the ratchet must not push anyone to rename it.
        for word in ("Archivieren", "archiviert", "Archiviert", "IFC-Archiv", "Archive"):
            assert not _BARE_ARCHIV.search(word), word
        for phrase in ("im Archiv", "Archiv öffnen", "„Archiv“", "Archiv:"):
            assert _BARE_ARCHIV.search(phrase), phrase


class TestOneNameInBothRuntimes:
    def test_the_backend_names_the_kind_and_the_shelf_buroablage(self):
        assert SOURCE_KINDS["buero"].label == NAME_DE
        assert SHELF_QUALIFIERS[Shelf.ARCHIV] == NAME_DE

    def test_the_retired_name_is_read_but_never_written(self):
        assert RETIRED_SHELF_QUALIFIERS == {"Büroarchiv": Shelf.ARCHIV}
        assert "Büroarchiv" not in SHELF_QUALIFIERS.values()

    @pytest.mark.parametrize(
        "path",
        [
            # The coarse kind in the source popover (ADR-0026).
            r"kinds:\s*\{[^}]*?buero:\s*'([^']+)'",
            # The shelf tab of a source card (ADR-0047).
            r"shelves:\s*\{\s*archiv:\s*'([^']+)'",
            # The shelf in the reasoning view's file chips.
            r"shelf:\s*\{[^}]*?buero:\s*'([^']+)'",
        ],
    )
    def test_the_german_dictionary_renders_the_same_name(self, path: str):
        chat = DICTIONARIES / "de" / "chat.ts"
        if not chat.is_file():
            pytest.skip("frontend not present in this checkout")
        match = re.search(path, chat.read_text(encoding="utf-8"), re.DOTALL)
        assert match, f"{path!r} not found in {chat}"
        assert match.group(1) == SOURCE_KINDS["buero"].label

    def test_the_navigation_names_the_page_in_both_languages(self):
        nav = {lang: (DICTIONARIES / lang / "nav.ts") for lang in ("de", "en")}
        if not all(path.is_file() for path in nav.values()):
            pytest.skip("frontend not present in this checkout")
        for lang, expected in (("de", NAME_DE), ("en", NAME_EN)):
            match = re.search(r"\barchiv:\s*'([^']+)'", nav[lang].read_text(encoding="utf-8"))
            assert match and match.group(1) == expected, lang
