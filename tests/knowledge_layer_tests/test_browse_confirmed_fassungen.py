"""`list_files` shows a Fassung a person confirmed, and it beats the reading of the names.

A confirmed replacement is a fact; an index in a file name is a guess. The older file
says which one replaced it, the newer which it replaced and, in a line, what changed.
An unconfirmed name series keeps its „dem Namen nach" mark. A link counts only while
both files are in the selection.
"""

from __future__ import annotations

import pytest

from aiq_agent.knowledge.inventory import render_inventory_block
from aiq_agent.knowledge.schema import AvailableDocument
from sources.knowledge_layer.src.browse import MAX_CHANGE_CHARS
from sources.knowledge_layer.src.browse import confirmed_revision_marks
from sources.knowledge_layer.src.browse import file_row
from sources.knowledge_layer.src.browse import file_rows
from sources.knowledge_layer.src.browse import render_listing
from sources.knowledge_layer.src.browse import select_files


def _doc(name: str, folder: str | None = None, **extra) -> AvailableDocument:
    return AvailableDocument(
        file_name=name,
        folder_path=folder,
        collection="proj_1",
        shelf="project",
        summary=extra.pop("summary", f"Zusammenfassung von {name}"),
        **extra,
    )


def _line(text: str, name: str) -> str:
    return next(line for line in text.splitlines() if line.startswith(f"- {name}"))


def _confirmed():
    """Two differently named files a person linked, and an unrelated one."""
    return file_rows(
        [
            _doc("Statik alt.pdf", superseded_by="Statik neu.pdf"),
            _doc(
                "Statik neu.pdf",
                supersedes=["Statik alt.pdf"],
                change_summary="- Bewehrung Decke 12 mm statt 10 mm\n- Neue Stütze in Achse 3",
                change_basis="Statik alt.pdf",
            ),
            _doc("Baubeschreibung.pdf"),
        ]
    )


class TestTheConfirmedMarks:
    def test_the_older_file_names_its_replacement_and_the_newer_the_file_it_replaced(self):
        text = render_listing(select_files(_confirmed(), shelf="project"))

        assert "ersetzt durch Statik neu.pdf (bestätigt)" in _line(text, "Statik alt.pdf")
        assert "ersetzt Statik alt.pdf (bestätigt)" in _line(text, "Statik neu.pdf")
        assert "bestätigt" not in _line(text, "Baubeschreibung.pdf")

    def test_the_newer_row_carries_what_changed_on_one_line(self):
        text = render_listing(select_files(_confirmed(), shelf="project"))

        line = _line(text, "Statik neu.pdf")
        assert "geändert: Bewehrung Decke 12 mm statt 10 mm; Neue Stütze in Achse 3" in line
        assert "geändert" not in _line(text, "Statik alt.pdf")

    def test_the_change_is_bounded_to_160_characters(self):
        rows = file_rows([_doc("neu.pdf", change_summary="- " + "x" * 400, change_basis="alt.pdf")])
        line = _line(render_listing(select_files(rows, shelf="project")), "neu.pdf")
        change = line.split("geändert: ", 1)[1].split(" · ")[0].split(" — ")[0]
        assert len(change) <= MAX_CHANGE_CHARS
        assert change.endswith("…")

    def test_a_change_against_the_files_own_previous_upload_says_so(self):
        rows = file_rows([_doc("statik.pdf", change_summary="- Lift neu", change_basis="statik.pdf")])
        line = _line(render_listing(select_files(rows, shelf="project")), "statik.pdf")
        assert "geändert (vorige Fassung): Lift neu" in line
        assert "bestätigt" not in line

    def test_the_profile_line_counts_the_confirmed_replacements(self):
        text = render_listing(select_files(_confirmed(), shelf="project"))
        assert "Fassungen (bestätigt): 1 Datei(en)" in text
        assert "file_name=" in text

    def test_no_confirmed_link_means_no_confirmed_line(self):
        text = render_listing(select_files(file_rows([_doc("a.pdf"), _doc("b.pdf")]), shelf="project"))
        assert "bestätigt" not in text

    def test_a_link_to_a_file_outside_the_selection_marks_nothing(self):
        rows = file_rows([_doc("alt.pdf", superseded_by="weg.pdf")])
        assert confirmed_revision_marks(rows) == {}
        assert "bestätigt" not in render_listing(select_files(rows, shelf="project"))

    def test_the_marks_are_keyed_by_collection_and_name(self):
        marks = confirmed_revision_marks(_confirmed())
        assert set(marks) == {("proj_1", "Statik alt.pdf"), ("proj_1", "Statik neu.pdf")}

    def test_a_file_that_replaced_one_and_was_replaced_itself_says_both(self):
        rows = file_rows(
            [
                _doc("a.pdf", superseded_by="b.pdf"),
                _doc("b.pdf", superseded_by="c.pdf", supersedes=["a.pdf"]),
                _doc("c.pdf", supersedes=["b.pdf"]),
            ]
        )
        line = _line(render_listing(select_files(rows, shelf="project")), "b.pdf")
        assert "ersetzt durch c.pdf (bestätigt)" in line and "ersetzt a.pdf (bestätigt)" in line


