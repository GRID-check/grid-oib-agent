# ADR-0039: Live shared turns and composing presence

- **Status:** Accepted
- **Date:** 2026-07-31
- **Deciders:** Platform engineering
- **Related:** ADR-0028 (conversation affinity / conversation bus), ADR-0033
  (server-authoritative shared conversations), ADR-0035 (notification model and the
  per-user event bus), ADR-0036 (when the agent answers in a shared thread),
  ../design/collaboration-sharing-and-inbox-spec.md (CC-9, CC-13, RT-3…RT-8)

## Context

ADR-0033 made a shared conversation converge: everyone ends up with the same
messages. It did not make it feel live. In the thread as shipped, a colleague who
is not the asker sees:

- a static banner, "Piloti is answering Anna's question…", for as long as the turn
  runs — thirty seconds for a shallow answer, minutes for a deep one;
- then the finished answer, all at once;
- and nothing at all while a colleague is typing a message.

Every one of those is *correct*. Together they are the wrong product. The asker
watches reasoning happen and text arrive; everybody else watches a spinner and
then gets handed a finished block. Two people in the same conversation are having
two different experiences of it, and the one with the worse experience is the one
who was invited.

The three specific gaps:

1. **No live answer.** The agent's frames go to the asker's WebSocket and nowhere
   else. ADR-0033 §7 named this as deferred: "mirroring the agent's frames to every
   participant needs a relay out of the Python tier."
2. **No live reasoning.** The Herleitung — which is a large part of what makes the
   product trustworthy in a regulated domain — is invisible to everyone but the
   asker, including the colleague who will have to defend the answer.
3. **No typing indicator.** The oldest affordance in group chat, and the one that
   makes a pause read as a person thinking rather than as a dead thread.

Two facts made this cheaper than it looks. First, the Python tier **already
publishes every outbound frame** to `conv:<id>:events` on Dragonfly — the
conversation bus from ADR-0028, whose day job is letting the replica holding a
socket relay frames for a turn owned by another replica. An observer wants
identical bytes for an identical reason: they do not hold the socket either.
Second, the per-user event bus from ADR-0035 already fans out to a thread's
participants, which is all a typing indicator needs.

## Decision

**We will show an observer of a shared thread the turn as it happens, and show the
thread who is composing — both as best-effort liveness layered on top of the
existing convergent paths, never as a new source of truth.**

1. **The BFF becomes one more relay on the conversation bus.**
   `GET /api/conversations/:id/live` (SSE) subscribes to `conv:<id>:events` and
   forwards the frames. The Python tier is unchanged: it already publishes at the
   single emit choke point (`WebSocketSessionRegistry.send`).

2. **Authorization for that stream is at subscribe time, and re-checked while it
   is open.** This is an explicit, narrow exception to ADR-0035 §9's "authorization
   happens at publish time", and the exception is the reason it lives in its own
   module (`lib/events/conversation-frames.ts`) rather than in `lib/events/bus.ts`.
   The publish-time argument holds for per-user channels because the server decides
   what to address to a subscriber; it does not transfer to a per-resource channel,
   which carries whatever the agent says. So: `viewer` is proven before the
   subscription opens, re-proven every 30 seconds, and a revoked grant closes the
   stream.

3. **The stream opens only for a colleague's turn, and closes when it ends.** Not
   for a private thread, not for the asker (who has the frames already), not for a
   gated org, and not between turns. A token stream is the most expensive thing in
   the collaboration feature; it exists for the ninety seconds it is worth
   something.

4. **No replay.** A subscriber sees frames from the moment it attaches. The bus's
   replay stream is per conversation rather than per turn, so replaying would mean
   deciding which buffered frames belong to the turn running *now* — and getting
   that wrong shows a colleague a stale answer under a live banner.

5. **The observer's view is read-only.** A prompt the agent puts to the asker is
   rendered as text ("Piloti asked a question and is waiting"), never as a control.
   The server refuses a colleague's answer to a prompt addressed to somebody else
   (`websocket_reconnect.py`, subject matching), so a control there would be a
   button whose every press fails.

6. **Composing presence is an event with an expiry, not a resource.**
   `POST /api/conversations/:id/typing` publishes `conversation.typing` to the
   thread's other participants and stores nothing. There is no `GET`. The claim
   carries a `ttlMs` (6s), the client republishes every 3s while typing continues,
   and a receiver stops believing it when the TTL elapses. `collaborator` is the
   bar — a viewer's draft can never become a message.

7. **Both layers degrade to exactly the previous behaviour.** No `REDIS_URL` (or an
   unreachable Dragonfly) → the live route answers `unsupported` once and closes,
   and the observer keeps the static turn banner and still gets the finished answer
   through the ordinary persisted-message path. A dropped typing event → no
   indicator, which is what there was before. Nothing in either layer is state a
   client must converge on, so spec RT-4 is untouched.

