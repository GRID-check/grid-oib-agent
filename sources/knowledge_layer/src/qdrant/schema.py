"""The physical shape of the Qdrant store: collections, vectors, payload indexes.

Two collections by data shape, not one per scope (ADR-0114):

* ``corpus`` holds the shared legal corpus (``oib_knowledge`` and any other
  collection without a tenant prefix). Every office reads it.
* ``office`` holds everything an office owns: Büroablage (``archiv_``),
  projects and their restricted folders (``proj_``), conversation uploads
  (``s_``).

The logical collection name every caller still speaks is the ``scope``
payload field, indexed ``is_tenant`` so each scope's points sit together on
disk. Clients address each collection through an alias (``piloti_corpus``,
``piloti_office``); a rebuild is a new ``_vN`` collection and one atomic alias
switch, which is how open-source Qdrant changes a shard count it cannot
reshard.

Every field a read filters on is indexed BEFORE the first point lands, because
strict mode refuses a filter on an unindexed field rather than scanning, and
filterable HNSW builds its extra links at index time.
"""

from __future__ import annotations

import logging
from enum import StrEnum
from typing import Any

from qdrant_client import QdrantClient
from qdrant_client import models

from aiq_agent.knowledge.base import READING_ORDER

from .config import replication_factor
from .config import shard_number

logger = logging.getLogger(__name__)

#: The dense named vector: the production embedder's vectors, copied unchanged.
DENSE = "dense"
#: The sparse named vector: BM25 computed by Qdrant itself from the chunk text.
LEXICAL = "lexical"

#: The server-side BM25 model, and the analysis it runs. German stemming and
#: stopwords, umlauts folded. The SAME options go with every write and every
#: query: a query analysed differently from the documents matches nothing.
BM25_MODEL = "qdrant/bm25"
BM25_OPTIONS: dict[str, Any] = {"language": "german", "ascii_folding": True}

#: Payload field holding the logical collection a point belongs to.
SCOPE_FIELD = "scope"
#: Payload field holding the chunk text: what BM25 reads, what the full-text
#: index serves phrase queries from, and what a hit's content is.
TEXT_FIELD = "text"
#: Payload field holding the chunk id every caller knows: the node id the
#: chunker gave it, which citations and ``already_read`` digests name.
CHUNK_ID_FIELD = "chunk_id"
#: Payload field holding every ``§ n`` the chunk text cites, spelled as
#: ``legal_terms.extract_exact_terms`` spells a query's (``§ 3``, ``§ 12.1``,
#: ``§ 3a``). The full-text index cannot answer "§ 3": every tokenizer that
#: keeps digits drops the ``§``, so the phrase is the bare token ``3`` and
#: matches "Abs. 3" and "Seite 3" as well (``payload.paragraph_refs``).
PARAGRAPH_FIELD = "paragraph_refs"

#: The full-text index on :data:`TEXT_FIELD`. ``word`` splits on every
#: non-alphanumeric character and KEEPS digits: "§ 3" is the token ``3``,
#: "5.1.1" the phrase ``5 1 1``, "OIB-Richtlinie 2" the phrase ``oib
#: richtlinie 2``. ``multilingual`` drops digits altogether, so a phrase on a
#: number matched nothing (``docs/contributing/gotchas.md``). Lowercasing and
#: ASCII folding keep "Größe", "GROESSE" and "grosse" one token. Fixed when the
#: index is created; :func:`text_index_drift` reports an index built otherwise.
TEXT_INDEX = models.TextIndexParams(
    type=models.TextIndexType.TEXT,
    tokenizer=models.TokenizerType.WORD,
    lowercase=True,
    ascii_folding=True,
    phrase_matching=True,
)

#: Payload object holding the owning project's fingerprint (the BFF's
#: ``FINGERPRINT_KEYS``), mirrored from Postgres ``projects.profile`` by scope.
#: Each key is indexed as ``project_facts.<key>``.
PROJECT_FACTS_FIELD = "project_facts"
#: Payload field holding the owning project's lifecycle state (ADR-0098).
PROJECT_STATUS_FIELD = "project_status"
#: The fingerprint, in the order the BFF's similarity weighs it.
FACT_KEYS: tuple[str, ...] = ("bundesland", "gebaeudeklasse", "bauweise", "nutzungen", "vorhabensart")