class TestAConfirmedLinkBeatsTheReadingOfTheNames:
    def _rows(self):
        return file_rows(
            [
                _doc("EG_Grundriss_Index_A.pdf"),
                _doc("EG_Grundriss_Index_B.pdf", superseded_by="EG_Grundriss_Index_C.pdf"),
                _doc("EG_Grundriss_Index_C.pdf", supersedes=["EG_Grundriss_Index_B.pdf"]),
            ]
        )

    def test_a_row_in_a_confirmed_link_carries_the_confirmed_mark_not_the_name_mark(self):
        text = render_listing(select_files(self._rows(), shelf="project"))

        assert "ersetzt durch EG_Grundriss_Index_C.pdf (bestätigt)" in _line(text, "EG_Grundriss_Index_B")
        assert "dem Namen nach" not in _line(text, "EG_Grundriss_Index_B")
        assert "dem Namen nach" not in _line(text, "EG_Grundriss_Index_C")

    def test_an_unconfirmed_member_of_the_same_series_keeps_the_name_mark(self):
        text = render_listing(select_files(self._rows(), shelf="project"))
        assert "ältere Fassung (Index A)" in _line(text, "EG_Grundriss_Index_A")
        assert "Fassungen: 1 Dokument(e)" in text  # the series still counts once, for A

    def test_an_unconfirmed_series_is_unchanged(self):
        rows = file_rows([_doc("EG_Index_A.pdf"), _doc("EG_Index_B.pdf")])
        text = render_listing(select_files(rows, shelf="project"))
        assert "aktuelle Fassung (Index B" in _line(text, "EG_Index_B")
        assert "bestätigt" not in text


def test_the_row_reads_the_facts_from_an_inventory_row_or_a_dict():
    row = file_row(
        {
            "file_name": "neu.pdf",
            "collection": "proj_1",
            "superseded_by": "neuer.pdf",
            "supersedes": ["alt.pdf", ""],
            "change_summary": " - Lift neu ",
            "change_basis": "alt.pdf",
        }
    )
    assert row.superseded_by == "neuer.pdf"
    assert row.supersedes == ("alt.pdf",)
    assert row.change_summary == "- Lift neu"
    assert row.change_basis == "alt.pdf"
    assert file_row({"file_name": "x.pdf", "collection": "c"}).supersedes == ()


class TestTheInventoryBlock:
    def _block(self, docs) -> str:
        return render_inventory_block(docs)

    def test_the_older_and_the_newer_row_say_what_a_person_confirmed(self):
        block = self._block(
            [
                _doc("Statik alt.pdf", superseded_by="Statik neu.pdf"),
                _doc("Statik neu.pdf", supersedes=["Statik alt.pdf"]),
                _doc("Baubeschreibung.pdf"),
            ]
        )
        older = next(line for line in block.splitlines() if line.startswith("- **Statik alt.pdf**"))
        newer = next(line for line in block.splitlines() if line.startswith("- **Statik neu.pdf**"))
        assert "ersetzt durch Statik neu.pdf (bestätigt)" in older
        assert "ersetzt Statik alt.pdf (bestätigt)" in newer
        assert "bestätigt" not in next(line for line in block.splitlines() if line.startswith("- **Baubeschreibung"))

    def test_a_block_without_links_is_byte_for_byte_what_it_was(self):
        block = self._block([_doc("a.pdf")])
        assert "bestätigt" not in block

    def test_many_replaced_files_are_counted_not_listed(self):
        names = [f"alt_{i}.pdf" for i in range(6)]
        block = self._block([_doc("neu.pdf", supersedes=names)])
        line = next(line for line in block.splitlines() if line.startswith("- **neu.pdf**"))
        assert "alt_0.pdf, alt_1.pdf, alt_2.pdf und 3 weitere (bestätigt)" in line


@pytest.mark.parametrize("field", ["superseded_by", "supersedes", "change_summary", "change_basis"])
def test_the_row_survives_a_missing_field(field):
    assert getattr(file_row({"file_name": "x.pdf", "collection": "c"}), field) in (None, ())
