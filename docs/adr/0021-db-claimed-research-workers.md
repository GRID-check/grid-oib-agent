# ADR-0021: DB-claimed workers for deep-research execution (retiring per-pod Dask)

- **Status:** Accepted — implemented behind `GRID_JOB_EXECUTION=db|dask` (default `dask`). See `frontends/aiq_api/src/aiq_api/jobs/{queue,worker}.py`, the submit switch in `jobs/submit.py`, and the `agent-worker` tier in `deploy/pulumi`. In `db` mode the chat/web tier also runs multiple replicas (`backendReplicas`, default 2); the ingest-status store and the reaper leader-lock this requires are now implemented (docs/deployment/kubernetes.md §6.4).
- **Date:** 2026-07-09
- **Deciders:** Platform engineering
- **Related:** ADR-0018 (per-run state), ADR-0011 (deletion pipeline — the pattern source), ../architecture/scaling-review-2026-07.md

## Context

Deep-research jobs execute on a Dask cluster that `deploy/entrypoint.py`
spawns **inside each backend container** (`NAT_DASK_SCHEDULER_ADDRESS` is
always `tcp://localhost:…`). Consequences at N>1 backend replicas:

- A job runs only on the replica that accepted the submit; capacity does not
  pool.
- **Cross-replica cancel silently no-ops:** `cancel_job` resolves the Dask
  future on the *local* scheduler; if the LB routes the cancel elsewhere, the
  status flips to INTERRUPTED while the task keeps running (the runner's 1 s
  status poll eventually saves this — but only because it re-reads the DB).
- A restart kills in-flight jobs; the ghost reaper marks them FAILURE after
  300 s. No queueing, no resume.

Meanwhile the repo already operates a correct DB-claimed worker: the purger
(`FOR UPDATE SKIP LOCKED`, attempts + backoff, stale-claim reaping,
ADR-0011), and job state/events already live in shared Postgres
(`job_info`/`job_events`). Dask contributes scheduling we barely use — each
job is one coarse task — at the cost of an in-container cluster, a second
process tree, and replica pinning.

## Decision (design)

We will replace per-pod Dask execution with **DB-claimed research workers**:

1. **Submission writes a row, nothing else.** `submit_agent_job` persists the
   job (status `SUBMITTED`, all context fields it already serializes — scope,
   project context, overrides, usage snapshot) and returns. The admission
   caps (`GRID_MAX_ACTIVE_JOBS*`) keep gating here.
2. **Dedicated worker containers** (same image, `command: python -m
   aiq_api.jobs.worker`) claim with `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1`
   on `SUBMITTED` rows, flip to `RUNNING`, and execute `run_agent_job`
   in-process. Worker count scales independently of web replicas
   (`GRID_RESEARCH_WORKERS` per container × containers).
3. **Cancellation is a status flip.** The runner's existing
   `CancellationMonitor` (1 s DB poll) already honors INTERRUPTED — with no
   scheduler future involved, cancel works from any replica by updating the
   row. The `_cancel_dask_task` path is deleted.
4. **Crash recovery via heartbeat reclaim.** Keep the 30 s heartbeats; a
   reaper (any worker, advisory-locked) returns stale `RUNNING` rows to
   `SUBMITTED` up to `max_attempts` (resume-by-rerun; deep runs are
   idempotent from the user's perspective — the report is regenerated).
5. **SSE/event streaming is unchanged** — it already reads
   `job_events`/LISTEN-NOTIFY from shared Postgres, never the Dask layer.
6. `entrypoint.py` stops spawning `dask-scheduler`/`dask-worker`; the
   sync-fallback path (no scheduler configured) remains for dev.

## Consequences

### Positive

- Jobs pool across workers; web replicas become genuinely stateless for
  execution; cancel and status work from anywhere; restarts re-queue instead
  of ghost-failing.
- One process model (uvicorn) per web container; the worker is a plain
  container that scales horizontally.
- Removes a whole distributed system (Dask) from the operational surface.

### Negative

- We own claim/heartbeat/reclaim logic (mitigated: the purger is a proven
  in-repo template, and half of it — heartbeats, status polling, reaping —
  already exists in the runner).
- Polling latency for job pickup (seconds; acceptable for multi-minute runs;
  LISTEN/NOTIFY can remove it later).

### Risks

- **NAT coupling:** `JobStore.submit_job` couples persistence to Dask
  submission today; the worker must reuse NAT's `job_info` semantics without
  the scheduler. Spike this boundary first — it is the main unknown and the
  reason this ADR ships before the code.
- **Double execution** on botched reclaim — prevented by attempts + stale
  windows exactly as in the purger; the runner's status checks make a zombie
  run terminate on its next poll.

## Alternatives Considered

- **External shared Dask cluster** — pools capacity with a smaller diff, but
  keeps Dask as an HA component, keeps cancel coupled to scheduler futures,
  and still needs every part of the queueing/backpressure work. Rejected.
- **Celery/RQ + Redis broker** — reintroduces a broker for a workload
  Postgres already serializes correctly; job state would live in two places.
  Rejected (consistent with the scaling review's no-broker verdict).
- **Status quo + sticky routing** — pins conversations *and* jobs to
  replicas, turns every deploy into job loss, and leaves cancel broken
  cross-replica. Rejected.

## Open Questions / Follow-ups

- Spike: run `run_agent_job` under a claimed row without `JobStore.submit_job`
  (NAT boundary above).
- Worker sizing default (`GRID_RESEARCH_WORKERS`) vs. the per-run
  `max_research_concurrency` fan-out — one worker ≈ one deep run is the
  starting point.
- Migration: ship workers alongside Dask behind `GRID_JOB_EXECUTION=db|dask`,
  flip the default, delete the Dask path.

## References

- `frontends/ui/purger/db.js` (claim pattern), `frontends/aiq_api/src/aiq_api/jobs/runner.py`
  (heartbeats, CancellationMonitor), `deploy/entrypoint.py` (Dask spawn)
