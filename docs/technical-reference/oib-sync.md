# OIB Richtlinien Sync

Incremental ingestion pipeline for OIB (Österreichisches Institut für Bautechnik) PDFs into the `oib_knowledge` ChromaDB collection.

---

## CLI Entry Point

**File**: `scripts/ingest_oib.py`

```python
from aiq_agent.oib_sync import sync

if __name__ == "__main__":
    added, total = sync()
    print(f"OIB sync complete: {added} added/changed, {total} total tracked")
```

Run via Docker:

```bash
docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env exec aiq-agent python scripts/ingest_oib.py
```

---

## Sync Algorithm

**File**: `src/aiq_agent/oib_sync.py`

```
sync()
  │
  ├─ 1. Scan data/oib/ for *.pdf files (recursive)
  │
  ├─ 2. Load data/oib_registry.json (SHA-256 → filename mapping)
  │
  ├─ 3. Compute SHA-256 for each PDF
  │
  ├─ 4. Compare against registry → identify new/changed files
  │
  ├─ 5. If no changes → return (0, total)
  │
  ├─ 6. Initialize LlamaIndex ingestor
  │
  ├─ 7. Ensure oib_knowledge collection exists
  │
  └─ 8. For each new/changed PDF:
       │
       ├─ ingestor.upload_file(path, collection)
       ├─ _wait_for_file(ingestor, file_id) → poll every 2s, timeout 600s
       ├─ If SUCCESS → record SHA-256 in registry, save
       └─ If FAILED  → leave registry unchanged (retry on next run)
```

### Incremental Sync

The registry file (`data/oib_registry.json`) maps relative PDF paths to their SHA-256 hashes:

```json
{
  "data/oib/OIB-Richtlinie-1.pdf": "abc123def456...",
  "data/oib/OIB-Richtlinie-2.pdf": "789012ghi345..."
}
```

On each run:
- Files with a **changed hash** are re-ingested (content was modified)
- **New files** (not in registry) are ingested
- **Unchanged files** are skipped
- **Failed files** are retried on the next run (registry not updated on failure)

### Polling (`_wait_for_file`)

| Parameter | Value |
|-----------|-------|
| Poll interval | 2 seconds |
| Timeout | 600 seconds (10 minutes) |
| Terminal states | `SUCCESS`, `FAILED` |
| On timeout | Returns `FAILED` (retry next run) |

The function calls `ingestor.get_file_status(file_id, collection_name)` in a loop until a terminal status is reached or the deadline is exceeded.

---

## Registry Management

**Functions**:
- `_load_registry()` — Reads `REGISTRY_PATH` (default: `data/oib_registry.json`), returns `dict[str, str]`
- `_save_registry(registry)` — Writes sorted JSON to `REGISTRY_PATH`, creates parent directories if needed
- `_file_hash(path)` — Streams the file through SHA-256 (8KB chunks)

Only files that reach `FileStatus.SUCCESS` have their hash recorded. Failures and timeouts leave the registry unchanged, guaranteeing automatic retry.

---

## Collection Management

`_ensure_collection(ingestor)`:
- Checks if `OIB_COLLECTION_NAME` (default: `oib_knowledge`) exists
- Creates it if missing, with description `"Persistent OIB Richtlinien knowledge base."`
- Idempotent — safe to call multiple times

Base/project collections like `oib_knowledge` are **never** subject to TTL auto-deletion (only `s_`-prefixed session collections are reaped).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OIB_DOCUMENTS_DIR` | `data/oib` | Directory containing OIB PDFs |
| `OIB_REGISTRY_PATH` | `data/oib_registry.json` | Path to SHA-256 registry file |
| `OIB_COLLECTION_NAME` | `oib_knowledge` | Target ChromaDB collection |
| `AIQ_CHROMA_DIR` | `/tmp/chroma_data` | ChromaDB persistence directory |

---

## Ingestor Initialization

The sync imports `knowledge_layer.llamaindex.adapter` eagerly to register the ingestor backend with the factory, then obtains an ingestor via:

```python
from aiq_agent.knowledge.factory import get_ingestor
ingestor = get_ingestor("llamaindex", {"persist_dir": CHROMA_DIR})
```

This creates a `LlamaIndexIngestor` with ChromaDB persistence at `AIQ_CHROMA_DIR`.

---

## Dependency Graph

```
scripts/ingest_oib.py
       │
       ▼
src/aiq_agent/oib_sync.py
       │
       ├── knowledge_layer.llamaindex.adapter  (registers backend)
       ├── aiq_agent.knowledge.factory          (get_ingestor)
       ├── aiq_agent.knowledge.schema           (FileStatus)
       │
       └── ChromaDB (@ AIQ_CHROMA_DIR / oib_knowledge collection)
```

The OIB collection is included as the default `base_collection` in every query's scope (see [Collection Scoping](collection-scoping.md)).
