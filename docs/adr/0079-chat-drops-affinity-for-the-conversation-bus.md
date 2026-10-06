---
status: proposed
date: 2026-10-06
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Chat drops conversation affinity for the conversation bus, and the backend scales on turn occupancy

## Context and Problem Statement

ADR-0028 made `aiq-agent` safe at N replicas by pinning each conversation to
`hashToIndex(conversationId, BACKEND_REPLICAS)` in the BFF's WebSocket proxy.
The hash makes the replica count part of the routing: changing it remaps live
conversations, so `BACKEND_REPLICAS` is a static environment value, the tier
cannot autoscale, and prod runs one replica behind a fleet-wide cap of 24
active turns (`turn_admission.py`). For thousands of offices this is the
ceiling, ahead of any worker tier (ADR-0078).

ADR-0028 also built the way out, and it is on by default
(`GRID_CONVERSATION_BUS=1`): the conversation bus
(`aiq_api/conversation_bus.py`). The replica that receives a question claims
the turn cluster-wide (`claim_turn`, `SET NX` on `conv:<id>:turn:<turn>`) and
becomes its **owner**: it holds the LangGraph task and the clarifier future and
publishes every frame to `conv:<id>:events` and the replay stream. Any replica
holding a socket for the conversation is a **relay**: it writes those frames to
its socket and hands clarifier answers, cancels and supersedes to the owner on
`conv:<id>:input`. ADR-0028 names the remaining step: validate it across
replicas on a real cluster, then remove affinity from `server.js`. Affinity is
now the only thing keeping the replica count static.

## Decision Drivers

* A running turn never moves; it finishes on the replica that claimed it.
* Adding or removing a replica does not disturb any other conversation.
* The tier scales on what limits it (turns in flight), not on CPU.
* No new ownership mechanism beside the one the bus already has.
* Prod changes behaviour only after the multi-replica path is proven on dev.

## Considered Options

1. Keep the hash and raise the static replica count by hand.
2. A per-conversation owner lease in Dragonfly that the BFF routes by.
3. Remove affinity: route sockets to the load-balanced service and let the
   bus's per-turn claim decide ownership.

## Decision Outcome

Chosen option 3.

* **Routing.** Behind `GRID_CHAT_AFFINITY` (on by default, so prod is
  unchanged until it is switched off), the BFF stops computing a pod from the
  conversation id and proxies the socket to the `aiq-agent` Service. With the
  flag on, routing is today's hash, byte for byte.
* **Ownership is per turn, not per conversation.** There is nothing to keep
  alive between turns: an idle socket on any replica is a relay that holds a
  subscription and no lease. The next question claims its own turn on the
  replica that receives it. This is why option 2 is unnecessary: a
  conversation-level lease would need renewing from relays, and would duplicate
  the claim the bus already makes.
* **A replica that loses readiness keeps its turns.** A terminating or
  not-ready replica stops receiving new sockets (Service endpoints drop it) but
  goes on running and publishing the turns it claimed until they finish or its
  grace period ends; relays on other replicas keep streaming them. A newer
  question for the same conversation, arriving anywhere, supersedes the stale
  turn through the input channel (`SUPERSEDE`), which is the existing fence: the
  old owner stops, the new turn runs where it was claimed. A replica killed
  mid-turn loses that turn's live stream exactly as a restart does today; the
  persisted answer and the checkpoint stay the source of truth (ADR-0020).
* **Scaling signal.** The fleet-wide active-turn count Dragonfly already holds
  for admission, served by an internal backend endpoint any replica can answer,
  read by KEDA's `metrics-api` scaler, beside a CPU trigger. Scale-in is slow
  and drains: the grace period covers the longest turn the admission lease
  allows.
* **Gate.** Prod keeps the flag on and `maxReplicas` at 1 until the
  cross-replica path (reconnect, clarifier round trip, cancel, supersede, a
  replica draining mid-turn) is validated against Dragonfly on the dev cluster
  with the flag off and at least two replicas.

### Consequences

* Good, because the backend can autoscale without touching live conversations.
* Good, because sockets spread across replicas independently of turns.
* Good, because no ownership mechanism is added; the one ADR-0028 tested is used.
* Bad, because with affinity off every turn's frames cross Dragonfly pub/sub
  unless owner and relay coincide. The bus already fails open to local delivery.
* Neutral: `BACKEND_REPLICAS` survives only for the flag-on path.

### Confirmation

* Unit: the BFF routes by hash with the flag on and to the Service with it off;
  the backend's occupancy endpoint and drain; the Pulumi ScaledObject spec.
* Protocol: the bus's existing two-replica tests (`test_conversation_bus.py`,
  `test_websocket_bus_wiring.py`, `test_conversation_bus_redis.py`), extended
  with a relay that stays idle across turns and an owner that drains mid-turn.
* Multi-replica behaviour against real Dragonfly: nothing enforces this yet;
  review is the only gate. The dev-cluster validation above is the step that
  closes it, before prod's flag changes.

## More Information

* Completes the rollout ADR-0028 describes ("remove affinity from `server.js`").
* ADR-0020 (Dragonfly is cache-only), ADR-0039 (spectators on the bus),
  ADR-0078 (claim substrate), ADR-0080 (provider limiter).
* Open gap: a check against a real Dragonfly for the multi-replica path, run in
  CI or as a dev-cluster smoke test.
