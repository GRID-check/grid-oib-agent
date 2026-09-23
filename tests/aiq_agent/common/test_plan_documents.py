"""The Unterlagen contract: what a reader names, and what a run may be told."""

from __future__ import annotations

from aiq_agent.common.plan_documents import MAX_PLAN_DOCUMENTS
from aiq_agent.common.plan_documents import PlanDocument
from aiq_agent.common.plan_documents import PlanDocuments
from aiq_agent.common.plan_documents import documents_from_plan
from aiq_agent.common.plan_documents import resolve_documents
from aiq_agent.common.plan_documents import sanitize_plan_documents
from aiq_agent.common.plan_documents import unread_grundlage


class TestSanitize:
    def test_a_row_without_a_name_is_dropped_and_the_rest_stay(self):
        docs = sanitize_plan_documents(
            {"grundlage": [{"title": "no name"}, {"name": " a.pdf ", "title": "A", "shelf": "project"}, "b.pdf"]}
        )
        assert docs is not None
        assert [(d.name, d.title, d.shelf) for d in docs.grundlage] == [
            ("a.pdf", "A", "project"),
            ("b.pdf", None, None),
        ]

    def test_the_stricter_intention_wins_a_name_in_both_lists(self):
        docs = sanitize_plan_documents({"grundlage": ["a.pdf", "b.pdf"], "ausgeschlossen": ["A.PDF"]})
        assert docs is not None
        assert [d.name for d in docs.ausgeschlossen] == ["A.PDF"]
        assert [d.name for d in docs.grundlage] == ["b.pdf"]

    def test_nothing_named_is_none_not_an_empty_object(self):
        assert sanitize_plan_documents({"grundlage": [], "ausgeschlossen": [{"no": "name"}]}) is None
        assert sanitize_plan_documents("x") is None

    def test_the_cap_holds(self):
        docs = sanitize_plan_documents({"grundlage": [f"{i}.pdf" for i in range(MAX_PLAN_DOCUMENTS + 5)]})
        assert docs is not None and len(docs.grundlage) == MAX_PLAN_DOCUMENTS


class TestResolve:
    INVENTORY = [
        {"file_name": "Einreichplan.pdf", "display_title": "Einreichplan EG", "shelf": "project"},
        {"file_name": "alt.pdf", "shelf": "archiv"},
    ]

    def test_a_name_or_a_title_resolves_to_the_file_case_folded(self):
        docs = resolve_documents(["einreichplan eg", "ALT.PDF", "erfunden.pdf", "alt.pdf"], self.INVENTORY)
        assert [(d.name, d.title, d.shelf) for d in docs] == [
            ("Einreichplan.pdf", "Einreichplan EG", "project"),
            ("alt.pdf", None, "archiv"),
        ]

    def test_without_an_inventory_nothing_resolves(self):
        assert resolve_documents(["Einreichplan.pdf"], None) == []

    def test_documents_from_plan_is_none_when_nothing_resolves(self):
        assert documents_from_plan(["erfunden.pdf"], [], self.INVENTORY) is None


class TestUnread:
    def test_the_grundlage_without_a_passage_is_unread(self):
        docs = PlanDocuments(grundlage=[PlanDocument(name="A.pdf"), PlanDocument(name="b.pdf")])
        assert [d.name for d in unread_grundlage(docs, {"a.pdf"})] == ["b.pdf"]
        assert unread_grundlage(None, set()) == []


def test_nur_grundlage_survives_only_with_a_grundlage():
    from aiq_agent.common.plan_documents import sanitize_plan_documents

    confined = sanitize_plan_documents({"grundlage": ["Plan.pdf"], "nur_grundlage": True})
    assert confined is not None and confined.nur_grundlage is True
    # A confinement to nothing would refuse every document the reader owns.
    empty = sanitize_plan_documents({"ausgeschlossen": ["Alt.pdf"], "nurGrundlage": True})
    assert empty is not None and empty.nur_grundlage is False
