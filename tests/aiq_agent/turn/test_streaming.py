"""Final-answer streaming: deltas that tile the text, one terminal chunk with the extras, and the fold back."""

from aiq_agent.common import _create_chat_response
from aiq_agent.turn.streaming import fold_chunks_to_response
from aiq_agent.turn.streaming import iter_answer_deltas
from aiq_agent.turn.streaming import response_to_chunks
from nat.data_models.api_server import ChatResponseChunk


def _answer_response(text, *, cards=None, sources=None, confidence=None, **extras):
    """A fully-built ChatResponse like the one _run assembles before delivery.

    ``extras`` accepts the transparency extras (routing_decision, etc.) set the
    same way _run attaches them, so tests can assert they ride the terminal chunk.
    """
    resp = _create_chat_response(text, response_id="research_response", model="m")
    if cards is not None:
        resp.cards = cards
    if sources is not None:
        resp.sources = sources
    if confidence is not None:
        resp.answer_confidence = confidence
    for name, value in extras.items():
        setattr(resp, name, value)
    return resp


def _finish(chunk):
    return chunk.choices[0].finish_reason


def _content(chunk):
    return chunk.choices[0].delta.content


class TestIterAnswerDeltas:
    """Deltas must tile the answer exactly — no bytes added or lost."""

    def test_join_reproduces_text_verbatim(self):
        for text in [
            "Gebäudeklasse 4 [1].\n\n## Quellen\n[1] OIB-RL 2",
            "  leading and  double   spaces\tand\ttabs ",
            "single",
            "a\n\nb\n\nc",
        ]:
            assert "".join(iter_answer_deltas(text)) == text

    def test_empty_text_yields_no_deltas(self):
        assert iter_answer_deltas("") == []

    def test_words_are_not_split_across_deltas(self):
        # Each delta boundary falls on whitespace, so no delta starts mid-word
        # (every non-first delta begins after a space the prior delta absorbed).
        deltas = iter_answer_deltas("the quick brown fox jumps over the lazy dog", target_size=8)
        assert len(deltas) > 1
        assert "".join(deltas) == "the quick brown fox jumps over the lazy dog"


