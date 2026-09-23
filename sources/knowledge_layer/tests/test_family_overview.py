"""A question about a whole Richtlinie is answered with all of its parts.

"Was weißt du über die OIB 2?" names four documents. Ranked passages answer it
with whichever two scored best, and the model then opens the rest one round at
a time, when it knows they exist at all. `knowledge_search` recognises the
shape (`norm_registry.family_query_number`), reads every member's scope passage
and Gliederung beside the search, and renders both in ONE grounding block: one
search round, then one round of Punkt opens.

These tests pin what that block is: the members first, in member order, each
with a Citation a reader can resolve; then the ordinary hits; one trailer
carrying one Gliederung per member; and a preamble that states what the corpus
holds rather than what a Richtlinie usually has.
"""

from __future__ import annotations

import importlib
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import knowledge_retrieval

from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.common.grounding_block import get_grounding_block
from aiq_agent.common.norm_registry import oib_families
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult

rp = importlib.import_module("knowledge_layer.read_passage")

BASE = "oib_knowledge"
MEMBERS = {
    "2": "oib-rl_2_ausgabe_mai_2023.pdf",
    "2.1": "oib-rl_2.1_ausgabe_mai_2023.pdf",
    "2.2": "oib-rl_2.2_ausgabe_mai_2023.pdf",
    "2.3": "oib-rl_2.3_ausgabe_mai_2023.pdf",
}
FAMILY_QUERY = "was weißt du über die OIB 2"
TOPIC_QUERY = "Fluchtweglänge GK 4 in der OIB 2"


def _punkt_chunk(file_name: str, punkt: str, depth: int, title: str, page: int, content: str = "") -> Chunk:
    return Chunk(
        chunk_id=f"{file_name}:{punkt}",
        content=content or f"{punkt} {title} — Text",
        score=0.71,
        file_name=file_name,
        page_number=page,
        display_citation=f"{file_name}, p.{page}",
        content_type=ContentType.TEXT,
        metadata={
            "chunking": "punkt",
            "punkt_id": punkt,
            "punkt_depth": depth,
            "punkt_title": title,
            "page_label": str(page),
        },
    )


def _outline_of(number: str, file_name: str) -> list[Chunk]:
    """One member as the store holds it: Punkt 0, two chapters, one sub-Punkt."""
    return [
        _punkt_chunk(file_name, "0", 1, "Vorbemerkungen", 2, content=f"Teil {number} gilt für …"),
        _punkt_chunk(file_name, "1", 1, "Begriffsbestimmungen", 3),
        _punkt_chunk(file_name, "2", 1, "Anforderungen", 4),
        _punkt_chunk(file_name, "2.1", 2, "Abstände", 4),
    ]


def _ranked() -> list[Chunk]:
    """What similarity returns for the same query: two passages, deep in one part."""
    return [
        _punkt_chunk(MEMBERS["2"], "3.5.2", 3, "Fluchtwege", 12, content="Die Fluchtweglänge …"),
        _punkt_chunk(MEMBERS["2.3"], "4.1", 2, "Hochhäuser", 5, content="Für Hochhäuser gilt …"),
    ]


def _outline_file(filters) -> str | None:
    """The file an OUTLINE fetch names, or ``None`` for an ordinary search."""
    clauses = (filters or {}).get("$and") or []
    names = [clause["file_name"]["$eq"] for clause in clauses if "file_name" in clause]
    depths = [clause for clause in clauses if "$or" in clause]
    return names[0] if names and depths else None


class _Store:
    """The retriever, answering outline fetches and ranked searches apart."""

    backend_name = "fake"
    embed_model_name = "fake-embedder"

    def __init__(self, outlines: dict[str, list[Chunk]], ranked: list[Chunk]):
        self.outlines = outlines
        self.ranked = ranked
        self.calls: list[dict] = []
        #: Set to make the ranked fetch fail the way a wrong embedder does.
        self.search_error: str | None = None

    async def retrieve(self, query, collection_name, top_k, filters=None):
        self.calls.append({"query": query, "collection": collection_name, "filters": filters, "top_k": top_k})
        file_name = _outline_file(filters)
        if self.search_error and not file_name:
            raise RuntimeError(self.search_error)
        chunks = self.outlines.get(file_name, []) if file_name else self.ranked
        return RetrievalResult(
            chunks=[chunk.model_copy(deep=True) for chunk in chunks],
            query=query,
            backend="fake",
            success=True,
        )


