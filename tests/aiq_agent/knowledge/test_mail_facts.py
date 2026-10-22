"""What a filed mail says about a document, and how it is printed (ADR-0134, RT-S2).

Pinned here: a record keeps only what it may (no address, no unknown key, no
trust outside the vocabulary); the line names a sender's domain only when a
signature confirmed it, in the Verlauf's own words; the Verlauf's newest
message is its date; the metadata row stores and reads both records back; and
the words and the trust vocabulary agree with the BFF's, which owns them.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore
from aiq_agent.knowledge.mail_facts import MAIL_COPY
from aiq_agent.knowledge.mail_facts import MAIL_LOCALES
from aiq_agent.knowledge.mail_facts import SENDER_TRUSTS
from aiq_agent.knowledge.mail_facts import VERIFIED_SENDER_TRUSTS
from aiq_agent.knowledge.mail_facts import mail_origin_label
from aiq_agent.knowledge.mail_facts import mail_thread_date
from aiq_agent.knowledge.mail_facts import mail_thread_label
from aiq_agent.knowledge.mail_facts import normalise_mail_origin
from aiq_agent.knowledge.mail_facts import normalise_mail_thread

REPO_ROOT = Path(__file__).resolve().parents[3]
RENDER_COPY = REPO_ROOT / "frontends" / "ui" / "src" / "lib" / "mail-thread" / "render-copy.ts"
VOCABULARY = REPO_ROOT / "frontends" / "ui" / "src" / "lib" / "inbound-mail" / "inbound-mail-vocabulary.ts"

HUBER = {
    "sent_at": "2026-05-12T07:12:00Z",
    "received_at": "2026-05-12T07:14:00Z",
    "from_name": "Mag. Anna Huber",
    "from_domain": "ma37.wien.gv.at",
    "signer_domain": "ma37.wien.gv.at",
    "sender_trust": "external_verified",
    "thread_document_id": "6d1f0c4e-2b1a-4c3e-9a51-0000000000a0",
    "locale": "de",
}
FORGER = {
    "sent_at": "2026-05-14T14:40:00Z",
    "from_name": "Mag. Anna Huber",
    "from_domain": "ma37-wien.at",
    "sender_trust": "external_unverified",
}


class TestTheLineNamesADomainOnlyWhenASignatureConfirmedIt:
    def test_a_verified_sender_is_named_by_the_signing_domain(self):
        assert (
            mail_origin_label(HUBER) == "kam mit der E-Mail vom 12.05.2026 09:12 von Mag. Anna Huber (ma37.wien.gv.at)"
        )

    def test_an_unverified_sender_says_domain_nicht_bestaetigt(self):
        assert mail_origin_label(FORGER) == (
            "kam mit der E-Mail vom 14.05.2026 16:40 von Mag. Anna Huber (ma37-wien.at, Domain nicht bestätigt)"
        )

    def test_a_signature_is_not_enough_without_a_verified_trust(self):
        """A signer domain on an unverified mail (a DKIM fail, a misaligned pass) proves nothing."""
        claimed = {**FORGER, "signer_domain": "ma37.wien.gv.at"}
        label = mail_origin_label(claimed)
        assert label is not None and "(ma37-wien.at, Domain nicht bestätigt)" in label
        assert "(ma37.wien.gv.at)" not in label

    def test_a_member_whose_domain_did_not_verify_is_not_confirmed_either(self):
        label = mail_origin_label({**HUBER, "sender_trust": "member_unverified"})
        assert label is not None and label.endswith("(ma37.wien.gv.at, Domain nicht bestätigt)")

    def test_a_verified_trust_without_a_signer_falls_back_to_unconfirmed(self):
        label = mail_origin_label({**HUBER, "signer_domain": None})
        assert label is not None and label.endswith("(ma37.wien.gv.at, Domain nicht bestätigt)")

    def test_an_archive_entry_says_where_it_came_from(self):
        label = mail_origin_label({**FORGER, "from_domain": "statik-weber.at", "sender_trust": "not_checked"})
        assert label is not None and label.endswith("(statik-weber.at, aus dem Outlook-Archiv)")

    def test_the_english_thread_writes_english(self):
        assert mail_origin_label({**FORGER, "locale": "en"}) == (
            "came with the mail of 2026-05-14 16:40 from Mag. Anna Huber (ma37-wien.at, domain not verified)"
        )

    def test_the_time_is_the_offices_clock(self):
        winter = mail_origin_label({**HUBER, "sent_at": "2026-01-12T07:12:00Z"})
        assert winter is not None and "12.01.2026 08:12" in winter

    def test_a_nameless_sender_is_unknown(self):
        label = mail_origin_label({**FORGER, "from_name": None})
        assert label is not None and " von Unbekannt (" in label


class TestARecordKeepsOnlyWhatItMay:
    def test_an_address_never_survives(self):
        record = normalise_mail_origin({**HUBER, "from_name": "huber@ma37.wien.gv.at", "from_address": "x@y.at"})
        assert record is not None
        assert "from_name" not in record and "from_address" not in record
        assert "@" not in repr(record)

    def test_brackets_cannot_fake_an_authority(self):
        record = normalise_mail_origin({**FORGER, "from_name": "Mag. Anna Huber (ma37.wien.gv.at)"})
        assert record is not None and record["from_name"] == "Mag. Anna Huber ma37.wien.gv.at"
        label = mail_origin_label(record)
        assert label is not None and label.endswith("(ma37-wien.at, Domain nicht bestätigt)")

    def test_a_domain_cannot_add_a_word(self):
        record = normalise_mail_origin({**FORGER, "from_domain": "Ma37-Wien.AT. (bestätigt)"})
        assert record is not None and record["from_domain"] == "ma37-wien.at.bestätigt"

    @pytest.mark.parametrize(
        "broken",
        [
            {**HUBER, "sent_at": None},
            {**HUBER, "sent_at": "bald"},
            {**HUBER, "sender_trust": "verified"},
            {**HUBER, "sender_trust": None},
            "kein Datensatz",
            None,
        ],
    )
    def test_an_origin_with_no_date_or_no_trust_is_none(self, broken):
        assert normalise_mail_origin(broken) is None
        assert mail_origin_label(broken) is None

    def test_times_are_utc_and_unknown_keys_go(self):
        record = normalise_mail_origin({**HUBER, "sent_at": "2026-05-12T09:12:00+02:00", "extra": 1})
        assert record is not None and record["sent_at"] == "2026-05-12T07:12:00Z" and "extra" not in record

    def test_an_unknown_locale_is_the_default_and_a_bad_thread_id_goes(self):
        record = normalise_mail_origin({**HUBER, "locale": "fr", "thread_document_id": "not-a-uuid"})
        assert record is not None and record["locale"] == MAIL_LOCALES[0] and "thread_document_id" not in record


class TestTheVerlaufsDateIsItsNewestMessage:
    THREAD = {"latest_sent_at": "2026-05-14T14:40:00Z", "message_count": 5, "locale": "de"}

    def test_the_label_counts_and_dates_it(self):
        assert mail_thread_label(self.THREAD) == "E-Mail-Verlauf · 5 E-Mails, zuletzt 14.05.2026"
        assert mail_thread_label({**self.THREAD, "message_count": 1}) == "E-Mail-Verlauf · 1 E-Mail, zuletzt 14.05.2026"
        assert mail_thread_label({**self.THREAD, "locale": "en"}) == "Mail thread · 5 mails, latest 2026-05-14"

    def test_a_count_a_thread_cannot_have_is_left_out(self):
        for count in (0, 201, True, "5"):
            record = normalise_mail_thread({**self.THREAD, "message_count": count})
            assert record is not None and "message_count" not in record
        assert mail_thread_label({**self.THREAD, "message_count": 0}) == "E-Mail-Verlauf · zuletzt 14.05.2026"

    def test_the_date_is_the_newest_message(self):
        assert mail_thread_date(self.THREAD) == "2026-05-14T14:40:00Z"
        assert mail_thread_date(None) is None
        assert normalise_mail_thread({"message_count": 3}) is None


_POSTGRES = os.environ.get("AIQ_TEST_POSTGRES_URL")
_BACKENDS = [
    "sqlite",
    pytest.param("postgres", marks=pytest.mark.skipif(not _POSTGRES, reason="AIQ_TEST_POSTGRES_URL not set")),
]


def test_the_postgres_branch_ran_where_it_is_required():
    """CI's ``task be:test:postgres`` sets the guard: there a missing database fails instead of skipping green."""
    if os.environ.get("AIQ_TEST_POSTGRES_REQUIRED"):
        assert _POSTGRES, "AIQ_TEST_POSTGRES_URL is unset while REQUIRED is set"


