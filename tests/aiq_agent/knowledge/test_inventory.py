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
from aiq_agent.knowledge.inventory import allocate_inventory_detailed
from aiq_agent.knowledge.inventory import document_identity
from aiq_agent.knowledge.inventory import render_inventory_block
from aiq_agent.knowledge.inventory import set_inventory_drops
from aiq_agent.knowledge.inventory import shelf_hint_from_query
from aiq_agent.knowledge.inventory import stamp_document
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.scoping import ScopedCollection


def _doc(
    name: str,
    *,
    collection: str | None = None,
    shelf: str | None = None,
    summary: str | None = None,
    folder_path: str | None = None,
):
    return AvailableDocument(
        file_name=name,
        summary=summary or f"Summary of {name}",
        collection=collection,
        shelf=shelf,
        folder_path=folder_path,
    )


class TestFoldersInTheInventory:
    """The agent can only talk about a folder structure it can see (ADR-0049).

    The inventory is where the agent learns what exists, so it is where the
    filing has to appear: without it "die drei Dokumente in Brandschutz" is a
    sentence the model can only guess at, and `knowledge_search folder=` has no
    value it could legitimately pass.
    """

    def test_a_filed_document_shows_its_folder(self):
        text = render_inventory_block(
            [_doc("plan.pdf", collection="proj_1", shelf="project", folder_path="Brandschutz/Fluchtwege")]
        )
        assert "**plan.pdf** (Ordner: Brandschutz/Fluchtwege)" in text

    def test_a_document_at_the_root_shows_no_folder(self):
        text = render_inventory_block([_doc("plan.pdf", collection="proj_1", shelf="project")])
        assert "Ordner:" not in text
        assert "**plan.pdf**" in text

    def test_the_folder_convention_is_explained_when_a_folder_is_present(self):
        text = render_inventory_block(
            [_doc("plan.pdf", collection="proj_1", shelf="project", folder_path="Brandschutz")]
        )
        assert "(Ordner: Pfad/Unterpfad)" in text
        assert "`folder=`" in text

    def test_nothing_is_said_about_folders_when_no_file_has_one(self):
        # A base-corpus-only turn has no folders at all; explaining them there is
        # prompt budget spent on a structure the user does not have.
        text = render_inventory_block([_doc("oib-rl_2.pdf", collection="oib_knowledge", shelf="base")])
        assert "Ordner" not in text

    def test_the_folder_sits_before_the_tags(self):
        text = render_inventory_block(
            [
                AvailableDocument(
                    file_name="plan.pdf",
                    summary="Ein Plan.",
                    tags=["Grundriss"],
                    collection="proj_1",
                    shelf="project",
                    folder_path="Brandschutz",
                )
            ]
        )
        assert "**plan.pdf** (Ordner: Brandschutz) [Grundriss]: Ein Plan." in text


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
        # The base shelf is folded to a count, so its filenames are absent by
        # design. See TestBaseShelfIsFolded.
        assert "oib-rl_2.pdf" not in text

        archiv = text.split("### Büroarchiv", 1)[1].split("### ", 1)[0]
        assert "Buero-Standard.pdf" in archiv
        assert "oib-rl_2.pdf" not in archiv
        assert "Lacknergasse.pdf" not in archiv

        base = text.split("### Basiswissen", 1)[1]
        assert "Buero-Standard.pdf" not in base
        assert "Lacknergasse.pdf" not in base

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