def fact_field(key: str) -> str:
    """The payload path of one fingerprint fact, as filters and formulas name it."""
    if key not in FACT_KEYS:
        raise ValueError(f"{key!r} is not a project fact")
    return f"{PROJECT_FACTS_FIELD}.{key}"


#: Fields stored and filtered as strings. A writer that hands one an int (or a
#: reader that asks with one) is coerced, so ``page_label`` 3 and "3" agree.
KEYWORD_FIELDS: tuple[str, ...] = (
    SCOPE_FIELD,
    CHUNK_ID_FIELD,
    "file_name",
    "punkt_id",
    "page_label",
    "chunking",
    "content_type",
    "doc_class",
    "richtlinie",
    "office_id",
    "project_id",
    "grid_document_id",
    "folder_path",
    # Every folder a document is filed in or beneath, case-folded: "this
    # folder and below" is one exact match (``prefilter.folder_ancestors``).
    "folder_ancestors",
    "tags",
    "topics",
    PROJECT_STATUS_FIELD,
    *(f"{PROJECT_FACTS_FIELD}.{key}" for key in FACT_KEYS if key != "gebaeudeklasse"),
    PARAGRAPH_FIELD,
    # Locators and labels the chunkers write (``punkt_chunking``,
    # ``section_chunking``, the adapter's visual documents) and a model may
    # name in ``knowledge_search``'s raw ``filters``. ``page_end`` is written
    # as a string, like ``page_label``. Large or unbounded fields
    # (``drawing_data``, ``description``) stay unindexed and unfilterable.
    "punkt_path",
    "punkt_parent_id",
    "punkt_title",
    "page_end",
    "drawing_type",
    "drawing_scale",
    "image_format",
    "image_key",
    "authored_by",
    "approved_by",
    "producer",
)
#: Payload field holding a chunk's place in document order (the seam's
#: ``READING_ORDER``): derived at write time from ``page_label``, never read
#: from the chunk's metadata, and what a structural fetch orders by.
READING_ORDER_FIELD = READING_ORDER
#: Payload field holding when ingestion wrote the point, in seconds since the
#: epoch. A collection's ``updated_at`` is its newest value (an ordered scroll),
#: which is what the reaper of conversation uploads (``TTLCleanupMixin``) reads.
INDEXED_AT_FIELD = "indexed_at"
#: Payload field holding a chunk's place in its file, 0 for the first chunk the
#: chunker cut: what orders the chunks of one page, whose point ids are random.
#: Written at ingest and by the import from Chroma (in the export's order, which
#: is Chroma's insertion order); a point written before it existed has none.
CHUNK_ORDINAL_FIELD = "chunk_ordinal"

#: Fields stored and filtered as integers. The Punkt chunker writes
#: ``punkt_depth`` as an int and some readers ask with "1"; both become 1.
INTEGER_FIELDS: tuple[str, ...] = (
    "punkt_depth",
    "section_order",
    READING_ORDER_FIELD,
    CHUNK_ORDINAL_FIELD,
    INDEXED_AT_FIELD,
    f"{PROJECT_FACTS_FIELD}.gebaeudeklasse",
    "section_part",
    "table_index",
    "table_part",
    "image_index",
    "stored_image_index",
    "segment_index",
)
#: Fields stored and filtered as booleans.
BOOL_FIELDS: tuple[str, ...] = ("superseded",)

INDEXED_FIELDS = frozenset(KEYWORD_FIELDS + INTEGER_FIELDS + BOOL_FIELDS + (TEXT_FIELD,))

#: Prefixes of collections an office owns. Anything else is shared corpus.
TENANT_PREFIXES = ("archiv_", "proj_", "s_")

#: Collection metadata keys naming the embedder every dense vector came from.
EMBED_IDENTITY_KEYS = ("aiq:embed_fingerprint", "aiq:embed_model")


class Physical(StrEnum):
    """The two physical collections."""

    CORPUS = "corpus"
    OFFICE = "office"


