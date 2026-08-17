"""Shelf-aware knowledge-base inventory — the list the agent answers from.

Regression: "welche Dateien hast du im Büroarchiv" mixed the OIB corpus,
project files and the org archive because available_documents carried
(file_name, summary) only. ADR-0047 already said that. These tests pin the
repair: identity is (collection, filename), the prompt is grouped by shelf,
and a listing question about one shelf cannot be answered from another.
"""

from __future__ import annotations

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.inventory import allocate_inventory
from aiq_agent.knowledge.inventory import document_identity
from aiq_agent.knowledge.inventory import render_inventory_block
from aiq_agent.knowledge.inventory import shelf_hint_from_query
from aiq_agent.knowledge.inventory import stamp_document
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.scoping import ScopedCollection


def _doc(name: str, *, collection: str | None = None, shelf: str | None = None, summary: str | None = None):
    return AvailableDocument(
        file_name=name,
        summary=summary or f"Summary of {name}",
        collection=collection,
        shelf=shelf,
    )


class TestStampDocument:
    def test_copies_collection_and_shelf_without_mutating(self):
        original = _doc("Plan.pdf")
        stamped = stamp_document(original, collection="archiv_org", shelf=Shelf.ARCHIV)
        assert stamped.collection == "archiv_org"
        assert stamped.shelf == "archiv"
        assert original.collection is None
        assert original.shelf is None

    def test_unknown_shelf_stays_none(self):
        stamped = stamp_document(_doc("x.pdf"), collection="custom", shelf=None)
        assert stamped.collection == "custom"
        assert stamped.shelf is None


class TestDocumentIdentity:
    def test_same_filename_on_two_shelves_is_two_documents(self):
        project = _doc("Plan.pdf", collection="proj_1", shelf="project")
        archiv = _doc("Plan.pdf", collection="archiv_org", shelf="archiv")
        assert document_identity(project) != document_identity(archiv)

    def test_identity_is_collection_and_name(self):
        assert document_identity(_doc("a.pdf", collection="proj_1")) == ("proj_1", "a.pdf")


class TestAllocateInventory:
    def test_same_filename_on_two_collections_is_kept_twice(self):
        docs = [
            _doc("Plan.pdf", collection="proj_1", shelf="project"),
            _doc("Plan.pdf", collection="archiv_org", shelf="archiv"),
        ]
        out = allocate_inventory(docs, max_documents=50)
        assert len(out) == 2
        assert {d.collection for d in out} == {"proj_1", "archiv_org"}

    def test_user_shelves_are_not_evicted_by_the_oib_corpus(self):
        """A 50-cap used to sort-then-slice. ~40 OIB filenames ate the list
        and the Büroarchiv disappeared — so the agent answered from OIB."""
        base = [_doc(f"oib-rl_{i}.pdf", collection="oib_knowledge", shelf="base") for i in range(40)]
        archiv = [_doc("Buero-Standard.pdf", collection="archiv_org", shelf="archiv")]
        project = [_doc("Lacknergasse.pdf", collection="proj_1", shelf="project")]
        out = allocate_inventory(base + archiv + project, max_documents=20)
        names = {d.file_name for d in out}
        assert "Buero-Standard.pdf" in names
        assert "Lacknergasse.pdf" in names
        assert sum(1 for d in out if d.shelf == "base") == 18

    def test_cap_of_zero_keeps_everything(self):
        docs = [_doc(f"{i}.pdf", collection="oib_knowledge", shelf="base") for i in range(5)]
        assert len(allocate_inventory(docs, max_documents=0)) == 5

    def test_within_a_shelf_the_cut_is_filename_sorted(self):
        docs = [
            _doc("m.pdf", collection="oib_knowledge", shelf="base"),
            _doc("a.pdf", collection="oib_knowledge", shelf="base"),
            _doc("z.pdf", collection="oib_knowledge", shelf="base"),
        ]
        out = allocate_inventory(docs, max_documents=2)
        assert [d.file_name for d in out] == ["a.pdf", "m.pdf"]

    def test_fair_share_when_user_shelves_overflow_the_cap(self):
        project = [_doc(f"p{i:02d}.pdf", collection="proj_1", shelf="project") for i in range(30)]
        archiv = [_doc(f"a{i:02d}.pdf", collection="archiv_org", shelf="archiv") for i in range(5)]
        out = allocate_inventory(project + archiv, max_documents=10)
        assert any(d.shelf == "archiv" for d in out)
        assert any(d.shelf == "project" for d in out)
        assert len(out) == 10

    def test_unknown_shelf_is_not_treated_as_base(self):
        unknown = [_doc("mystery.pdf", collection="custom_x", shelf=None)]
        base = [_doc(f"oib-{i}.pdf", collection="oib_knowledge", shelf="base") for i in range(10)]
        out = allocate_inventory(unknown + base, max_documents=3)
        assert "mystery.pdf" in {d.file_name for d in out}