@pytest.fixture
def corpus(monkeypatch):
    """A base shelf holding OIB 2, 2.1, 2.2 and 2.3, and nothing else."""

    def install(members: dict[str, str], ranked: list[Chunk] | None = None) -> _Store:
        store = _Store(
            {file_name: _outline_of(number, file_name) for number, file_name in members.items()}, ranked or _ranked()
        )

        async def _documents(collection: str):
            return [SimpleNamespace(file_name=name, display_title=None) for name in members.values()]

        monkeypatch.setattr("knowledge_layer.register._get_retriever", lambda config: store)
        monkeypatch.setattr("knowledge_layer.register._initialize_ingestor", lambda config, llm: None)
        monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: store)
        monkeypatch.setattr("aiq_agent.knowledge.factory.get_available_documents_async", _documents)
        monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
        monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
        # The formatter's three store lookups are not what these tests are
        # about; an empty map is the documented fail-open and keeps the run
        # database-free.
        for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
            monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        return store

    return install


def _config(**overrides) -> KnowledgeRetrievalConfig:
    return KnowledgeRetrievalConfig(
        collection_name=BASE,
        include_base_collection=True,
        include_session_collection=False,
        generate_summary=False,
        top_k=8,
        max_chunks_per_document=0,
        **overrides,
    )


async def _search(query: str = FAMILY_QUERY, **kwargs) -> str:
    async with knowledge_retrieval(_config(), MagicMock()) as info:
        return await info.single_fn(info.input_schema(query=query, **kwargs))


def _citations(out: str) -> list[str]:
    return [line.split("Citation: ", 1)[1] for line in out.splitlines() if line.startswith("Citation: ")]


def _lanes(out: str) -> dict:
    return json.loads(out.split("## Trace-Lanes\n", 1)[1].split("\n", 1)[0])


class TestTheFamilyIsTheAnswer:
    async def test_every_member_is_a_hit_before_the_ranked_passages(self, corpus):
        """Member order, not score order: the reader is walking a Richtlinie."""
        corpus(MEMBERS)

        out = await _search()

        assert _citations(out)[:4] == [f"{MEMBERS[number]}, p.2" for number in ("2", "2.1", "2.2", "2.3")]
        assert _citations(out)[4:] == [f"{MEMBERS['2']}, p.12", f"{MEMBERS['2.3']}, p.5"]

    async def test_a_member_hit_is_its_scope_passage(self, corpus):
        """Punkt 0 says what the part is FOR, which is the question that was asked."""
        corpus(MEMBERS)

        out = await _search()

        assert "Teil 2.2 gilt für …" in out
        assert "Punkt: 0" in out

    async def test_the_preamble_names_the_family_and_counts_its_parts(self, corpus):
        corpus(MEMBERS)

        out = await _search()

        assert "OIB-Richtlinie 2: 4 Teile im Bestand (2, 2.1, 2.2, 2.3)." in out
        assert "Treffer 1 bis 4 sind der Geltungsbereich dieser Teile" in out

    async def test_the_preamble_says_the_parts_are_open(self, corpus):
        """The fact that stops the second round.

        The block already carried each part's scope passage and Gliederung,
        which is what `read_passage(document=…)` returns for one of them, and
        said nothing about that: the model read the preamble as a search
        result, announced it would now open the Richtlinie properly, and spent
        a whole round re-reading the passages it was holding. The Punkt is
        where the next open pays, and `_OUTLINE_INSTRUCTION` below says how.
        """
        corpus(MEMBERS)

        out = await _search()

        assert "Damit sind diese Teile geöffnet, auf der Ebene von `read_passage(document=…)`" in out
        assert "tiefer führt nur ein einzelner Punkt aus einer Gliederung" in out

    async def test_a_part_the_corpus_lacks_is_never_claimed(self, corpus):
        """Membership is derived from what is indexed. A deployment without 2.3
        must not be told it has one, which is the failure the whole branch
        exists to avoid, one level up."""
        corpus({"2": MEMBERS["2"], "2.1": MEMBERS["2.1"]})

        out = await _search()

        assert "OIB-Richtlinie 2: 2 Teile im Bestand (2, 2.1)." in out
        assert _citations(out)[:2] == [f"{MEMBERS['2']}, p.2", f"{MEMBERS['2.1']}, p.2"]
        assert "## Gliederung OIB-Richtlinie 2.3" not in out

    async def test_a_member_the_store_cannot_read_drops_out(self, corpus):
        """Registered and unreadable is not the same fact as indexed: a member
        with no chunk contributes no passage, no Gliederung and no count."""
        store = corpus(MEMBERS)
        store.outlines[MEMBERS["2.2"]] = []

        out = await _search()

        assert "OIB-Richtlinie 2: 3 Teile im Bestand (2, 2.1, 2.3)." in out
        assert MEMBERS["2.2"] not in out


