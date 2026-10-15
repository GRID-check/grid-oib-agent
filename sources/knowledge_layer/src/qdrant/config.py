"""How the knowledge layer reaches Qdrant, its one vector store (ADR-0113).

Every value is read from the environment per call: a test, or an operator,
can repoint it without rebuilding a process-wide singleton (``store.reset_store``
drops the client built from it).
"""

from __future__ import annotations

import os

#: Bounds one request to Qdrant. The chromadb client this replaced set none,
#: and one dead pod drained the API's thread pool on 2026-10-12; the Qdrant
#: client takes a timeout natively, so this is a constant, not a reach-in.
REQUEST_TIMEOUT_SECONDS = 30


# @environment_variable AIQ_QDRANT_URL
# @category Knowledge Layer
# @type str
# @default (unset)
# @required true
# Qdrant HTTP endpoint, e.g. http://qdrant:6333. Every backend tier that reads or writes the knowledge layer needs it.
def qdrant_url() -> str:
    """The Qdrant HTTP endpoint; every read and write of the knowledge layer needs it."""
    url = (os.environ.get("AIQ_QDRANT_URL") or "").strip()
    if not url:
        raise RuntimeError("AIQ_QDRANT_URL is not set; the knowledge layer stores every chunk in Qdrant")
    return url


# @environment_variable AIQ_QDRANT_API_KEY
# @category Knowledge Layer
# @type str
# @default (unset)
# @required false
# API key for Qdrant (service.api_key). Unset only for a local, unauthenticated instance.
def qdrant_api_key() -> str | None:
    """The API key Qdrant expects, or None for an unauthenticated local instance."""
    return (os.environ.get("AIQ_QDRANT_API_KEY") or "").strip() or None


def _positive_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    value = int(raw)
    if value < 1:
        raise ValueError(f"{name} must be at least 1, got {value}")
    return value


# @environment_variable AIQ_QDRANT_SHARD_NUMBER
# @category Knowledge Layer
# @type int
# @default 1
# @required false
# Shards per Qdrant collection, set once at creation. 6 on the 3-node cluster (fits 1/2/3/6 nodes).
def shard_number() -> int:
    """Shards for the tenant collection, fixed at creation (open-source Qdrant cannot reshard)."""
    return _positive_int("AIQ_QDRANT_SHARD_NUMBER", 1)


# @environment_variable AIQ_QDRANT_REPLICATION_FACTOR
# @category Knowledge Layer
# @type int
# @default 1
# @required false
# Replicas per shard, set once at creation. 2 on the 3-node cluster; writes need only one (consistency 1).
def replication_factor() -> int:
    """Replicas per shard, fixed at creation; a self-hosted cluster does not re-replicate by itself."""
    return _positive_int("AIQ_QDRANT_REPLICATION_FACTOR", 1)
