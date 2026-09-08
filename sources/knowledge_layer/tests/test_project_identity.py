"""WHICH project a hit came from travels with the hit (ADR-0054).

The Büro can read five mounted projects in one turn, so "Projektwissen" no
longer says whose, and the agent must name the project for every claim it takes
from one (spec AG-4). The identity is on the scope entry the moment the BFF
builds it, and the two places it could be lost are here: the fan-out that tags
each chunk (the last point at which it is known for free) and the block the
model reads, which is also what the citation parser reads back.
"""

from types import SimpleNamespace

from knowledge_layer import register as reg

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.scoping import ScopedCollection


def _chunk(**metadata) -> SimpleNamespace:
    """One retrieved chunk, duck-typed the way the formatter reads it."""
    return SimpleNamespace(
        metadata=dict(metadata),
        file_name="brandschutz.pdf",
        page_number=7,
        content="Der Fluchtweg ist mit 1,20 m bemessen.",
        content_type=SimpleNamespace(value="text"),
        score=0.87,
    )


class TestTagging:
    def test_a_mounted_project_s_identity_lands_on_every_chunk(self):
        entry = ScopedCollection(
            "proj_seestadt",
            Shelf.PROJECT,
            project_id="proj-uuid-1",
            project_name="Seestadt Baufeld D",
        )
        chunks = [_chunk(), _chunk()]

        reg._tag_chunks_with_scope(chunks, entry)

        for chunk in chunks:
            assert chunk.metadata["collection"] == "proj_seestadt"
            assert chunk.metadata["shelf"] == "project"
            assert chunk.metadata["project_id"] == "proj-uuid-1"
            assert chunk.metadata["project_name"] == "Seestadt Baufeld D"

    def test_an_entry_without_a_project_stamps_none(self):
        """Absent is how this pipeline spells unknown: a base-corpus hit must
        not acquire a project, and a project chat's single collection carries no
        identity because the BFF had no second project to tell it apart from."""
        chunk = _chunk()

        reg._tag_chunks_with_scope([chunk], ScopedCollection("oib_knowledge", Shelf.BASE))

        assert chunk.metadata == {"collection": "oib_knowledge", "shelf": "base"}
        assert reg._chunk_project(chunk) == (None, None)

    def test_it_never_overwrites_what_the_producer_already_stated(self):
        chunk = _chunk(collection="proj_other", project_id="proj-uuid-9")

        reg._tag_chunks_with_scope(
            [chunk],
            ScopedCollection("proj_seestadt", Shelf.PROJECT, project_id="proj-uuid-1", project_name="Seestadt"),
        )

        assert chunk.metadata["collection"] == "proj_other"
        assert chunk.metadata["project_id"] == "proj-uuid-9"
        # The name was NOT stated, so it is filled in — setdefault per field.
        assert chunk.metadata["project_name"] == "Seestadt"


class TestTheBlockTheModelReads:
    def _format(self, chunk) -> str:
        result = SimpleNamespace(success=True, chunks=[chunk], error_message=None)
        return reg._format_results(result, "Brandschutz")

    def test_a_project_hit_states_its_project_by_name_and_by_id(self):
        block = self._format(
            _chunk(
                collection="proj_seestadt",
                shelf="project",
                project_id="proj-uuid-1",
                project_name="Seestadt Baufeld D",
            )
        )

        assert "Projekt: Seestadt Baufeld D" in block
        assert "Projekt-Id: proj-uuid-1" in block
        # Two lines, not one "Name (id: …)": a project name may carry brackets,
        # and the id is what the frontend links on.
        assert "Seestadt Baufeld D (id:" not in block

    def test_a_hit_from_no_project_states_none(self):
        block = self._format(_chunk(collection="oib_knowledge", shelf="base"))

        assert "Projekt:" not in block
        assert "Projekt-Id:" not in block

    def test_the_citation_parser_reads_both_fields_back(self):
        """The block is the contract between the knowledge layer and the source
        registry; a field the parser cannot read back is a field the citation
        chip does not have."""
        from aiq_agent.common.citation_verification import _parse_knowledge_layer

        block = self._format(
            _chunk(
                collection="proj_seestadt",
                shelf="project",
                project_id="proj-uuid-1",
                project_name="Seestadt Baufeld D",
            )
        )

        entries = _parse_knowledge_layer(block, "knowledge_search")

        assert len(entries) == 1
        assert entries[0].project_id == "proj-uuid-1"
        assert entries[0].project_name == "Seestadt Baufeld D"
