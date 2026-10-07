---
status: proposed
date: 2026-09-30
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Ingestion is claimed fairly from a durable queue, by a tier that scales on its depth

## Context and Problem Statement

Every ingestion job ran in one in-memory `ThreadPoolExecutor` per backend
process: `AIQ_INGEST_MAX_WORKERS=2`, FIFO across every tenant. Prod runs one
backend replica, so the platform indexed two documents at a time, in arrival
order. One office's folder upload or project reindex of a few hundred plan sets
put every other office's single upload behind it for hours. A restart lost the
whole queue: each job was settled `failed: interrupted` and had to be re-sent.
Nothing could add capacity except a bigger backend pod, which is also the chat
pod.

The product has to serve thousands of offices on this path.

## Decision Drivers

* No office waits behind another office's backlog, at any fleet size.
* Idle capacity is used: an office alone on the platform gets every worker.
* A job outlives the replica that accepted it.
* Capacity follows the backlog without an operator, and costs nothing while
  there is none.
* More workers must not turn into more upstream 429s: every ingest call shares
  one OpenRouter key with chat.
* Buy the autoscaler; do not write one.

## Considered Options

1. Raise `AIQ_INGEST_MAX_WORKERS` and the backend replica count.
2. A per-organisation FIFO in each process (fair share inside one pod only).
3. A durable Postgres claim queue with a fair claim order, a dedicated worker
   tier, and KEDA scaling that tier on the queue's depth.
4. A message broker (RabbitMQ, SQS) with a queue per organisation.

## Decision Outcome

Chosen option 3, because it is the only one that is fair across the fleet,
durable and elastic at once, and it reuses the claim pattern the research queue
has run in production since ADR-0021.

* **The claim order is the fairness.** A free worker takes the next job of the
  lane (organisation) with the fewest jobs running fleet-wide, then the lane
  served longest ago (`ingest_lane_turns`), then the oldest job. It is
  work-conserving: a lone office uses every worker, and a newcomer's job takes
  the next worker that frees up. `GRID_INGEST_MAX_PER_ORG` adds a hard cap and
  is off by default, because a cap idles workers when one office is alone.
  The same order runs inside each process for jobs with local files
  (`ingest_scheduler.FairIngestScheduler`).
* **The queue is `ingest_job_queue`, beside `ingest_jobs`**, not a row type in
  `research_job_queue`. Research claims FIFO with a `run_agent_job` payload and
  a `job_info` verdict. Ingestion needs a different order, runs inside the
  ingestor's threads and reports through `ingest_jobs`. The claim, heartbeat,
  reclaim and reap are the research queue's pattern (`FOR UPDATE SKIP LOCKED`,
  stale heartbeat, three attempts), now one implementation both queues share:
  `aiq_agent.common.claim_queue` (ADR-0079), with a table of its own each.
* **A claim ranks lanes, not jobs.** Ranking every queued job cost ~165 ms per
  claim at 100 000 queued jobs across 2 000 organisations (Postgres 16, local).
  Ranking one row per lane, then taking the best lanes' best jobs through the
  `(lane, priority, created_at)` index, costs ~43 ms p50 and ~62 ms p95 at the
  same backlog (re-measured with the priority column, ADR-0079: ~36 ms p50,
  ~42 ms p95 on a quieter machine).
* **A queued job is waiting, not lost.** The status store never settles a job
  as interrupted while the queue still holds it (`_stale_predicate`).
* **The payload is encrypted** with `GRID_JOB_PAYLOAD_KEK`, because it carries
  presigned URLs. Every URL passes the SSRF gates again when a worker reads it,
  because without a KEK a queue row is plaintext anyone who can write the table
  can forge.
* **The tier scales on the queue.** `GRID_ROLE=ingest-worker` runs
  `aiq_api.jobs.ingest_worker`. KEDA's `postgresql` trigger counts the rows of
  `ingest_job_queue` that are not `dead` (a dead row is kept as a trace, and is
  no work) and asks for ceil(jobs / concurrency) replicas. It scales
  out at once and in one pod a minute, down to zero where the floor is zero.
  The cluster-autoscaler adds nodes for Pending replicas (docs/deployment/
  kubernetes.md). CPU cannot drive this tier: a job mostly waits on the provider.
