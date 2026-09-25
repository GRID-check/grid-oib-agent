"""The one repair (ADR-0067): which quotes it may correct, which corrections hold, where they go."""

from __future__ import annotations

import asyncio

import pytest

from aiq_agent.agents.piloti import quote_patch
from aiq_agent.agents.piloti.quote_patch import PATCH_FLOOR
from aiq_agent.agents.piloti.quote_patch import accept
from aiq_agent.agents.piloti.quote_patch import patch_quotes
from aiq_agent.agents.piloti.quote_patch import select
from aiq_agent.agents.piloti.quote_patch import splice
from aiq_agent.common import citation_verification
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import UnverifiedQuote
from aiq_agent.common.citation_verification import closeness
from aiq_agent.common.citation_verification import verify_citations
from aiq_agent.common.citation_verification import verify_quoted_spans

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
        nearest_closeness=closeness(text, PASSAGE),
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


def test_an_attribution_problem_is_not_selected():
    answer = f"Es gilt: „{MISQUOTE}“."

    assert select([_quote(MISQUOTE, answer, reason="uncited")]) == []
    assert select([_quote(MISQUOTE, answer)]) != []


def test_a_passage_from_a_source_the_sentence_does_not_cite_is_never_used():
    # Two Bundesländer with near-identical texts. The quote cites Tirol [1],
    # but its wording is closest to Salzburg's passage. Correcting against that
    # would put Salzburg's words, and its value, under Tirol's citation.
    misquote = "Die lichte Durchgangshöhe bei Treppen muss wenigstens 2,50 m betragen"
    tirol = "Treppen: eine Durchgangshöhe von 2,20 m ist einzuhalten, gemessen lotrecht über der Stufenvorderkante."
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key="tbo_2022.pdf, p.20", chunk_text=tirol, source_type="knowledge_layer"))
    registry.add(SourceEntry(citation_key="s_bautg.pdf, p.5", chunk_text=PASSAGE, source_type="knowledge_layer"))
    answer = f"In Tirol gilt: „{misquote}“ [1].\n\n## Quellen\n- [1] tbo_2022.pdf, p.20\n"

    [flagged] = verify_quoted_spans(answer, registry)

    assert closeness(misquote, PASSAGE) >= PATCH_FLOOR  # Salzburg's text would have been patched from
    assert flagged.nearest is not None and flagged.nearest.citation_key == "tbo_2022.pdf, p.20"
    assert select([flagged]) == []  # Tirol's own text is not close: the marker stays


@pytest.mark.parametrize(
    ("cited", "other"),
    [
        # A cited filename that contains another Bundesland's filename.
        ("NÖ Bauordnung.pdf, p.4", "Bauordnung.pdf, p.4"),
        # The same with RIS keys.
        ("Steiermärkisches Baugesetz, § 5", "Baugesetz, § 5"),
    ],
)
def test_a_source_whose_name_is_inside_the_cited_one_is_not_cited(cited, other):
    # The line cites Niederösterreich; Bauordnung.pdf is only a substring of
    # its name. Read by a filename scan, it counted as cited and its closer
    # passage was chosen, the patch putting its words under [1].
    misquote = "Die lichte Durchgangshöhe bei Treppen muss wenigstens 2,50 m betragen"
    own = "Treppen: eine Durchgangshöhe von 2,20 m ist einzuhalten, gemessen lotrecht über der Stufenvorderkante."
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key=cited, chunk_text=own, source_type="knowledge_layer"))
    registry.add(SourceEntry(citation_key=other, chunk_text=PASSAGE, source_type="knowledge_layer"))
    answer = f"Es gilt: „{misquote}“ [1].\n\n## Quellen\n- [1] {cited}\n"

    [flagged] = verify_quoted_spans(verify_citations(answer, registry).verified_report, registry)

    assert flagged.nearest is not None and flagged.nearest.citation_key == cited
    assert select([flagged]) == []


def test_the_passage_of_the_cited_source_is_the_one_patched_against():
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key="s_bautg.pdf, p.5", chunk_text=PASSAGE, source_type="knowledge_layer"))
    answer = f"In Salzburg gilt: „{MISQUOTE}“ [1].\n\n## Quellen\n- [1] s_bautg.pdf, p.5\n"

    [flagged] = verify_quoted_spans(answer, registry)

    assert flagged.nearest is not None and select([flagged]) == [flagged]


def test_a_slow_patch_leaves_the_quote_as_it_was(monkeypatch):
    monkeypatch.setattr(quote_patch, "PATCH_TIMEOUT_S", 0.01)
    answer = f"Es gilt: „{MISQUOTE}“ [1]."

    async def patch(text: str, passage: str) -> str | None:
        await asyncio.sleep(1)
        return CORRECT

    assert asyncio.run(patch_quotes(answer, [_quote(MISQUOTE, answer)], patch)) == (answer, 0)