def _fresh_database(backend: str, tmp_path: Path) -> str:
    """A SQLite file per test, or the throwaway Postgres (``task be:test:postgres``) with the store's tables gone."""
    from sqlalchemy import text

    if backend == "sqlite":
        return f"sqlite:///{tmp_path / 'mail.db'}"
    assert _POSTGRES
    with DocumentMetadataStore._get_or_create_sync_engine(_POSTGRES).begin() as conn:
        for table in ("document_metadata", "document_revision_retained"):
            conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
    # The store remembers a database whose schema it ensured; this one has none again.
    DocumentMetadataStore._tables_initialized.discard(_POSTGRES)
    return _POSTGRES


class TestTheMetadataRowStoresBoth:
    """On every backend production runs: SQLite in a dev checkout, Postgres in a deployment."""

    @pytest.fixture(params=_BACKENDS)
    def database_url(self, request, tmp_path):
        url = _fresh_database(request.param, tmp_path)
        yield url
        DocumentMetadataStore.dispose_engine(url)

    @pytest.fixture
    def store(self, database_url):
        return DocumentMetadataStore(database_url)

    def test_a_table_from_before_the_columns_gets_them_on_first_open(self, database_url):
        """The add-column path: a deployment's existing ``document_metadata`` lacks both columns."""
        from sqlalchemy import text

        engine = DocumentMetadataStore._get_or_create_sync_engine(database_url)
        with engine.begin() as conn:
            conn.execute(
                text(
                    # The table as `_create_table` made it before any optional column existed.
                    "CREATE TABLE document_metadata (collection VARCHAR(256) NOT NULL, filename VARCHAR(512) NOT NULL, "
                    "summary TEXT NOT NULL, tags TEXT, doc_class TEXT, display_title TEXT, folder_path TEXT, "
                    "provenance TEXT, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, "
                    "PRIMARY KEY (collection, filename))"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO document_metadata (collection, filename, summary) VALUES ('proj_1', 'alt.pdf', 'Alt.')"
                )
            )
        store = DocumentMetadataStore(database_url)
        assert store.set_mail_origin("proj_1", "alt.pdf", HUBER)
        assert store.get_all("proj_1")[0].mail_origin == normalise_mail_origin(HUBER)

    def test_set_and_read_back_through_the_listing(self, store):
        store.register("proj_1", "Verlauf.md", "Ein Verlauf.")
        store.register("proj_1", "Stellplatzberechnung.pdf", "Eine Berechnung.")
        assert store.set_mail_thread(
            "proj_1", "Verlauf.md", {"latest_sent_at": "2026-05-14T14:40:00Z", "message_count": 5}
        )
        assert store.set_mail_origin("proj_1", "Stellplatzberechnung.pdf", {**HUBER, "from_address": "huber@x.at"})

        rows = {doc.file_name: doc for doc in store.get_all("proj_1")}
        assert rows["Verlauf.md"].mail_thread == {
            "latest_sent_at": "2026-05-14T14:40:00Z",
            "message_count": 5,
            "locale": "de",
        }
        assert rows["Verlauf.md"].mail_origin is None
        assert rows["Stellplatzberechnung.pdf"].mail_origin == normalise_mail_origin(HUBER)
        assert "@" not in repr(rows["Stellplatzberechnung.pdf"].mail_origin)

    def test_a_record_that_cannot_be_printed_clears_the_column(self, store):
        store.register("proj_1", "a.pdf", "A.")
        store.set_mail_origin("proj_1", "a.pdf", HUBER)
        store.set_mail_origin("proj_1", "a.pdf", {**HUBER, "sender_trust": "trusted"})
        assert store.get_all("proj_1")[0].mail_origin is None

    def test_a_row_that_does_not_exist_is_not_created(self, store):
        assert store.set_mail_thread("proj_1", "missing.md", {"latest_sent_at": "2026-05-14T14:40:00Z"}) is False
        assert store.get_all("proj_1") == []

    def test_an_unreadable_stored_value_reads_as_none(self, store):
        from sqlalchemy import text

        store.register("proj_1", "a.pdf", "A.")
        with DocumentMetadataStore._get_or_create_sync_engine(store.db_url).begin() as conn:
            conn.execute(text("UPDATE document_metadata SET mail_origin = '{not json', mail_thread = '[]'"))
        row = store.get_all("proj_1")[0]
        assert row.mail_origin is None and row.mail_thread is None


