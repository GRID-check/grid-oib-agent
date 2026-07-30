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
   paths.

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
  unwanted answer in a thread the caller already has access to — not a data leak. A
  server-side veto would require the agent tier to consult BFF state on every turn,
  which is not worth it at this stage.

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