class TestTheMembersAreOpened:
    """What the family branch returns is credited as OPENED on the turn's ledger,
    the way a ``read_passage(document=…)`` read is: a member re-read in a later
    round is then a repeat, not a new document."""

    @staticmethod
    async def _captured(query: str) -> list[dict]:
        from aiq_agent.common.turn_status import begin_lane_capture
        from aiq_agent.common.turn_status import end_lane_capture
        from aiq_agent.common.turn_status import get_lane_captures

        token = begin_lane_capture()
        try:
            await _search(query)
            return get_lane_captures()
        finally:
            end_lane_capture(token)

    async def test_a_member_s_hits_carry_the_locator_stamp(self, corpus):
        corpus(MEMBERS)

        hits = await self._captured(FAMILY_QUERY)

        members = {name for name in MEMBERS.values()}
        stamped = {hit["name"]: hit.get("tool") for hit in hits if hit["name"] in members}
        assert stamped and set(stamped.values()) == {"read_passage"}

    async def test_an_ordinary_search_stamps_nothing_as_opened(self, corpus):
        corpus(MEMBERS)

        hits = await self._captured(TOPIC_QUERY)

        assert hits and {hit.get("tool") for hit in hits} == {"knowledge_search"}


class TestWhereMembershipComesFrom:
    """Three sources, cheapest first, and never a literal list of parts."""

    async def test_the_turn_s_own_family_list_answers_without_a_store_read(self, corpus, monkeypatch):
        """The production path. The list is derived from the base shelf BEFORE
        the inventory cap can drop a member, so it is the complete one; the
        listing below it is what a run with no turn around it has."""
        from aiq_agent.knowledge.inventory import set_norm_families

        store = corpus(MEMBERS)

        async def _no_listing(collection: str):
            raise AssertionError("the bound family list already knows the members")

        monkeypatch.setattr("aiq_agent.knowledge.factory.get_available_documents_async", _no_listing)
        set_norm_families(oib_families(MEMBERS.values()))
        try:
            out = await _search()
        finally:
            set_norm_families(None)

        assert "OIB-Richtlinie 2: 4 Teile im Bestand (2, 2.1, 2.2, 2.3)." in out
        assert len([call for call in store.calls if _outline_file(call["filters"])]) == 4


class TestTheOneTrailer:
    async def test_one_gliederung_per_member_under_its_own_title(self, corpus):
        corpus(MEMBERS)

        out = await _search()

        assert out.count("## Gliederung ") == 4
        assert "## Gliederung OIB-Richtlinie 2.3, Ausgabe Mai 2023" in out

    async def test_the_instruction_is_stated_once(self, corpus):
        """It says what a Gliederung is and is not, and that holds for all of
        them; four copies would be three copies of one sentence."""
        corpus(MEMBERS)

        out = await _search()

        assert out.count(rp._OUTLINE_INSTRUCTION) == 1

    async def test_the_index_lists_chapters_and_not_sub_punkte(self, corpus):
        """Four members at the single-document budget is 4 to 6k tokens of index
        framing far less evidence, so a family prints depth 1 only."""
        corpus(MEMBERS)

        out = await _search()
        index = out.split("## Gliederung ", 1)[1]

        assert "- Punkt 2: Anforderungen (S. 4)" in index
        assert "Punkt 2.1: Abstände" not in index

    async def test_the_trailer_follows_the_fan_out(self, corpus):
        """A heading may not arrive where a passage body is read."""
        corpus(MEMBERS)

        out = await _search()

        assert out.index("## Trace-Lanes") < out.index("## Gliederung ")