## Consequences

### Positive

- A shared thread is one conversation rather than two experiences of it. The
  observer sees the reasoning chain build and the answer arrive, which is also what
  lets them intervene *during* a turn instead of after it.
- The reasoning is visible to the person who will have to defend the answer, not
  only to whoever happened to type the question.
- No new streaming architecture: the frames are the ones already on the bus, and
  the presence events ride the channel ADR-0035 already built.
- The observer's view reuses `ChatThinking` and `MarkdownRenderer`, so the live
  Herleitung cannot drift from the asker's.

### Negative

- A second SSE connection per observer during a turn, carrying hundreds of frames.
  Bounded by the gating in (3), but it is real traffic that did not exist.
- Live spectating requires a shared cache tier. A single-node deployment without
  Dragonfly gets the banner, not the stream — the one capability in collaboration
  that is not fully functional without Redis.
- One more consumer of the Python tier's bus envelope. That wire format now has a
  reader in another language, pinned by `conversation-frames.spec.ts`.
- A typing indicator is a small, continuous request stream from every composer in a
  shared thread. Throttled to one request per 3s per typist.

### Risks

- **Access revoked mid-stream.** Mitigated by the 30s re-check plus the
  `resource.access.changed` event the browser already acts on. Worst case a
  colleague sees up to 30 seconds more of a turn they may no longer read — of a
  thread they could read a moment earlier.
- **Frame format drift.** A change to `conversation_bus.Envelope` or to the NAT
  frame shapes silently empties the live view, which from the browser looks exactly
  like "the agent is being slow". Mitigated by pinning the decoder and the reducer
  in unit tests, and by the fallback being visibly different (the banner).
- **A stuck typing indicator** — a colleague permanently "about to answer" is worse
  than no indicator. Mitigated by the TTL being the only thing that keeps a claim
  alive: there is no path that sets it without an expiry.
- **Announcing a streaming answer to screen-reader users** would make the thread
  unusable. The live region is deliberately off on the spectated turn; the finished
  message's arrival announcement (CC-9) reports the answer once, when it is
  readable.

## Alternatives Considered

- **Fan the frames out over the existing per-user `/api/stream`.** Rejected: that
  channel is per session and carries a handful of change hints per minute to every
  open tab. Pushing token deltas through it would deliver a conversation's stream to
  tabs that are not looking at that conversation, and would put the cheapest
  connection in the product on the hottest path.
- **Have the asker's browser rebroadcast what it receives.** Rejected: it makes the
  least trustworthy participant in the system the relay for everyone else's view,
  doubles the traffic, and dies when the asker closes their tab — which is exactly
  when an observer most wants to know what happened.
- **Reuse `useWebSocketChat` for the observer.** Rejected: that hook drives a turn
  (acknowledgements, resend buffers, watchdogs, auth rotation, HITL, deep-research
  hand-off). None of it applies to reading along, and teaching it a passive mode
  would put the observer's path inside the most reliability-sensitive code in the
  product. The observer gets a pure fold from frames to display state instead
  (`spectator-frames.ts`).
- **Write the spectated turn into the chat store's streaming slots.** Rejected: it
  would make an observer's store indistinguishable from an asker's mid-turn, and
  every guard in the local-first path that keys on `isStreaming` would then be
  reasoning about somebody else's turn.
- **Persist typing state.** Rejected on principle: a fact that is worthless one
  second later must not reach Postgres, and a `GET` for it would be a second, weaker
  source of truth for something no client needs to converge on.

## Open Questions / Follow-ups

- **Deep research.** A deep-research turn hands off to its own SSE job stream after
  the dispatch frame, so an observer currently sees the reasoning up to the hand-off
  and then the banner until the job lands. Relaying job progress to observers is the
  obvious next step and is deliberately not in this change.
- **Cards.** Grid cards on the terminal frame are not rendered in the live view;
  the persisted message brings them a moment later. If a card ever needs to be
  visible mid-turn, it needs its own decision — an interactive card rendered to a
  non-asker is a second person able to press "apply" (ADR-0030).
- **Roster-sized fan-out.** Presence publishes N times for N participants, matching
  ADR-0035's deliberate choice. Fine at present roster sizes; the same revisit
  applies to both.

## References

- `frontends/aiq_api/src/aiq_api/conversation_bus.py` — the bus this reads from.
- `frontends/ui/src/lib/events/conversation-frames.ts` — the BFF-side subscriber.
- `frontends/ui/src/features/collaboration/lib/spectator-frames.ts` — frames → view.
- `frontends/ui/src/lib/conversations/presence.ts` — composing presence.
- [`docs/api/collaboration-routes.md`](../api/collaboration-routes.md) — both routes.
- Visual evidence: `frontends/ui/visual/screenshots/shared-thread-live.*.png`.