class TestTruncationIsAnnouncedToTheModel:
    """A capped shelf must say so IN THE BLOCK, not only in the operator's log.

    The block instructs the model to "answer ONLY from that shelf's group. If
    the group is empty, say so" — and a shelf-listing question is routed to
    ``meta``, which strips every search tool, so the block is the only source
    the answer can come from. A shelf that silently loses its alphabetical tail
    therefore produces a confidently complete-looking wrong answer with no
    fallback available.
    """

    def teardown_method(self):
        set_inventory_drops(None)

    def test_reports_what_the_cap_dropped_per_shelf(self):
        docs = [_doc(f"archiv-{i:02d}.pdf", collection="archiv_org", shelf="archiv") for i in range(10)]
        docs += [_doc(f"proj-{i:02d}.pdf", collection="proj_1", shelf="project") for i in range(4)]
        kept, dropped = allocate_inventory_detailed(docs, max_documents=6)

        assert len(kept) == 6
        # Per shelf, not a single global number: the model has to know WHICH
        # answer is incomplete, and a global count cannot say.
        assert dropped[Shelf.ARCHIV] + dropped[Shelf.PROJECT] == 8
        assert dropped[Shelf.ARCHIV] > 0

    def test_no_drops_reported_when_nothing_was_cut(self):
        docs = [_doc("a.pdf", collection="proj_1", shelf="project")]
        kept, dropped = allocate_inventory_detailed(docs, max_documents=50)
        assert len(kept) == 1
        assert all(count == 0 for count in dropped.values())

    def test_uncapped_allocation_reports_nothing(self):
        docs = [_doc(f"a{i}.pdf", collection="proj_1", shelf="project") for i in range(3)]
        _, dropped = allocate_inventory_detailed(docs, max_documents=0)
        assert dropped == {}

    def test_the_block_tells_the_model_the_shelf_is_incomplete(self):
        docs = [_doc(f"archiv-{i:02d}.pdf", collection="archiv_org", shelf="archiv") for i in range(10)]
        kept, dropped = allocate_inventory_detailed(docs, max_documents=4)
        set_inventory_drops(dropped)

        rendered = render_inventory_block(kept)
        assert "6 weitere Datei(en)" in rendered
        assert "unvollst" in rendered

    def test_a_complete_shelf_carries_no_notice(self):
        docs = [_doc("only.pdf", collection="proj_1", shelf="project")]
        kept, dropped = allocate_inventory_detailed(docs, max_documents=50)
        set_inventory_drops(dropped)

        rendered = render_inventory_block(kept)
        assert "weitere Datei" not in rendered

    def test_the_notice_lands_in_the_truncated_shelf_section(self):
        docs = [_doc(f"archiv-{i:02d}.pdf", collection="archiv_org", shelf="archiv") for i in range(10)]
        docs += [_doc("proj.pdf", collection="proj_1", shelf="project")]
        kept, dropped = allocate_inventory_detailed(docs, max_documents=5)
        set_inventory_drops(dropped)

        rendered = render_inventory_block(kept)
        archiv_section = rendered.split("### ")[1]
        # The notice belongs to the shelf that lost files, not to the block.
        assert "Büroarchiv" in archiv_section
        assert "weitere Datei(en)" in archiv_section

    def test_a_stale_count_from_a_previous_turn_cannot_leak(self):
        set_inventory_drops({Shelf.ARCHIV: 99})
        set_inventory_drops(None)
        rendered = render_inventory_block([_doc("a.pdf", collection="proj_1", shelf="project")])
        assert "99" not in rendered


class TestBaseShelfIsFolded:
    """Basiswissen carries a count, not ~39 filenames, on every ordinary turn.

    The platform corpus is a constant: the same OIB files on every request,
    project or not. Spelling them out is paid on a greeting exactly as on a
    Brandschutz question, and buys nothing retrieval does not already give —
    ``knowledge_search`` with no ``file_name`` fans out across this corpus and
    its hits name the file they came from.

    The exception is the turn that has no retrieval: a listing question about
    this shelf routes to ``intent="meta"``, which binds no search tools. That
    turn arrives with ``focus_shelf=base`` and gets the full list.
    """

    def teardown_method(self):
        set_inventory_drops(None)

    def test_base_filenames_are_not_spelled_out(self):
        docs = [_doc(f"oib-rl_{i}.pdf", collection="oib_knowledge", shelf="base") for i in range(39)]
        text = render_inventory_block(docs)

        assert "oib-rl_7.pdf" not in text
        assert "39 Dateien" in text

    def test_the_fold_names_the_way_to_reach_the_files(self):
        docs = [_doc(f"oib-rl_{i}.pdf", collection="oib_knowledge", shelf="base") for i in range(39)]
        text = render_inventory_block(docs)

        # A count with no route to the contents would just be a smaller lie.
        assert "knowledge_search" in text
        assert "Erfinde keine" in text

    def test_a_listing_turn_about_base_still_gets_every_name(self):
        docs = [_doc(f"oib-rl_{i}.pdf", collection="oib_knowledge", shelf="base") for i in range(39)]
        text = render_inventory_block(docs, focus_shelf=Shelf.BASE)

        assert "oib-rl_7.pdf" in text
        assert "39 Dateien" not in text

    def test_user_shelves_are_still_spelled_out(self):
        docs = [
            _doc("oib-rl_2.pdf", collection="oib_knowledge", shelf="base"),
            _doc("Lacknergasse.pdf", collection="proj_1", shelf="project"),
            _doc("Buero-Standard.pdf", collection="archiv_org", shelf="archiv"),
        ]
        text = render_inventory_block(docs)

        # The fold is about the platform constant, not about saving lines. The
        # user's own files are why the model can cite a document by name.
        assert "Lacknergasse.pdf" in text
        assert "Buero-Standard.pdf" in text

    def test_the_count_includes_what_the_cap_dropped(self):
        docs = [_doc(f"oib-rl_{i:02d}.pdf", collection="oib_knowledge", shelf="base") for i in range(39)]
        kept, dropped = allocate_inventory_detailed(docs, max_documents=10)
        set_inventory_drops(dropped)

        text = render_inventory_block(kept)

        # The shelf holds 39 whether or not the cap let 10 through. Reporting
        # the surviving count would understate the corpus on every capped turn.
        assert "39 Dateien" in text
        assert "10 Dateien" not in text

    def test_an_empty_base_shelf_still_says_it_is_empty(self):
        text = render_inventory_block([], in_scope_shelves=[Shelf.BASE])
        assert "empty" in text.lower()


