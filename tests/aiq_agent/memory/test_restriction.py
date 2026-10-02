"""The one decision about which restricted folders a memory depends on (ADR-0078).

``decide_restrictions`` is called by the ``remember`` tool and by the reflection
stage. These tests drive it directly with a fake judge model, and pin the strict
reading of the judge's reply, because an unusable reply must fail CLOSED.
"""

import asyncio
import json

import pytest

from aiq_agent.memory import restriction as R
from aiq_agent.memory.restriction import RestrictionEvidence
from aiq_agent.memory.restriction import decide_restriction
from aiq_agent.memory.restriction import decide_restrictions
from aiq_agent.memory.restriction import parse_judge_reply
from aiq_agent.memory.restriction import restriction_evidence

PROJECT = "proj_abc"
CONTRACTS = f"{PROJECT}_r0123456789ab"
PERSONNEL = f"{PROJECT}_rba9876543210"
SCOPE = ["oib_knowledge", PROJECT, CONTRACTS, PERSONNEL, "s_c1"]

CONTRACT_ROW = {"collection": CONTRACTS, "file_name": "Honorarvertrag.pdf", "summary": "Honorar LP 5-8: 184.000 EUR"}
PERSONNEL_ROW = {"collection": PERSONNEL, "file_name": "Gehaltsliste.xlsx", "summary": "Gehälter 2026"}
OPEN_ROW = {"collection": PROJECT, "file_name": "Grundriss.pdf", "summary": "Grundriss EG"}


class _Response:
    def __init__(self, content: str) -> None:
        self.content = content


class _Judge:
    """A chat model stand-in that answers with canned text and records the prompt."""

    def __init__(self, content: str | Exception, *, delay: float = 0.0) -> None:
        self._content = content
        self._delay = delay
        self.calls: list = []

    def bind(self, **_kwargs):
        return self

    async def ainvoke(self, messages):
        self.calls.append(messages)
        if self._delay:
            await asyncio.sleep(self._delay)
        if isinstance(self._content, Exception):
            raise self._content
        return _Response(self._content)


def _reply(*verdicts: list[int]) -> str:
    return json.dumps({"notes": [{"note": i, "documents": docs} for i, docs in enumerate(verdicts, start=1)]})


def _evidence(*, sources=(), rows=(CONTRACT_ROW, OPEN_ROW), scope=SCOPE) -> RestrictionEvidence:
    return restriction_evidence(scope, source_collections=sources, listed_documents=rows)


class TestEvidence:
    def test_an_open_scope_is_no_restriction(self):
        evidence = restriction_evidence([PROJECT, "oib_knowledge"], source_collections=[PROJECT])
        assert not evidence.restricted

    def test_only_restricted_collections_of_the_scope_count_as_read(self):
        evidence = _evidence(sources=[CONTRACTS.upper(), PROJECT, None, "proj_other_r0123456789ab"])
        assert evidence.scope == (CONTRACTS, PERSONNEL)
        assert evidence.read == (CONTRACTS,)

    def test_only_restricted_rows_are_kept_as_documents(self):
        evidence = _evidence(rows=(CONTRACT_ROW, OPEN_ROW, {"collection": "elsewhere_r0123456789ab"}))
        assert [doc.name for doc in evidence.documents] == ["Honorarvertrag.pdf"]
        assert evidence.listing_known

    def test_an_object_row_reads_like_a_dict_row(self):
        class Row:
            collection = CONTRACTS
            file_name = "v.pdf"
            display_title = "Vertrag"
            summary = "x" * 1000

        [doc] = _evidence(rows=(Row(),)).documents
        assert doc.name == "Vertrag"
        assert len(doc.summary) == 300


