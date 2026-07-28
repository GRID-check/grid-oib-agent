"""Contract tests across the citation pipeline's SEAMS.

Every bug the citation audit found lived between two well-tested units, not
inside one. The worst pair is the knowledge-layer text protocol: it is PRODUCED
by ``sources/knowledge_layer/src/register.py::_format_results`` and PARSED by
``aiq_agent.common.citation_verification::_parse_knowledge_layer`` — two
packages that never meet in a test.

The unit tests on either side cannot catch drift between them because they use
hand-written fixture strings written to match the parser: that tests the parser
against a COPY of the producer's format, not against the producer. These tests
call the real producer, feed its actual bytes to the real parser, and assert
every field landed on the right hit; then they walk one realistic turn all the
way to the wire payload the frontend renders.

The cross-language seams (Python producer ↔ TypeScript consumer) cannot run in
one process; they are pinned to shared fixture files instead — see
``TestSharedWireFixturesAreCurrent`` and its counterpart
``frontends/ui/src/features/chat/lib/citation-wire-contract.spec.ts``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest

from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import extract_sources_from_tool_result
from aiq_agent.common.citation_verification import sanitize_report
from aiq_agent.common.citation_verification import source_entry_to_wire
from aiq_agent.common.citation_verification import source_lane
from aiq_agent.common.citation_verification import verify_citations
from sources.knowledge_layer.src.register import _CHUNK_TRUNCATE_CHARS
from sources.knowledge_layer.src.register import _format_results

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures" / "citation_pipeline"


@pytest.fixture(autouse=True)
def fixture_empty_summary_store(tmp_path):
    """Keep chunk metadata authoritative so producer output is deterministic.

    ``_format_results`` resolves ``doc_class`` and ``display_title`` through the
    process-global document-metadata store. Without an empty per-test store the
    producer's bytes would depend on whichever database another test happened to
    configure first, and these tests would pass or fail by test order.
    """
    from aiq_agent.knowledge import factory
    from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore

    previous = factory._document_metadata_store
    db_url = f"sqlite:///{tmp_path / 'contract.db'}"
    DocumentMetadataStore._tables_initialized.discard(db_url)
    factory.configure_summary_db(db_url)
    yield
    factory._document_metadata_store = previous


# ---------------------------------------------------------------------------
# Synthetic retrieval hits — the INTENT both ends of the seam must agree on
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Hit:
    """One synthetic retrieval hit.

    Carries exactly the attributes ``_format_results`` reads off a chunk
    (``file_name``, ``page_number``, ``content``, ``content_type.value``,
    ``score``, ``metadata``) plus the parsed identity it must come back as.
    """

    file_name: str
    page: int | None = None
    collection: str | None = None
    doc_class: str | None = None
    body: str = "Passage."

    def chunk(self) -> SimpleNamespace:
        metadata: dict[str, str] = {}
        if self.collection:
            metadata["collection"] = self.collection
        if self.doc_class:
            metadata["doc_class"] = self.doc_class
        return SimpleNamespace(
            file_name=self.file_name,
            page_number=self.page,
            content=self.body,
            content_type=SimpleNamespace(value="text"),
            score=0.87,
            metadata=metadata,
        )

    @property
    def citation_key(self) -> str:
        return f"{self.file_name}, p.{self.page}" if self.page else self.file_name

    @property
    def identity(self) -> tuple[str, str | None, str | None]:
        return (self.citation_key, self.collection, self.doc_class)


def format_hits(hits: list[Hit], query: str = "Brandschutz") -> str:
    """The REAL producer's output for ``hits`` — never a hand-written string."""
    result = SimpleNamespace(success=True, error_message=None, chunks=[hit.chunk() for hit in hits])
    return _format_results(result, query)


def roundtrip(*hits: Hit):
    """hits → real producer → real parser → parsed ``SourceEntry`` list."""
    return extract_sources_from_tool_result("knowledge_search", format_hits(list(hits)))


def identities(entries) -> list[tuple[str | None, str | None, str | None]]:
    return [(entry.citation_key, entry.collection, entry.doc_class) for entry in entries]


def parsed_identities(tool_output: str) -> list[tuple[str | None, str | None, str | None]]:
    return identities(extract_sources_from_tool_result("knowledge_search", tool_output))


def trace_lanes(tool_output: str) -> list[dict]:
    """The ``## Trace-Lanes`` fan-out the frontend reads, as parsed JSON."""
    return json.loads(tool_output.split("## Trace-Lanes\n")[1])["lanes"]