class TestTheBlockIsStillOneRecordSet:
    @pytest.fixture
    def capturing(self):
        token = begin_grounding_capture()
        yield
        end_grounding_capture(token)

    async def test_the_whole_block_is_found_by_its_own_bytes(self, corpus, capturing):
        """ADR-0061: the preamble and the trailer are rendered INSIDE the block.
        A byte glued on afterwards costs this result the structured reader."""
        corpus(MEMBERS)

        assert get_grounding_block(await _search()) is not None

    async def test_the_lane_fan_out_carries_every_member(self, corpus):
        corpus(MEMBERS)

        (lane,) = _lanes(await _search())["lanes"]

        assert [source["name"] for source in lane["sources"]][:4] == list(MEMBERS.values())
        assert [source["detail"] for source in lane["sources"]][:4] == ["Pkt. 0 p.2"] * 4

    async def test_a_punkt_addressed_hit_is_listed_by_its_punkt(self, corpus):
        """The locus a reader of a normative document can act on is the Punkt.
        The page rides along because the frontend takes the preview's page out
        of this string."""
        corpus(MEMBERS)

        details = [source["detail"] for source in _lanes(await _search())["lanes"][0]["sources"]]

        assert details[4:] == ["Pkt. 3.5.2 p.12", "Pkt. 4.1 p.5"]


class TestTheOrdinarySearchIsUntouched:
    async def test_a_topic_question_gets_passages_and_no_family(self, corpus):
        """ "OIB 2 Fluchtweglänge" wants the passage it named. An overview would
        answer a question nobody asked and spend the round doing it."""
        store = corpus(MEMBERS)

        out = await _search(TOPIC_QUERY)

        assert "im Bestand" not in out
        assert "## Gliederung" not in out
        assert _citations(out) == [f"{MEMBERS['2']}, p.12", f"{MEMBERS['2.3']}, p.5"]
        assert [call for call in store.calls if _outline_file(call["filters"])] == []

    async def test_a_file_scoped_search_is_the_opposite_request(self, corpus):
        """`file_name=` is the caller narrowing to one document."""
        store = corpus(MEMBERS)

        out = await _search(FAMILY_QUERY, file_name=MEMBERS["2"])

        assert "im Bestand" not in out
        assert [call for call in store.calls if _outline_file(call["filters"])] == []

    async def test_a_folder_scoped_search_is_too(self, corpus):
        store = corpus(MEMBERS)

        await _search(FAMILY_QUERY, folder="Brandschutz")

        assert [call for call in store.calls if _outline_file(call["filters"])] == []

    async def test_a_failed_fan_out_is_reported_as_a_failure(self, corpus):
        """An overview rendered over a corpus that answered nothing would look
        exactly like a complete answer."""
        store = corpus(MEMBERS)
        store.search_error = "Retrieval failed: Collection 'oib_knowledge' embedding mismatch: e5 vs nv-embed"

        out = await _search()

        assert out.startswith("Knowledge retrieval failed:")
        assert "im Bestand" not in out

    async def test_a_corpus_without_the_family_answers_as_it_always_did(self, corpus):
        store = corpus({"3": "oib-rl_3_ausgabe_mai_2023.pdf"})

        out = await _search()

        assert "im Bestand" not in out
        assert [call for call in store.calls if _outline_file(call["filters"])] == []