class TestDecision:
    @pytest.mark.asyncio
    async def test_no_restricted_scope_is_open_and_asks_nobody(self):
        judge = _Judge(_reply([1]))
        assert await decide_restriction("x", RestrictionEvidence(), llm=judge) is None
        assert judge.calls == []

    @pytest.mark.asyncio
    async def test_a_cited_or_read_restricted_collection_restricts_without_a_judge(self):
        judge = _Judge(_reply([1]))
        evidence = _evidence(sources=[CONTRACTS], rows=(CONTRACT_ROW, OPEN_ROW))
        assert await decide_restriction("Honorar 184.000 EUR", evidence, llm=judge) == (CONTRACTS,)
        assert judge.calls == []

    @pytest.mark.asyncio
    async def test_listed_only_and_the_judge_says_yes(self):
        judge = _Judge(_reply([1]))
        assert await decide_restriction("Honorar 184.000 EUR", _evidence(), llm=judge) == (CONTRACTS,)
        prompt = judge.calls[0][1].content
        assert "Honorarvertrag.pdf" in prompt and "184.000" in prompt
        assert "Grundriss" not in prompt, "an open document is not the judge's business"

    @pytest.mark.asyncio
    async def test_listed_only_and_the_judge_says_no(self):
        judge = _Judge(_reply([]))
        assert await decide_restriction("Flachdach extensiv begrünt", _evidence(), llm=judge) is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "judge",
        [
            None,
            _Judge(RuntimeError("provider down")),
            _Judge("not json at all"),
            _Judge(json.dumps({"notes": []})),
            _Judge(json.dumps({"notes": [{"note": 1, "documents": [7]}]})),
        ],
        ids=["no-model", "error", "unparseable", "missing-note", "out-of-range"],
    )
    async def test_an_unanswered_judge_fails_closed_to_every_restricted_collection(self, judge):
        evidence = _evidence(rows=(CONTRACT_ROW, PERSONNEL_ROW))
        assert await decide_restriction("x", evidence, llm=judge) == (CONTRACTS, PERSONNEL)

    @pytest.mark.asyncio
    async def test_a_judge_timeout_fails_closed(self, monkeypatch):
        monkeypatch.setattr(R, "JUDGE_TIMEOUT_S", 0.01)
        judge = _Judge(_reply([]), delay=1.0)
        assert await decide_restriction("x", _evidence(), llm=judge) == (CONTRACTS, PERSONNEL)

    @pytest.mark.asyncio
    async def test_an_unknown_inventory_fails_closed(self):
        """The inventory read failed open: what the turn could list is unknown."""
        judge = _Judge(_reply([]))
        evidence = _evidence(sources=[CONTRACTS], rows=())
        assert await decide_restriction("x", evidence, llm=judge) == (CONTRACTS, PERSONNEL)
        assert judge.calls == []

    @pytest.mark.asyncio
    async def test_restricted_collections_with_nothing_in_them_leave_the_memory_open(self):
        judge = _Judge(_reply([1]))
        assert await decide_restriction("x", _evidence(rows=(OPEN_ROW,)), llm=judge) is None
        assert judge.calls == []

    @pytest.mark.asyncio
    async def test_read_plus_an_unread_folder_the_note_draws_on(self):
        """Read A, and B's summary was listable: a note restricted to A alone
        would carry B's content to people cleared only for A."""
        judge = _Judge(_reply([1]))
        evidence = _evidence(sources=[CONTRACTS], rows=(CONTRACT_ROW, PERSONNEL_ROW))
        assert await decide_restriction("Gehälter steigen", evidence, llm=judge) == (CONTRACTS, PERSONNEL)
        assert "Gehaltsliste" in judge.calls[0][1].content
        assert "Honorarvertrag" not in judge.calls[0][1].content, "a read folder needs no judging"

    @pytest.mark.asyncio
    async def test_one_call_judges_every_note_of_a_batch(self):
        judge = _Judge(_reply([], [1], [1, 2]))
        evidence = _evidence(rows=(CONTRACT_ROW, PERSONNEL_ROW))
        result = await decide_restrictions(["a", "b", "c"], evidence, llm=judge)
        assert result == [None, (CONTRACTS,), (CONTRACTS, PERSONNEL)]
        assert len(judge.calls) == 1

    @pytest.mark.asyncio
    async def test_more_unread_documents_than_the_judge_is_shown_fails_closed(self, monkeypatch):
        monkeypatch.setattr(R, "MAX_JUDGE_DOCUMENTS", 1)
        judge = _Judge(_reply([]))
        evidence = _evidence(rows=(CONTRACT_ROW, PERSONNEL_ROW))
        assert await decide_restriction("x", evidence, llm=judge) == (CONTRACTS, PERSONNEL)
        assert judge.calls == []


class TestParse:
    def test_a_fenced_reply_parses(self):
        assert parse_judge_reply("```json\n" + _reply([2], []) + "\n```", notes=2, documents=2) == [
            frozenset({2}),
            frozenset(),
        ]

    @pytest.mark.parametrize(
        "payload",
        [
            {"notes": [{"note": 1, "documents": []}, {"note": 1, "documents": []}]},
            {"notes": [{"note": 1, "documents": [], "extra": True}]},
            {"notes": [{"note": 2, "documents": []}]},
            {"verdicts": []},
            [],
        ],
        ids=["duplicate", "extra-key", "wrong-note", "wrong-shape", "not-an-object"],
    )
    def test_anything_but_one_verdict_per_note_is_no_answer(self, payload):
        assert parse_judge_reply(json.dumps(payload), notes=1, documents=1) is None


class TestRestrictedMemoryInThePrompt:
    """A paraphrase of a restricted NOTE must not be filed as open memory."""

    _DIGEST = (
        "PROJECT_MEMORY v1\n"
        '- [decision | high | unverified] "Flachdach extensiv begrünt."\n'
        '- [restricted | derived_fact | high | unverified] "Honorar LP 5-8 pauschal 184.000 EUR."'
    )

    def test_the_restricted_lines_of_a_digest_are_read_back(self):
        assert R.restricted_digest_notes(self._DIGEST) == ("Honorar LP 5-8 pauschal 184.000 EUR.",)
        assert R.restricted_digest_notes(None) == ()

    @pytest.mark.asyncio
    async def test_a_note_drawing_on_restricted_memory_is_restricted_to_every_collection(self):
        judge = _Judge(_reply([2]))
        evidence = restriction_evidence(
            SCOPE,
            listed_documents=(CONTRACT_ROW, OPEN_ROW),
            restricted_notes=R.restricted_digest_notes(self._DIGEST),
        )
        assert await decide_restriction("Das Pauschalhonorar bleibt", evidence, llm=judge) == (CONTRACTS, PERSONNEL)
        assert "(confidential note) Honorar LP 5-8" in judge.calls[0][1].content

    @pytest.mark.asyncio
    async def test_restricted_memory_alone_is_judged_too(self):
        judge = _Judge(_reply([]))
        evidence = restriction_evidence(SCOPE, listed_documents=(OPEN_ROW,), restricted_notes=("Honorar 184.000",))
        assert await decide_restriction("Flachdach", evidence, llm=judge) is None
        assert len(judge.calls) == 1

    @pytest.mark.asyncio
    async def test_nothing_to_judge_once_every_collection_is_read(self):
        judge = _Judge(_reply([1]))
        evidence = restriction_evidence(
            SCOPE, source_collections=[CONTRACTS, PERSONNEL], listed_documents=(OPEN_ROW,), restricted_notes=("x",)
        )
        assert await decide_restriction("y", evidence, llm=judge) == (CONTRACTS, PERSONNEL)
        assert judge.calls == []
