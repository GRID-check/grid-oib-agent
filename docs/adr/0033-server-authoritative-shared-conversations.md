# ADR-0033: Server-authoritative shared conversations (and the seam that keeps private ones local-first)

- **Status:** Accepted
- **Date:** 2026-07-29
- **Deciders:** Platform engineering
- **Related:** ADR-0009 (WebSocket-only chat transport), ADR-0028 (conversation
  affinity / conversation bus), ADR-0032 (shareable-resource model),
  ADR-0035 (notification model), ../design/collaboration-sharing-and-inbox-spec.md (CC-7…CC-11)

## Context

Chat state today is **local-first**. The Zustand chat store persists conversations,
the current conversation, pending interactions and composer drafts into browser
storage (`aiq-chat-store`), and mirrors messages to the BFF with per-message POSTs.
The server copy is what a *second device* or a wiped browser rehydrates from; the
browser copy is what the user actually looks at.

For one author that is a good design: instant, offline-tolerant, and the server never
has to be on the critical path of rendering. For two authors it is incorrect by
construction — a browser cannot know that a colleague just wrote a message, and a
cache that is also the truth has no way to learn it.

Rewriting all of chat to be server-authoritative would touch history loading,
streaming reconciliation, reconnect, optimistic echo, and deep-research resume — the
highest-traffic, most reliability-sensitive path in the product, with a large blast
radius and no benefit for the many users who never share anything.

## Decision

**We will invert the source of truth only for shared conversations, and keep the
existing local-first path for private ones, with one explicit seam between them.**

1. **A conversation is "shared" when its visibility is not `private` or it has at
   least one grant.** This is a server-computed fact delivered with the conversation.

2. **For a shared conversation the server is authoritative for the message list.**
   On open, server history is loaded and *replaces* any locally cached copy for that
   conversation. The local store remains a legitimate cache and draft store; it is
   never the truth.

3. **For a private conversation nothing changes.** The existing local-first path,
   its persistence mirroring, and its offline behaviour are untouched.

4. **The seam is a single hook.** One synchronisation hook owns "load from server,
   subscribe to updates, reconcile into the store, dedupe by message id". Components
   below it keep rendering from the store exactly as they do today, so the message
   list, streaming bubble and card renderers are unchanged.

5. **Remote insertion is deduplicated by message id**, so a participant's own message
   arriving back over the push channel does not double-render next to its optimistic
   echo.

6. **Correctness never depends on a push event arriving.** Every state a participant
   can observe is reachable by a plain fetch on open, on focus, or on poll. The push
   channel (ADR-0035) is latency, not mechanism.

7. **Observers see turn *state*, not token-level mirroring, in phase 1.** A
   participant who did not start a turn sees "Piloti is answering <name>'s question"
   and then the completed answer, driven by message-persistence events the BFF already
   owns. Token-by-token mirroring to observers would require relaying the agent's
   frames out of the Python tier and is deferred.

## Consequences

### Positive

- Multi-author threads are correct: a participant always converges to the true
  history, and cannot be shown a stale thread assembled from their own cache.
- The blast radius is bounded to shared conversations. A regression cannot reach the
  single-player path, which is the overwhelming majority of usage.
- No change to the Python tier, the WebSocket protocol, or the conversation bus.
- The seam is one hook, so the eventual "make all of chat server-authoritative"
  migration — if it ever becomes worth it — has exactly one place to change.

### Negative

- **Two behaviours in one feature.** A conversation that becomes shared changes how it
  loads. Mitigated by making the transition explicit (sharing is a deliberate user
  action) and by having both paths converge on the same store shape.
- Opening a shared conversation costs a server round-trip before the thread is
  correct, where a private one renders from cache instantly.
- Observers get a coarser live experience than the asker in phase 1 (turn state, not
  streaming text).
