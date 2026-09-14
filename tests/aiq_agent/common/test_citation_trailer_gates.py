"""Trailer-value grounding, digest rejection, mechanical quote gates.

Specs for the three ``citation_verification`` gates behind the reviewer
findings:

1. **Digest rejection** — an already-read digest line (``"<file> |
   <collection> | Seiten <p> | Punkte <n> | Turn <k>"``) is the read-index,
   not evidence, so a source line in that shape is removed in verification
   even when it names a genuinely retrieved document.
2. **Trailer values** — ``drop_ungrounded_trailer_values``: a Zahl, Klasse or
   Frist in a verdict, a takeaway or a detail survives only with a Fundstelle
   that resolves to a source this turn retrieved; otherwise the field drops
   while the prose keeps every word.
3. **Mechanical quote gates** — a quote over 40 words, or with no ``[N]`` in
   its sentence, is flagged at ``verify_quoted_spans`` even when verbatim.
"""

CHUNK = (
    "Die lichte Durchgangshoehe von Treppen muss mindestens 2,10 m betragen. Handlaeufe sind beidseitig anzubringen."
)


def _registry(*chunks: str):
    from aiq_agent.common.citation_verification import SourceEntry
    from aiq_agent.common.citation_verification import SourceRegistry

    reg = SourceRegistry()
    for i, chunk in enumerate(chunks, 1):
        reg.add(
            SourceEntry(
                citation_key=f"doc{i}.pdf, p.{i}",
                source_type="knowledge_layer",
                tool_name="knowledge_search",
                chunk_text=chunk,
            )
        )
    return reg


def _oib_entry():
    from aiq_agent.common.citation_verification import SourceEntry

    return SourceEntry(
        citation_key="oib-rl_2_ausgabe_mai_2023.pdf, p.12",
        title="OIB-Richtlinie 2",
        source_type="knowledge_layer",
        tool_name="knowledge_search",
        collection="oib_knowledge",
    )


class TestDigestShapedCitationsRejected:
    """A digest line cites the index; verification must not accept it."""

    _DIGEST_LINE = "oib-rl_2_ausgabe_mai_2023.pdf | oib_knowledge | Seiten 12 | Punkte 3.5.2 | Turn 1"

    def _report(self, line: str) -> str:
        return f"Die Regel gilt [1].\n\n## Sources\n- [1] {line}"

    def test_a_digest_shaped_line_is_removed_even_for_a_retrieved_document(self):
        from aiq_agent.common.citation_verification import SourceRegistry
        from aiq_agent.common.citation_verification import verify_citations

        registry = SourceRegistry()
        registry.add(_oib_entry())

        result = verify_citations(self._report(self._DIGEST_LINE), registry)

        assert result.valid_citations == []
        assert [removed["reason"] for removed in result.removed_citations] == ["digest_line_not_citable"]
        assert "[1]" not in result.verified_report.split("## Sources")[0]

    def test_a_proper_citation_to_the_same_document_stays_valid(self):
        from aiq_agent.common.citation_verification import SourceRegistry
        from aiq_agent.common.citation_verification import verify_citations

        registry = SourceRegistry()
        registry.add(_oib_entry())

        result = verify_citations(
            self._report("oib-rl_2_ausgabe_mai_2023.pdf, p.12"),
            registry,
        )

        assert len(result.valid_citations) == 1
        assert result.removed_citations == []

    def test_a_digest_line_does_not_sink_the_other_citations(self):
        from aiq_agent.common.citation_verification import SourceRegistry
        from aiq_agent.common.citation_verification import verify_citations

        registry = SourceRegistry()
        registry.add(_oib_entry())
        report = (
            "Erstens [1], zweitens [2].\n\n## Sources\n"
            f"- [1] {self._DIGEST_LINE}\n"
            "- [2] oib-rl_2_ausgabe_mai_2023.pdf, p.12"
        )

        result = verify_citations(report, registry)

        assert [cited["citation_key"] for cited in result.valid_citations] == ["oib-rl_2_ausgabe_mai_2023.pdf, p.12"]
        assert [removed["number"] for removed in result.removed_citations] == [1]


