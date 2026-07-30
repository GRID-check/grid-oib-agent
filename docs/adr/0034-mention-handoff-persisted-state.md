# ADR-0034: The mention hand-off is persisted conversation state, not the agent's in-memory HITL

- **Status:** Accepted
- **Date:** 2026-07-29
- **Deciders:** Platform engineering
- **Related:** ADR-0028 (conversation bus / in-process HITL futures), ADR-0030
  (interactive card decisions persist on the message), ADR-0032 (shareable-resource
  model), ADR-0033 (server-authoritative shared conversations),
  ../design/collaboration-sharing-and-inbox-spec.md (§7)

## Context

The product's headline collaboration behaviour is: a participant tags a colleague, and
**the agent deliberately does not answer** until that colleague responds. The thread
visibly waits for a named human.

There is an existing mechanism that looks like the right home for this. The agent
already supports human-in-the-loop (HITL): mid-turn it can ask a question and await a
person's answer. But that mechanism is built for a different problem:

| | Agent HITL (exists) | Mention hand-off (needed) |
|---|---|---|
| Waits for | whoever holds the socket | a **specific named person** |
| Duration | seconds to minutes | **hours to days** |
| Held in | an in-process `asyncio` Future bound to the event loop of the replica running the turn | must survive restarts, deploys and replica reshuffles |
| Survives a restart | no — the in-flight prompt is lost (ADR-0028 accepts this) | must survive |
| Resolved by | a WebSocket frame on the same conversation | a message from another user, possibly days later, possibly from another device |
| Scope | one turn | conversation state, spanning many turns |

Reusing the HITL future would mean a colleague's answer must arrive while the same
replica still holds the same loop-bound future — which the product explicitly does not
guarantee. The failure mode is silent: the thread would simply stop waiting, and
nobody would be told why.

The product has already learned this lesson once. Interactive cards originally held
the user's decision in component-local React state; because the card payload persisted
but the decision did not, a reload re-offered a live button that would apply a
non-idempotent write a second time (ADR-0030). The rule that came out of it — *a
decision that gates a real consequence belongs in persisted state, not in
in-flight state* — applies here verbatim.

## Decision

**We will model the hand-off as persisted, queryable state in `grid_app`, entirely
outside the agent tier.**

1. **A `mention_requests` row per (mention, recipient)** carries: the resource it
   belongs to, an opaque anchor identifying the spot inside it (the message id, for a
   chat), who asked, who is asked, a status (`open | answered | released | void`) and
   its resolution metadata.

2. **The thread-level "awaiting" state is derived, not stored** — it is the existence
   of an `open` request for that conversation. There is exactly one source of truth, so
   the banner and the inbox can never disagree.

3. **A message's addressee set is computed once, server-side, at persist time, and
   stored on the message.** It is never re-derived from the text later (an edited
   display name must not change who a two-week-old message was addressed to) and never
   taken on trust from the client.

4. **The agent is suppressed by not being invoked.** No turn is started for a
   message whose addressees contain a human and not the agent — nothing is started and
   cancelled, so no tokens are spent. The persistence response tells the client the
   resolved addressees, and the client uses that answer to decide whether to open an
   agent turn. The server is the decider; the client is the executor.

5. **Resolution is driven by domain events, not by the recipient tidying up.** A reply
   from a mentioned person, an explicit release by any participant, or the mention
   becoming void (access lost) each close the request and resolve the corresponding
   inbox item.

6. **No Python change.** The mention hand-off lives wholly in the BFF, hanging off
   message persistence, which the BFF already owns on both the session and internal
   paths. — **Superseded: see the 2026-07-30 addendum.** The *hand-off state* does
   live wholly in the BFF, but "the agent is suppressed by not being invoked" also
   kept the message out of the agent's checkpoint, i.e. out of its memory. Delivering
   it as context needed a change in the agent tier.

## Addendum (2026-07-30): a plain message while awaiting a human is a remark, not a question

The rule as first shipped was *"no mentions means the agent answers"*. That is right
for a thread in its normal state and **wrong while a hand-off is outstanding**, which
review caught before release:

> Matthias tags Anna. Anna answers — a plain message, no mentions. Under the
> original rule `addressed.length === 0` made `agent: true`, so **Piloti answered a
> message Anna had written to Matthias.** The same happened for "thanks, take your
> time" from the asker.

The model is therefore stated as **two states**, and only one rule changes between
them:

| State | Entered by | A plain message goes to | Left when |
|---|---|---|---|
| **Asking Piloti** (default, and where a thread always returns) | — | the agent | a human is tagged |
| **Waiting on a named person** | tagging a human | the **thread** (`{ agent: false, users: [] }`) | they answer · anyone releases · someone types `@Piloti` |

