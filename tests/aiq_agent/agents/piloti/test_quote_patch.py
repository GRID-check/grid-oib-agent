"""The one repair (ADR-0067): which quotes it may correct, which corrections hold, where they go."""

from __future__ import annotations

import asyncio

from aiq_agent.agents.piloti import quote_patch
from aiq_agent.agents.piloti.quote_patch import PATCH_FLOOR
from aiq_agent.agents.piloti.quote_patch import accept
from aiq_agent.agents.piloti.quote_patch import closeness
from aiq_agent.agents.piloti.quote_patch import patch_quotes
from aiq_agent.agents.piloti.quote_patch import splice
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import UnverifiedQuote

PASSAGE = (
    "Vorher steht ein Satz über Geländer und Brüstungen. Die lichte Durchgangshöhe von Treppen muss "
    "mindestens 2,10 m betragen. Danach ein Satz über Podeste und Stufen in Gebäudeklasse 4."
)
MISQUOTE = "Die lichte Durchgangshöhe bei Treppen muss wenigstens 2,10 m betragen"
CORRECT = "Die lichte Durchgangshöhe von Treppen muss mindestens 2,10 m betragen"


def _quote(text: str, answer: str, *, reason: str = "not_verbatim") -> UnverifiedQuote:
    start = answer.index(f"„{text}“")
    return UnverifiedQuote(
        quote=text,
        span=f"„{text}“",
        start=start,
        end=start + len(text) + 2,
        best_coverage=0.4,
        reason=reason,
        nearest=SourceEntry(citation_key="oib.pdf, p.3", chunk_text=PASSAGE),
    )


def test_a_misremembered_quote_is_close_and_an_invented_one_is_not():
    assert closeness(MISQUOTE, PASSAGE) >= PATCH_FLOOR
    assert closeness("Treppen müssen mit einer automatischen Löschanlage ausgestattet sein", PASSAGE) < PATCH_FLOOR


def test_a_correction_holds_only_when_it_is_the_passage_verbatim():
    assert accept(MISQUOTE, CORRECT, PASSAGE) == CORRECT
    assert accept(MISQUOTE, f"„{CORRECT}“", PASSAGE) == CORRECT  # quotation marks are not wording
    # One digit off passes the verifier's fuzzy threshold; it is not the passage.
    assert accept(MISQUOTE, CORRECT.replace("2,10", "2,50"), PASSAGE) is None
    assert accept(MISQUOTE, "NONE", PASSAGE) is None
    # Verbatim, but another sentence of the passage: not a correction of this quote.
    assert accept(MISQUOTE, "Danach ein Satz über Podeste und Stufen in Gebäudeklasse 4", PASSAGE) is None


def test_only_the_words_between_the_quotation_marks_move():
    answer = f"Es gilt: „{MISQUOTE}“ [1]. Danach die Breite."
    quote = _quote(MISQUOTE, answer)

    assert splice(answer, [(quote, CORRECT)]) == f"Es gilt: „{CORRECT}“ [1]. Danach die Breite."


def test_an_attribution_problem_is_not_patched():
    answer = f"Es gilt: „{MISQUOTE}“."
    calls: list[str] = []

    async def patch(text: str, passage: str) -> str | None:
        calls.append(text)
        return CORRECT

    patched, count = asyncio.run(patch_quotes(answer, [_quote(MISQUOTE, answer, reason="uncited")], patch))

    assert (patched, count, calls) == (answer, 0, [])


def test_a_slow_patch_leaves_the_quote_as_it_was(monkeypatch):
    monkeypatch.setattr(quote_patch, "PATCH_TIMEOUT_S", 0.01)
    answer = f"Es gilt: „{MISQUOTE}“ [1]."

    async def patch(text: str, passage: str) -> str | None:
        await asyncio.sleep(1)
        return CORRECT

    assert asyncio.run(patch_quotes(answer, [_quote(MISQUOTE, answer)], patch)) == (answer, 0)
