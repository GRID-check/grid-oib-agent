# The API plugin: `frontends/aiq_api`

The backend's FastAPI front end, loaded by NAT as a front-end plugin
(`_type: aiq_api`): REST routes, the async job API with SSE streaming, and
`/v1/ingest`. A uv workspace member, installed into the same venv as the agent.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add a route | Put it in `src/aiq_api/routes/` and register it in exactly one role's list in `plugin.py`: `api_routers` / `API_APP_REGISTRARS` for `api`, `CHAT_ROUTERS` for `chat` (ADR-0082). Almost every route is `api`'s; `chat` serves the socket and what KEDA reads from it | `tests/test_roles.py`: a router under `routes/` that no role mounts, or both do, fails it. Without the list, the route exists and nothing serves it |
| Accept a request | Authenticate through `auth/middleware.py`; the validator is resolved from the `aiq_api.validators` entry point, not imported | The WorkOS validator is pluggable on purpose (ADR-0002). A direct import hard-wires identity into the API tier |
| Add a job phase | Emit it through `jobs/phase_events.py` so the SSE stream and the event store agree | The UI's progress display and the stored history diverge, and only one of them is replayable |
| Store job payloads | Go through `jobs/payload_crypto.py` | Job payloads carry tenant content into a shared store |
| Change job execution | Respect `GRID_JOB_EXECUTION=db\|dask`; both paths must work (ADR-0021), though dask works inside one process only: the `chat` role submits jobs that the `api` role streams and cancels (ADR-0082), so every deployment that runs both runs `db` | The default is `dask`; a change tested only on the db path ships broken for everyone |

## Rules that need more than a row

**This tier is stateless about identity and trusting about tenancy.** It
validates the JWT and reads the context headers; it does not look up who you
are. The BFF decided that (ADR-0003, ADR-0007). Anything that needs to *decide*
access belongs in the BFF, not here.

**Job workers are claimed in the database, not assigned.** Both queues are
tables on one claim, `aiq_agent.common.claim_queue` (ADR-0079): fewest running in
the lane (the organization) fleet-wide first, then the lane served longest ago,
then `interactive` before `bulk`, then oldest; a heartbeat, a reclaim of stale
claims, `release_claims` on a drain (no attempt spent), and `dead` rows kept as a
trace instead of a `DELETE`. A change to the order, the heartbeat or the dead
rows is made there, once. `jobs/queue.py` and `jobs/worker.py` are research's
table, encrypted payload and poison verdict on it; the reaper and the checkpoint
retention sweep assume it. Ingestion claims from its own table,
`aiq_agent.knowledge.ingest_queue`; `jobs/ingest_dispatch.py` puts jobs there and
`jobs/ingest_worker.py` is its dedicated tier, the only process that claims
(ADR-0076): the `chat` and `api` roles enqueue and never claim. New work of either kind
joins by claiming through its queue, never by an in-process pool alone.

**Research waits, it is not refused.** With `GRID_JOB_EXECUTION=db` capacity
never makes `jobs/submit.py` raise: `GRID_MAX_ACTIVE_JOBS` is a Dask-only cap,
`GRID_MAX_ACTIVE_JOBS_PER_ORG` is the claim's per-lane cap (read by the worker),
and the one 429 left is `GRID_MAX_QUEUED_JOBS_PER_ORG`, abuse protection on how
many jobs one organization may have waiting. A scheduled fire is `bulk`. Do not
turn a full cluster back into a refusal: a scheduled task that meets one is
skipped, not retried.

## Reference

- [`README.md`](README.md) here has the run commands and the layered
  architecture diagram.
- Endpoint contracts: [`docs/api/python-endpoints.md`](../../docs/api/python-endpoints.md).
- ADR-0021 (db-claimed workers), ADR-0018 (per-run state), ADR-0028 (conversation affinity).
