---
status: proposed
date: 2026-10-06
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Background work runs on one claim substrate, in worker pools KEDA scales on their queues

## Context and Problem Statement

ADR-0076 made ingestion fair, durable and elastic. A survey of the rest of the
system (October 2026) found the same defect ADR-0076 removed, in four other
places, and a ceiling none of the queues touch:

* **Research jobs** (`research_job_queue`, ADR-0021) claim FIFO
  (`aiq_api/jobs/queue.py`), refuse with a 429 once `GRID_MAX_ACTIVE_JOBS=8`
  are active fleet-wide (`jobs/submit.py`), and a scheduled task that meets the
  429 is skipped, not retried. The agent-worker tier scales on CPU, which an
  LLM-bound job does not move.
* **IFC extraction** runs fire-and-forget inside the BFF pod
  (`lib/documents/service.ts`, `void runBimExtraction`), unbounded, lost on
  restart, on the event loop that also proxies chat.
* **Office → PDF rendition** runs fire-and-forget in the BFF behind a
  per-process FIFO of two Gotenberg slots (`lib/documents/rendition.ts`): the
  cross-office FIFO ADR-0076 removed, standing in front of the fair queue.
* **Project reindex and "rescan failed"** walk up to ~10 000 documents inside
  one HTTP request; a request that dies half way leaves no record of which half.
* **Research report filing** renders a PDF inside the outcome callback, with no
  retry once it fails.

Inside ingestion, a drain that times out loses claims for the stale window and
burns an attempt; an office's single upload waits behind its own bulk reindex;
reaped jobs are deleted without trace; and nothing measures queue depth, wait or
429s.

## Decision Drivers

* No office waits behind another office's backlog, on any background path.
* A job outlives the process that accepted it, and a drain never costs an attempt.
* Interactive work goes before bulk work inside an office.
* Capacity follows the backlog per resource profile, without an operator.
* Every queue is measured before anyone tunes it.
* Buy the autoscaler (KEDA, already installed); do not write one.

## Considered Options

1. Raise caps and replica counts per workload.
2. One generic worker Deployment that runs every job kind.
3. **One claim substrate (fair lanes, priority, lease and heartbeat, release on
   drain, dead rows, metrics), one queue per runtime, one worker pool per
   resource profile, each scaled by KEDA on its own queue.**

## Decision Outcome

Chosen option 3.

* **One substrate per language, one algorithm.** `aiq_agent.common.claim_queue`
  holds the claim ADR-0076 proved (fewest-running lane, then lane served longest
  ago, then priority, then oldest), heartbeat, reclaim, release-on-drain without
  an attempt, and dead rows. `ingest_job_queue` and `research_job_queue` both
  run on it; their payloads and verdicts stay apart (ADR-0076). The BFF's
  TypeScript work gets `bff_job_queue` in the app database with the same
  algorithm in `lib/jobs-queue/`. Two implementations of one algorithm, in two
  databases, each tested against the same scenarios; a shared SQL function was
  rejected because the Python queues also run on SQLite in tests.
* **Pools per resource profile, not one worker.** `ingest-worker` (ingestor,
  VLM pool), `agent-worker` (NAT workflow, long drains) and `bff-jobs` (the
  frontend image, internal only, for IFC parse, rendition, reindex and report
  filing) each have their own ScaledObject on their own queue. One Deployment
  for every kind would pay the largest image, the longest cold start and the
  longest drain everywhere, and a reindex burst would take research capacity.
* **Admission waits instead of refusing.** Research jobs queue past the active
  cap; the per-organisation cap becomes a claim cap, as in ingestion. A queue
  length bound per organisation stays as abuse protection.
* **Priority is `interactive` or `bulk`.** A user's upload is interactive; a
  reindex, a rescan and a scheduled run are bulk. The lane order still decides
  between offices; priority decides inside one.
* **Measured.** OTel meters (`grid.queue.*`) through the existing collector:
  depth by status, oldest-queued age, claim latency, job duration, dead rows.
  **The gap:** the Python queues (`ingest_job_queue`, `research_job_queue`) emit
  them; `bff_job_queue` does not. The `bff-jobs` runner is a plain Node process
  that bridges logs to the collector (`observability/otel-logs.js`) but ships no
  OTLP metrics exporter, and adding one is a new dependency and lockfile change
  this decision did not take on. Until it does, the BFF queue is observed through
  the depth KEDA already counts, the `[bff-jobs] … now dead` ERROR lines (each
  one opens an issue), and a `SELECT` on the table.
