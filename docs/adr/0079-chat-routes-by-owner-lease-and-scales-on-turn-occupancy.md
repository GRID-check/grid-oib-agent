---
status: proposed
date: 2026-10-06
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Chat routes a conversation by an owner lease, and the backend scales on turn occupancy

## Context and Problem Statement

ADR-0028 made `aiq-agent` safe at N replicas by pinning each conversation to
`hashToIndex(conversationId, BACKEND_REPLICAS)`, because a conversation's
WebSocket session, clarifier futures and running LangGraph task live in one
process. The hash makes the replica count part of the routing: changing it
remaps live conversations, so `BACKEND_REPLICAS` is a static environment value,
the tier cannot autoscale, and prod runs one replica behind a fleet-wide cap of
24 active turns (`turn_admission.py`). For thousands of offices this is the
ceiling, ahead of any worker tier (ADR-0078).

## Decision Drivers

* A live conversation never moves while it has in-process state.
* Adding or removing a replica does not remap any other conversation.
* The tier scales on what limits it (turns in flight), not on CPU.
* A Dragonfly outage degrades to today's behaviour, not to an outage.

## Considered Options

1. Keep the hash and raise the static replica count by hand.
2. Consistent hashing over the ready replicas.
3. An owner lease per conversation in Dragonfly, assigned on first connect.
4. Move turn state out of process (checkpoint every await) and route anywhere.

## Decision Outcome

Chosen option 3.

* The BFF resolves a conversation's owner from `chat:owner:<conversationId>`.
  When none exists it picks the ready replica with the fewest active turns and
  sets the lease; the owning backend renews it while the conversation has a
  socket or a running turn, and it expires a TTL after both end.
* A replica that is gone (lease points at a pod that no longer resolves or is
  not ready) is replaced by a fresh assignment, which is what a restart costs
  today.
* With Dragonfly unavailable the BFF falls back to the ADR-0028 hash over the
  configured replica count.
* The scaling signal is the fleet-wide active-turn count Dragonfly already
  holds for admission, served by an internal backend endpoint that any replica
  can answer, read by KEDA's `metrics-api` scaler. Scale-in is slow and
  drains: a terminating replica stops accepting new owners and waits for its
  turns.
* Option 2 still moves a share of live conversations on every scale event.
  Option 4 is the right end state and a rewrite of the turn runtime; it is not
  needed to scale out.

### Consequences

* Good, because the backend can autoscale without touching live conversations.
* Good, because new conversations land on the least-busy replica.
* Bad, because routing now reads Dragonfly on connect; the fallback keeps that
  from becoming a dependency for availability.
* Neutral: `BACKEND_REPLICAS` survives only as the fallback's modulus.

### Confirmation

BFF routing tests for assign, reuse, dead-owner reassignment and the Dragonfly
fallback; backend tests for lease renewal and drain; a Pulumi spec for the
ScaledObject.

## More Information

* Supersedes the routing part of ADR-0028; the per-pod DNS and headless service
  it introduced stay.
* ADR-0078 (claim substrate), ADR-0080 (provider limiter).