def trace_lane_shape(tool_output: str):
    """Only the fan-out fields ``parseTraceLanesBlock`` actually consumes."""
    return [
        (
            lane["key"],
            lane["label"],
            lane["hitCount"],
            [(source["name"], source.get("title"), source.get("detail")) for source in lane["sources"]],
        )
        for lane in trace_lanes(tool_output)
    ]


class TestProducerParserContract:
    """Fields must bind to THEIR hit through the real producer's real output.

    The parser used to zip separate whole-document ``findall`` lists by
    position. ``_format_results`` emits ``Collection:`` and ``Dokumentart:``
    only when a hit HAS one, so a single unclassified hit shifted every later
    optional value onto the wrong document — and since ``doc_class`` is the
    first-priority signal in ``lane_for_hit``, a user's own project upload was
    silently presented as a binding OIB Richtlinie.
    """

    OIB = Hit(
        file_name="oib-rl_2_ausgabe_mai_2023.pdf",
        page=12,
        collection="oib_knowledge",
        doc_class="oib_richtlinie",
        body="Brandabschnitte sind so auszubilden, dass eine Brandausbreitung begrenzt wird.",
    )
    PROJEKT = Hit(
        file_name="einreichplan_og.pdf",
        page=4,
        collection="proj_abc",
        body="Der Einreichplan zeigt die Lage der Fluchtwege im Obergeschoss.",
    )
    ARCHIV = Hit(
        file_name="detail_attika.pdf",
        page=7,
        collection="archiv_org1",
        body="Bueroeigenes Regeldetail fuer die Attikaausbildung.",
    )

    def test_only_some_hits_classified_keeps_every_field_on_its_own_hit(self):
        """The audited bug: one unclassified hit shifted doc_class onto its neighbour."""
        entries = roundtrip(self.PROJEKT, self.OIB, self.ARCHIV)
        assert identities(entries) == [self.PROJEKT.identity, self.OIB.identity, self.ARCHIV.identity]

    def test_the_unclassified_hit_is_not_rendered_as_building_law(self):
        """The user-visible consequence of a shift: chip colour and authority badge."""
        projekt, oib, archiv = roundtrip(self.PROJEKT, self.OIB, self.ARCHIV)
        assert source_lane(projekt) == ("projekt", "Projektwissen")
        assert source_lane(archiv) == ("buero", "Büroarchiv")
        assert source_lane(oib) == ("baurecht_oib", "OIB-Richtlinie")

    def test_all_hits_classified(self):
        second = Hit(
            file_name="erlaeuterungen_oib-rl_2.pdf",
            page=3,
            collection="oib_knowledge",
            doc_class="oib_erlaeuterung",
            body="Erlaeuternde Bemerkungen zur Richtlinie 2.",
        )
        entries = roundtrip(self.OIB, second)
        assert identities(entries) == [self.OIB.identity, second.identity]

    def test_no_hit_classified(self):
        entries = roundtrip(self.PROJEKT, self.ARCHIV)
        assert identities(entries) == [self.PROJEKT.identity, self.ARCHIV.identity]
        assert all(entry.doc_class is None for entry in entries)

    def test_hit_without_a_collection_claims_no_collection(self):
        """A collection-less hit must not inherit the next hit's collection."""
        loose = Hit(file_name="lose_notiz.pdf", page=2, body="Handnotiz ohne Collection.")
        loose_entry, oib_entry = roundtrip(loose, self.OIB)
        assert (loose_entry.collection, loose_entry.doc_class) == (None, None)
        assert (oib_entry.collection, oib_entry.doc_class) == ("oib_knowledge", "oib_richtlinie")

    def test_single_hit(self):
        (entry,) = roundtrip(self.OIB)
        assert (entry.citation_key, entry.collection, entry.doc_class) == self.OIB.identity
        # The human `Source:` label, not the raw corpus filename, is the chip title.
        assert entry.title == "OIB-Richtlinie 2, Ausgabe Mai 2023"

    def test_many_hits_alternating_between_classified_and_not(self):
        """Ten hits: any positional zip drifts further with every optional field."""
        hits = []
        for index in range(10):
            if index % 2 == 0:
                hits.append(
                    Hit(
                        file_name=f"oib-rl_{index}_ausgabe_mai_2023.pdf",
                        page=index + 1,
                        collection="oib_knowledge",
                        doc_class="oib_richtlinie",
                        body=f"Richtlinientext {index}.",
                    )
                )
            else:
                hits.append(Hit(file_name=f"plan_{index}.pdf", page=index + 1, body=f"Planinhalt {index}."))
        entries = roundtrip(*hits)
        assert identities(entries) == [hit.identity for hit in hits]

    def test_pageless_hit_keeps_a_pageless_citation_key(self):
        """A page-less hit must not borrow the following hit's page number."""
        pageless = Hit(file_name="leitfaden.pdf", collection="oib_knowledge", body="Ohne Seitenzahl.")
        entry, oib_entry = roundtrip(pageless, self.OIB)
        assert entry.citation_key == "leitfaden.pdf"
        assert source_entry_to_wire(entry).get("page") is None
        assert source_entry_to_wire(oib_entry)["page"] == 12

    def test_truncated_body_arrives_without_the_producer_marker(self):
        """The truncation marker is protocol, not evidence — quote matching must not see it."""
        long_hit = Hit(
            file_name="langer_bericht.pdf",
            page=1,
            collection="proj_abc",
            body="A" * (_CHUNK_TRUNCATE_CHARS + 100),
        )
        (entry,) = roundtrip(long_hit)
        assert entry.chunk_text == "A" * _CHUNK_TRUNCATE_CHARS

    def test_trace_lanes_block_never_becomes_the_last_hit_body(self):
        """The fan-out JSON belongs to the result set; as evidence it verifies fake quotes."""
        tool_output = format_hits([self.PROJEKT, self.OIB])
        assert "## Trace-Lanes" in tool_output
        entries = extract_sources_from_tool_result("knowledge_search", tool_output)
        assert entries[-1].chunk_text == self.OIB.body

    def test_each_body_reaches_the_entry_that_retrieved_it(self):
        entries = roundtrip(self.PROJEKT, self.OIB, self.ARCHIV)
        assert [entry.chunk_text for entry in entries] == [self.PROJEKT.body, self.OIB.body, self.ARCHIV.body]

    def test_producer_emits_the_optional_lines_only_when_the_hit_has_them(self):
        """Guards the premise of every test above.

        If the producer ever emitted ``Collection:``/``Dokumentart:`` for every
        hit, positional parsing would look correct here and the shift would only
        reappear in production.
        """
        tool_output = format_hits([self.PROJEKT, self.OIB])
        assert tool_output.count("Dokumentart:") == 1
        assert format_hits([Hit(file_name="lose.pdf", page=1)]).count("Collection:") == 0