* **A failed attempt costs an attempt, behind a backoff; a dead row is a trace.**
  Only a drain or a cap gives a claim back free. A handler that threw, a slice
  that timed out and a BFF that did not answer spend the attempt, and the job
  waits `GRID_BFF_JOBS_RETRY_BACKOFF_SECONDS`, doubling, before the next
  (`bff_job_queue.not_before`), so a job that always times out or kills the BFF
  ends instead of cycling, and three attempts are not burnt in the seconds one
  blip lasts. A job that goes dead keeps its reason and only the identifiers a
  sweep matches it by: its payload (a report, a requester's email and
  permissions, storage keys) is dropped, as the Python queues blank theirs. The
  row is deleted after `GRID_BFF_JOBS_DEAD_RETENTION_DAYS`, and at once with its
  project (`purger/purge-project.js`) or, when an organization purge exists, its
  organization (`eraseLane`).
* **A walk runs as the person's rights of today.** A job can wait, and a reindex
  spans many slices, so `reindex_project` and `reingest_failed` resolve the
  requester's membership and role again before every slice
  (`resolvePinnedRequesterSession`) and the rescan re-checks `org:settings:manage`.
  A role revoked, or a person who left, ends the job quietly. A reader's
  filing of a finished report asks for permission when the request is made, so a
  refusal is the answer they get rather than a job that is refused on every read.
* **The scaler reads a count, not rows.** KEDA's login holds SELECT on the
  `status` column of each queue table and nothing else, so a leaked DSN cannot
  read a payload.
* Chat scale-out and the provider ceiling are the two neighbouring decisions
  the same survey produced: ADR-0079 and ADR-0080. The implementation plan
  below covers all three, because they ship together.

### Consequences

* Good, because every background path inherits ADR-0076's fairness and
  durability instead of re-deriving it.
* Good, because the chat pod stops parsing IFC and waiting on Gotenberg.
* Good, because a scheduled task is never skipped for a full queue again.
* Bad, because the claim algorithm exists in Python and TypeScript; the shared
  scenario tests are what keep them one algorithm.
* Neutral: three ScaledObjects and one more Deployment for KEDA to watch.

## Implementation plan

Phase 1, in parallel:

1. **Python substrate + ingestion hardening.** `claim_queue`; ingestion on it;
   `priority`; release claims on drain; maximum job runtime and a progress
   heartbeat; dead rows instead of `DELETE`; one per-organisation cap name;
   queue meters. `/v1/ingest` accepts `priority: "interactive" | "bulk"`
   (default `interactive`).
2. **Provider limiter.** `provider_limiter` with priority classes and AIMD,
   wrapped around the single LLM and embedding choke points; embeddings gated
   with 429 backoff; limiter meters.
3. **BFF job substrate.** `bff_job_queue` (drizzle migration), the TypeScript
   claim, the `bff-jobs` Deployment and its ScaledObject; project reindex and
   rescan-failed become jobs that enqueue `priority: "bulk"` ingests.
4. **Chat scale-out.** Affinity off behind `GRID_CHAT_AFFINITY` (on by
   default), the occupancy endpoint, drain, a ScaledObject for the backend.

Phase 2, on the merged result:

5. **Research on the substrate.** Fair claim, wait-not-reject admission,
   scheduled fires no longer skipped, agent-worker on KEDA instead of the CPU
   HPA.
6. **BFF job kinds.** IFC extraction, background rendition and report filing
   move onto `bff_job_queue`; interactive preview rendition stays on request.

Phase 3:

7. **KEDA hardening across every ScaledObject.** Pinned chart, `fallback`,
   read-only scaler roles, grace = drain + 30 s, queue tables created before
   the scaler reads them, ingest `maxReplicas` asserted against the provider
   ceilings, stale numbers in `kubernetes.md` corrected.

### Confirmation

Each workstream lands with its tests; the claim scenarios run against both
substrates; `task verify` passes on the merged branch.

## More Information

* ADR-0021 (DB-claimed research workers), ADR-0040 (layered rate limiting),
  ADR-0076 (fair ingestion queue), ADR-0079 (chat scale-out), ADR-0080
  (provider limiter).
* `docs/architecture/rate-limiting-and-load-protection.md`, whose L3 and L3b
  this extends.
