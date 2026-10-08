---
status: proposed
date: 2026-10-06
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Backend roles are split by job, and named after it

## Context and Problem Statement

The `aiq-agent` StatefulSet (the backend's `web` role) does six jobs in one
process:

1. **Chat runtime**: the WebSocket and the running answers (stateful per
   answer, drains for as long as a turn may run, up to ~45 minutes with
   affinity off, ADR-0080).
2. **Knowledge API**: search, collections, document status, ingest enqueue.
3. **Job API**: research submit, status, SSE.
4. **LLM utilities for the BFF**: titles, summaries, consistency check,
   feedback digest, lesson distillation, skill review, note embeddings.
5. **Admin**: base-corpus upload and sync, norms, maintenance. The base corpus
   lives on a per-replica PVC (`/app/data`), the only reason the tier is a
   StatefulSet, and an upload lands on one replica's disk only.
6. **Housekeeping loops in every replica**: ghost-job reaper, event cleanup,
   checkpoint reaper, the boot-time corpus sync.

Each job has its own scaling signal, rollout cost and failure mode, yet all six
roll, scale and fail together: an API request routed to a pod that is draining
chat turns waits on that drain. And "agent" names about fifteen things (the
Python package, this pod, `agent-worker`, Piloti, the deep researcher, NAT
agents, agent groups, `AGENT_REGISTRY`, Agent Skills, ...), so the name no
longer says what a thing does.

There are three images, one per runtime (backend Python, frontend Node, web
static), which is the right granularity. The coupling is not the image but the
boot: every Python role builds the whole NAT chat workflow from the full
config, including the ingest worker, which needs only the ingestor.

## Decision Drivers

* A job's rollout, scaling and failures do not reach jobs that do not need them.
* No pod keeps files; every tier is a Deployment.
* One image per runtime stays; roles are chosen by `GRID_ROLE`, as the workers
  already are.
* Names say the job. "Agent" names only the AI agents.
* Each step is its own reversible change; nothing here blocks ADR-0079/0080.

## Considered Options

1. Keep one web role and tune it.
2. One image per role.
3. One image per runtime, one role per job, named after the job.
4. Separate services (microservices): each part its own codebase or module
   with its own API, release and data.

## Decision Outcome

Chosen option 3. Target roles of the backend image:

| Role | Jobs | Scales on |
|---|---|---|
| `chat` | 1 | active turns (KEDA, ADR-0080) |
| `api` | 2, 3, 4 | CPU / requests |
| `research-worker` (today `agent-worker`) | research jobs | research queue (ADR-0079) |
| `ingest-worker` | ingestion | ingest queue (ADR-0076) |

Housekeeping (6) becomes CronJobs on the existing `internalSweepCronJob`
pattern. The base corpus (5) moves to SeaweedFS (ADR for the object store), so
`chat` becomes a Deployment without a PVC. The frontend image keeps its own
roles (BFF, scheduler, purger, `bff-jobs`).

This is a modular monolith run as several process types (the twelve-factor
"process types" model, as Rails/Sidekiq, Django/Celery, Airflow, Temporal and
self-hosted Sentry run one image as several processes), not a split into
services. What is split is only what rolls out, scales and fails together.
The code, the release and the data stay one, and the roles do not call each
other. The HTTP APIs do not change either: the BFF already calls every route
these roles serve. Step B does add one contract, a routing and configuration
one: the BFF holds a URL for `chat` and one for `api` and must send each route
to the right one.

Option 4 was rejected for now: it buys independent releases, independent data
ownership and per-service teams, none of which this repo has (one codebase,
one team, one release, shared Postgres, Dragonfly and Chroma), and it costs
network contracts, version skew and a pipeline per service. A role becomes its
own service when one of these holds, and that is a new ADR:

* it needs dependencies or a runtime the others do not, and the shared image's
  size or boot measurably hurts it (cold start, scale from zero);
* it needs its own release cadence, or a team of its own owns it;
* it owns data no other role touches and can sit behind a stable API.

Option 2 was rejected: it multiplies builds, scans and cached layers for a size
saving nobody has measured. Role-scoped boot (each role builds only what it
uses) is the lever for cold start, to be pulled once cold start is measured.
`grid.boot.phase_seconds{role,phase}` measures it
(`aiq_agent.observability.boot_timing`): each role's `load_config`,
`workflow_build` and `ready` (process age when it can work), and the research
worker's per-job build under `role="research-job"`, which every job pays.

### Steps, in order

| Step | Change | Size |
|---|---|---|
| A1 | Housekeeping loops to CronJobs | S |
| A2 | Base corpus from the PVC to SeaweedFS, with a one-time copy | M |
| B | `api` split from `chat`: a role switch picks the routers, a new Deployment and Service, the BFF gets a chat URL and an API URL | S–M |
| C | The BFF becomes the relay, so `chat` pods hold no sockets | L |
| D | Rename: drop `aiq` from Kubernetes names and Python packages | L |

A1, A2 and B deliver the architecture and follow ADR-0079's PR. C is taken
only on evidence (sockets per pod or drain cost measured as a problem) and
after the multi-replica validation ADR-0080 gates on. D is scheduled by the
product owner.

### Consequences

* Good, because chat's long drains no longer hold the API's rollouts.
* Good, because every backend tier becomes a Deployment and no upload is lost
  to one replica's disk.
* Good, because a tier's name says what it does.
* Bad, because the BFF routes to two backend services instead of one.
* Neutral: one more Deployment of the same image.

### Confirmation

Each step adds its own gate as it lands:
- A1: `index.spec.ts` asserts that the three `housekeeping-*` CronJobs exist.
  `src/app/housekeeping.spec.ts` asserts that the CronJobs, and the Compose
  clock, call exactly the routes the backend registers. The backend has no
  loop to fall back on.
- A2: a Pulumi spec that the web role mounts no PVC.
- B: a spec that the `chat` and `api` Deployments mount disjoint route sets.

## More Information

* ADR-0076, ADR-0079, ADR-0080, ADR-0081.
* Open gap: the steps above are not yet scheduled; this record is where they
  are tracked.