class TestRenderInventoryBlock:
    def test_groups_by_shelf_and_refuses_to_call_oib_the_archiv(self):
        docs = [
            _doc("oib-rl_2.pdf", collection="oib_knowledge", shelf="base", summary="Brandschutz."),
            _doc("Lacknergasse.pdf", collection="proj_1", shelf="project", summary="Ansichten."),
            _doc("Buero-Standard.pdf", collection="archiv_org", shelf="archiv", summary="Detail."),
        ]
        text = render_inventory_block(docs)

        assert "Büroarchiv" in text
        assert "Projektwissen" in text
        assert "Basiswissen" in text
        assert "Buero-Standard.pdf" in text
        assert "Lacknergasse.pdf" in text
        assert "oib-rl_2.pdf" in text

        archiv = text.split("### Büroarchiv", 1)[1].split("### ", 1)[0]
        assert "Buero-Standard.pdf" in archiv
        assert "oib-rl_2.pdf" not in archiv
        assert "Lacknergasse.pdf" not in archiv

        base = text.split("### Basiswissen", 1)[1]
        assert "oib-rl_2.pdf" in base
        assert "Buero-Standard.pdf" not in base

        assert "NOT base/OIB" in text
        assert "Never the Büroarchiv" in text or "never the Büroarchiv" in text
        assert "always on this request" in text
        assert "on every project" in text
        assert "on every session of this project" in text
        assert "only this chat" in text

    def test_empty_in_scope_archiv_is_shown_empty_not_omitted(self):
        """If the section is missing the model fills it with OIB."""
        docs = [_doc("oib-rl_2.pdf", collection="oib_knowledge", shelf="base")]
        text = render_inventory_block(docs, in_scope_shelves=[Shelf.ARCHIV, Shelf.BASE])
        assert "### Büroarchiv" in text
        archiv = text.split("### Büroarchiv", 1)[1].split("### ", 1)[0]
        assert "empty" in archiv.lower()
        assert "oib-rl_2.pdf" not in archiv

    def test_listing_rule_is_in_the_block(self):
        text = render_inventory_block([_doc("a.pdf", collection="proj_1", shelf="project")])
        assert "which files" in text.lower() or "welche Dateien" in text
        assert "ONLY from that shelf" in text or "only from that shelf" in text

    def test_index_not_sources_banner_survives(self):
        text = render_inventory_block([_doc("a.pdf", collection="proj_1", shelf="project")])
        assert "NOT sources" in text
        assert "not a citable source" in text.lower() or "not evidence" in text.lower()

    def test_nothing_to_show_when_no_docs_and_no_scope(self):
        assert render_inventory_block([]) == ""

    def test_project_docs_without_scope_still_show_empty_archiv(self):
        """A missing envelope must not hide an empty Büroarchiv once we
        already know this is a project turn (project files are present)."""
        docs = [_doc("Lacknergasse.pdf", collection="proj_1", shelf="project")]
        text = render_inventory_block(docs)
        assert "### Büroarchiv" in text
        archiv = text.split("### Büroarchiv", 1)[1].split("### ", 1)[0]
        assert "empty" in archiv.lower()
        assert "Lacknergasse.pdf" not in archiv

    def test_base_only_does_not_invent_an_empty_archiv(self):
        text = render_inventory_block([_doc("oib-rl_2.pdf", collection="oib_knowledge", shelf="base")])
        assert "### Büroarchiv" not in text

    def test_listing_focus_hides_other_shelves(self):
        """A Büroarchiv listing must not put OIB filenames in the prompt."""
        docs = [
            _doc("oib-rl_2.pdf", collection="oib_knowledge", shelf="base"),
            _doc("Lacknergasse.pdf", collection="proj_1", shelf="project"),
            _doc("Buero-Standard.pdf", collection="archiv_org", shelf="archiv"),
        ]
        text = render_inventory_block(docs, focus_shelf=Shelf.ARCHIV)
        assert "Buero-Standard.pdf" in text
        assert "oib-rl_2.pdf" not in text
        assert "Lacknergasse.pdf" not in text
        assert "### Büroarchiv" in text
        assert "### Basiswissen" not in text
        assert "other shelves" in text.lower()


class TestShelfHintFromQuery:
    def test_buerorarchiv_typos_and_german(self):
        assert shelf_hint_from_query("welche datein hast du im Bro archiv") == Shelf.ARCHIV
        assert shelf_hint_from_query("nicht im projekt was hast du im archiv") == Shelf.ARCHIV
        assert shelf_hint_from_query("was liegt im Büroarchiv") == Shelf.ARCHIV

    def test_project_vs_base(self):
        assert shelf_hint_from_query("welche Dateien hast du im Projekt") == Shelf.PROJECT
        assert shelf_hint_from_query("welche OIB-Richtlinien hast du") == Shelf.BASE

    def test_content_question_is_not_a_shelf_listing(self):
        assert shelf_hint_from_query("was sagt OIB-RL 2 zum Brandschutz") is None
        assert shelf_hint_from_query("zeig mir den Schnitt Lacknergasse") is None

    def test_nearby_german_listings_are_not_research(self):
        """The two quoted utterances are not the whole language."""
        assert shelf_hint_from_query("zeig mir die dateien im archiv") == Shelf.ARCHIV
        assert shelf_hint_from_query("liste das büroarchiv") == Shelf.ARCHIV
        assert shelf_hint_from_query("hast du was im archiv") == Shelf.ARCHIV
        assert shelf_hint_from_query("und im archiv?") == Shelf.ARCHIV


class TestListingIntentOverride:
    def test_archiv_listing_is_meta_even_if_the_classifier_said_research(self):
        from aiq_agent.knowledge.inventory import listing_intent_override

        assert listing_intent_override("welche datein hast du im Bro archiv") == "meta"
        assert listing_intent_override("nicht im projekt was hast du im archiv") == "meta"

    def test_content_questions_are_not_overridden(self):
        from aiq_agent.knowledge.inventory import listing_intent_override

        assert listing_intent_override("was sagt OIB-RL 2 zum Brandschutz") is None
        assert listing_intent_override("What is CUDA?") is None


class TestScopedCollectionRoundTrip:
    def test_scope_entries_carry_the_shelf_the_renderer_needs(self):
        entries = [
            ScopedCollection("archiv_org", Shelf.ARCHIV),
            ScopedCollection("oib_knowledge", Shelf.BASE),
        ]
        text = render_inventory_block([], in_scope_shelves=[e.shelf for e in entries if e.shelf])
        assert "### Büroarchiv" in text
        assert "empty" in text.lower()