`@Piloti` remains the explicit way back, and already released an open wait
(spec MN-9.3), so no new gesture was invented.

**Cost control.** The check is derived from open requests like every other reading
of the hand-off state, so it cannot disagree with the banner — but it is a query,
and the default path must stay free. It therefore runs **only for shared
conversations**: a solo thread cannot hold a request, so the overwhelmingly common
case (one person asking the agent) still reaches `{ agent: true }` without touching
the database. `createConversationMessages` resolves shared-ness once and threads it
to both the addressee decision and the fan-out, so neither pays twice.

**The behaviour was not the whole defect.** The rule was invisible: nothing in the
UI said who the next message would reach. The composer now states its addressee in
every state ("Geht an Piloti" / "Geht an {name}" / "Geht an den Chat" with
"@Piloti eingeben, um Piloti zu fragen"), because a correct rule the user has to
infer is still an unclear product.

## Addendum (2026-07-30): the agent tier needed a change after all — "always send, never always judge"

Decision 6 above said **"No Python change."** That was wrong, and the way it was wrong
is worth recording, because the framing concealed the gap rather than closing it.

The BFF owns *who a message is for*. It does not own *what the agent remembers*. The
agent's conversation history **is** its LangGraph checkpoint (`thread_id ==
conversation_id`), and the client sends only `{ query, data_sources }` — so the
checkpoint contains exactly what passed through the agent, and nothing else:

1. Matthias asks Piloti → in the checkpoint ✓
2. Matthias tags Anna → **no agent turn** → not in the checkpoint
3. Anna answers → **no agent turn** → not in the checkpoint
4. Matthias types `@Piloti given that, recheck` → the agent's context is his original
   question, its own answer, and "given that" — **"that" refers to nothing.**

Anna's answer existed only in `grid_app.messages`. Decision 4 ("suppress the agent by
not invoking it") was right about tokens and silently wrong about memory, which
defeats the feature's stated core value (spec OQ-8: *"yes — it is exactly the context
that makes this valuable"*).

**The decision: every human message reaches the agent, tagged with whether it is
addressed to it.**

| The server's ruling | What the client sends | What the agent does |
|---|---|---|
| `addressees.agent = true` | today's `user_message`, unchanged | answers — exactly as before |
| `addressees.agent = false` | the same frame plus `context_only: true` + `author_name` | appends the turn to its conversation state and **generates nothing** |

So there is no third state and no new concept: not answering stays a routing decision
the server makes deterministically, and only *delivery* changed. When Piloti is next
addressed, Anna's answer is already in its history — no transcript field to bound, no
prompt stuffing, and no product-authored text masquerading as a user's message (the
ingested turn is the human's own words with their name in front).

Ingestion is genuinely free, which is what keeps Decision 4's economics intact:
LangGraph's `aupdate_state` writes a checkpoint through the `messages` reducer and
executes no node, so no LLM is called, no `system_response_message` is emitted, and no
status or intermediate frame is streamed. It is also bounded (4000 chars, the same cap
`normalize_project_context` uses) and fail-soft: a lost context frame degrades the
agent's memory and must never break the thread, because the message itself is already
persisted where the humans read it.

The addendum above (a plain message during a hand-off) gets the same treatment. Its
ruling is `{ agent: false, users: [] }`, so the composer now routes such a message
through the awaited-persist path too — the client decides only whether to *ask* for
the ruling, never what it is, so a stale hand-off read costs one round trip and
nothing more.

### Why the clarifier-as-classifier alternative was rejected for routing

The obvious-looking alternative is to make the agent an always-on listener: send it
everything with no tag, and let a cheap clarifier decide per message whether it was
addressed. Rejected, and not on cost grounds:

- It makes **"does Piloti answer?" probabilistic.** The composer's whole reason for
  existing in this feature is that it can state the recipient truthfully *before* send
  ("Geht an Piloti" / "Geht an {name}" / "Geht an den Chat"). A statement about a
  classifier's future guess is not a statement.
- It makes **mentions advisory rather than binding.** `@Piloti` is the documented way
  back out of an open wait (spec MN-9.3). A model that may read it differently turns a
  gesture the user was taught into a suggestion.
- Its **failure mode is silent nothing.** A misjudgement produces no answer and no
  explanation, which is indistinguishable from the deliberate quiet of a hand-off —
  precisely the "the thread simply stops waiting and nobody is told why" failure this
  ADR was written to avoid.
- The server **already has the answer**, deterministically, from structured mentions
  and the open-request rows. Replacing a decided fact with an inference is a downgrade
  regardless of how good the inference is.

Delivery, unlike routing, is a fine place for tolerance: the worst outcome of a context
frame going missing is a slightly forgetful agent.

### Consequences of the addendum

- The agent tier now has a second, deliberately tiny entry point
  (`ChatResearcherAgent.append_context_message`) that writes history without running
  the graph. It touches `messages` only — never turn-scoped state (`shallow_result`,
  confidence, routing extras) — so it cannot leak a previous turn's signals forward.
- `aiq_api` reaches it through a registered appender rather than an import, keeping the
  socket tier free of the graph. A process without a chat agent logs and no-ops.
- A version skew (new client, old backend) degrades to *pre-change* behaviour: the old
  backend ignores the unknown JSON key and answers the message. One unwanted answer in
  a thread the sender can already read — never a dropped frame. See
  `docs/api/websocket-protocol.md`.
- Ingested context is bounded per message but **not** bounded in aggregate: a very
  chatty shared thread grows the checkpoint like any long conversation does, and is
  trimmed by the same `max_history_tokens` window at turn time.

## Consequences

### Positive

- The wait survives restarts, deploys, replica reshuffles and the recipient answering
  a week later from a different device — because it is a row, not a future.
- One derived source of truth for "who are we waiting for" means the thread banner, the
  participant view and the recipient's inbox cannot drift apart.
- Suppressing the agent by *not invoking it* costs zero tokens, which is both cheaper
  and simpler than starting a turn and cancelling it.
- The agent tier keeps its existing HITL semantics untouched; the two mechanisms do not
  interact.

### Negative

- A second "waiting for a human" concept now exists alongside agent HITL. They look
  similar in the UI and are unrelated in the implementation, which is a real
  comprehension cost. Mitigated by naming them distinctly in code and copy
  (*clarification* for the agent's own question, *request* for a mention).
- The client decides whether to open an agent turn from the server's answer, so a
  hostile client could open one anyway. The consequence is a wasted turn and an
  unwanted answer **in a thread the caller can already reach** — not a data leak. A
  server-side veto on the *turn* would require the agent tier to consult BFF state
  on every turn, which is not worth it at this stage.

  "A thread the caller can already reach" is a claim, so it is enforced rather than
  assumed: the WebSocket upgrade's scope resolution
  (`lib/collection-scope-request.ts`) authorizes the caller-supplied
  `conversationId` — at least `viewer` via `requireResourceAccess` — and the
  gateway destroys the socket on the resulting 403. An id that does not exist yet
  is still allowed, because conversation ids are client-generated and the row
  appears with the first message; absent is fine, existing-but-unreachable is not.
  Without that check the residual was not "a wasted turn" at all: the finished
  assistant turn is persisted through the internal service path, whose only gate is
  an org-scoped conversation lookup, so any signed-in org member could have had an
  answer written into a colleague's private thread and fanned out to its real
  participants.

### Risks

- **An abandoned wait** — the mentioned person never answers and nobody releases it —
  leaves the thread quiet indefinitely. Mitigated by making release a first-class,
  always-available action for any participant, and by the reminder/escalation
  follow-up (spec MN-17) which the row model already supports.
- **Void transitions could be missed**, leaving an open request against someone who
  lost access. Mitigated by voiding requests in the same operation that revokes access,
  and by re-authorising at read time so an unresolvable request cannot be acted on.

## Alternatives Considered

- **Reuse the agent's HITL future.** Rejected: it is loop-bound, in-process, and
  explicitly not durable across restarts (ADR-0028). Days-long waits and a named
  recipient are outside what it models.
- **Store the wait as a flag on the conversation row.** Rejected: it cannot express
  multiple outstanding requests against different people (spec MN-10), and it would
  duplicate a fact the request rows already carry — inviting exactly the drift ADR-0030
  warns about.
- **Start the agent turn and cancel it immediately.** Rejected: spends tokens, emits
  status output, and races with the cancel.
- **Enforce suppression in the agent tier.** Rejected for phase 1: it would put a
  BFF-state lookup on every turn for a threat whose worst outcome is a wasted answer in
  a thread the actor can already read.

## Open Questions / Follow-ups

- Reminders / escalation for unanswered requests (spec MN-17) — the row model carries
  the data; the scheduler work is deferred.
- Generalising the anchor to non-chat resources (spec MN-19/MN-20) — the column is
  already opaque; the second surface will prove it.

## References

- ../design/collaboration-sharing-and-inbox-spec.md — §7 (MN-1…MN-20), §11.5
- ADR-0028 (why the in-process future is not durable), ADR-0030 (the precedent)