class TestTruncationEdgesTheFirstPassMissed:
    """Two shelves the drop notice did not reach, both found in review.

    Both are the same defect the per-shelf notice exists to prevent: a list the
    cap shortened, presented as the whole of it.
    """

    def teardown_method(self):
        set_inventory_drops(None)

    def test_base_still_names_itself_when_the_cap_took_every_row(self):
        # User shelves spend the whole cap, so base keeps nothing.
        docs = [_doc(f"proj-{i:02d}.pdf", collection="proj_1", shelf="project") for i in range(6)]
        docs += [_doc(f"oib-{i:02d}.pdf", collection="oib_knowledge", shelf="base") for i in range(39)]
        kept, dropped = allocate_inventory_detailed(docs, max_documents=6)
        set_inventory_drops(dropped)

        rendered = render_inventory_block(kept, in_scope_shelves=[Shelf.PROJECT, Shelf.BASE])

        # Reporting the platform corpus as "(empty)" tells the model the OIB
        # files are gone — on the one shelf present in every single request.
        assert "39 Dateien" in rendered
        base = rendered.split("### Basiswissen", 1)[1]
        assert "empty" not in base.lower()

    def test_a_truncated_unattributed_list_says_it_is_incomplete(self):
        docs = [_doc(f"mystery-{i:02d}.pdf", collection="unknown_coll") for i in range(9)]
        kept, dropped = allocate_inventory_detailed(docs, max_documents=3)
        set_inventory_drops(dropped)

        rendered = render_inventory_block(kept)

        # Shelf-less drops are recorded under `None`, a key no shelf lookup hits.
        assert "### Unattributed" in rendered
        assert "weitere Datei(en) ohne angegebenes Regal" in rendered


class TestFilesStillBeingRead:
    """THE ABSENCE OF A FILE IS NOT THE SAME FACT AS ITS NON-EXISTENCE.

    The inventory is built from the summaries table, which is written when an
    ingestion job COMPLETES. A plan attached moments ago is therefore missing
    from it in exactly the way it is missing from retrieval — and the model,
    reading a complete-looking shelf, answered confidently without the one
    document the question was about. Naming the files in flight is what lets an
    answer say what it could not see.
    """

    def test_it_names_a_file_that_is_still_being_read(self):
        block = render_inventory_block(
            [_doc("oib-rl_2.pdf", collection="oib_knowledge")],
            in_scope_shelves=[ScopedCollection("oib_knowledge", Shelf.BASE)],
            in_flight=["grundriss_eg.pdf"],
        )

        assert "grundriss_eg.pdf" in block
        # And says what that MEANS, because a filename alone reads like one more
        # available document.
        assert "NOT in the inventory above" in block
        assert "still being processed" in block

    def test_it_forbids_presenting_an_answer_that_silently_omits_it(self):
        block = render_inventory_block(
            [_doc("oib-rl_2.pdf", collection="oib_knowledge")],
            in_scope_shelves=[ScopedCollection("oib_knowledge", Shelf.BASE)],
            in_flight=["plan.pdf"],
        )

        assert "do not present an answer that omits it" in block

    def test_a_bulk_upload_carries_the_shape_and_not_the_list(self):
        """Same bound as every other block here: hundreds of names would be paid
        for on every turn and would stop informing the answer past a handful."""
        block = render_inventory_block(
            [_doc("oib-rl_2.pdf", collection="oib_knowledge")],
            in_scope_shelves=[ScopedCollection("oib_knowledge", Shelf.BASE)],
            in_flight=[f"plan_{i}.pdf" for i in range(40)],
        )

        assert "plan_0.pdf" in block
        assert "plan_39.pdf" not in block
        # The remainder is COUNTED, in the text the model reads — not dropped.
        assert "35 weitere" in block

    def test_nothing_in_flight_changes_nothing(self):
        with_none = render_inventory_block(
            [_doc("oib-rl_2.pdf", collection="oib_knowledge")],
            in_scope_shelves=[ScopedCollection("oib_knowledge", Shelf.BASE)],
        )
        with_empty = render_inventory_block(
            [_doc("oib-rl_2.pdf", collection="oib_knowledge")],
            in_scope_shelves=[ScopedCollection("oib_knowledge", Shelf.BASE)],
            in_flight=[],
        )

        assert with_none == with_empty
        assert "still being read" not in with_none.lower()

    def test_a_first_upload_still_gets_a_block(self):
        """An empty project whose only document is mid-ingest used to render no
        inventory at all — so the turn carried no hint that anything existed."""
        block = render_inventory_block([], in_flight=["erste_datei.pdf"])

        assert block != ""
        assert "erste_datei.pdf" in block