# ---------------------------------------------------------------------------
# Golden path: KB tool output → wire payload
# ---------------------------------------------------------------------------


GOLDEN_HITS = [
    Hit(
        file_name="oib-rl_2_ausgabe_mai_2023.pdf",
        page=12,
        collection="oib_knowledge",
        doc_class="oib_richtlinie",
        body="Brandabschnitte sind so auszubilden, dass eine Brandausbreitung begrenzt wird.",
    ),
    Hit(
        file_name="einreichplan_og.pdf",
        page=4,
        collection="proj_abc",
        body="Der Einreichplan zeigt die Lage der Fluchtwege im Obergeschoss.",
    ),
    Hit(
        file_name="detail_attika.pdf",
        page=7,
        collection="archiv_org1",
        body="Bueroeigenes Regeldetail fuer die Attikaausbildung.",
    ),
]

# The model's answer: two real sources and, between them, one it invented.
# The fabricated source sits in the MIDDLE so its removal opens a gap that
# renumbering must close — the combination that was broken.
GOLDEN_ANSWER = (
    "Brandabschnitte sind nach OIB-Richtlinie 2 auszubilden [1]. "
    "Ergaenzend fordert die OENORM B 1300 eine jaehrliche Begehung [2]. "
    "Der Einreichplan zeigt die Fluchtwege im Obergeschoss [3].\n"
    "\n"
    "## Quellen\n"
    "- [1] oib-rl_2_ausgabe_mai_2023.pdf, p.12\n"
    "- [2] oenorm_b1300_2024.pdf, p.9\n"
    "- [3] einreichplan_og.pdf, p.4\n"
)


def run_golden_path():
    """Walk the whole chain exactly as the shallow researcher's node does.

    KB tool output → ``extract_sources_from_tool_result`` → ``SourceRegistry`` →
    ``verify_citations`` → ``sanitize_report`` → ``source_entry_to_wire``,
    including the renumber remap the agent applies to the ``[N]`` labels.
    """
    tool_output = format_hits(GOLDEN_HITS)
    registry = SourceRegistry()
    for entry in extract_sources_from_tool_result("knowledge_search", tool_output):
        registry.add(entry)

    verification = verify_citations(GOLDEN_ANSWER, registry, reference_sources=registry.all_sources())
    sanitization = sanitize_report(verification.verified_report)

    wire = []
    for citation in verification.valid_citations:
        entry = registry.entry_for_citation_key(citation["citation_key"])
        number = sanitization.renumber_map.get(citation["number"], citation["number"])
        wire.append(source_entry_to_wire(entry, number=number))
    return tool_output, verification, sanitization, wire


