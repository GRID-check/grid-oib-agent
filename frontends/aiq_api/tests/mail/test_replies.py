"""The reply split: own text, quoted blocks, and a bounded worst case."""

from __future__ import annotations

import time

import pytest

from aiq_api.mail import limits
from aiq_api.mail.replies import split_replies


def test_text_with_no_quote_is_all_own_text():
    split = split_replies("Bitte um Rückruf.")

    assert (split.own, split.quoted, split.split) == ("Bitte um Rückruf.", (), True)


def test_nested_replies_come_back_in_the_order_they_appeared():
    text = (
        "Passt.\n\n"
        "Am 13.10.2026 um 09:00 schrieb Max Weber <max@statik-weber.at>:\n"
        "> Neue Statik anbei.\n\n"
        "Am 12.10.2026 um 15:02 schrieb Eva Berger <eva@berger-architektur.at>:\n"
        "> Kannst du das prüfen?\n"
    )

    split = split_replies(text)
    assert split.own == "Passt."
    assert [quote.text for quote in split.quoted] == ["Neue Statik anbei.", "Kannst du das prüfen?"]
    assert split.quoted[1].header.startswith("Am 12.10.2026")


def test_a_text_past_the_bound_is_kept_whole_and_unsplit(monkeypatch):
    monkeypatch.setattr(limits, "MAX_SPLIT_CHARS", 20)
    text = "Eigener Text.\n\nAm 1.1.2026 schrieb A <a@b.at>:\n> zitiert"

    split = split_replies(text)
    assert (split.own, split.quoted, split.split) == (text, (), False)


def test_whitespace_runs_are_bounded_but_the_words_stay():
    split = split_replies("Spalte A" + "\t" * 5000 + "Spalte B\n" + "\n" * 5000 + "Ende")

    assert split.own.startswith("Spalte A\t")
    assert split.own.endswith("Spalte B\n\nEnde")
    assert "\t" * (limits.MAX_WHITESPACE_RUN + 1) not in split.own


#: Inputs that cost the square of a run before the whitespace was bounded
#: (each took 7 to 12 s at these sizes), and line patterns that probe the
#: library's other expressions.
HOSTILE = {
    "tabs in one line": "a" + "\t" * 20_000 + "b",
    "spaces in one line": "a" + " " * 20_000 + "b",
    "line separators": "a" + "\u2028" * 20_000 + "b",
    "carriage returns": "a" + "\r" * 20_000 + "b",
    "empty lines": "a" + "\n" * 20_000 + "b",
    "whitespace lines": "a" + " \n" * 20_000 + "b",
    "quote markers": ">\n" * 50_000,
    "dashes": "-\n" * 50_000,
    "header lines": "Von: x\nAn: y\n" * 10_000,
    "wrote lines": "Am 1.1.2026 schrieb x y:\n" * 5_000,
    "greetings": "Grüße\n\n" * 20_000,
}


@pytest.mark.parametrize("text", HOSTILE.values(), ids=HOSTILE.keys())
def test_hostile_text_splits_within_its_budget(text):
    started = time.perf_counter()
    split_replies(text)
    # Measured at most 1.2 s on one core for 200,000 characters; the budget is generous for CI.
    assert time.perf_counter() - started < 5.0
