---
status: accepted
date: 2026-09-29
decision-makers: Grid engineering, product owner
consulted:
informed: everyone working in this repo
---

# The knowledge layer has one backend: llamaindex

## Context and Problem Statement

The knowledge layer came from NVIDIA's AI-Q template with two backends behind
`BaseRetriever`/`BaseIngestor`: `llamaindex` (LlamaIndex over ChromaDB, in
process) and `foundational_rag`, an HTTP client for NVIDIA's hosted RAG
Blueprint, which was the template's Helm default. The package README and
`KNOWLEDGE-LAYER-SETUP.md` labelled them "Development, prototyping" and
"Production, multi-user". The labels were the template's. The product owner
read them as a description of Piloti and concluded Piloti ran on the RAG
Blueprint. It never did:

* Every config Piloti has deployed, from the first commit (`3ffeca6b4`,
  2026-07-01) on, sets `backend: llamaindex`. The one config that selected the
  other backend, the template's `config_web_frag.yml`, pointed at a RAG server
  nobody ran and was removed in `cb9e1e2e1` (2026-09-07).
* It could not run the product's retrieval. Its `filter_expr` translation takes
  flat equality only and raises `ValueError` on an operator node. The OIB
  base-collection exclusion (`chunking $ne page`), every `read_passage` lookup
  (`file_name $eq …`) and the family overview all send operator nodes.
  `_merge_results` logs a raising layer at DEBUG and skips it, so each of those
  searches would have come back empty without a visible error.
* It lacked what the answer depends on: no `get_document_visual_details`, no
  page-render track for drawings, no lexical/hybrid channel, and no rank stamp
  for cross-collection fusion.
* It was maintained anyway. Provenance (`fd0684600`), the filter guard
  (`a1f07a502`), tag classification (`1e14552d8`) and the rendition path of
  ADR-0071 (`62fba7f94`, 89 lines) each paid to keep 1,900 lines of adapter
  in step, plus two test files and a manual harness, for a backend with no
  deployment.

The remaining question was whether NVIDIA's ingestion stack should replace or
feed the llamaindex pipeline for OCR and tables. Research on NV-Ingest in
2026-09 said no. The hosted trial's terms forbid production and personal data.
Self-hosting needs a GPU node Piloti does not run. The OCR model's language
list does not include German.

## Considered Options

* Keep both backends and fix the labels.
* Keep `foundational_rag` as the production target and port the product's
  retrieval to it.
* Delete `foundational_rag`; `llamaindex` is the one backend.

## Decision Outcome

Chosen option: delete `foundational_rag`, because nothing ran it, it could not
serve the product, and every change to the pipeline paid for it twice.

What went: the `sources/knowledge_layer/src/foundational_rag/` package, its
`foundational_rag` extra (`requests`, `urllib3`), its tests and the
`run_foundational_rag.py` harness, `RAG_SERVER_URL`/`RAG_INGEST_URL`, and the
`backend`, `rag_url`, `ingest_url`, `timeout` and `verify_ssl` fields of
`KnowledgeRetrievalConfig`. `register.py` wires llamaindex unconditionally.
The config no longer has a `backend` key: a config that still sets one loads,
because NAT ignores unknown keys, and gets llamaindex.

What stayed: the `BaseRetriever`/`BaseIngestor` seam and the adapter registry
in `aiq_agent.knowledge.factory`. Tests register fakes through them, and
`run_adapter_compliance.py` checks an adapter against the interface. That seam
is the architecture; the second implementation was not.

OCR for scanned pages and table extraction come to the llamaindex pipeline
through the existing OpenRouter route (the VLM's credential resolution, BYOK
and per-org model override), not through a second backend.

### Consequences

* Good, because the docs say what runs: `llamaindex` is the production backend,
  and it always was.
* Good, because a pipeline change (a new filter shape, a new ingestion input) is
  written and tested once.
* Good, because the deploy surface loses two env vars and an extra that pulled
  `requests` into the image for nothing.
* Bad, because a future move to a hosted vector store is an adapter written from
  the seam up rather than a config switch. The deleted adapter was never that
  switch, since it could not run the product's retrieval.
* Neutral: the `BACKEND` constant in `register.py` still names the registry key,
  so a second backend would reintroduce a selection there.

### Confirmation

`sources/knowledge_layer/tests/test_single_backend.py` pins that the config has
no `backend` field and that `_setup_backend` always wires llamaindex, even for
a config that names another backend. `test_ingestor_registry.py` pins that
`llamaindex` is registered as an ingestor class. Nothing stops someone
registering a new adapter; this record and review are the gate against it
becoming a second production backend.

## More Information

* Revisit if Piloti needs a vector store that ChromaDB cannot serve (multi-node
  write throughput, a tenant count past what one Chroma directory holds). The
  answer is then a new adapter behind the same seam and an ADR superseding this
  one.
* ADR-0057's follow-up "the `foundational_rag` page-render track" is moot.