def test_the_page_quoted_is_chosen_over_a_page_sharing_one_long_phrase():
    # Both pages belong to the cited document, so both are candidates. Page 4
    # shares one long contiguous phrase with the misquote (higher coverage),
    # page 3 is the sentence it misremembers (higher closeness). Ranked by
    # coverage, page 4 was chosen and select() dropped the quote unpatched.
    page_4 = "Die lichte Durchgangshöhe bei Treppen muss der Nutzung entsprechen, Aufzüge sind ausgenommen."
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key="oib.pdf, p.3", chunk_text=PASSAGE, source_type="knowledge_layer"))
    registry.add(SourceEntry(citation_key="oib.pdf, p.4", chunk_text=page_4, source_type="knowledge_layer"))
    answer = f"Es gilt: „{MISQUOTE}“ [1].\n\n## Quellen\n- [1] oib.pdf, p.3\n"

    [flagged] = verify_quoted_spans(answer, registry)

    assert flagged.nearest is not None and flagged.nearest.citation_key == "oib.pdf, p.3"
    assert select([flagged]) == [flagged]


BRANDWAND_PASSAGE = "Als Brandabschnitt gilt der Bereich „zwischen Brandwänden“ eines Geschosses nach Punkt 3.1."
BRANDWAND = "Als Brandabschnitt gilt der Bereich „zwischen Brandwänden“"
BRANDWAND_MISQUOTE = "Als Brandabschnitt gilt der Raum „zwischen Brandwänden“"


def test_a_quotation_mark_that_is_the_passages_wording_is_kept():
    # The closing “ is the passage's; stripping it spliced an unbalanced „.
    assert accept(BRANDWAND_MISQUOTE, BRANDWAND, BRANDWAND_PASSAGE, span=f"»{BRANDWAND_MISQUOTE}«") == BRANDWAND


def test_a_correction_that_would_nest_the_enclosing_marks_is_refused():
    # Inside „…“, the correction's own „…“ closes the quote early: the verifier
    # would re-read only „zwischen Brandwänden“, and the patch ship unchecked.
    assert accept(BRANDWAND_MISQUOTE, BRANDWAND, BRANDWAND_PASSAGE, span=f"„{BRANDWAND_MISQUOTE}“") is None


WRAPPED_PASSAGE = (
    "4.2 Treppen\nDie lichte Durchgangs-\nhöhe von Treppen muss\nmindestens 2,10 m betragen.\n\nPodeste sind ..."
)


def test_a_correction_copied_from_a_wrapped_passage_keeps_the_table_row_whole():
    # A PDF passage carries its line breaks and hyphen wraps. Copied as the
    # model returns it, the correction split the row into three lines.
    wrapped = "Die lichte Durchgangs-\nhöhe von Treppen muss\nmindestens 2,10 m betragen"
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key="oib.pdf, p.3", chunk_text=WRAPPED_PASSAGE, source_type="knowledge_layer"))
    answer = f"| Bauteil | Anforderung |\n|---|---|\n| Treppe | „{MISQUOTE}“ [1] |\n\n## Quellen\n- [1] oib.pdf, p.3\n"
    [flagged] = verify_quoted_spans(answer, registry)

    corrected = accept(MISQUOTE, wrapped, WRAPPED_PASSAGE, span=flagged.span)
    patched = splice(answer, [(flagged, corrected)])

    assert corrected == CORRECT
    assert f"| Treppe | „{CORRECT}“ [1] |\n" in patched
    assert verify_quoted_spans(patched, registry) == []  # what ships still verifies


def test_select_reuses_the_verifiers_closeness(monkeypatch):
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key="s_bautg.pdf, p.5", chunk_text=PASSAGE, source_type="knowledge_layer"))
    answer = f"In Salzburg gilt: „{MISQUOTE}“ [1].\n\n## Quellen\n- [1] s_bautg.pdf, p.5\n"
    [flagged] = verify_quoted_spans(answer, registry)

    def no_second_pass(*args: object) -> float:
        raise AssertionError("select() recomputed closeness")

    monkeypatch.setattr(citation_verification, "_normalized_closeness", no_second_pass)
    monkeypatch.setattr(citation_verification, "closeness", no_second_pass)

    assert flagged.nearest_closeness >= PATCH_FLOOR
    assert select([flagged]) == [flagged]


def test_a_quote_the_patch_never_corrects_gets_no_nearest_passage():
    long_quote = " ".join(["Treppen"] * 45)
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key="s_bautg.pdf, p.5", chunk_text=PASSAGE, source_type="knowledge_layer"))
    answer = (
        f"Es gilt: „{long_quote}“ [1]. Und „{MISQUOTE}“.\n\n"
        f"Ferner „{MISQUOTE}“ [1].\n\n## Quellen\n- [1] s_bautg.pdf, p.5\n"
    )

    too_long, uncited, misquoted = verify_quoted_spans(answer, registry)

    assert (too_long.reason, too_long.nearest, too_long.nearest_closeness) == ("too_long", None, 0.0)
    assert (uncited.reason, uncited.nearest) == ("uncited", None)
    assert misquoted.nearest is not None
    # A caller that never patches asks for none.
    assert all(quote.nearest is None for quote in verify_quoted_spans(answer, registry, with_nearest=False))
