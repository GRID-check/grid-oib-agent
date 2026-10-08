# Knowledge Layer

Document ingestion and retrieval for NeMo Agent Toolkit workflows.

For comprehensive documentation, see [`KNOWLEDGE-LAYER-SETUP.md`](./KNOWLEDGE-LAYER-SETUP.md).

## Installation

```bash
uv pip install -e "sources/knowledge_layer[llamaindex]"
```

## The backend

There is one: `llamaindex` (LlamaIndex over ChromaDB, embeddings and the VLM
through OpenRouter). It is the production backend, and it has been since the
first commit: every Piloti deployment has run on it.

This package once also carried a second backend, a client for NVIDIA's hosted
retrieval service that came with the AI-Q template. Its README row called it
"Production, multi-user", which was never true of Piloti: no Piloti deployment
ever ran it, and it could not run the product's retrieval. It was deleted in
[ADR-0072](../../docs/adr/0072-the-knowledge-layer-has-one-backend-llamaindex.md).

The `BaseRetriever`/`BaseIngestor` seam and the adapter registry in
`aiq_agent.knowledge.factory` stay: tests register fakes through them.

## Usage

See [Web UI Mode](./KNOWLEDGE-LAYER-SETUP.md#web-ui-mode) for document upload and chat interfaces.