class TestTheBffOwnsTheWordsAndTheVocabulary:
    """The words and tokens are the BFF's (``render-copy.ts``, ``inbound-mail-vocabulary.ts``); this is a mirror."""

    def test_the_trust_words_are_the_verlaufs(self):
        source = RENDER_COPY.read_text(encoding="utf-8")
        for locale, copy in MAIL_COPY.items():
            block = re.search(rf"\n  {locale}: \{{(.*?)\n  \}},", source, re.DOTALL)
            assert block, f"the {locale} copy was not found in render-copy.ts"
            for key, value in (
                ("unverifiedDomain", copy.unverified_domain),
                ("fromArchive", copy.from_archive),
                ("unknownSender", copy.unknown_sender),
            ):
                assert f"{key}: '{value}'" in block.group(1), (locale, key)
        assert set(MAIL_COPY) == set(MAIL_LOCALES)

    def test_the_trusts_are_the_bffs(self):
        source = VOCABULARY.read_text(encoding="utf-8")
        listed = re.search(r"export const SENDER_TRUSTS = \[(.*?)\]", source, re.DOTALL)
        verified = re.search(r"export const VERIFIED_SENDER_TRUSTS[^=]*= \[(.*?)\]", source, re.DOTALL)
        assert listed and verified
        assert tuple(re.findall(r"'([^']+)'", listed.group(1))) == SENDER_TRUSTS
        assert frozenset(re.findall(r"'([^']+)'", verified.group(1))) == VERIFIED_SENDER_TRUSTS
