"""Storing the rasters the ingest pipeline extracts, and reading them back.

Three layers: the store module against stub presign/upload callables; the
same module reached through ``_run_ingestion`` so the caption chunk carries
``image_key``; and the hit renderer's ``Image:`` line, which appears only for
a chunk that carries the key.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex import image_store
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor

from aiq_agent.common.credential_resolution import ResolvedCredential
from sources.knowledge_layer.src.register import _format_results

# =============================================================================
# store_extracted_images against stub callables
# =============================================================================


def _record(page: int, index: int, payload: bytes = b"\xff\xd8jpeg") -> dict:
    return {"image_bytes": payload, "page_number": page, "image_index": index, "format": "jpeg"}


class _Stubs:
    """A presigner that answers up to ``ceiling`` slots, and an uploader that records PUTs."""

    def __init__(self, ceiling: int = 64, fail_upload_at: int | None = None):
        self.ceiling = ceiling
        self.fail_upload_at = fail_upload_at
        self.presigned: list[tuple[str, str, int, str | None]] = []
        self.uploaded: list[tuple[str, bytes]] = []

    def presign(self, document_id, collection, index, organization_id):
        self.presigned.append((document_id, collection, index, organization_id))
        if index >= self.ceiling:
            return None
        return (f"http://seaweed/put/{index}", f"org/o1/project/p1/doc/{document_id}/_img/{index}.jpg")

    def upload(self, url, payload):
        if self.fail_upload_at is not None and url.endswith(f"/{self.fail_upload_at}"):
            raise RuntimeError("PUT failed")
        self.uploaded.append((url, payload))


def test_annotates_records_with_key_and_index_in_document_order():
    stubs = _Stubs()
    later = _record(3, 0, b"later")
    earlier = _record(1, 1, b"earlier")
    first = _record(1, 0, b"first")
    results = [(later, "image", "c"), (earlier, "image", "c"), (first, "image", "c")]

    stored = image_store.store_extracted_images(
        results,
        document_id="d1",
        collection="proj_1",
        organization_id="org_1",
        presign=stubs.presign,
        upload=stubs.upload,
    )

    assert stored == 3
    assert (first["stored_image_index"], earlier["stored_image_index"], later["stored_image_index"]) == (0, 1, 2)
    assert first["image_key"] == "org/o1/project/p1/doc/d1/_img/0.jpg"
    assert [payload for _url, payload in stubs.uploaded] == [b"first", b"earlier", b"later"]
    assert stubs.presigned[0] == ("d1", "proj_1", 0, "org_1")


def test_stops_at_the_first_refused_slot_and_keeps_the_captions():
    stubs = _Stubs(ceiling=1)
    results = [(_record(1, 0), "image", "c"), (_record(1, 1), "image", "c"), (_record(2, 0), "image", "c")]

    stored = image_store.store_extracted_images(
        results, document_id="d1", collection="p", presign=stubs.presign, upload=stubs.upload
    )

    assert stored == 1
    assert "image_key" in results[0][0]
    assert "image_key" not in results[1][0] and "image_key" not in results[2][0]
    # One refusal, then no more asking: a ceiling or a dead BFF costs one call.
    assert [index for _d, _c, index, _o in stubs.presigned] == [0, 1]


def test_a_failed_upload_leaves_that_record_unkeyed_and_stops():
    stubs = _Stubs(fail_upload_at=0)
    results = [(_record(1, 0), "image", "c"), (_record(1, 1), "image", "c")]

    stored = image_store.store_extracted_images(
        results, document_id="d1", collection="p", presign=stubs.presign, upload=stubs.upload
    )

    assert stored == 0
    assert all("image_key" not in record for record, _t, _c in results)


def test_records_without_bytes_are_skipped():
    stubs = _Stubs()
    results = [(_record(1, 0, b""), "image", "c"), (_record(1, 1), "image", "c")]

    assert (
        image_store.store_extracted_images(
            results, document_id="d1", collection="p", presign=stubs.presign, upload=stubs.upload
        )
        == 1
    )
    assert stubs.presigned == [("d1", "p", 1, None)]


# =============================================================================
# request_upload_slot against the BFF (httpx stubbed)
# =============================================================================


def test_request_upload_slot_fail_open(monkeypatch):
    import httpx

    monkeypatch.delenv("FRONTEND_INTERNAL_URL", raising=False)
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    assert image_store.request_upload_slot("d1", "proj_1", 0) is None

    calls: list[dict] = []

    class _Response:
        def __init__(self, status_code, payload):
            self.status_code = status_code
            self._payload = payload

        def json(self):
            return self._payload

    state = {"response": _Response(200, {"uploadUrl": "http://seaweed/put", "storageKey": "org/o1/_img/0.jpg"})}

    def _post(url, *, json, headers, timeout):
        assert url == "http://frontend:3000/api/internal/document-image-upload-url"
        assert headers["x-grid-internal-token"] == "tok"
        calls.append(json)
        return state["response"]

    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000/")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
    monkeypatch.setattr(httpx, "post", _post)

    assert image_store.request_upload_slot("d1", "proj_1", 2) == ("http://seaweed/put", "org/o1/_img/0.jpg")
    assert calls[-1] == {"documentId": "d1", "collection": "proj_1", "imageIndex": 2}

    assert image_store.request_upload_slot("d1", "archiv_org_1", 0, "org_1") is not None
    assert calls[-1]["organizationId"] == "org_1"

    # 404 is the BFF's "unknown document or ceiling reached": no slot, no raise.
    state["response"] = _Response(404, {})
    assert image_store.request_upload_slot("d1", "proj_1", 64) is None

    state["response"] = _Response(200, {"uploadUrl": "", "storageKey": "k"})
    assert image_store.request_upload_slot("d1", "proj_1", 0) is None

    def _boom(*_a, **_k):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(httpx, "post", _boom)
    assert image_store.request_upload_slot("d1", "proj_1", 0) is None


# =============================================================================
# Through _run_ingestion (heavy collaborators mocked)
# =============================================================================


@pytest.fixture
def summary_db(tmp_path):
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory

    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._document_metadata_store = None


@pytest.fixture
def ingestor(tmp_path, monkeypatch):
    llm = MagicMock()
    llm.invoke.side_effect = lambda prompt: MagicMock(
        content='["Foto"]' if "klassifizierst" in prompt else "A photo of the facade."
    )
    ing = LlamaIndexIngestor(
        {"persist_dir": str(tmp_path / "chroma"), "generate_summary": True, "summary_llm": llm, "extract_images": True}
    )
    ing._embed_model = MagicMock()
    ing._initialized = True
    monkeypatch.setattr("llama_index.core.VectorStoreIndex", MagicMock())
    monkeypatch.setattr("llama_index.core.Settings", MagicMock())
    return ing


def _wait_terminal(ing, job_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = ing.get_job_status(job_id)
        if status.is_terminal:
            return status
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")


def _indexed_documents():
    import llama_index.core

    documents = []
    for call in llama_index.core.VectorStoreIndex.from_documents.call_args_list:
        documents.extend(call.args[0])
    return documents


def _prepare_pdf_with_one_raster(tmp_path, monkeypatch):
    cred = ResolvedCredential(api_key="vlm-key", base_url="https://vlm.test/v1", model="test-vlm", source="env")
    monkeypatch.setattr(adapter, "resolve_vlm_credential", lambda organization_id=None: cred)
    monkeypatch.setattr(adapter, "_extract_text_from_pdf", lambda p: [])
    monkeypatch.setattr(
        adapter,
        "_extract_images_from_pdf",
        lambda *a, **k: [
            {
                "image_bytes": b"\xff\xd8raster",
                "page_number": 2,
                "image_index": 0,
                "format": "jpeg",
                "width": 800,
                "height": 600,
            }
        ],
    )
    monkeypatch.setattr(adapter, "analyze_visual", lambda *a, **k: ("image", "A photo of the facade.", {}))
    import knowledge_layer.llamaindex.processing as processing_module

    monkeypatch.setattr(processing_module, "render_visual_pages_no_vlm", lambda *a, **k: [])
    pdf = tmp_path / "fassade.pdf"
    pdf.write_bytes(b"%PDF-1.4\n% minimal\n")
    return pdf


class TestRunIngestionStoresRasters:
    def test_caption_chunk_carries_the_stored_key(self, tmp_path, monkeypatch, ingestor, summary_db):
        pdf = _prepare_pdf_with_one_raster(tmp_path, monkeypatch)
        stubs = _Stubs()
        monkeypatch.setattr(image_store, "request_upload_slot", stubs.presign)
        monkeypatch.setattr(image_store, "put_raster", stubs.upload)

        job_id = ingestor.submit_job(
            [str(pdf)],
            "proj_1",
            config={"original_filenames": ["fassade.pdf"], "document_id": "d1", "organization_id": "org_1"},
        )
        assert _wait_terminal(ingestor, job_id).is_success

        assert stubs.presigned == [("d1", "proj_1", 0, "org_1")]
        assert stubs.uploaded == [("http://seaweed/put/0", b"\xff\xd8raster")]
        [chunk] = [d for d in _indexed_documents() if d.metadata.get("content_type") == "image"]
        assert chunk.metadata["image_key"] == "org/o1/project/p1/doc/d1/_img/0.jpg"
        assert chunk.metadata["stored_image_index"] == 0
        assert chunk.metadata["page_label"] == "2"
        # Addressing, not meaning: neither key is embedded.
        assert "image_key" in chunk.excluded_embed_metadata_keys
        assert "stored_image_index" in chunk.excluded_embed_metadata_keys

    def test_no_document_id_means_captions_only(self, tmp_path, monkeypatch, ingestor, summary_db):
        """The corpus sync sends no id: nothing to store under, no BFF call."""
        pdf = _prepare_pdf_with_one_raster(tmp_path, monkeypatch)
        stubs = _Stubs()
        monkeypatch.setattr(image_store, "request_upload_slot", stubs.presign)

        job_id = ingestor.submit_job([str(pdf)], "oib", config={"original_filenames": ["fassade.pdf"]})
        assert _wait_terminal(ingestor, job_id).is_success

        assert stubs.presigned == []
        [chunk] = [d for d in _indexed_documents() if d.metadata.get("content_type") == "image"]
        assert "image_key" not in chunk.metadata

    def test_upload_failure_keeps_the_caption(self, tmp_path, monkeypatch, ingestor, summary_db):
        pdf = _prepare_pdf_with_one_raster(tmp_path, monkeypatch)
        stubs = _Stubs(fail_upload_at=0)
        monkeypatch.setattr(image_store, "request_upload_slot", stubs.presign)
        monkeypatch.setattr(image_store, "put_raster", stubs.upload)

        job_id = ingestor.submit_job(
            [str(pdf)], "proj_1", config={"original_filenames": ["fassade.pdf"], "document_id": "d1"}
        )
        assert _wait_terminal(ingestor, job_id).is_success

        [chunk] = [d for d in _indexed_documents() if d.metadata.get("content_type") == "image"]
        assert chunk.text.endswith("A photo of the facade.")
        assert "image_key" not in chunk.metadata


# =============================================================================
# The Image: line on a hit
# =============================================================================


def _hit(metadata: dict):
    return SimpleNamespace(
        file_name="fassade.pdf",
        page_number=2,
        content="[IMAGE from page 2]\n\nA photo of the facade.",
        content_type=SimpleNamespace(value="image"),
        score=0.8,
        metadata={"collection": "proj_1", "shelf": "project", **metadata},
    )


def _format(chunks) -> str:
    return _format_results(SimpleNamespace(success=True, chunks=chunks, error_message=None), "q")


def test_hit_shows_the_image_line_only_when_a_raster_was_stored():
    with_key = _format([_hit({"image_key": "org/o1/project/p1/doc/d1/_img/3.jpg", "stored_image_index": 3})])
    assert "Image: stored (view_knowledge_image image_index=3)" in with_key
    assert with_key.index("Citation: fassade.pdf, p.2") < with_key.index("Image: stored")

    without = _format([_hit({"image_index": 0})])
    assert "Image:" not in without
