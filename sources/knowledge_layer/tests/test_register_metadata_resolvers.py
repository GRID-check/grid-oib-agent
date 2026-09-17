"""The document-metadata resolvers fail open, and say so.

Each of the three (`doc_class`, `display_title`, folder path) swallowed every
store error and returned an empty map, so a metadata store that was down or
misconfigured made every hit fall back to its chunk metadata — a wrong
doc_class, a filename for a title, a root folder — with nothing in any log to
distinguish that from a correct answer.
"""

import logging
from types import SimpleNamespace

import pytest
from knowledge_layer import register as reg


def _chunk(collection: str = "proj_1", file_name: str = "plan.pdf") -> SimpleNamespace:
    return SimpleNamespace(metadata={"collection": collection}, file_name=file_name)


@pytest.mark.parametrize(
    ("resolver", "factory_fn", "what"),
    [
        (reg._resolve_doc_classes, "get_document_doc_classes", "doc_class"),
        (reg._resolve_display_titles, "get_document_display_titles", "display_title"),
        (reg._resolve_folder_paths, "get_document_folder_paths", "folder_path"),
    ],
)
def test_a_store_read_failure_is_fail_open_and_logged(monkeypatch, caplog, resolver, factory_fn, what):
    from aiq_agent.knowledge import factory

    def boom(collection, filenames):
        raise RuntimeError("metadata store unreachable")

    monkeypatch.setattr(factory, factory_fn, boom)

    with caplog.at_level(logging.WARNING, logger=reg.logger.name):
        resolved = resolver([_chunk(), _chunk(file_name="other.pdf")])

    assert resolved == {}
    warning = next(r for r in caplog.records if r.levelno == logging.WARNING)
    assert "proj_1" in warning.getMessage()
    assert what in warning.getMessage()
    # The traceback travels with it: "falls back" without the cause is a
    # symptom line, and the operator needs the fault.
    assert warning.exc_info is not None


def test_a_healthy_store_stays_silent(monkeypatch, caplog):
    from aiq_agent.knowledge import factory

    monkeypatch.setattr(factory, "get_document_doc_classes", lambda collection, filenames: {"plan.pdf": "plan"})

    with caplog.at_level(logging.WARNING, logger=reg.logger.name):
        resolved = reg._resolve_doc_classes([_chunk()])

    assert resolved == {("proj_1", "plan.pdf"): "plan"}
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
