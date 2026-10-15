"""The measurement harness for the Qdrant retrieval gates (design doc §10, G1b, G2, G6).

``task be:eval:qdrant-parity`` runs it. It indexes the OIB corpus into Qdrant
through ingestion's own write (``qdrant/writes.py``) and measures it through the
production retriever (``LlamaIndexRetriever._retrieve_sync``, ``_find_text_sync``),
then sets every number beside what the Chroma path measured on the same corpus and
vectors before Chroma left the stack (``baseline.py``, ADR-0113). With
``--variants`` it also runs the ranking sweep over the same collection.

``runner`` is the CLI. The modules below it are split so the parts a test can pin
without a server (metrics, gates, oracles, truncation, the report) stay pure.
"""
