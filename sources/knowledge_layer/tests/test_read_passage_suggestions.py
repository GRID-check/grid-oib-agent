"""Unknown-document refusals name up to three verbatim guesses.

``read_passage`` never fuzzy-matches — the match path stays exact — but a
refusal that names nothing leaves the model retyping the same near-miss. The
refusal therefore appends the closest legal inventory titles, ranked by
similarity, restricted to this turn's readable scope, and labelled as guesses
to pass back verbatim.
"""

import importlib
from types import SimpleNamespace

# NOTE: `knowledge_layer.read_passage` as an ATTRIBUTE is the registered NAT
# function (see `knowledge_layer/__init__.py`); the module holding the helpers
# is reached through the import system instead.
rp = importlib.import_module("knowledge_layer.read_passage")


def _doc(file_name: str, display_title: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(file_name=file_name, display_title=display_title)


class TestMatchPathUntouched:
    def test_exact_and_case_insensitive_names_resolve(self):
        doc = _doc("oib-rl_2_ausgabe_mai_2023.pdf")

        assert rp._matches(doc, "oib-rl_2_ausgabe_mai_2023.pdf".casefold())
        assert rp._matches(doc, "OIB-RL_2_AUSGABE_MAI_2023.PDF".casefold())

    def test_a_fragment_is_not_a_match(self):
        doc = _doc("oib-rl_2_ausgabe_mai_2023.pdf")

        assert not rp._matches(doc, "oib-rl_2.pdf".casefold())
        # The title's HEAD is not a fragment: it is the document's name without
        # its edition, one of the exact names `_document_names` lists (with the
        # family-member spellings), so it opens the document — and still never
        # its sibling, because "oib-richtlinie 2" is not "oib-richtlinie 2.3".
        assert rp._matches(doc, "oib-richtlinie 2".casefold())
        assert not rp._matches(_doc("oib-rl_2.3_ausgabe_mai_2023.pdf"), "oib-richtlinie 2".casefold())


class TestSuggestions:
    def test_a_typo_suggests_the_file(self):
        docs = [_doc("oib-rl_2_ausgabe_mai_2023.pdf"), _doc("EG_Grundriss.pdf")]

        assert rp._suggestion_names("oib-rl_2_ausgabe_mai_20233.pdf", docs) == ["oib-rl_2_ausgabe_mai_2023.pdf"]

    def test_at_most_three_guesses(self):
        docs = [_doc(f"bericht_{index}.pdf") for index in range(6)]

        assert len(rp._suggestion_names("bericht.pdf", docs)) <= 3

    def test_every_guess_is_verbatim_usable(self):
        docs = [_doc("oib-rl_2_ausgabe_mai_2023.pdf"), _doc("Brandschutzkonzept.pdf")]
        guesses = rp._suggestion_names("oib-rl_2_ausgabe_mai_20203.pdf", docs) + rp._suggestion_names(
            "Brandschutzkonzeptt.pdf", docs
        )

        assert guesses
        for guess in guesses:
            folded = guess.strip().casefold()
            assert any(rp._matches(doc, folded) for doc in docs), f"{guess!r} resolves to nothing in scope"

    def test_scope_restricted(self):
        """Candidates are this turn's readable inventory: ``_open`` passes the
        scope listings, so a same-named file on an unreadable shelf is never
        suggested — even when it is string-closest."""
        in_scope = [_doc("Fremder_Bericht.pdf")]
        out_of_scope = _doc("Fremder_Bericht Kopie.pdf")

        unscoped = rp._suggestion_names("Fremder_Bericht Kopie.pdf", in_scope + [out_of_scope])
        assert unscoped[0] == "Fremder_Bericht Kopie.pdf"
        assert "Fremder_Bericht Kopie.pdf" not in rp._suggestion_names("Fremder_Bericht Kopie.pdf", in_scope)

    def test_nothing_close_means_no_guesses(self):
        docs = [_doc("oib-rl_2_ausgabe_mai_2023.pdf")]

        assert rp._suggestion_names("xyz-voellig-fremd-12345", docs) == []

    def test_cross_document_low_overlap_is_not_a_guess(self):
        # "Plan.pdf" vs "Brandschutzkonzept.pdf" sits at 0.40: the old bar
        # named it, the raised bar (0.6, the stdlib default) does not.
        docs = [_doc("Brandschutzkonzept.pdf")]

        assert rp._suggestion_names("Plan.pdf", docs) == []


class TestRefusalMessage:
    def test_guesses_are_appended_and_labelled_verbatim(self):
        message = rp._unknown_document_message("oib-rl_2_ausgabe_mai_20233.pdf", 4, ["oib-rl_2_ausgabe_mai_2023.pdf"])

        assert "No document in scope is named" in message
        assert "- oib-rl_2_ausgabe_mai_2023.pdf" in message
        assert "verbatim" in message

    def test_no_close_match_leaves_the_base_refusal(self):
        message = rp._unknown_document_message("xyz-voellig-fremd-12345", 4, [])

        assert "No document in scope is named" in message
        assert "knowledge_search" in message
        assert "Did you mean" not in message

    def test_truncation_names_the_further_count(self):
        guesses = [f"bericht_{index}.pdf" for index in range(5)]
        message = rp._unknown_document_message("bericht.pdf", 6, guesses)

        assert "- bericht_0.pdf" in message
        assert "+2 more candidate(s)" in message

    def test_zero_readable_documents_points_at_the_inventory(self):
        message = rp._unknown_document_message("irgendwas.pdf", 0, [])

        assert "No document in scope is named" in message
        assert "inventory" in message
        assert "knowledge_search" in message
        assert "Did you mean" not in message


class TestCoercePage:
    """#656: providers send '' for 'no page'; the int schema rejects it."""

    def test_empty_string_means_omitted(self):
        assert rp._coerce_page("") is None
        assert rp._coerce_page("   ") is None
        assert rp._coerce_page(None) is None

    def test_ints_pass_through(self):
        assert rp._coerce_page(12) == 12

    def test_numeric_strings_coerce(self):
        assert rp._coerce_page("12") == 12
        assert rp._coerce_page(" 7 ") == 7

    def test_garbage_means_omitted_not_crash(self):
        assert rp._coerce_page("abc") is None
