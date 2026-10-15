"""Every delete the adapter makes, against a real Qdrant (ADR-0113).

Qdrant is the one store, so a delete is one delete: it took what it names or
it raised, and the caller's retry starts over. What these pin, per operation:

* when Qdrant refuses, nothing is deleted and nothing recorded as deleted (the
  metadata row stays, the collection version is not bumped), and a retry
  finishes the job;
* a delete takes the chunks it names and nothing else: another file, another
  version of the same name, another collection;
* ``delete_file`` takes every stored spelling the delete's rule accepts (a
  ``tmp…_`` upload prefix, percent-encoding), not only the exact one.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter as adapter_module
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
from knowledge_layer.llamaindex.adapter import _PreviousVersion
from knowledge_layer.qdrant import store as store_module

from sources.knowledge_layer.tests.qdrant_testing import FakeEmbedder
from sources.knowledge_layer.tests.qdrant_testing import record
from sources.knowledge_layer.tests.qdrant_testing import write

SCOPE = "proj_deletes"


class QdrantOutage:
    """Makes every Qdrant delete fail while ``down``, as an unreachable server does (after the store's retries)."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch):
        self.down = False
        real = store_module.QdrantStore._delete

        def delete(store: store_module.QdrantStore, scope: str, *conditions: Any) -> None:
            if self.down:
                raise ConnectionError("qdrant unreachable")
            real(store, scope, *conditions)

        monkeypatch.setattr(store_module.QdrantStore, "_delete", delete)


@pytest.fixture
def env(tmp_path, monkeypatch, qdrant_store):
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory

    summary_db = f"sqlite:///{tmp_path / 'summaries.db'}"
    monkeypatch.setenv("AIQ_SUMMARY_DB", summary_db)
    factory._document_metadata_store = None
    configure_summary_db(summary_db)
    bumped: list[str] = []
    monkeypatch.setattr(adapter_module, "bump_collection_version", bumped.append)
    monkeypatch.setattr(store_module, "_sleep", lambda seconds: None)

    ingestor = LlamaIndexIngestor({"generate_summary": False, "summary_llm": MagicMock()})
    ingestor._embed_model = FakeEmbedder()
    ingestor._initialized = True
    yield {"ingestor": ingestor, "bumped": bumped, "outage": QdrantOutage(monkeypatch)}
    factory._document_metadata_store = None


def _seed(file_name: str, count: int = 3, *, stored_as: str | None = None, scope: str = SCOPE) -> list[str]:
    """``count`` chunks of ``file_name`` in Qdrant and its row in the metadata store."""
    from aiq_agent.knowledge import register_summary

    stored = stored_as or file_name
    records = [record(f"{file_name} Abschnitt {index}", stored, page_label=str(index + 1)) for index in range(count)]
    write(scope, records)
    register_summary(scope, stored, f"Zusammenfassung {file_name}")
    return [chunk.chunk_id for chunk in records]


def _ids(file_name: str | None = None, scope: str = SCOPE) -> set[str]:
    filters = {"file_name": file_name} if file_name else None
    return {str(point.payload["chunk_id"]) for point in store_module.get_store().scroll(scope, filters)}


def _summary_rows(scope: str = SCOPE) -> set[str]:
    from aiq_agent.knowledge import get_available_documents

    return {document.file_name for document in get_available_documents(scope)}


# ---------------------------------------------------------------- delete_file


def test_delete_file_deletes_nothing_when_qdrant_fails_and_finishes_on_retry(env):
    ids = _seed("plan.pdf")
    _seed("other.pdf")
    _seed("plan.pdf", scope="proj_elsewhere")
    env["outage"].down = True

    assert env["ingestor"].delete_file("plan.pdf", SCOPE) is False

    assert _ids("plan.pdf") == set(ids)
    assert "plan.pdf" in _summary_rows()
    assert env["bumped"] == []

    env["outage"].down = False
    assert env["ingestor"].delete_file("plan.pdf", SCOPE) is True
    assert _ids("plan.pdf") == set()
    assert "plan.pdf" not in _summary_rows()
    assert env["bumped"] == [SCOPE]
    assert len(_ids("other.pdf")) == 3  # the neighbour untouched
    assert len(_ids("plan.pdf", scope="proj_elsewhere")) == 3  # the same name in another collection too


def test_delete_file_takes_every_stored_spelling_of_the_name(env):
    tmp_ids = _seed("Plan A.pdf", stored_as="tmpab12cd34_Plan%20A.pdf")
    plain_ids = _seed("Plan A.pdf", 2)
    other = _seed("Plan B.pdf", 2)

    assert env["ingestor"].delete_file("Plan A.pdf", SCOPE) is True

    assert _ids() == set(other)
    assert not _ids() & (set(tmp_ids) | set(plain_ids))


def test_delete_file_by_its_listed_id_resolves_the_name(env):
    from aiq_agent.knowledge.schema import stable_file_id

    _seed("plan.pdf")
    assert env["ingestor"].delete_file(stable_file_id(SCOPE, "plan.pdf"), SCOPE) is True
    assert _ids() == set()


def test_delete_file_with_no_chunks_still_clears_its_row(env):
    """A row with no chunks lists a file nobody can retrieve: the delete takes it whatever the store holds."""
    from aiq_agent.knowledge import register_summary

    register_summary(SCOPE, "ghost.pdf", "Nur eine Zeile")
    assert env["ingestor"].delete_file("ghost.pdf", SCOPE) is False  # nothing of the file was in the store
    assert "ghost.pdf" not in _summary_rows()


# ---------------------------------------------------------------- retire / quarantine / discard


@pytest.mark.parametrize("operation", ["retire", "quarantine"])
def test_retiring_a_version_is_all_or_nothing(env, operation):
    old = _seed("statik.pdf", stored_as="tmpab12cd34_statik.pdf")
    new = _seed("statik.pdf", 2)
    previous = _PreviousVersion(chunk_ids=old, stored_names=["tmpab12cd34_statik.pdf"])
    retire = getattr(
        env["ingestor"], "_retire_previous_version" if operation == "retire" else "_retire_held_predecessor"
    )
    env["outage"].down = True

    retire(SCOPE, "statik.pdf", previous)

    assert _ids() == set(old) | set(new)
    assert env["bumped"] == []

    env["outage"].down = False
    retire(SCOPE, "statik.pdf", previous)
    assert _ids() == set(new), "the version under the same name is not the one retired"
    assert env["bumped"] == [SCOPE]
    if operation == "retire":
        assert "tmpab12cd34_statik.pdf" not in _summary_rows()
    else:  # a quarantine drops no metadata row (ADR-0086)
        assert "tmpab12cd34_statik.pdf" in _summary_rows()
    assert "statik.pdf" in _summary_rows()


def test_the_previous_version_is_found_under_every_spelling(env):
    old = _seed("statik.pdf", stored_as="tmpab12cd34_statik.pdf")
    plain = _seed("statik.pdf", 2)
    _seed("andere.pdf")

    found = env["ingestor"]._find_previous_versions(SCOPE, ["statik.pdf"])

    assert list(found) == ["statik.pdf"]
    assert sorted(found["statik.pdf"].chunk_ids) == sorted(old + plain)
    assert sorted(found["statik.pdf"].stored_names) == ["statik.pdf", "tmpab12cd34_statik.pdf"]
    assert _ids() >= set(old) | set(plain), "the find only reads"


def test_discarding_a_partial_attempt_takes_exactly_its_chunks(env):
    kept = _seed("statik.pdf")
    partial = _seed("statik.pdf", 2)
    env["outage"].down = True

    env["ingestor"]._discard_partial_version(SCOPE, "statik.pdf", partial)
    assert _ids() == set(kept) | set(partial)

    env["outage"].down = False
    env["ingestor"]._discard_partial_version(SCOPE, "statik.pdf", partial + ["never-written"])
    assert _ids() == set(kept)
    assert env["bumped"] == [SCOPE]


def test_discarding_with_nothing_attempted_deletes_nothing(env):
    kept = _seed("statik.pdf")
    env["ingestor"]._discard_partial_version(SCOPE, "statik.pdf", None)
    env["ingestor"]._discard_partial_version(SCOPE, "statik.pdf", [])
    assert _ids() == set(kept) and env["bumped"] == []


# ---------------------------------------------------------------- delete_collection


def test_delete_collection_keeps_everything_when_qdrant_fails(env):
    ids = _seed("plan.pdf")
    _seed("plan.pdf", scope="proj_elsewhere")
    env["outage"].down = True

    assert env["ingestor"].delete_collection(SCOPE) is False
    assert _ids() == set(ids)
    assert "plan.pdf" in _summary_rows()
    assert env["bumped"] == []

    env["outage"].down = False
    assert env["ingestor"].delete_collection(SCOPE) is True
    assert _ids() == set()
    assert _summary_rows() == set()
    assert env["bumped"] == [SCOPE]
    assert len(_ids(scope="proj_elsewhere")) == 3
