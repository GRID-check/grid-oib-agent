# Streaming the Chat Answer — wire contract

**Status:** Implemented (2026-07-18). Streaming is the default delivery; there is
no runtime flag — the backend and frontend ship together in this monorepo, so
the change is atomic and needs no staged rollout toggle.
**Related:** the per-turn chat path (`chat_researcher`), `websocket_reconnect.py`,
the `frontends/ui` chat store.

## Why this is cross-stack, not backend-only

The transport can already carry many chunks, but two layers assume **one content
frame per turn**:

1. **Rendering** — `frontends/ui/.../messages-store.ts` appends a *brand-new*
   assistant bubble for every content frame; it never merges deltas. N streamed
   frames ⇒ N bubbles.
2. **Persistence** — on a client disconnect, the terminal message is persisted
   under `deterministic_assistant_message_id(conversation, parent)` with
   `onConflictDoNothing`. The **first** frame that fails to send wins the id;
   every later frame (including the one carrying `cards`/`sources`) no-ops. So
   naive delta frames persist a *partial* answer and drop cards/citations.

Therefore streaming requires coordinated changes in the backend generator, the
WS handler's persistence gating, and the frontend accumulation logic.

## The citation constraint (why this is progressive rendering, not lower TTFT)

`verify_citations` + `sanitize_report` rewrite the answer body — they delete
unverified `[N]` markers and renumber the `## Sources` section — and they need
the **complete** answer text. A shallow answer can also still escalate to deep
research. So we cannot stream the model's raw tokens without briefly showing
unverified citations (the exact thing "preserve citations first" forbids) or
streaming text that gets superseded.

**Consequence:** orchestration stays fully buffered. We stream the
**already-verified** final text as deltas. This is a typewriter/progressive
rendering improvement, **not** a time-to-first-token reduction — the first delta
is emitted only after the answer is generated, verified, and sanitized.

## Wire contract

Backend `_run` is an async generator yielding `ChatResponseChunk`s. Orchestration
is buffered; only delivery differs.

- **Answer turns:** yield incremental **delta** chunks (`finish_reason=None`, no
  extras, contents concatenate to *exactly* the final text), then one
  **terminal** chunk — full content, `finish_reason="stop"`, extras
  (`cards`/`sources`/`answer_confidence`/`deep_research_job_id`) on
  `model_extra`. The terminal is authoritative for persistence and for the
  single-consumer fold.
- **Error / budget turns:** a single **terminal** chunk (short, fully known up
  front — no point tokenizing). The WS handler renders a lone terminal chunk
  with the pre-streaming frame pattern, so these are unaffected.

The delta/terminal distinction reaches the wire via WS message **status**:
deltas ⇒ `IN_PROGRESS`, terminal ⇒ the completing frame. `_response_to_chunks`
keeps a `stream` parameter (True for answers, False for errors), but there is no
env/runtime gate — streaming is always on for answer turns.

### WS handler (`websocket_reconnect.py::_run_workflow`)

- A chunk with `finish_reason=None` (delta) ⇒ send `IN_PROGRESS`,
  **not persist-eligible**.
- A chunk with `finish_reason="stop"` (terminal) ⇒ the finalizing frame,
  full content + extras, **persist-eligible** (fixes the partial-persist bug).
- When only a terminal chunk is seen (error/budget turns, or any single-chunk
  producer), the existing `IN_PROGRESS content` + synthetic `COMPLETE` behavior
  is preserved.

### Frontend (`use-websocket-chat.ts` / `messages-store.ts`)

- Maintain one streaming bubble per turn (keyed by `parent_id`).
- `IN_PROGRESS` content frame ⇒ **append** delta to the streaming bubble
  (create it on the first delta).
- Completing frame with full content ⇒ **replace** the bubble content with the
  authoritative full text (idempotent when equal to the accumulation), attach
  `cards`/`sources`, finalize.
- Backward compatible: with the current backend (one content frame), "append the
  only delta then finalize" yields the same single bubble as today.

### Single-consumer fold (`--input` CLI, single-shot HTTP)

`_fold_chunks_to_response` collapses the chunk stream to one `ChatResponse`:
the terminal (`finish_reason="stop"`) content is authoritative; extras are
copied from the terminal. Deltas are ignored when a terminal is present, so the
folded content is never doubled.

## Tests

- Backend: `stream=False` (error/budget) yields one terminal chunk equal to
  today's response; `stream=True` (answers) yields deltas whose join equals the
  verified text, extras only on the terminal; fold reproduces the single
  response either way.
- Handler: delta frames are IN_PROGRESS and not persisted; terminal frame is the
  finalizing, persist-eligible frame with cards/sources.
- Frontend: deltas accumulate into one bubble; terminal replaces + attaches
  cards; single-frame backend still renders one bubble.
