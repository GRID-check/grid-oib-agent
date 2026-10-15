"""The knowledge layer has one backend, llamaindex (ADR-0072).

``backend`` is no longer a config key: a config written before the deletion
still loads (the key is ignored), and whatever it said, the function wires the
llamaindex adapter.
"""

from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import _setup_backend


def test_a_config_that_still_names_the_backend_loads():
    config = KnowledgeRetrievalConfig(backend="llamaindex", collection_name="oib_knowledge")

    assert not hasattr(config, "backend")
    assert config.collection_name == "oib_knowledge"


def test_setup_always_wires_llamaindex(monkeypatch):
    monkeypatch.delenv("KNOWLEDGE_RETRIEVER_BACKEND", raising=False)
    monkeypatch.delenv("KNOWLEDGE_INGESTOR_BACKEND", raising=False)
    config = KnowledgeRetrievalConfig(backend="foundational_rag")

    backend, backend_config = _setup_backend(config)

    assert backend == "llamaindex"
    assert "rag_url" not in backend_config


def test_a_config_that_still_names_a_chroma_dir_loads():
    """``chroma_dir`` went with Chroma (ADR-0113): a config written before still loads, and nothing reads it."""
    config = KnowledgeRetrievalConfig(chroma_dir="/tmp/chroma_data", collection_name="oib_knowledge")

    assert not hasattr(config, "chroma_dir")
    assert "persist_dir" not in _setup_backend(config)[1]
