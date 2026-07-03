# OIB Parallel Ingestion Design

## Goal

Reduce wall-clock time for OIB PDF ingestion by allowing a bounded number of files to ingest concurrently while preserving the current registry semantics and failure handling.

## Current Behavior

`src/aiq_agent/oib_sync.py` discovers new or changed PDFs, uploads one file through the LlamaIndex ingestor, waits for that file to finish, updates `data/oib_registry.json` on success, then moves to the next file. The LlamaIndex ingestor already starts background ingestion work per uploaded file, but `sync()` serializes the process by waiting immediately after each upload.

## Recommended Approach

Add bounded concurrency in `oib_sync.sync()` with a default maximum of four active files, and improve log output so one-off Docker runs show useful live state.

The sync loop will:

1. Read `OIB_SYNC_MAX_WORKERS`, defaulting to `4`.
2. Submit up to that many new or changed PDFs via the existing `ingestor.upload_file()` API.
3. Poll all active file IDs in one loop.
4. When a file succeeds, update the registry immediately for that PDF and submit the next pending PDF.
5. When a file fails or times out, log the error, leave the registry entry unchanged, and continue.
6. Return the existing `(added_or_changed, total_pdfs)` result shape.

Setting `OIB_SYNC_MAX_WORKERS=1` keeps effectively sequential behavior for troubleshooting or constrained environments.

## Trade-Offs

This keeps the change local to OIB sync and avoids changing adapter behavior for every ingestion caller. It uses the existing background ingestion model instead of adding a second independent ingestion implementation. The main risk is increased contention against the embedding API or Chroma persistence directory, so the concurrency limit is intentionally small and configurable.

## Error Handling

Each active file has its own start time. A file that remains non-terminal beyond the existing poll timeout is treated as timed out, logged, and removed from the active set. Other active files continue. Successful files save the registry incrementally so partial progress survives process interruption.

## State Reporting

Logs are the primary state-reporting surface for this change. `sync()` should emit clear `INFO` logs for:

1. Initial discovery counts: total PDFs, registry entries, new or changed files, max workers, collection name, and Chroma directory.
2. Each submitted file: queue position, filename, file size, and backend file ID.
3. Periodic progress while files are active: active count, completed count, failed count, timed-out count, queued count, and each active file's current status and elapsed time.
4. Per-file terminal outcomes: success with chunk count if available, failure with error message, or timeout with elapsed time.
5. Final summary: succeeded, failed, timed out, skipped, and total discovered files.

The implementation should avoid noisy per-poll logs by reporting only when a state changes or on a modest interval during long waits. The existing Docker command can enable these logs with `logging.basicConfig(level=logging.INFO)` and unbuffered Python (`python -u`).

## Testing

Add focused unit tests around the sync orchestration using a fake ingestor. Tests should cover bounded submission, incremental registry updates, failed files not being registered, `OIB_SYNC_MAX_WORKERS=1` preserving sequential behavior, and representative state-reporting logs.