#: Alias each physical collection is addressed by, and the collection it
#: points at when this code creates it.
ALIASES = {Physical.CORPUS: "piloti_corpus", Physical.OFFICE: "piloti_office"}
FIRST_VERSION = "_v1"

#: Replicas that must acknowledge a write, whatever the replication factor.
#: The other replica is durable once it has caught up; the snapshots to
#: SeaweedFS are the net behind the window in which it has not
#: (``docs/deployment/qdrant-runbook.md``).
WRITE_CONSISTENCY_FACTOR = 1


def physical_for_scope(scope: str) -> Physical:
    """Which physical collection holds a logical collection's points."""
    return Physical.OFFICE if scope.startswith(TENANT_PREFIXES) else Physical.CORPUS


def _field_schema(field: str) -> Any:
    if field == SCOPE_FIELD:
        return models.KeywordIndexParams(type=models.KeywordIndexType.KEYWORD, is_tenant=True)
    if field == TEXT_FIELD:
        return TEXT_INDEX
    if field in INTEGER_FIELDS:
        return models.PayloadSchemaType.INTEGER
    if field in BOOL_FIELDS:
        return models.PayloadSchemaType.BOOL
    return models.PayloadSchemaType.KEYWORD


def create_collection(
    client: QdrantClient,
    physical: Physical,
    name: str,
    dense_size: int,
    identity: dict[str, str],
    *,
    shards: int | None = None,
    replication: int | None = None,
) -> None:
    """Create one physical collection with its vectors, quantization, strict mode and indexes.

    No alias: :func:`ensure_collection` points the alias at a first version,
    and a rebuild (``rebuild.py``) creates the next ``_vN`` beside the live one
    and switches the alias only once the copy is complete. ``shards`` and
    ``replication`` override the environment's, which is what a rebuild is for.
    """
    tenant = physical is Physical.OFFICE
    rf = replication or replication_factor()
    client.create_collection(
        name,
        vectors_config={DENSE: models.VectorParams(size=dense_size, distance=models.Distance.COSINE)},
        sparse_vectors_config={LEXICAL: models.SparseVectorParams(modifier=models.Modifier.IDF)},
        # The corpus is small and read by every query: one shard, on every node.
        shard_number=(shards or shard_number()) if tenant else 1,
        replication_factor=rf,
        # One replica acknowledges a write; Qdrant brings the other up to date
        # from its WAL (``wal_delta``) when it is back. At RF 2 a write
        # consistency of 2 failed every write to a shard whose second peer was
        # down, which a rollout or a node drain does to most of the six.
        write_consistency_factor=WRITE_CONSISTENCY_FACTOR,
        # Per-scope graph links beside the global graph: a project-filtered
        # query walks its own scope's graph, a cross-project one the global.
        hnsw_config=models.HnswConfigDiff(payload_m=16) if tenant else None,
        quantization_config=models.TurboQuantization(
            turbo=models.TurboQuantQuantizationConfig(bits=models.TurboQuantBitSize.BITS4)
        ),
        strict_mode_config=models.StrictModeConfig(
            enabled=True, unindexed_filtering_retrieve=False, unindexed_filtering_update=False
        ),
        metadata=dict(identity),
    )
    ensure_payload_indexes(client, name)


def text_index_drift(params: Any) -> str | None:
    """How an existing text index differs from :data:`TEXT_INDEX`, or None when it does not."""
    wanted = TEXT_INDEX.model_dump(include={"tokenizer", "lowercase", "ascii_folding", "phrase_matching"})
    found = {key: getattr(params, key, None) for key in wanted}
    drift = {key: (found[key], value) for key, value in wanted.items() if found[key] != value}
    if not drift:
        return None
    return ", ".join(f"{key} is {have!r}, wants {want!r}" for key, (have, want) in sorted(drift.items()))


