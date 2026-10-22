"""A mail body as text, from whichever form the message stored it in."""

from __future__ import annotations

from aiq_api.mail import body_text as module
from aiq_api.mail.body_text import body_text
from aiq_api.mail.body_text import html_to_text


def test_plain_text_wins_over_html_and_rtf():
    result = body_text(b"Hallo Anna,\r\nbitte pruefen.", b"<p>ignored</p>", b"{\\rtf1 ignored}")

    assert result.source == "plain"
    assert result.text == "Hallo Anna,\nbitte pruefen."


def test_html_keeps_line_breaks_and_drops_style_and_script():
    markup = (
        "<html><head><style>p{}</style></head><body><p>Erste Zeile</p><div>Zweite<br>Dritte</div>"
        "<script>alert(1)</script></body></html>"
    )

    assert html_to_text(markup).split() == ["Erste", "Zeile", "Zweite", "Dritte"]
    assert body_text(None, markup.encode(), None).text == "Erste Zeile\nZweite\nDritte"


def test_an_rtf_body_reads_as_its_text():
    rtf = rb"{\rtf1\ansi\deff0{\fonttbl{\f0 Arial;}}\pard Brandschutz\par Gutachten folgt.\par}"

    result = body_text(None, None, rtf)
    assert result.source == "rtf"
    assert result.text == "Brandschutz\nGutachten folgt."


def test_encapsulated_html_reads_as_the_text_without_the_tags():
    rtf = (
        rb"{\rtf1\ansi\fromhtml1 {\*\htmltag19 <html>}{\*\htmltag50 <body>}"
        rb"{\*\htmltag64 <p>}Termin am Montag{\*\htmltag72 </p>}{\*\htmltag58 </body>}}"
    )

    assert body_text(None, None, rtf).text == "Termin am Montag"


def test_an_ansi_body_falls_back_to_the_windows_code_page():
    assert body_text("Grüße".encode("cp1252"), None, None).text == "Grüße"


def test_an_empty_body_says_none():
    result = body_text(b"", None, None)
    assert (result.source, result.text, result.truncated) == ("none", "", False)


def test_a_body_past_the_bound_is_cut_and_says_so(monkeypatch):
    monkeypatch.setattr(module, "MAX_BODY_CHARS", 10)

    result = body_text(b"0123456789abcdef", None, None)
    assert (result.text, result.truncated) == ("0123456789", True)


def test_an_html_table_keeps_its_cells_apart():
    """RT-X3: a table flattened without separators reads "Stellplätze12"."""
    markup = (
        "<table><tr><th>Bauteil</th><th>Anzahl</th></tr>"
        "<tr><td>Stellplätze</td><td>12</td></tr>"
        "<tr><td>Fahrradabstellplätze</td><td><b>30</b></td></tr></table>"
    )

    assert body_text(None, markup, None).text == "Bauteil | Anzahl\nStellplätze | 12\nFahrradabstellplätze | 30"


def test_html_that_declares_its_own_encoding_reads_as_text_not_markup():
    """lxml refuses a str with an encoding declaration; Outlook writes one."""
    markup = '<?xml version="1.0" encoding="utf-8"?><html><body><p>Grüße aus Wien</p></body></html>'

    assert html_to_text(markup).strip() == "Grüße aus Wien"


def test_markup_with_nothing_to_show_is_no_text():
    assert html_to_text("<!-- only a comment -->") == ""
    assert body_text(None, "<!-- only a comment -->", None).source == "none"
