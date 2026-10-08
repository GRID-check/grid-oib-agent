"""The knowledge layer has one backend, llamaindex (ADR-0072).

``backend`` is not a config key: a config that still sets it loads (the key is
ignored), and whatever it says, the function wires the llamaindex adapter.
"""

from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import _setup_backend


def test_a_config_that_still_names_the_backend_loads():
    config = KnowledgeRetrievalConfig(backend="llamaindex", collection_name="oib_knowledge")

    assert not hasattr(config, "backend")
    assert config.collection_name == "oib_knowledge"


def test_setup_always_wires_llamaindex(tmp_path, monkeypatch):
    monkeypatch.delenv("KNOWLEDGE_RETRIEVER_BACKEND", raising=False)
    monkeypatch.delenv("KNOWLEDGE_INGESTOR_BACKEND", raising=False)
    monkeypatch.delenv("AIQ_CHROMA_DIR", raising=False)
    config = KnowledgeRetrievalConfig(backend="foundational_rag", chroma_dir=str(tmp_path))

    backend, backend_config = _setup_backend(config)

    assert backend == "llamaindex"
    assert backend_config["persist_dir"] == str(tmp_path)
    assert "rag_url" not in backend_config
