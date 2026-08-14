# ADR-0048: An attachment is a turn signal, not a retrieval scope

- **Status:** Proposed
- **Date:** 2026-08-14
- **Deciders:** Platform engineering
- **Related:** ADR-0047 (a document's shelf travels as data),
  [../api/websocket-protocol.md](../api/websocket-protocol.md),
  [../architecture/backend-deep-dive.md](../architecture/backend-deep-dive.md),
  [../architecture/meta-vs-research-contract.md](../architecture/meta-vs-research-contract.md),
  issue #429

## Context

A user drops a PDF into a chat and writes "Fass den Inhalt zusammen". The agent
asks back *which* content. On a retry it searches the project store and the
Büroarchiv as well, and finally proposes a research plan over Archiv material
the user never mentioned.

Nothing in that chain was broken code. Each layer behaved correctly on the
information it had, and the information it had was wrong:

- **The act left no trace on the wire.** The `user_message` frame was
  byte-identical with and without an attachment. `messageFiles` existed for the
  display chips and was never sent.
- **`focus_file_name`, the one existing scoping hook, does not cover this.** It
  is set from the composer subject or a visible peek — never from dropping a
  file.
- **`available_documents` could not distinguish the upload from the corpus.** It
  was an undifferentiated, alphabetically-sorted union of base + Archiv +
  project + session (fixed by ADR-0047 and the shelf-carrying aggregator).
- **The inventory is written by the async ingest job, and the composer does not
  gate send.** On the first prompt the just-attached file is routinely absent
  from the inventory entirely.
- **The prompts then behaved correctly on that false picture.** The researcher
  prompt instructs the model to ask when a request is under-specified; a
  subjectless "fass den Inhalt zusammen" against a 39-document shared corpus
  *is* under-specified. The clarifier prompt rendered the whole union under
  "The user has uploaded the following file(s)" and used
  `available_documents[0].file_name` — the alphabetically first entry, in
  practice an OIB Richtlinie — as the exemplar of "the file the user means".

## Decision

**We will carry the turn's attachments as their own explicit signal, and treat
that signal as evidence about what THIS turn is about — never as a scope that
narrows retrieval on its own.**

### 1. `session_attachments`, not an extension of `focus_file_name`

They are different facts and are kept as two:

| | `focus_file_name` | `session_attachments` |
|---|---|---|
| Cardinality | exactly one | many |
| Origin | viewing state (composer subject, visible peek) | an act (the user attached a file) |
| Lifetime | as long as the bar is open | the turn that declares it |
| Indexing state | always fully ingested | may be mid-ingest |
| Retrieval semantics | soft re-rank | may become a hard `file_name=` filter |

`focus_file.py` is untouched and keeps strict precedence over attachments. The
wire shape is `session_attachments: [{file_name, state}]` with
`state: 'ready' | 'indexing'`; `indexing` is the client saying "this document
exists and is the subject of this turn even though your inventory does not list
it yet".

### 2. Three retrieval layers — and the third is deliberately empty

- **L1 — the model passes `file_name=`.** This already exists and is already a
  hard filter. The prompt's job is to make it unambiguous *when* to pass it, and
  the attachment block does exactly that.
- **L2 — a deterministic named retrieve per attachment**, when the model passed
  no narrowing filter of its own. An extra `file_name`-filtered query per
  session/project collection, whose hits are merged into the normal candidate
  pool. It is a BOOST: it adds candidates, it never removes any.
- **L3 — none.** A runtime hard scope on "this turn has attachments" is
  **rejected**. The user attaches a Statik-Bericht at turn 1 and asks a general
  Fluchtweg question at turn 6; a scope would answer that question out of the
  Statik-Bericht. The refusal is written into the prompt as an explicit negative
  rule ("an attachment does NOT take the conversation over") and pinned by a
  test, because a rule that exists only in an ADR is a rule the next prompt edit
  will delete.

`_merge_results` is specifically NOT changed to front attachment chunks. That
would reorder every turn in every conversation that ever had an attachment, and
could push genuine corpus hits past `top_k`.

### 3. The routing classifier gets the signal as prose, with no deterministic override

An attachment plus a subjectless request is a research turn, and a shallow one.
It is stated in the classifier prompt, not enforced in code: a hard
"attachments ⇒ research" rule would answer "wer hat die WM gewonnen?" out of an
attached PDF, and out-of-scope turns must keep their fixed redirect.

The rule says "not `deep`" as well as "not `out_of_scope`" and "not `meta`". A
deep route is what summons the clarifier and its research plan — the user's
third symptom — so keeping the turn shallow is what actually stops it. The
clarifier fix (its block now separates real attachments from the searchable
inventory) is defence in depth on the shallow→deep escalation path.

### 4. The ingest race is answered structurally, plus a bounded fail-open wait

`state: 'indexing'` is the structural half: the agent is told the document
exists even when its own inventory disagrees. `GRID_ATTACHMENT_INDEX_WAIT_SECONDS`
(default 8, `0` disables) is the pragmatic half — the inventory load polls for a
declared-`indexing` attachment it cannot see. It fails open on every error,
never raises, and is its own commit so it can be dropped without unpicking the
rest. It holds a `GRID_MAX_ACTIVE_TURNS` lease for its duration, which is why it
is bounded and disablable.

Gating the composer's send on ingest completion is **not** part of this
decision: that is a product call about how a chat composer behaves.

## Consequences

### Positive

- A subjectless request about a just-attached file is answerable on the first
  prompt, including while the file is still being ingested.
- The three facts a reader needs — what exists, what the user just handed over,
  what this turn is about — are three separate signals instead of one union.
- The anti-hijack rule is explicit and tested, so the fix cannot quietly become
  "attachments win forever" through a later prompt edit.
- The wire field is additive and compatible by absence: a client that sends no
  `session_attachments` behaves exactly as before.

### Negative

- Two overlapping file signals (`focus_file_name` and `session_attachments`)
  now exist, and a reader must know which is which. Mitigated by strict, stated
  precedence and by the module docstrings being twins of each other.
- Every attachment costs prompt tokens each turn (bounded: ten client-side,
  ten backend-side).
- The bounded wait can hold a turn admission lease for up to 8 s.

### Risks

- **The model over-applies `file_name=`** and answers a general question out of
  an attachment. This is the failure mode the negative rule addresses; it is
  the case the live smoke script exercises explicitly, and the one to re-check
  after any model change.
- **The model under-applies it** and answers from the corpus instead of the
  attachment. L2 bounds the damage: the attachment's passages are in the
  candidate pool regardless of what the model passed.
- **Prompt-cache churn.** Every block is truthiness-guarded and sits below the
  KV-cache boundary; a turn with no attachments renders byte-identically to
  before. Verified by rendering each touched template with
  `session_attachments=[]` and diffing.

## Alternatives Considered

- **Extend `focus_file_name` to a list.** Rejected: it conflates an act with
  viewing state, and it would have to carry an indexing state that a focused
  file can never have. The two would then drift apart inside one field.
- **A hard runtime retrieval scope while the turn has attachments.** Rejected —
  see L3. It fixes turn 1 by breaking turn 6, and the breakage is silent.
- **Front attachment chunks in `_merge_results`.** Rejected: it changes the
  result order of every turn in a conversation that ever had an attachment, and
  can push corpus hits past `top_k`.
- **A `collection` or `shelf` parameter on `knowledge_search`.** Rejected as
  YAGNI: `file_name=` is already a hard, precise lever, and a shelf parameter
  widens a working primitive rather than repairing a defect on this path.
- **Gate the composer's send until ingest finishes.** Rejected as out of scope:
  a product decision about the composer, not a fix for the agent's picture of
  the turn.