- **The agent WebSocket follows intent to send, not mounting, in a shared thread.**
  §7 says an observer needs no agent socket, and the Python socket registry
  (`websocket_reconnect.py`) is keyed by conversation id, so a second socket on one
  conversation replaces the first. Opening a shared thread therefore must not open a
  socket, or a reader silently takes over the asker's registration. `useWebSocketChat`
  connects on composer focus instead, and on mount only when the flag is off, when the
  server has said the thread is private, or when this browser owns an unanswered turn
  (so a refresh mid-answer still reattaches). A private thread is unchanged.

### Risks

- **Replace-on-open could discard an unsent local message** if a conversation is shared
  while the user has unsynced content. Mitigated because composer drafts are stored
  separately from messages, and message persistence is per-message rather than batched
  at the end.
- **Divergence between optimistic echo and server order.** Mitigated by ordering on
  server-assigned timestamps/sequence and deduping by id, so the worst case is a
  message settling into a different position, not appearing twice.
- A future contributor may add a chat feature that writes only to the local store and
  silently works for private threads while breaking shared ones. Mitigated by
  documenting the seam in the chat feature's own module docs and covering remote
  insertion with tests.

## Alternatives Considered

- **Make all conversations server-authoritative.** Cleanest end state, rejected for
  now on blast radius: it puts the product's most reliability-sensitive path at risk
  for users who gain nothing from it. This ADR deliberately leaves that door open.
- **Keep local-first and poll for changes.** Rejected: polling alone cannot give a
  correct thread when two people write concurrently, because the local copy still wins
  on merge and there is no ordering authority.
- **Relay the agent's streaming frames to every participant in phase 1.** Rejected as
  premature: it requires either a BFF subscriber on the agent's per-conversation bus
  channels or a Python change, and "who is asking, and the answer when it lands" is
  most of the value at a fraction of the cost. Revisit once shared threads are in real
  use.
- **A CRDT / operational-transform document model for the thread.** Rejected: chat is
  append-only. There is no concurrent edit to reconcile, so the machinery would buy
  nothing.

## Open Questions / Follow-ups

- **A pending HITL prompt is now bound to the person it was asked of** (2026-07-30).
  `_pending_interactions` was keyed by conversation id alone, so any socket registered for
  that conversation could resolve the future — in a shared conversation, a colleague
  answering a question the assistant asked somebody else. The only thing preventing it was
  the answering browser having no prompt to render, which is a UI accident and not a rule.
  The registry now stores the awaited subject beside the future and refuses a mismatch
  (bus relays and unauthenticated/service callers stay open by design, for the reasons
  given in `_may_answer_interaction`). The await is also bounded now
  (`GRID_HITL_RESPONSE_TIMEOUT_SECONDS`, default 30 min): an unanswered prompt used to pin
  the turn and its checkpoint indefinitely, released only by a *new* turn cancelling the
  stale task — and a shared thread makes that worse, since the asker can close the tab
  while colleagues keep reading. **Still open:** the prompt itself is not persisted, so an
  observer sees no card at all and the thread merely looks frozen.
- **The conversation-keyed socket registry is only mitigated, not fixed.** Driving the
  connection from intent removes the case that actually happens (a reader opening a
  thread someone else is using), but two participants who are both composing legitimately
  hold sockets on the same conversation id, and the last one to connect still wins. Fully
  closing it requires the Python tier to key `WebSocketSessionRegistry._sockets` per
  socket — `dict[str, set[WebSocket]]` — with `send`/`has_socket` fanning out to every
  socket of a conversation, `clear_socket` discarding one member instead of popping the
  entry, and the HITL/relay bookkeeping following the same shape. Deliberately not
  half-built here.
- Token-level streaming to observers (phase 2) — decide then whether the relay lives
  in the BFF (subscribing to `conv:<id>:events`) or the Python tier publishes a
  participant-addressed frame.
- Whether the private path should eventually be retired in favour of one model, once
  shared threads have proven the server-authoritative path in production.

## References

- ../design/collaboration-sharing-and-inbox-spec.md — CC-7…CC-11, §11.2
- ADR-0009, ADR-0028
