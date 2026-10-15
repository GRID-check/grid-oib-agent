"""The Qdrant vector store (ADR-0113): the only package that imports ``qdrant_client``.

``config`` says how a process reaches the cluster; ``schema`` owns the
physical collections; ``scope`` builds every read filter (ADR-0114); ``store``
holds the client and the primitive writes; ``writes`` writes a file's chunks
and copies the facts people set; ``search`` runs the ranked reads, ``reads``
the structural ones; ``rebuild`` copies a collection into a new ``_vN`` and
moves its alias.
"""