def ensure_payload_indexes(client: QdrantClient, collection: str) -> list[str]:
    """Create every index in :data:`INDEXED_FIELDS` the collection lacks; returns the fields created.

    The migration for a field added after a collection was made: strict mode
    refuses a filter on it until its index exists, so every process that
    reads or writes a collection runs this once before its first query.
    Idempotent: an index that exists is left alone, its points untouched.

    An index cannot change its analysis in place. A text index built with
    other parameters than :data:`TEXT_INDEX` is reported, loudly, and left:
    rebuilding it is a new collection and an alias switch, never a silent
    drop under a running cluster.
    """
    schema = client.get_collection(collection).payload_schema or {}
    text = schema.get(TEXT_FIELD)
    drift = text_index_drift(text.params) if text is not None else None
    if drift:
        logger.error(
            "Qdrant collection %s: the %r full-text index was built differently (%s). Phrase and exact-term "
            "matching on numbers (§ 3, 5.1.1) is wrong until it is rebuilt: copy into a new _vN collection and "
            "switch the alias (scripts/qdrant_rebuild.py, docs/deployment/qdrant-runbook.md)",
            collection,
            TEXT_FIELD,
            drift,
        )
    missing = sorted(INDEXED_FIELDS - set(schema))
    for field in missing:
        client.create_payload_index(collection, field, field_schema=_field_schema(field), wait=True)
    if missing and schema:
        logger.info("Qdrant collection %s: created missing payload indexes %s", collection, missing)
    return missing


def _alias_exists(client: QdrantClient, alias: str) -> bool:
    return any(entry.alias_name == alias for entry in client.get_aliases().aliases)


def _create_alias(client: QdrantClient, name: str, alias: str) -> None:
    """Point ``alias`` at ``name`` unless it already exists; a racing writer that made it first is success."""
    if _alias_exists(client, alias):
        return
    try:
        client.update_collection_aliases(
            change_aliases_operations=[
                models.CreateAliasOperation(create_alias=models.CreateAlias(collection_name=name, alias_name=alias))
            ]
        )
    except Exception:
        if not _alias_exists(client, alias):
            raise


def identity_mismatch(stored: dict[str, Any] | None, identity: dict[str, str]) -> str | None:
    """Why the collection's vectors are not from this process's embedder, or None when they are."""
    stored = stored or {}
    fingerprint = EMBED_IDENTITY_KEYS[0]
    if stored.get(fingerprint) == identity.get(fingerprint):
        return None
    return (
        f"embedding mismatch: Qdrant collection was written with {stored.get(EMBED_IDENTITY_KEYS[1])!r}, "
        f"this process embeds with {identity.get(EMBED_IDENTITY_KEYS[1])!r}"
    )


def _create_or_adopt(client: QdrantClient, physical: Physical, dense_size: int, identity: dict[str, str]) -> None:
    """Create the first collection behind the alias, or finish one another writer started.

    Creating is three steps (collection, indexes, alias) and none of them is
    atomic with the next. A writer that dies after the first leaves ``_v1``
    with no alias, and a writer racing this one may hold the collection
    without its alias yet. Either way the create conflicts, and the
    collection is finished here instead: every index added, the alias made.
    Both steps are idempotent, so two writers finishing it at once agree.
    """
    alias = ALIASES[physical]
    name = alias + FIRST_VERSION
    try:
        create_collection(client, physical, name, dense_size, identity)
        logger.info("Created Qdrant collection %s", name)
    except Exception:
        if not client.collection_exists(name):
            raise
        logger.info("Qdrant collection %s exists without alias %s; finishing it", name, alias)
        ensure_payload_indexes(client, name)
    _create_alias(client, name, alias)


def ensure_collection(client: QdrantClient, physical: Physical, dense_size: int, identity: dict[str, str]) -> None:
    """Create the physical collection behind its alias if missing; refuse a foreign vector space.

    Idempotent and safe to race, and it recovers a collection a dead writer
    left without its alias (:func:`_create_or_adopt`).
    """
    alias = ALIASES[physical]
    if not _alias_exists(client, alias):
        _create_or_adopt(client, physical, dense_size, identity)
    info = client.get_collection(alias)
    mismatch = identity_mismatch(info.config.metadata, identity)
    if mismatch:
        raise RuntimeError(f"{alias}: {mismatch}")
    ensure_payload_indexes(client, alias)
