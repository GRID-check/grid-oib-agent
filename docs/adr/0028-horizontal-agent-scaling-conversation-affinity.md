# ADR-0028: Horizontally scaling the aiq-agent container via conversation affinity

- **Status:** Accepted
- **Date:** 2026-07-22
- **Deciders:** Platform engineering
- **Related:** ADR-0021 (DB-claimed workers), ADR-0020 (Dragonfly shared cache),
  docs/architecture/scaling-review-2026-07-phase2.md (chat P0)

## Context

The `aiq-agent` container hosts the interactive chat / shallow-researcher path
over WebSocket. The scaling review found it was **not** safe to run at
`backendReplicas > 1`: the WebSocket session registry, human-in-the-loop
(clarifier) futures, and the running LangGraph task are held **in process**
(`frontends/aiq_api/.../websocket_reconnect.py`), with no cross-replica
mechanism. The frontend proxied every WS to the load-balanced ClusterIP
(`aiq-agent:8000`), so a reconnect or HITL turn could land on a *different*
replica than the one running the conversation and silently fail to reattach.
Defaulting to 1 replica made that honest but gave up horizontal scale — which is
the whole point of the tier.

## Decision

Run `aiq-agent` at N replicas with **conversation affinity**: the frontend WS
proxy pins each conversation to a single owning replica by a stable hash of
`conversationId`, so the in-process state is always reachable **without
rewriting the backend**.

- **Per-pod DNS:** the `aiq-agent` StatefulSet gets a **headless governing
  service** (`aiq-agent-headless`, `clusterIP: None`, `publishNotReadyAddresses:
  true`) so pods resolve as `aiq-agent-<i>.aiq-agent-headless:8000`
  (`deploy/pulumi/src/app/backend.ts`).
- **Routing:** the frontend gateway (`frontends/ui/server.js`) computes
  `pickBackendWsTarget(conversationId)` = `aiq-agent-<FNV1a(conversationId) % N>`
  and proxies the WS there. It falls back to the load-balanced `BACKEND_URL`
  when N ≤ 1, no pod template is configured, or there is no `conversationId`, so
  single-replica behavior is unchanged.
- **Wiring:** Pulumi passes `BACKEND_REPLICAS` and `BACKEND_POD_WS_TEMPLATE`
  (`ws://aiq-agent-{i}.aiq-agent-headless:8000`) to the frontend
  (`deploy/pulumi/src/app/config.ts`); `backendReplicas` defaults to 2 again.

## Consequences

### Positive
- The chat tier genuinely scales horizontally: N replicas each own ~1/N of
  conversations; load and memory distribute. Reconnect + HITL work because a
  conversation always returns to its owner.
- No change to the backend's in-process state model — low blast radius, ships now.

### Negative / accepted tradeoffs
- **Not fully stateless.** If a replica restarts, the *live streams* for its
  slice of conversations drop; the next turn reloads history from the Postgres
  checkpoint (only the in-flight stream / in-flight HITL prompt is lost — the
  same failure mode as a single-replica restart, now scoped to 1/N of users).
- **Scaling the replica count reshuffles the hash**, so some conversations move
  owners; their next turn reloads from checkpoint (no data loss, a dropped live
  stream at the scale event). Acceptable; prefer scaling at low-traffic windows.
- Affinity concentrates a hot conversation on one replica (no in-conversation
  parallelism) — fine, a conversation is inherently sequential.

### The fully-stateless target — IMPLEMENTED (gated)
The robust end state is a **Dragonfly (Redis) pub/sub event bus**, and it is now
implemented (`frontends/aiq_api/src/aiq_api/conversation_bus.py` + the
`WebSocketSessionRegistry` wiring): the replica running a turn (the **owner**,
which keeps the loop-bound HITL future + LangGraph task) publishes streaming
frames to `conv:<id>:events`; any replica holding the client's WS (the **relay**)
subscribes and writes them to the socket; HITL answers round-trip on
`conv:<id>:input`, where the owner's subscriber resolves its future. A bounded
Redis stream (`conv:<id>:stream`) buffers frames for reconnect replay
(best-effort — the Postgres checkpoint stays source of truth, ADR-0020). This
removes the affinity pin: **any replica serves any conversation**, and a relay's
death just means the client reconnects elsewhere while the owner keeps
publishing.

**Gating & rollout.** The bus is OFF by default — with `GRID_CONVERSATION_BUS`
unset it uses an in-process transport, so single-replica / current behavior is
byte-identical (and every existing WS test passes unchanged). It activates only
when `GRID_CONVERSATION_BUS=1` **and** `REDIS_URL` are set. The safe flip is:
(1) deploy with the bus enabled but affinity still on (co-located owner==relay —
bus is exercised, harmless); (2) live-validate cross-replica reconnect + HITL;
(3) remove affinity from `server.js` (route WS to the plain load-balanced
`aiq-agent` service) so sockets spread independently of turn ownership. Owner
election (`SET NX EX` on `conv:<id>:owner`) prevents two replicas running one
conversation once affinity is off.

### Validation
The bus protocol and the registry wiring are unit-tested over an in-memory
transport with two `ConversationBus` instances standing in for two replicas
(fan-out ordering, HITL round-trip, supersede/cancel, reconnect replay, exclusive
owner election, fail-open; `test_conversation_bus.py`, `test_websocket_bus_wiring.py`).
Affinity logic is a pure function with a safe fallback; the Pulumi program
typechecks and `server.js` parses. **Still needs live validation before the
affinity-off flip:** true cross-replica reconnect end-to-end, Dragonfly pub/sub
semantics under eviction, HITL races, and owner-key expiry vs. heartbeat timing.
