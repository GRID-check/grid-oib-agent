# The API plugin — `frontends/aiq_api`

The backend's FastAPI front end, loaded by NAT as a front-end plugin
(`_type: aiq_api`): REST routes, the async job API with SSE streaming, and
`/v1/ingest`. A uv workspace member, installed into the same venv as the agent.

Additive to the root [`../../AGENTS.md`](../../AGENTS.md), not a replacement: this file is only what is true here.

## Commands

```bash
task be:test:api      # pytest frontends/aiq_api/tests/
task be:verify        # lint + core suite + this suite, as CI runs them
```

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add a route | Put it in `src/aiq_api/routes/` and register it on the plugin's router in `plugin.py` | The route exists and nothing serves it |
| Accept a request | Authenticate through `auth/middleware.py`; the validator is resolved from the `aiq_api.validators` entry point, not imported | The WorkOS validator is pluggable on purpose (ADR-0002). A direct import hard-wires identity into the API tier |
| Add a job phase | Emit it through `jobs/phase_events.py` so the SSE stream and the event store agree | The UI's progress display and the stored history diverge, and only one of them is replayable |
| Store job payloads | Go through `jobs/payload_crypto.py` | Job payloads carry tenant content into a shared store |
| Change job execution | Respect `GRID_JOB_EXECUTION=db\|dask` — both paths must work (ADR-0021) | The default is `dask`; a change tested only on the db path ships broken for everyone |

## Rules that need more than a row

**This tier is stateless about identity and trusting about tenancy.** It
validates the JWT and reads the context headers; it does not look up who you
are. The BFF decided that (ADR-0003, ADR-0007). Anything that needs to *decide*
access belongs in the BFF, not here.

**Job workers are claimed in the database, not assigned.** `jobs/queue.py` and
`jobs/worker.py` implement the claim; the reaper and the checkpoint retention
sweep assume it. New work joins by claiming through the same queue.

## Reference

- [`README.md`](README.md) here has the run commands and the layered
  architecture diagram.
- Endpoint contracts: [`docs/api/python-endpoints.md`](../../docs/api/python-endpoints.md).
- ADR-0021 (db-claimed workers), ADR-0018 (per-run state), ADR-0028 (conversation affinity).
