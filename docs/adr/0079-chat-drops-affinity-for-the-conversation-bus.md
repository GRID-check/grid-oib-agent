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
  grace period ends; relays on other replicas keep streaming them. A replica killed
  mid-turn loses that turn's live stream exactly as a restart does today; the
  persisted answer and the checkpoint stay the source of truth (ADR-0020).
* **One running turn per conversation, fenced.** Today a newer question
  starts its turn and then publishes `SUPERSEDE` best-effort, which is safe only
  while affinity keeps both turns in one process. With affinity off they can
  run on two replicas and write one LangGraph thread. So the owner holds a
  conversation-level running marker (`conv:<id>:running`, its replica and turn
  id, with a TTL it renews while the turn runs and deletes when the turn ends).
  A new turn first publishes `SUPERSEDE`, then waits, bounded, for the marker to
  clear or to name itself, and only then claims and runs. If the marker does not
  clear in time the question is refused as "still finishing the previous
  answer", never run concurrently. A marker whose owner died expires with its
  TTL. With the bus down the fence fails open only while affinity is on.
* **The owner fences itself.** A marker can be lost while its owner still runs
  (a renewal that finds it gone, or Dragonfly unreachable from that replica for
  longer than the TTL). The owner then cancels its own turn, through the same
  path a cancel takes, so it ends with a terminal and writes nothing after a
  new turn could have started. With affinity on the fence fails open, as the
  bus does, because affinity already keeps both turns in one process.
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
  with a relay that stays idle across turns, an owner that drains mid-turn,
  a second question on another replica while a turn runs (the new turn starts
  only after the old one stopped, or is refused), two turns racing from an
  empty marker (one enters LangGraph), and an owner that keeps running past its
  marker's expiry (it is cancelled and never writes after the new turn starts).
* Multi-replica behaviour against real Dragonfly: nothing enforces this yet;
  review is the only gate. The dev-cluster validation above is the step that
  closes it, before prod's flag changes.

## More Information

* Completes the rollout ADR-0028 describes ("remove affinity from `server.js`").
* ADR-0020 (Dragonfly is cache-only), ADR-0039 (spectators on the bus),
  ADR-0078 (claim substrate), ADR-0080 (provider limiter).
* Open gap: a check against a real Dragonfly for the multi-replica path, run in
  CI or as a dev-cluster smoke test.
* Where it lives: the BFF's routing rule is `frontends/ui/src/lib/proxy/backend-target.js`;
  the running marker is `ConversationBus.acquire_running` and
  `ChatRegistry.hold_conversation` (`GRID_CHAT_RUNNING_TTL_SECONDS`,
  `GRID_CHAT_SUPERSEDE_WAIT_SECONDS`); the drain is `drain_chat_turns`
  (`GRID_CHAT_DRAIN_SECONDS`); the scaling signal is
  `GET /v1/internal/chat-occupancy` (`turn_admission.active_turns`); the
  ScaledObject is `deploy/pulumi/src/app/backend-scaling.ts`.
* How the owner fences itself: `aiq_api/turn_fence.py` holds the deadline,
  `ChatRegistry.keep_conversation` renews and cancels, and every write path
  asks it first (`aiq_agent/common/write_fence.py`; the checkpointer is wrapped
  by `FencedCheckpointer`, the frames by `TurnWire`, the outcome by
  `persist_turn_result`). The deadline is the start of the last successful
  renewal plus the TTL minus a margin, and each guard compares
  `time.monotonic()` with it directly, so a renewal task that never ran cannot
  leave a stale answer. The margin is one guarded write (bounded at 3 s) plus
  1 s for the cancel and clock skew; the TTL must exceed it. The persist of the
  outcome is checked but not cut short: it is the turn's own message row, which
  cannot collide with a newer turn's. A marker deleted before its TTL (a
  Dragonfly that lost its data) can be taken at once and no local clock sees
  it; the renewal's `False` fences the turn the next time it runs.
* The TTL trade-off. A longer `GRID_CHAT_RUNNING_TTL_SECONDS` rides out longer
  Dragonfly blips (the window is the TTL minus 4 s) and costs a longer wait
  behind a replica that died mid-turn, which must stay under
  `GRID_CHAT_SUPERSEDE_WAIT_SECONDS` and so under the client's 15 s
  acknowledgement bound. 12 s keeps the wait at 13.5 s, rides out a 5 s blip
  whatever the renewal phase, and renews four times per TTL.
* One difference from the order written above: the turn id is claimed first,
  then the marker is taken. A resent question that is a duplicate must never
  publish `SUPERSEDE`, or a late resend of an old question would stop the newer
  turn that is running. A question the fence refuses is therefore a claimed,
  finished turn (`RUN_STARTED`, then `RUN_FINISHED` with outcome `refused`, the
  wire's existing refusal shape, retry hint 5 s), not a `rejected` frame, so no
  new wire code is needed. The marker is `SET NX`, so of two questions racing
  from two replicas exactly one runs first; the renewal and the release are
  compare-and-write on the marker's own `{replica, turn_id}` value.
* A replica holds no disk state a conversation depends on: checkpoints are in
  Postgres, vectors in the shared Chroma. The one per-replica file set is the
  base-corpus admin upload (`OIB_UPLOADS_DIR` on the data PVC, kubernetes.md
  §6.4), which chat never reads. Scale-in keeps the PVC (`whenScaled: Retain`),
  so that source PDF is back when the ordinal returns.