* **The provider sees a fixed ceiling, not the worker count.** Every vision
  call holds one of `AIQ_VLM_FLEET_CONCURRENCY` fleet-wide slots, a lease pool
  on Dragonfly (`common.lease_slots`, the chat admission's scripts). A 429 waits
  out its `Retry-After`, or 2, 4, 8 … s, outside the slot.

Options 1 and 2 keep the queue in memory and fair only per pod. Option 4 adds a
stateful service to run, back up and secure. It buys nothing Postgres does not
already give at this volume: a few claims per second.

### Consequences

* Good, because an office's upload waits for at most one job to finish, not
  for another office's backlog.
* Good, because a job survives a deploy or a crash, and is claimed again up to
  three times.
* Good, because the web tier no longer runs ingestion when the tier is on, so
  a PDF's parse no longer shares the chat pod's CPU and GIL.
* Good, because KEDA also brings `external.metrics.k8s.io`, which the frontend's
  WS-connection scaling (kubernetes.md §6.5) was waiting on.
* Bad, because KEDA is a new cluster component to upgrade and watch.
* Neutral: the per-lane cap is hard, at a price. Two claims racing past it
  both commit, then each checks again under a per-lane advisory lock and the
  later check gives its job back. A worker that gives one back has spent a
  claim round trip for nothing. (A check ranked by claim time let three
  through a cap of two in the race test: transaction start order is not
  commit order.)
* Neutral: a worker that loses its claim mid-run (it stalled past the stale
  window and another worker took the job) asks the database before reading
  each file and again before writing its chunks, and stops with nothing more
  written. The new owner indexes the file once. A file already written in the
  same job before the loss is written again by the new owner; re-indexing
  replaces a file's chunks, so that costs time, not correctness.
* Neutral: a job whose document was deleted while it waited asks the BFF before
  reading each file and skips it, so the queue widening the window across
  restarts costs no download, OCR or vision calls. The check after indexing
  (`_deleted_while_indexing`) still catches a delete that lands mid-run.
* Neutral: an office sees its place in the queue ("Wartet · 3 Dateien davor"),
  counted among its own jobs only (`ingest_queue.ahead_in_lane`, stamped as
  `metadata.queue_ahead` on the batch status). That is the one order the queue
  promises: inside a lane it claims by priority (`interactive` before `bulk`,
  ADR-0079), then oldest first, across lanes it interleaves,
  so no other office's backlog stands in the count. It cannot say how long the
  wait is, because that depends on how many lanes are busy when each job is
  claimed.
* Neutral: a job that fails every claim is no longer deleted. Its row becomes
  `dead` with a reason (kept 14 days), so the status store settles it
  `failed: interrupted` as before and the cause stays inspectable. A worker
  that must exit gives the claims it still holds back at no cost in attempts
  (ADR-0079), instead of leaving them for the stale window.

### Confirmation

* The claim order: `tests/knowledge_layer_tests/test_ingest_queue.py`, on
  SQLite and, with `AIQ_TEST_POSTGRES_URL`, on Postgres, including eight racing
  workers that must never claim one job twice.
* The in-process order: `tests/aiq_agent/knowledge/test_ingest_scheduler.py`.
* The payload and the worker: `frontends/aiq_api/tests/test_ingest_dispatch.py`,
  including forged rows that must be refused.
* The wiring: `deploy/pulumi/src/app/ingest-worker.spec.ts` reads the Python
  sources, so the env names and the table KEDA counts cannot drift.
* The lost claim and the deleted document:
  `tests/knowledge_layer_tests/test_reingest_replaces_versions.py`
  (`…_lost_its_claim_stops_before_writing`, `…_is_not_read_at_all`) and the
  dispatch guard in `frontends/aiq_api/tests/test_ingest_dispatch.py`.
* The place in the queue: `test_a_waiting_job_counts_only_its_own_offices_jobs_ahead`
  in `test_ingest_queue.py`, and the BFF's carry of it in
  `frontends/ui/src/lib/documents/reconcile-status.spec.ts`.
* The provider ceiling: `tests/knowledge_layer_tests/test_vlm_rate_limits.py`
  and `tests/aiq_agent/common/test_lease_slots.py`.

## More Information

* ADR-0021 (DB-claimed research workers), whose claim pattern this reuses.
* ADR-0040 (layered rate limiting): this is its L3 fair-share layer for
  ingestion; `docs/architecture/rate-limiting-and-load-protection.md` lists it.
* Revisit when the claim p95 crosses ~200 ms, or when claims per second reach
  the hundreds. A lane table maintained on enqueue, or a broker, is then the
  next step.