class TestDropUngroundedTrailerValues:
    """Values with Zahl/Klasse/Frist need a turn-source Fundstelle."""

    def _drop(self, meta: dict | None, sources: list) -> dict | None:
        from aiq_agent.common.citation_verification import drop_ungrounded_trailer_values

        return drop_ungrounded_trailer_values(meta, sources)

    def test_a_verdict_with_a_resolving_reference_survives(self):
        meta = {
            "v": 1,
            "verdict": {
                "value": "100 cm",
                "subject": "Erforderliche Gelanderhohe",
                "reference": {"document": "OIB-Richtlinie 2"},
            },
        }

        assert self._drop(meta, [_oib_entry()]) == meta

    def test_a_verdict_value_without_any_reference_drops(self):
        meta = {"v": 1, "verdict": {"value": "REI 60", "subject": "Feuerwiderstand"}}

        assert self._drop(meta, [_oib_entry()]) is None

    def test_a_verdict_value_with_an_unresolving_reference_drops(self):
        from aiq_agent.common.citation_verification import SourceEntry

        meta = {
            "v": 1,
            "verdict": {
                "value": "GK 4",
                "subject": "Gebaudeklasse",
                "reference": {"document": "OIB-Richtlinie 2"},
            },
        }
        stranger = SourceEntry(citation_key="plan.pdf, p.1", title="Plan", source_type="knowledge_layer")

        assert self._drop(meta, [stranger]) is None

    def test_a_verdict_without_a_value_is_never_touched(self):
        meta = {"v": 1, "verdict": {"value": "Nicht geregelt", "subject": "Zustandigkeit"}}

        assert self._drop(meta, [_oib_entry()]) == meta

    def test_bare_locators_are_not_values(self):
        """``Tabelle 1b``, ``Pkt. 3.5.2`` and ``§ 63`` locate; they claim nothing."""
        for value in ("Tabelle 1b", "Pkt. 3.5.2", "§ 63 Wiener Bauordnung"):
            meta = {"v": 1, "verdict": {"value": value, "subject": "Fundstelle"}}
            assert self._drop(meta, [_oib_entry()]) == meta

    def test_each_value_shape_triggers(self):
        """Zahl, Klasse and Frist each need their Fundstelle."""
        for value in ("100 cm", "REI 60", "GK 4", "vier Wochen", "binnen sechs Wochen", "unverzüglich"):
            meta = {"v": 1, "verdict": {"value": value, "subject": "Angabe"}}
            assert self._drop(meta, [_oib_entry()]) is None, value

    def test_a_takeaway_with_a_fundstelle_in_its_detail_survives(self):
        meta = {
            "v": 1,
            "takeaways": [
                {"text": "Tragende Bauteile in GK 4: mindestens REI 60"},
                {
                    "text": "Massgeblich ist das Fluchtniveau",
                    "detail": "Nach OIB-Richtlinie 2, Tabelle 1b.",
                },
            ],
        }

        dropped = self._drop(meta, [_oib_entry()])

        assert dropped is not None
        assert [item["text"] for item in dropped["takeaways"]] == ["Massgeblich ist das Fluchtniveau"]

    def test_a_takeaway_value_without_a_fundstelle_drops_the_item(self):
        meta = {
            "v": 1,
            "takeaways": [
                {"text": "Tragende Bauteile mindestens REI 60", "detail": "Aufkantungen zahlen mit."},
                {"text": "Massgeblich ist das Fluchtniveau, nicht die Geschosszahl"},
            ],
        }

        dropped = self._drop(meta, [_oib_entry()])

        assert dropped is not None
        assert [item["text"] for item in dropped["takeaways"]] == [
            "Massgeblich ist das Fluchtniveau, nicht die Geschosszahl"
        ]

    def test_a_takeaway_without_any_detail_and_with_a_value_drops(self):
        meta = {"v": 1, "takeaways": [{"text": "Die Frist betraegt vier Wochen"}]}

        assert self._drop(meta, [_oib_entry()]) is None

    def test_a_detail_carrying_its_own_value_drops_alone(self):
        """The claim stands; only the ungrounded footnote goes."""
        meta = {
            "v": 1,
            "takeaways": [
                {
                    "text": "Massgeblich ist das Fluchtniveau",
                    "detail": "Im Keller gilt REI 90.",
                }
            ],
        }

        dropped = self._drop(meta, [_oib_entry()])

        assert dropped == {"v": 1, "takeaways": [{"text": "Massgeblich ist das Fluchtniveau"}]}

    def test_a_callout_detail_with_a_value_but_no_fundstelle_drops_alone(self):
        meta = {
            "v": 1,
            "callout": {
                "kind": "frist",
                "text": "Die Frist beachten.",
                "detail": "Sie betraegt vier Wochen.",
            },
        }

        dropped = self._drop(meta, [_oib_entry()])

        assert dropped == {"v": 1, "callout": {"kind": "frist", "text": "Die Frist beachten."}}

    def test_a_callout_detail_naming_the_source_survives(self):
        meta = {
            "v": 1,
            "callout": {
                "kind": "frist",
                "text": "Die Frist beachten.",
                "detail": "Vier Wochen nach OIB-Richtlinie 2.",
            },
        }

        assert self._drop(meta, [_oib_entry()]) == meta

    def test_no_turn_sources_is_abstain_not_acquittal(self):
        """Nothing retrieved means nothing to judge against — pass through."""
        meta = {"v": 1, "verdict": {"value": "100 cm", "subject": "Hohe"}}

        assert self._drop(meta, []) == meta

    def test_no_meta_is_none(self):
        assert self._drop(None, [_oib_entry()]) is None