class TestResponseToChunks:
    """The chunk sequence _run yields for a fully-built response."""

    def test_flag_off_single_terminal_chunk(self):
        resp = _answer_response("The answer.", cards=[{"type": "summary"}])
        chunks = response_to_chunks(resp, stream=False)
        assert len(chunks) == 1
        assert _finish(chunks[0]) == "stop"
        assert _content(chunks[0]) == "The answer."
        assert getattr(chunks[0], "cards", None) == [{"type": "summary"}]

    def test_stream_deltas_then_terminal(self):
        text = "Gebäudeklasse 4 gilt hier [1]. Die OIB-Richtlinie 2 ist maßgeblich [2]."
        resp = _answer_response(text, cards=[{"type": "summary"}], sources=[{"citation_key": "k"}], confidence="high")
        chunks = response_to_chunks(resp, stream=True)
        # last chunk is the terminal; all others are deltas
        assert _finish(chunks[-1]) == "stop"
        assert all(_finish(c) is None for c in chunks[:-1])
        assert len(chunks) > 1
        # delta contents concatenate to exactly the answer text
        assert "".join(_content(c) for c in chunks[:-1]) == text

    def test_extras_only_on_terminal_never_on_deltas(self):
        resp = _answer_response("some answer text here", cards=[{"type": "summary"}], sources=[{"citation_key": "k"}])
        chunks = response_to_chunks(resp, stream=True)
        assert getattr(chunks[-1], "cards", None) == [{"type": "summary"}]
        assert getattr(chunks[-1], "sources", None) == [{"citation_key": "k"}]
        for delta in chunks[:-1]:
            assert getattr(delta, "cards", None) is None
            assert getattr(delta, "sources", None) is None

    def test_terminal_carries_full_content_for_persistence(self):
        # The terminal must carry the FULL text (not empty) so the disconnect
        # persistence path stores the complete answer, not a partial.
        text = "a somewhat longer answer that spans multiple streaming deltas for sure"
        resp = _answer_response(text)
        chunks = response_to_chunks(resp, stream=True)
        assert _content(chunks[-1]) == text

    def test_transparency_extras_ride_the_terminal_chunk(self):
        # WP-A extras set on the ChatResponse are lifted onto the terminal chunk
        # (never onto deltas), just like cards/sources.
        resp = _answer_response(
            "some answer text that spans multiple deltas for the stream",
            routing_decision="deep",
            escalation_reason="Die erste Antwort war unzureichend.",
            answer_confidence_capped_reason="ungrounded",
            citations_removed={"count": 2, "reasons": ["broken"]},
        )
        chunks = response_to_chunks(resp, stream=True)
        terminal = chunks[-1]
        assert getattr(terminal, "routing_decision", None) == "deep"
        assert getattr(terminal, "escalation_reason", None) == "Die erste Antwort war unzureichend."
        assert getattr(terminal, "answer_confidence_capped_reason", None) == "ungrounded"
        assert getattr(terminal, "citations_removed", None) == {"count": 2, "reasons": ["broken"]}
        for delta in chunks[:-1]:
            assert getattr(delta, "routing_decision", None) is None
            assert getattr(delta, "citations_removed", None) is None

    def test_absent_transparency_extras_not_set_on_terminal(self):
        # Absent-when-not-applicable: a plain answer carries none of the extras.
        resp = _answer_response("a plain answer with no transparency extras at all")
        terminal = response_to_chunks(resp, stream=True)[-1]
        for field in (
            "routing_decision",
            "escalation_reason",
            "answer_confidence_capped_reason",
            "citations_removed",
            "job_admission_rejected",
            "retry_after_seconds",
        ):
            assert getattr(terminal, field, None) is None

    def test_job_admission_rejection_extras_ride_terminal(self):
        # The queue-rejection notice carries both fields onto the terminal chunk.
        resp = _answer_response(
            "The research queue is full. Please retry shortly.",
            job_admission_rejected=True,
            retry_after_seconds=30,
        )
        terminal = response_to_chunks(resp, stream=False)[-1]
        assert getattr(terminal, "job_admission_rejected", None) is True
        assert getattr(terminal, "retry_after_seconds", None) == 30

    def test_rejection_streams_no_deltas_only_terminal(self):
        # A queue rejection is surfaced by the frontend banner, NOT an answer
        # bubble: even with streaming ON it must yield NO delta chunks — only the
        # single terminal chunk carrying both extras — so no bubble is opened.
        resp = _answer_response(
            "The research queue is full. Please retry shortly.",
            job_admission_rejected=True,
            retry_after_seconds=30,
        )
        chunks = response_to_chunks(resp, stream=True)
        assert len(chunks) == 1
        terminal = chunks[0]
        assert _finish(terminal) == "stop"
        assert getattr(terminal, "job_admission_rejected", None) is True
        assert getattr(terminal, "retry_after_seconds", None) == 30

    def test_normal_answer_still_streams_deltas_when_not_rejected(self):
        # Guard: the rejection short-circuit must not suppress deltas for a
        # normal answer of comparable length.
        text = "A normal answer that is long enough to span several streaming deltas here."
        resp = _answer_response(text)
        chunks = response_to_chunks(resp, stream=True)
        assert len(chunks) > 1
        assert "".join(_content(c) for c in chunks[:-1]) == text


class TestFoldChunksToResponse:
    """Single-output consumers (--input CLI, single-shot HTTP) get one response
    folded from the stream — never a doubled body."""

    def test_fold_stream_uses_terminal_not_doubled(self):
        text = "Antwort mit Beleg [1]."
        resp = _answer_response(text, cards=[{"type": "summary"}], sources=[{"citation_key": "k"}], confidence="high")
        folded = fold_chunks_to_response(response_to_chunks(resp, stream=True))
        assert folded.choices[0].message.content == text  # NOT doubled
        assert folded.cards == [{"type": "summary"}]
        assert folded.sources == [{"citation_key": "k"}]
        assert folded.answer_confidence == "high"

    def test_fold_single_terminal_reproduces_response(self):
        resp = _answer_response("Just one chunk.", cards=[{"type": "summary"}])
        folded = fold_chunks_to_response(response_to_chunks(resp, stream=False))
        assert folded.choices[0].message.content == "Just one chunk."
        assert folded.cards == [{"type": "summary"}]

    def test_fold_deltas_only_concatenates(self):
        # Defensive: a stream with no terminal folds to the concatenation.

        deltas = [ChatResponseChunk.create_streaming_chunk(t, finish_reason=None) for t in ["Hel", "lo!"]]
        folded = fold_chunks_to_response(deltas)
        assert folded.choices[0].message.content == "Hello!"
