"""A filed mail survives ingestion: its format onto every chunk, its records onto the metadata row (ADR-0134).

``POST /v1/ingest`` puts ``source_format: mail`` and ``mail_thread`` on the job config of a filed
E-Mail-Verlauf, and ``mail_origin`` on an attachment's (``test_ingest_mail.py`` in ``aiq_api``). This is
the job's end: the format goes on the CHUNK, because a retrieval hit is a chunk and the lane is read off
it (``norm_registry.lane_for_hit``); the records go on the ROW, which the listing and the reader read.
"""

from __future__ import annotations

from knowledge_layer.llamaindex.adapter import EMBED_EXCLUDED_METADATA_KEYS
from knowledge_layer.llamaindex.adapter import _source_format_from_config
from knowledge_layer.llamaindex.adapter import _stamp_chunk_metadata
from knowledge_layer.llamaindex.adapter import _store_mail_facts
from llama_index.core import Document

THREAD = {"latest_sent_at": "2026-05-14T14:40:00Z", "message_count": 5, "locale": "de"}
ORIGIN = {"sent_at": "2026-05-04T06:30:00Z", "sender_trust": "external_verified", "locale": "de"}


class TestTheFormatGoesOnEveryChunk:
    def test_only_the_known_format_is_read_off_the_config(self):
        assert _source_format_from_config({"source_format": "mail"}) == "mail"
        for config in ({}, {"source_format": "pdf"}, {"source_format": "MAIL"}, {"source_format": None}):
            assert _source_format_from_config(config) is None

    def test_a_verlaufs_sections_are_stamped_and_the_format_is_not_embedded(self):
        sections = [Document(text="Abschnitt eins", metadata={"file_name": "Verlauf.md", "clause_id": "a"})]
        _stamp_chunk_metadata(
            sections, doc_class=None, provenance={}, chunk_size=1024, file_name="Verlauf.md", source_format="mail"
        )
        (section,) = sections
        assert section.metadata["source_format"] == "mail"
        assert "source_format" in section.excluded_embed_metadata_keys
        assert "source_format" in section.excluded_llm_metadata_keys
        assert "source_format" in EMBED_EXCLUDED_METADATA_KEYS

    def test_any_other_document_is_left_as_it_was(self):
        pages = [Document(text="Seite", metadata={"file_name": "Plan.pdf"})]
        _stamp_chunk_metadata(pages, doc_class=None, provenance={}, chunk_size=1024, file_name="Plan.pdf")
        assert "source_format" not in pages[0].metadata


class TestTheRecordsGoOnTheRow:
    def _calls(self, monkeypatch, config: dict, *, replaced: bool) -> dict[str, list]:
        calls: dict[str, list] = {"thread": [], "origin": []}
        monkeypatch.setattr(
            "aiq_agent.knowledge.set_document_mail_thread", lambda c, f, v: calls["thread"].append((c, f, v))
        )
        monkeypatch.setattr(
            "aiq_agent.knowledge.set_document_mail_origin", lambda c, f, v: calls["origin"].append((c, f, v))
        )
        _store_mail_facts("proj_1", "Datei", config, replaced=replaced)
        return calls

    def test_a_verlauf_writes_its_thread_record(self, monkeypatch):
        calls = self._calls(monkeypatch, {"mail_thread": THREAD}, replaced=False)
        assert calls == {"thread": [("proj_1", "Datei", THREAD)], "origin": []}

    def test_an_attachment_writes_its_origin(self, monkeypatch):
        calls = self._calls(monkeypatch, {"mail_origin": ORIGIN}, replaced=False)
        assert calls == {"thread": [], "origin": [("proj_1", "Datei", ORIGIN)]}

    def test_a_new_upload_that_came_by_no_mail_writes_nothing(self, monkeypatch):
        assert self._calls(monkeypatch, {}, replaced=False) == {"thread": [], "origin": []}

    def test_a_re_upload_as_an_ordinary_file_clears_what_the_mail_said(self, monkeypatch):
        calls = self._calls(monkeypatch, {}, replaced=True)
        assert calls == {"thread": [("proj_1", "Datei", None)], "origin": [("proj_1", "Datei", None)]}
