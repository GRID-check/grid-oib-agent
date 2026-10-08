"""The permit-record backfill: which documents it reads, how it orders them, what it stores."""

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from aiq_agent.knowledge.schema import AvailableDocument

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_backfill():
    """Import ``scripts/backfill_permit_records.py`` without requiring a package."""
    spec = importlib.util.spec_from_file_location(
        "scripts.backfill_permit_records", REPO_ROOT / "scripts" / "backfill_permit_records.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


backfill = _load_backfill()

REPLY = {
    "record": {
        "kind": "nachforderung",
        "authority": "MA 37",
        "municipality": None,
        "bundesland": "wien",
        "issued_on": "2017-12-04",
        "reference": None,
        "requirements": [],
    }
}


class FakeLLM:
    model_name = "fake/model"

    def __init__(self, reply=REPLY):
        self.reply = reply
        self.messages = []

    def bind(self, **kwargs):
        return self

    def invoke(self, messages):
        self.messages = messages
        return SimpleNamespace(content=json.dumps(self.reply))


class Store:
    def __init__(self, ok=True):
        self.ok = ok
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        return self.ok


def _fetch(collection, file_name):
    return [("2", "zweite"), ("1", "erste")]


def _doc(name="ma37.pdf", tags=("Bescheid",)):
    return AvailableDocument(file_name=name, summary="s", tags=list(tags) if tags else None)


def _run(docs, *, store=None, fetch=_fetch, ids=None, dry_run=False, llm=None):
    store = store or Store()
    stats = backfill.run_backfill(
        organization_id="org_1",
        collection="proj_1",
        documents=docs,
        llm=llm or FakeLLM(),
        store_fn=store,
        page_fetcher=fetch,
        document_ids={"ma37.pdf": "d1"} if ids is None else ids,
        dry_run=dry_run,
    )
    return stats, store


def test_a_bescheid_is_extracted_and_stored_under_its_document_id():
    llm = FakeLLM()
    stats, store = _run([_doc()], llm=llm)

    assert (stats.stored, stats.failed) == (1, 0)
    org, document_id, collection, file_name, model, record = store.calls[0]
    assert (org, document_id, collection, file_name, model) == ("org_1", "d1", "proj_1", "ma37.pdf", "fake/model")
    assert record.authority == "MA 37"


def test_documents_the_tags_do_not_call_a_bescheid_are_skipped():
    stats, store = _run([_doc("a.pdf", ("Gutachten",)), _doc("b.pdf", None)])
    assert (stats.skipped, stats.stored) == (2, 0)
    assert store.calls == []


def test_a_dry_run_extracts_and_writes_nothing_and_needs_no_ids():
    stats, store = _run([_doc()], ids={}, dry_run=True)
    assert (stats.stored, stats.failed) == (1, 0)
    assert store.calls == []


def test_with_document_ids_a_bescheid_without_an_entry_fails_before_any_model_call():
    llm = FakeLLM()
    stats, store = _run([_doc()], ids={"other.pdf": "d9"}, llm=llm)
    assert stats.failed == 1
    assert llm.messages == [] and store.calls == []


def test_without_document_ids_a_real_run_stores_by_file_name_with_no_id():
    llm = FakeLLM()
    stats, store = _run([_doc()], ids={}, llm=llm)

    assert (stats.stored, stats.failed) == (1, 0)
    org, document_id, collection, file_name, _, record = store.calls[0]
    assert (org, document_id, collection, file_name) == ("org_1", None, "proj_1", "ma37.pdf")
    assert record.authority == "MA 37"


def test_a_real_run_without_document_ids_exits_zero_and_stores_by_file_name(monkeypatch):
    stored = []

    def fake_store(*args):
        stored.append(args)
        return True

    monkeypatch.setattr("aiq_agent.knowledge.configure_summary_db", lambda url: None)
    monkeypatch.setattr("aiq_agent.knowledge.get_available_documents", lambda collection: [_doc()])
    monkeypatch.setattr("aiq_agent.knowledge.permit_records_client.store_permit_record", fake_store)
    monkeypatch.setattr(backfill, "make_page_fetcher", lambda chroma_dir: _fetch)
    monkeypatch.setattr(backfill, "build_extraction_llm", lambda: FakeLLM())

    exit_code = backfill.main(["--organization-id", "org_1", "--collection", "proj_1"])

    assert exit_code == 0
    assert [(call[1], call[3]) for call in stored] == [(None, "ma37.pdf")]


def test_a_store_the_bff_refused_is_a_failure():
    stats, _ = _run([_doc()], store=Store(ok=False))
    assert stats.failed == 1


def test_a_document_with_no_indexed_text_fails_and_the_batch_goes_on():
    stats, store = _run(
        [_doc("gone.pdf"), _doc()],
        fetch=lambda c, f: None if f == "gone.pdf" else _fetch(c, f),
        ids={"ma37.pdf": "d1", "gone.pdf": "d2"},
    )
    assert (stats.failed, stats.stored) == (1, 1)
    assert len(store.calls) == 1


def test_no_record_from_the_model_is_not_a_failure_and_is_not_stored():
    stats, store = _run([_doc()], llm=FakeLLM({"record": None}))
    assert (stats.no_record, stats.failed) == (1, 0)
    assert store.calls == []


def test_the_pages_reach_the_model_in_page_order_under_their_markers():
    llm = FakeLLM()
    _run([_doc()], llm=llm)
    shown = llm.messages[1].content
    assert shown.index("[Seite 2]") < shown.index("zweite")
    assert "[Seite 1]" in shown


def test_chunks_are_ordered_by_numeric_page_label():
    ordered = sorted([("10", "c"), ("2", "b"), (None, "a"), ("1", "z")], key=backfill._page_sort_key)
    assert [text for _, text in ordered] == ["a", "z", "b", "c"]


def test_the_document_id_file_must_be_a_flat_string_map(tmp_path):
    good = tmp_path / "ids.json"
    good.write_text('{"a.pdf": "d1"}')
    bad = tmp_path / "bad.json"
    bad.write_text('["a.pdf"]')

    assert backfill._load_document_ids(str(good)) == {"a.pdf": "d1"}
    assert backfill._load_document_ids(str(bad)) is None
    assert backfill._load_document_ids(str(tmp_path / "missing.json")) is None
    assert backfill._load_document_ids(None) == {}


@pytest.mark.parametrize("argv", [["--collection", "c"], ["--organization-id", "o"]])
def test_organization_and_collection_are_required(argv):
    with pytest.raises(SystemExit):
        backfill._parse_args(argv)
