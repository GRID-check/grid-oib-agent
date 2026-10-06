---
status: proposed
date: 2026-10-06
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Every model call passes one priority-aware provider limiter that adapts to 429s

## Context and Problem Statement

Chat, research, ingestion and embeddings call models on one OpenRouter key.
Each has its own ceiling or none: chat a turn cap, ingestion a VLM lease pool
(`AIQ_VLM_FLEET_CONCURRENCY`), embeddings nothing and no 429 backoff. When the
key saturates, nothing decides that a user waiting on chat goes before a bulk
reindex, and scaling a worker tier out (ADR-0076, ADR-0078) only adds callers.

## Decision Drivers

* Under pressure, bulk work slows first and chat last.
* One ceiling for the whole fleet, whatever the replica counts.
* The ceiling follows the provider's actual behaviour, which we cannot read in
  advance and which differs by model.
* Fails open, like the other L3 layers (rate-limiting-and-load-protection.md).

## Considered Options

1. Per-workload static caps (today).
2. A fleet tokens-per-minute token bucket, per organisation or global.
3. A fleet concurrency pool with priority classes and an adaptive (AIMD) limit.
4. An egress AI gateway in front of OpenRouter.

## Decision Outcome

Chosen option 3, `aiq_agent.common.provider_limiter`.

* A Dragonfly lease pool, the scripts of `common.lease_slots`, with four
  priority classes: `chat`, `interactive`, `research`, `bulk`. A free slot goes
  to the highest class waiting; inside a class, to the longest waiter.
* The limit is adaptive, and scoped to the quota that produced the 429. A
  429 from an upstream provider (OpenRouter's error names the provider) halves
  the limit for that model only; a 429 from OpenRouter itself, which carries no
  upstream provider, is the key's limit and halves the key-wide pool. Each
  quiet interval adds one back, within a floor and a ceiling per scope. A call
  holds a slot in the key-wide pool and in its model's pool. When a 429 cannot
  be classified it counts against the model, so one model's brown-out never
  shrinks capacity for the others. The 429 itself still waits out its
  `Retry-After` outside the slot.
* The class comes from the caller's context (a ContextVar set by the chat turn,
  the research job and the ingest job, with the job's priority), so call sites
  do not pass it.
* It wraps the one seam every model call already passes (the OpenRouter seam of
  ADR-0074) and the embedding client. The VLM pool stays as ingestion's inner
  ceiling.
* Option 2 was rejected for now: output tokens are unknown until the call ends,
  so a bucket must reserve and settle; the upstream limit is unknown and moves
  by model; fairness and spend are already held by the claim order and the
  budgets (ADR-0015). Revisit if smoothing spend becomes the complaint.
* Option 4 stays the back-pocket option the rate-limiting document describes.

### Consequences

* Good, because a provider brown-out degrades bulk work, not chat.
* Good, because embeddings stop being an ungated caller.
* Bad, because every model call now makes a Dragonfly round trip; it fails open.
* Neutral: the adaptive limit needs its meters (`grid.provider.*`) to be tuned.

### Confirmation

* Unit tests for class order, FIFO inside a class, AIMD per scope (a 429 for
  one model leaves another's limit untouched), and fail-open; an integration
  test that a `bulk` waiter yields to a `chat` waiter.
* The invariant that every model and embedding call passes the limiter: a
  call-site test beside `tests/aiq_agent/common/test_openrouter_call_sites.py`
  that fails when a chat model or an embedding client is built outside the
  limited seam. Until it lands: Nothing enforces this yet; review is the only
  gate.

## More Information

* ADR-0040 (layered rate limiting), ADR-0074 (the OpenRouter seam), ADR-0076,
  ADR-0078.
* Open gap until the call-site test lands: a new model or embedding call site
  that bypasses the limiter is caught only in review.