class TestMechanicalQuoteGates:
    """Form gates at ``verify_quoted_spans``: too long, or uncited, is flagged."""

    def test_a_41_word_verbatim_cited_quote_is_flagged_for_length(self):
        from aiq_agent.common.citation_verification import verify_quoted_spans

        quote = " ".join(f"Wort{i}" for i in range(1, 42))
        reg = _registry(f"Vorbemerkung. {quote} Nachbemerkung.")
        answer = f'Es gilt: „{quote}" [1].\n\n## Sources\n[1] doc1.pdf, p.1'

        (flagged,) = verify_quoted_spans(answer, reg)

        assert flagged.reason == "too_long"
        assert flagged.best_coverage >= 0.90

    def test_exactly_40_words_passes_the_length_gate(self):
        from aiq_agent.common.citation_verification import verify_quoted_spans

        quote = " ".join(f"Wort{i}" for i in range(1, 41))
        reg = _registry(f"Vorbemerkung. {quote} Nachbemerkung.")
        answer = f'Es gilt: „{quote}" [1].\n\n## Sources\n[1] doc1.pdf, p.1'

        assert verify_quoted_spans(answer, reg) == []

    def test_a_verbatim_quote_without_any_marker_is_flagged_uncited(self):
        from aiq_agent.common.citation_verification import verify_quoted_spans

        reg = _registry(CHUNK)
        answer = (
            "Die Norm verlangt „Handlaeufe sind beidseitig anzubringen“ ohne jede Markierung.\n\n"
            "## Sources\n[1] doc1.pdf, p.1"
        )

        (flagged,) = verify_quoted_spans(answer, reg)

        assert flagged.reason == "uncited"
        assert flagged.best_coverage >= 0.90

    def test_a_marker_two_sentences_away_does_not_attribute(self):
        from aiq_agent.common.citation_verification import verify_quoted_spans

        reg = _registry(CHUNK)
        answer = (
            "Die Regel lautet „Handlaeufe sind beidseitig anzubringen“ hier. "
            "Dazwischen steht ein Satz. Erst hier [1].\n\n"
            "## Sources\n[1] doc1.pdf, p.1"
        )

        (flagged,) = verify_quoted_spans(answer, reg)

        assert flagged.reason == "uncited"

    def test_a_trailing_marker_in_the_next_sentence_attributes(self):
        """Citations trail their sentence; abbreviations split the window.

        The one-sentence lookahead keeps ``… Satz. [1] …`` and ``… „Quote"
        vgl. … [1].`` passing — a quote two sentences from any marker is
        still flagged (see above).
        """
        from aiq_agent.common.citation_verification import verify_quoted_spans

        reg = _registry(CHUNK)
        answer = (
            "Die Regel lautet „Handlaeufe sind beidseitig anzubringen“ hier. Siehe [1].\n\n"
            "## Sources\n[1] doc1.pdf, p.1"
        )

        assert verify_quoted_spans(answer, reg) == []

    def test_a_decimal_point_does_not_split_the_sentence(self):
        from aiq_agent.common.citation_verification import verify_quoted_spans

        chunk = "Die lichte Hoehe muss mindestens 2.50 m im Lichten betragen, so die Verordnung."
        reg = _registry(chunk)
        answer = 'Es gilt: „Die lichte Hoehe muss mindestens 2.50 m im Lichten betragen" [1].'

        assert verify_quoted_spans(answer, reg) == []

    def test_long_and_uncited_combine_in_one_reason(self):
        from aiq_agent.common.citation_verification import verify_quoted_spans

        quote = " ".join(f"Wort{i}" for i in range(1, 42))
        reg = _registry(f"Vorbemerkung. {quote} Nachbemerkung.")
        answer = f"Es gilt: „{quote}“ ohne Markierung."

        (flagged,) = verify_quoted_spans(answer, reg)

        assert flagged.reason == "too_long+uncited"

    def test_a_cited_short_verbatim_quote_still_passes(self):
        from aiq_agent.common.citation_verification import verify_quoted_spans

        reg = _registry(CHUNK)
        answer = (
            'Es gilt: „Die lichte Durchgangshoehe von Treppen muss mindestens 2,10 m betragen" [1].\n\n'
            "## Sources\n[1] doc1.pdf, p.1"
        )

        assert verify_quoted_spans(answer, reg) == []
