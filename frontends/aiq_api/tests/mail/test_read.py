"""Reading one raw message: body choice, own text and quotes, calendar, and the fixture corpus.

The fixtures under ``fixtures/`` are mail as the clients that matter here write
it: Outlook's German reply block, Apple Mail's flowed text with "Am … schrieb",
an HTML-only table in a mislabelled Latin-1, an Outlook invitation with the
same event inline and as ``invite.ics``, S/MIME, a hyphen list above an RFC
3676 signature, a bare forward, an English reply sent from a phone.
"""

from __future__ import annotations

from email.message import EmailMessage
from pathlib import Path

import pytest

from aiq_api.mail.models import MailRead
from aiq_api.mail.models import UnreadableReason
from aiq_api.mail.read import read_message
from aiq_api.mail.read import unflow

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name: str) -> MailRead:
    return read_message((FIXTURES / name).read_bytes())


def test_an_outlook_reply_is_own_text_then_the_quoted_message_without_the_signature():
    read = fixture("outlook-reply-de.eml")

    assert read.body_source == "plain"
    assert read.own_text == (
        "Sehr geehrte Frau Berger,\n\n"
        "der Stellplatznachweis ist vollständig. Es fehlen nur noch die\n"
        "Fahrradabstellplätze im Lageplan."
    )
    assert read.signature_removed is True
    assert "Tel." not in read.own_text
    (quote,) = read.quoted
    assert quote.header.startswith("Von: Eva Berger <eva@berger-architektur.at>\nGesendet: Freitag")
    assert quote.text == "Liebe Frau Huber,\n\nanbei der Stellplatznachweis für Bauplatz 12."
    assert read.unreadable is False


def test_flowed_text_is_one_paragraph_again_and_the_quote_loses_its_markers():
    read = fixture("apple-reply-flowed-de.eml")

    assert "ich schicke die geänderte Statik bis Freitag." in read.own_text
    assert "die \n" not in read.own_text
    (quote,) = read.quoted
    assert quote.header == "Am 12.10.2026 um 15:02 schrieb Eva Berger <eva@berger-architektur.at>:"
    assert quote.text == "Hallo Max,\nkannst du die Deckenbewehrung noch einmal prüfen?"


def test_an_html_only_mail_keeps_its_table_cells_and_its_windows_characters():
    read = fixture("html-table-latin1.eml")

    assert read.body_source == "html"
    assert "Stellplätze | 12\nFahrradabstellplätze | 30" in read.own_text
    # Declared ISO-8859-1, written as Windows-1252: the dash is 0x96.
    assert "hier die Mengen – wie besprochen:" in read.own_text
    assert "alert" not in read.own_text


def test_an_invitation_is_read_once_in_vienna_time():
    read = fixture("invite-vienna.eml")

    # Inline in Outlook's Windows zone and again as invite.ics in UTC: one event.
    (event,) = read.calendar
    assert event.method == "REQUEST"
    assert event.summary == "Bauverhandlung Bauplatz 12"
    assert (event.start, event.end) == ("2026-11-03T09:00:00+01:00", "2026-11-03T11:00:00+01:00")
    assert event.location == "MA 37, Dresdner Straße 73-75, 1200 Wien"
    assert (event.organizer_name, event.status, event.sequence) == ("Huber, Anna", "CONFIRMED", 0)
    assert read.own_text == "Die Bauverhandlung findet am 3. November statt."


def test_an_encrypted_mail_says_so_and_reads_no_body():
    read = fixture("smime-encrypted.eml")

    assert (read.encrypted, read.body_source, read.own_text) == (True, "none", "")
    assert read.unreadable is False


def test_a_hyphen_list_stays_text_and_the_rfc_3676_signature_goes():
    read = fixture("hyphen-list-de.eml")

    assert read.own_text.endswith("- Stellplatz 7 zu schmal")
    assert "Berger Architektur" not in read.own_text
    assert read.signature_removed is True


def test_a_bare_forward_has_no_own_text_and_quotes_the_forwarded_message():
    read = fixture("forward-only-en.eml")

    assert read.own_text == ""
    (quote,) = read.quoted
    assert quote.header.startswith("From: Sales <sales@windows.example>")
    assert quote.text == "Dear Ms Berger,\nplease find our offer attached."


def test_an_english_reply_drops_the_sign_off_and_the_phone_line():
    read = fixture("english-reply.eml")

    assert read.own_text == "Dear Ms Berger,\n\ndelivery is possible in week 46."
    assert read.quoted[0].text == "When can you deliver?"


@pytest.mark.parametrize("path", sorted(FIXTURES.glob("*.eml")), ids=lambda path: path.name)
def test_every_fixture_reads_and_round_trips_through_the_wire_shape(path):
    read = read_message(path.read_bytes())

    assert MailRead.model_validate_json(read.model_dump_json()) == read


def message(**parts: tuple[str, str]) -> EmailMessage:
    """A message with one part per keyword: ``plain=("text", "utf-8")`` and so on."""
    mail = EmailMessage()
    mail["Subject"] = "Test"
    for subtype, (content, charset) in parts.items():
        if mail.is_multipart() or mail.get_content_type() != "text/plain" or mail.get_payload():
            mail.add_alternative(content, subtype=subtype, charset=charset)
        else:
            mail.set_content(content, subtype=subtype, charset=charset)
    return mail


def test_plain_wins_over_html_and_an_oversized_html_is_then_not_even_measured():
    mail = message(plain=("Kurzer Text", "utf-8"), html=("<p>" + "x" * (3 * 1024 * 1024) + "</p>", "utf-8"))

    read = read_message(mail.as_bytes())
    assert (read.body_source, read.own_text, read.unreadable) == ("plain", "Kurzer Text", False)


def test_an_unknown_charset_falls_back_instead_of_failing():
    raw = b"Content-Type: text/plain; charset=x-made-up\n\nGr\xc3\xbc\xc3\x9fe aus Wien\n"

    assert read_message(raw).own_text == "Grüße aus Wien"


def test_bytes_that_are_no_message_read_as_an_empty_body():
    read = read_message(b"\x00\xff garbage without headers \xfe")

    assert read.unreadable is False
    assert isinstance(read.own_text, str)


def test_a_parser_failure_is_unreadable_never_an_exception(monkeypatch):
    from aiq_api.mail import read as module

    def explode(_text):
        raise RecursionError("a parser bug")

    monkeypatch.setattr(module, "split_replies", explode)

    read = read_message(b"Content-Type: text/plain\n\nHallo\n")
    assert read.unreadable_reasons == [UnreadableReason.FAILED]
    assert read.own_text == ""


@pytest.mark.parametrize(
    ("flowed", "delete_space", "expected"),
    [
        ("Ein Satz, der \r\numbricht.\r\n", False, "Ein Satz, der umbricht.\n"),
        ("Wort-\r\nende\r\n", True, "Wort-\nende\n"),
        ("Zusammen \r\ngeschrieben\r\n", True, "Zusammengeschrieben\n"),
        (" From here, space-stuffed\r\n", False, "From here, space-stuffed\n"),
        ("Gruß\r\n-- \r\nEva\r\n", False, "Gruß\n-- \nEva\n"),
        ("> zitiert \r\n> weiter\r\nselbst\r\n", False, "> zitiert weiter\nselbst\n"),
        ("> Ebene eins \r\n>> Ebene zwei\r\n", False, "> Ebene eins \n>> Ebene zwei\n"),
    ],
)
def test_unflow_follows_rfc_3676(flowed, delete_space, expected):
    assert unflow(flowed, delete_space=delete_space) == expected