class TestAnOverviewThatFailsSaysSo:
    """Fail-open kept the answer and lost the fact that the family branch ran.

    A production trace showed a family question coming back as two ranked
    documents with nothing marking the overview as attempted and lost, so the
    turn read exactly like an ordinary search and could not be explained.
    """

    @staticmethod
    def _broken(monkeypatch) -> None:
        async def _raise(entries, family_key):
            raise RuntimeError("outline store down")

        monkeypatch.setattr(rp, "family_overview", _raise)

    async def test_the_ranked_passages_still_answer(self, corpus, monkeypatch):
        corpus(MEMBERS)
        self._broken(monkeypatch)

        out = await _search()

        assert _citations(out) == [f"{MEMBERS['2']}, p.12", f"{MEMBERS['2.3']}, p.5"]
        assert "im Bestand" not in out
        assert "## Gliederung" not in out

    async def test_the_notice_says_the_overview_was_lost(self, corpus, monkeypatch):
        corpus(MEMBERS)
        self._broken(monkeypatch)

        out = await _search()

        assert out.startswith("Hinweis: der Überblick über die Teile der OIB-Richtlinie 2 konnte nicht erstellt")
        assert "`read_passage(document=…)`" in out

    async def test_a_search_that_names_no_family_carries_no_notice(self, corpus):
        corpus(MEMBERS)

        out = await _search(TOPIC_QUERY)

        assert "Hinweis:" not in out

    async def test_a_listed_family_with_no_readable_part_is_a_lost_overview(self, corpus):
        """No member read is not "no family": the corpus lists it, so the
        search asked for an overview and got none, and the notice says so."""
        store = corpus(MEMBERS)
        for file_name in MEMBERS.values():
            store.outlines[file_name] = []

        out = await _search()

        assert out.startswith("Hinweis: der Überblick über die Teile der OIB-Richtlinie 2 konnte nicht erstellt")
        assert _citations(out) == [f"{MEMBERS['2']}, p.12", f"{MEMBERS['2.3']}, p.5"]


class TestOneRoundNotFive:
    async def test_the_members_are_read_in_one_gathered_round(self, corpus):
        """One filtered fetch per member, plus the search itself."""
        store = corpus(MEMBERS)

        await _search()

        outline_calls = [call for call in store.calls if _outline_file(call["filters"])]
        assert sorted(_outline_file(call["filters"]) for call in outline_calls) == sorted(MEMBERS.values())
        assert all(call["top_k"] == rp._MAX_OUTLINE_CHUNKS for call in outline_calls)

    async def test_a_scope_passage_the_search_also_ranked_is_not_repeated(self, corpus):
        """One passage, one citation key: a repeat would spend a result slot on
        text the block already carries."""
        corpus(MEMBERS, ranked=[_punkt_chunk(MEMBERS["2"], "0", 1, "Vorbemerkungen", 2, content="Teil 2 gilt für …")])

        out = await _search()

        assert _citations(out).count(f"{MEMBERS['2']}, p.2") == 1


def _ranked_many() -> list[Chunk]:
    """What a real family query ranks around the overview: many passages, mostly guidance."""
    return [
        _punkt_chunk(MEMBERS["2"], f"3.{i}", 2, f"Abschnitt {i}", 10 + i, content=f"Passage {i} …") for i in range(1, 11)
    ]


class TestTheOverviewIsNotBuriedInRankedHits:
    async def test_only_a_few_ranked_passages_ride_beside_the_overview(self, corpus):
        """The overview answers; sixteen ranked passages beside it were half the block."""
        reg = importlib.import_module("knowledge_layer.register")
        corpus(MEMBERS, ranked=_ranked_many())

        out = await _search()

        citations = _citations(out)
        assert citations[:4] == [f"{MEMBERS[number]}, p.2" for number in ("2", "2.1", "2.2", "2.3")]
        assert len(citations) == 4 + reg._FAMILY_RANKED_HITS

    async def test_an_ordinary_search_keeps_its_full_budget(self, corpus):
        corpus(MEMBERS, ranked=_ranked_many())

        out = await _search(query=TOPIC_QUERY)

        assert len(_citations(out)) == 8


class TestAnOverviewQuestionIsNotJudged:
    async def test_the_requery_judge_never_runs_on_a_family_query(self, corpus, monkeypatch):
        """The judge counts a scope note as not answering; on an overview it said no by construction."""
        corpus(MEMBERS)
        calls: list = []

        class _Judge:
            async def ainvoke(self, *args, **kwargs):
                calls.append(args)
                return SimpleNamespace(content='{"sufficient": false, "queries": ["andere Frage"]}')

        async def _resolve(_builder, _name):
            return _Judge()

        monkeypatch.setattr("aiq_agent.common.get_langchain_llm", _resolve)
        async with knowledge_retrieval(_config(requery_llm="judge"), MagicMock()) as info:
            out = await info.single_fn(info.input_schema(query=FAMILY_QUERY))

        assert calls == []
        assert "Umformulierungen" not in out
