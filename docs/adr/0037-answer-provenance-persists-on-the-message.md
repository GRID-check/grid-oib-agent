# ADR-0037: An answer's provenance — and its open questions — persist on the message

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Platform engineering, product
- **Related:** ADR-0030 (interactive card decisions persist on the message),
  ADR-0033 (server-authoritative shared conversations), ADR-0032 (shareable-resource model)

## Context

Exactly seven things reached the server with a message: `errorData`, `fileData`, `cards`,
`cardInteractions`, `enabledDataSources`, `messageFiles`, and — after an earlier fix whose
reasoning this ADR reuses — `citations`. Everything that explains **how** an answer was
reached stayed in the browser tab that produced it: the Herleitung (`thinkingSteps`), the
confidence self-assessment and its stated reason, the routing transparency
(`routingDecision`, `routingReason`, `escalationReason`), `citationsRemoved`, and the
deep-research job pointer.

For one user on one device that was tolerable, because the tab that asked is the tab that
looks. Sharing makes it wrong twice over:

1. **A colleague sees a bare answer.** An observer holds no agent socket *by design*
   (ADR-0033 §7 — a reader needs no socket, and the Python socket registry is keyed by
   conversation so a second one would displace the asker's). So the intermediate frames
   never reach them, and the server row they load instead never carried the reasoning.
   Anna reads "1,20 m" with nothing on screen to say what it rests on.
2. **The asker loses it too** — on a second device, after a storage prune, in any browser
   that was not the one that asked. This one predates sharing and was simply invisible.

In a building-regulation assistant the provenance is not decoration. An answer without its
grounding is the one thing this product must never render, which is precisely the argument
the citations fix already made and won.

A human-in-the-loop **prompt** was the same defect in a sharper form. `addAgentPrompt`
never persisted anything, so a clarification card existed only in the browser whose
socket received the frame. An observer's load showed **no card at all** — the thread
simply stopped mid-question and the "Piloti is answering …" banner aged out after five
minutes — and the asker's own reload lost it too. The transcript recorded that
something had been asked and never what was decided.

## Decision

**The compact provenance — and any prompt — is stored on the message row, and
restored from it.**

1. **Compact, not raw.** `stripThinkingStepsForStorage` already defines what a Herleitung
   is worth keeping — display fields plus the `traceLanes` fan-out, with `content` and
   `rawPayload` dropped — because that is exactly what `ChatThinking` renders. The server
   keeps what localStorage keeps, so a thread restored from the server and one restored
   from the browser cannot look different in ways nobody predicted.

2. **The pointer, not the document.** A deep-research report stays out of the message row;
   `deepResearchJobId` goes in, and a colleague fetches the report through the path that
   already serves it. A message row is not a place to put a document.

3. **Written after the turn settles, not with the message.** None of this exists when the
   message is posted — it accumulates from the intermediate frames while the answer
   streams. So it rides the same row-locked `mergeMessageMetadata` primitive that card
   decisions use (ADR-0030), as a `PATCH` once the turn completes.

4. **The client is not trusted with the bound.** `sanitizeProvenance` is a whitelist that
   runs before anything reaches the jsonb column: unknown keys dropped, unions checked,
   strings capped, the step list truncated. A jsonb column fed from a client-supplied array
   is otherwise an unbounded write, and "it is typed" is not a bound.

5. **Best-effort, never blocking.** A failed mirror is logged and swallowed. The asker is
   already reading the Herleitung from the store; losing the mirror costs a colleague's view
   and the cross-device replay, not the turn.

6. **A prompt is persisted with its addressee, and read-only for everybody else.**
   `promptFor` names the person the agent asked. It is not decoration: the agent tier
   refuses an answer from anybody else (ADR-0033's follow-up), so a UI that offered a
   colleague the buttons would be offering a refusal. A colleague therefore sees the
   question and the options, plus a line saying who is being waited for — because a
   card with no actions and no explanation reads as broken rather than as somebody
   else's turn. `isPromptResponded` is derived from the stored answer rather than
   stored beside it: two fields that can disagree about one fact is one field too many.

7. **Restored flat, onto the fields the renderers already read.** `ChatThinking`, the
   confidence chip and the routing line each take their own prop, and none of them should
   have to know whether the value arrived from a live stream or a server row.

## Consequences

### Positive

- A colleague sees the same reasoning as the asker, which is what makes a shared answer
  reviewable rather than merely readable.
- The asker's own reasoning survives a new device and a storage prune — a pre-existing loss
  this closes on the way past.
- No new table, no new route, no migration: one metadata key on a primitive that already
  exists and is already row-locked.

### Negative

- **Message rows get bigger.** Bounded (200 steps, 600-char reasons, 40 lanes per step),
  and the heavy fields were already being dropped for localStorage, so the ceiling is the
  one the browser already lives with.
- **One extra PATCH per turn** (two when both messages carry provenance). Sequential, after
  the answer has landed, on a path where nothing is waiting for it.
- **The write can be lost** while the answer is kept, so a row can hold an answer with no
  provenance. That is strictly better than today, where every row is like that, and the
  renderers already handle absence.

### Risks

- **The compact form is a judgement about what a reader needs**, inherited from the
  localStorage prune. If `ChatThinking` ever starts rendering step payloads, this becomes
  lossy in a way that will not be obvious. Mitigated by both paths sharing one function, so
  the decision has exactly one place to change.
- A row written by an older build has no provenance and one written by a future build may
  have keys this one does not know. Both are handled by narrowing on read rather than
  casting.

## Alternatives Considered

- **Stream the intermediate frames to observers.** The complete fix, and explicitly deferred
  by ADR-0033: it needs either a BFF subscriber on the agent's per-conversation bus or a
  Python change, and it still leaves the asker's second device with nothing. Persisting is
  the smaller change that fixes both, and it remains the substrate a live relay would want
  anyway.
- **A separate `message_provenance` table.** Cleaner normalisation, no gain: it is read
  exactly when the message is read, written exactly when the message is written, and never
  queried on its own.
- **Store the raw steps.** Rejected on size for no benefit — the payloads are not rendered,
  which is why the localStorage path already drops them.
- **Leave it, and tell the observer the reasoning is unavailable.** Honest, and considered.
  Rejected because "unavailable" is the wrong answer to a question the product exists to
  answer, and because it would leave the asker's own second-device loss standing.

## References
- ADR-0030, ADR-0033
- `lib/conversations/message-provenance.ts` — the whitelist and the bounds
- `features/chat/lib/prune-message-for-storage.ts` — the shared definition of "compact"
