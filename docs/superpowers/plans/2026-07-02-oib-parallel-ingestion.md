# OIB Parallel Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parallelize OIB PDF ingestion with bounded concurrency and useful live logging.

**Architecture:** Keep the change local to `src/aiq_agent/oib_sync.py`. The sync function submits up to `OIB_SYNC_MAX_WORKERS` active uploads, polls them together, and updates the registry incrementally as files complete.

**Tech Stack:** Python 3.11, pytest, existing AI-Q knowledge ingestor interfaces.

---

## File Structure

- Modify `src/aiq_agent/oib_sync.py`: add worker-count parsing, active ingestion tracking, pooled polling, and state-reporting logs.
- Create `tests/test_oib_sync.py`: unit tests using a fake ingestor and temporary OIB/registry paths. This lives outside `tests/aiq_agent` so it can exercise the isolated sync orchestration without loading the heavier aiq-agent conftest.
- Existing design reference: `docs/superpowers/specs/2026-07-02-oib-parallel-ingestion-design.md`.

### Task 1: Test Bounded Submission And Registry Updates

**Files:**
- Create: `tests/test_oib_sync.py`
- Modify: `src/aiq_agent/oib_sync.py`

- [ ] **Step 1: Write failing tests for concurrency and registry behavior**

Add tests that monkeypatch `oib_sync.get_ingestor`, module paths, poll timing, and `OIB_SYNC_MAX_WORKERS`. Use a fake ingestor whose first two files stay active until both have been submitted, proving bounded parallel submission. Assert successful files are written to the registry and failed files are not.

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_oib_sync.py -v`

Expected: fail because `OIB_SYNC_MAX_WORKERS` and pooled polling do not exist yet.

- [ ] **Step 3: Implement bounded active-file polling**

In `oib_sync.py`, add a small active-file record, parse `OIB_SYNC_MAX_WORKERS` with default `4`, submit files until capacity is full, poll active file IDs together, update registry on success, and continue after failures/timeouts.

- [ ] **Step 4: Run tests to verify bounded ingestion passes**

Run: `uv run pytest tests/test_oib_sync.py -v`

Expected: pass.

### Task 2: Test And Implement State-Reporting Logs

**Files:**
- Modify: `tests/test_oib_sync.py`
- Modify: `src/aiq_agent/oib_sync.py`

- [ ] **Step 1: Add log assertions**

Use `caplog` to assert logs include initial discovery counts, submitted file details, terminal outcomes, periodic progress, and final summary.

- [ ] **Step 2: Run tests to verify logging gaps**

Run: `uv run pytest tests/test_oib_sync.py -v`

Expected: fail if required log messages are missing.

- [ ] **Step 3: Add concise INFO logs**

Emit initial discovery, per-submit, progress, success/failure/timeout, and final summary logs. Avoid logging every poll unless state changed or a configured progress interval has elapsed.

- [ ] **Step 4: Run focused tests**

Run: `uv run pytest tests/test_oib_sync.py -v`

Expected: pass.

### Task 3: Quality Gate

**Files:**
- Modify: `src/aiq_agent/oib_sync.py`
- Modify: `tests/test_oib_sync.py`

- [ ] **Step 1: Format and lint changed Python files**

Run: `uv run ruff format src/aiq_agent/oib_sync.py tests/test_oib_sync.py`

Run: `uv run ruff check src/aiq_agent/oib_sync.py tests/test_oib_sync.py`

Expected: no lint errors.

- [ ] **Step 2: Run focused tests**

Run: `uv run pytest tests/test_oib_sync.py -v`

Expected: all tests pass.

- [ ] **Step 3: Inspect diff**

Run: `git diff -- src/aiq_agent/oib_sync.py tests/test_oib_sync.py docs/superpowers/specs/2026-07-02-oib-parallel-ingestion-design.md docs/superpowers/plans/2026-07-02-oib-parallel-ingestion.md`

Expected: only the intended implementation, tests, spec, and plan changes are present.

## Self-Review

- Spec coverage: bounded concurrency, default max workers of four, sequential fallback, incremental registry updates, failure/timeout continuation, and logs-as-state-reporting are all covered by the tasks.
- Placeholder scan: no implementation placeholders remain in the plan.
- Type consistency: plan uses existing `sync()`, `get_ingestor`, `FileStatus`, and pytest monkeypatch/caplog patterns.
