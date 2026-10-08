"""A mail body as text, from whichever form the archive stored it in."""

from __future__ import annotations

from aiq_api.mail_archive import body_text as module
from aiq_api.mail_archive.body_text import body_text
from aiq_api.mail_archive.body_text import html_to_text


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