class TestGoldenPathToWire:
    """One realistic turn, end to end, including a fabricated citation.

    Removal, renumbering and the wire ``number`` were each covered alone; their
    COMBINATION was not, and it was broken — the chip kept the number the model
    wrote while the prose had already been renumbered, so the inline marker
    scrolled to a source row that no longer existed.
    """

    def test_the_invented_source_is_the_only_one_removed(self):
        _, verification, _, _ = run_golden_path()
        assert [(c["number"], c["reason"]) for c in verification.removed_citations] == [
            (2, "citation_key_not_in_registry")
        ]

    def test_the_reader_sees_a_gapless_source_list(self):
        _, _, sanitization, _ = run_golden_path()
        assert sanitization.sanitized_report.endswith(
            "## Quellen\n- [1] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.12\n- [2] [KB] einreichplan_og.pdf, p.4\n"
        )

    def test_the_surviving_prose_marker_is_renumbered_with_the_list(self):
        _, _, sanitization, _ = run_golden_path()
        body = sanitization.sanitized_report.split("## Quellen")[0]
        assert "Fluchtwege im Obergeschoss [2]." in body
        # The sentence that cited the invented source keeps its text, loses its marker.
        assert "OENORM B 1300" in body
        assert "[3]" not in body
        # …and loses the space the marker sat in, rather than leaving the reader a
        # "Begehung ." that reads as a typo the writer never made.
        assert "eine jaehrliche Begehung. Der Einreichplan" in body

    def test_each_chip_carries_the_number_the_prose_now_uses(self):
        _, _, _, wire = run_golden_path()
        assert [(source["number"], source["file_name"]) for source in wire] == [
            (1, "oib-rl_2_ausgabe_mai_2023.pdf"),
            (2, "einreichplan_og.pdf"),
        ]

    def test_the_oib_hit_reaches_the_wire_fully_classified(self):
        _, _, _, wire = run_golden_path()
        oib = wire[0]
        assert (oib["kind"], oib["lane"], oib["origin"]) == ("baurecht", "baurecht_oib", "kb")
        assert (oib["file_name"], oib["page"]) == ("oib-rl_2_ausgabe_mai_2023.pdf", 12)

    def test_the_project_upload_reaches_the_wire_as_project_knowledge(self):
        _, _, _, wire = run_golden_path()
        projekt = wire[1]
        assert (projekt["kind"], projekt["lane"], projekt["origin"]) == ("projekt", "projekt", "kb")
        assert (projekt["file_name"], projekt["page"]) == ("einreichplan_og.pdf", 4)

    def test_a_retrieved_but_uncited_source_never_becomes_a_chip(self):
        """Chips claim the answer USED a source; the Büroarchiv detail was only found."""
        _, _, _, wire = run_golden_path()
        assert "detail_attika.pdf" not in {source["file_name"] for source in wire}


# ---------------------------------------------------------------------------
# Cross-language seams (Python producer ↔ TypeScript consumer)
# ---------------------------------------------------------------------------


class TestSharedWireFixturesAreCurrent:
    """Pin the three formats a TypeScript consumer parses.

    These formats cross a process boundary, so no single test can exercise both
    ends. Each side asserts against the SAME checked-in fixture instead: this
    class proves the fixtures are still what the Python producers emit, and
    ``frontends/ui/src/features/chat/lib/citation-wire-contract.spec.ts`` proves
    the frontend still parses them. Change a format and exactly one of the two
    fails — which is the whole point, because silent drift here is invisible
    until a user sees an unlabelled or mis-tinted source.

    When a format change here is intended, rewrite the fixtures from
    ``run_golden_path()`` and then run the frontend spec — that run is what
    tells you whether the frontend can still read the new format.

    The assertions are deliberately "the fixture is still a faithful sample",
    not "the bytes are identical": ADDING a field is invisible to a JSON
    consumer and must not break the build, while renaming, removing or
    re-valuing one of the fields the frontend reads must.
    """

    def test_kb_tool_output_fixture_still_describes_the_hits_it_claims(self):
        """Counterpart: trace-lanes.ts (`parseTraceLanesBlock`)."""
        tool_output, _, _, _ = run_golden_path()
        fixture = (FIXTURE_DIR / "kb_tool_output.txt").read_text(encoding="utf-8")
        assert parsed_identities(fixture) == parsed_identities(tool_output)

    def test_kb_tool_output_fixture_still_carries_the_same_fan_out(self):
        """Every field ``parseTraceLanesBlock`` reads must still mean what it did."""
        tool_output, _, _, _ = run_golden_path()
        fixture = (FIXTURE_DIR / "kb_tool_output.txt").read_text(encoding="utf-8")
        assert trace_lane_shape(fixture) == trace_lane_shape(tool_output)

    def test_verified_report_fixture_matches_the_pipeline(self):
        """Counterpart: report-citations.ts (`splitReportSources`, SOURCE_KIND_TOKEN_RE)."""
        _, _, sanitization, _ = run_golden_path()
        assert (FIXTURE_DIR / "verified_report.md").read_text(encoding="utf-8") == sanitization.sanitized_report

    def test_wire_sources_fixture_matches_the_serializer(self):
        """Counterpart: wire-citation.ts (`citationFromWire`)."""
        _, _, _, wire = run_golden_path()
        fixture = json.loads((FIXTURE_DIR / "wire_sources.json").read_text(encoding="utf-8"))
        assert len(fixture) == len(wire)
        for sampled, live in zip(fixture, wire, strict=True):
            assert sampled.items() <= live.items()

    def test_every_origin_is_one_the_frontend_token_regex_accepts(self):
        """``SOURCE_KIND_TOKEN_RE`` and ``normalizeOrigin`` know exactly three tokens."""
        _, _, _, wire = run_golden_path()
        assert {source["origin"] for source in wire} <= {"kb", "ris", "web"}

    def test_trace_lane_keys_agree_with_the_wire_lanes(self):
        """The fan-out and the chips must not disagree about where a hit belongs."""
        tool_output, _, _, wire = run_golden_path()
        lanes = trace_lanes(tool_output)
        assert [lane["key"] for lane in lanes] == ["baurecht_oib", "projekt", "buero"]
        assert {source["lane"] for source in wire} <= {lane["key"] for lane in lanes}


class TestBatchToolOutputContract:
    """The batch envelope must be split by the real producer's real separator.

    ``_format_batch_tool_output`` (deep researcher) joins ``## Query: <q>``
    sections with ``\\n\\n---\\n\\n``; ``_split_batch_output_bodies`` (citation
    verification, a different package) re-splits them to decide whether a batch
    is evidence or a status report. The consumer's tests hand-write that
    envelope, so a change to the producer's separator would leave every test
    green while a batch of pure failures started registering itself as a
    citable source — the "3 sources" the answer never had.
    """

    def batch(self, *results: tuple[str, str | None, str | None]) -> str:
        from aiq_agent.agents.deep_researcher.tools.source_tool_batching import _format_batch_tool_output

        return _format_batch_tool_output(list(results))

    def test_a_batch_where_every_query_failed_cites_nothing(self):
        output = self.batch(("alpha", None, "connection refused"), ("beta", None, "timeout"))
        assert extract_sources_from_tool_result("ris_search_tool", output) == []

    def test_a_batch_where_every_query_found_nothing_cites_nothing(self):
        output = self.batch(("alpha", "No RIS documents found for query alpha.", None))
        assert extract_sources_from_tool_result("ris_search_tool", output) == []

    def test_one_good_query_survives_alongside_a_failed_one(self):
        """A partial failure must not discard the evidence the batch did find."""
        output = self.batch(
            ("alpha", None, "connection refused"),
            ("beta", "Title: Bauordnung\nhttps://ris.bka.gv.at/eli/lgbl/W/1930/11", None),
        )
        entries = extract_sources_from_tool_result("ris_search_tool", output)
        assert [entry.url for entry in entries] == ["https://ris.bka.gv.at/eli/lgbl/W/1930/11"]


class TestPassageBodyCannotForgeHeaderFields:
    """A retrieved passage must never be read as another hit's header field.

    Block-scoped parsing alone was not enough: a block holds the header AND the
    retrieved text, and the producer omits ``Dokumentart:``/``Collection:`` for
    a hit that has none — so a scanned title block or metadata table inside the
    passage supplied them instead. That reproduced the exact user-visible
    failure positional misalignment caused: a project upload presented as a
    binding OIB Richtlinie. Header fields are now read from the header region
    only (``_kl_block_header``).
    """

    POISONED = Hit(
        file_name="einreichplan_og.pdf",
        page=4,
        collection="proj_abc",
        body="Deckblatt\nDokumentart: oib_richtlinie — OIB-Richtlinie\nProjekt Nr. 42",
    )

    def test_passage_text_does_not_classify_the_hit(self):
        (entry,) = roundtrip(self.POISONED)
        assert entry.doc_class is None

    def test_a_project_upload_stays_out_of_the_baurecht_lane(self):
        (entry,) = roundtrip(self.POISONED)
        assert source_lane(entry) == ("projekt", "Projektwissen")
