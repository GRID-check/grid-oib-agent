---
status: proposed
date: 2026-09-09
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Memory is a store the agent reads, and a layer the reader can see

## Context and Problem Statement

Project and organization memory reaches the agent one way: a digest injected
into every turn, capped at 1800 characters, 20 items and 12 pins, re-selected
each turn against that turn's question. There is a `remember` tool for writing
and **no tool for reading**. A project with 200 findings therefore has 180 that
no question can reach on a given turn, and the digest's own text tells the
*model* how many were dropped while telling the *reader* nothing.

The same asymmetry runs through the surfaces. Every other knowledge source in
this product is visible where it is used: a document resolves to a citation
chip, a highlighted passage and a lane in the Herleitung; the Archiv and the
base corpus carry shelf labels; a Steckbrief cites as `register`. Memory shapes
every answer and appears in none of it. The Wissensbasis tree
(`scope-tree-model.ts`) offers five levels — Basiswissen, Büroarchiv,
Projektregister, Projekt, Diese Unterhaltung — and omits the one layer that is
read on *every* turn. `trace-lanes.ts` and `herleitung-levels.ts` have no memory
lane. The only memory a reader ever sees is the write: a chip saying "Piloti hat
sich gemerkt", whose copy then tells them to walk to another page.

Two consequences follow, and both were reported before this record was written.
A corrected memory is the quietest event in the system: polarity supersession
retires the old note and records `supersedes_id`, which nothing reads, so the
replaced note simply vanishes from the panel and the correction cannot be seen
or undone (`memory-reflection-audit.md`). And organization memory, which the
Büro-Chat reads on every turn (ADR-0054), has no realistic writer at all: the
reflection stage refuses org scope by construction, and the only remaining path
is a permission held by admins alone.

Underneath all of it is one shape: **the control surface was built and the trust
surface was skipped.** Curating, pinning and deleting are well served and rarely
used. "Why did you say that" and "what do you think you know" are asked
constantly and have no answer in the product.

## Decision Drivers

- Traceability is this product's proposition. A legal answer must resolve to
  something a person can open, and memory is the one input that resolves to
  nothing.
- A cap that cannot be looked past is a ceiling. Everywhere else in this system
  a bounded selection is paired with a way to reach the rest: retrieval for the
  corpus, mounting for projects (ADR-0054).
- What the model is told and what the reader is told must not diverge. The
  omission count going to one and not the other is the inversion in miniature.
- Firm-wide memory is the one write whose blast radius is every project in the
  tenant, so it needs both a gate and a review, which is exactly what the
  reflection stage said it was missing.
- No new surface. Memory must become legible inside the surfaces that already
  exist, or it adds to the very confusion it is meant to relieve.

## Considered Options

1. **Raise the cap.** Inject more of the store per turn.
2. **Adopt a memory product** — mem0 self-hosted, LangMem, or the `nat.memory`
   interface already in the dependency tree — and inherit its recall and
   surfaces.
3. **Make memory readable and visible**: a bounded search tool beside
   `remember`, a level in the Wissensbasis tree, memory lanes in the Herleitung,
   correction as a stated event, and organization memory filling by proposal.
4. **Do nothing** and treat the digest as sufficient.

## Decision Outcome

Chosen option: 3, because the cap is not the problem — the absence of a second
path is. Option 1 trades prompt budget for coverage and still leaves the store
larger than any cap; measured against the turn's real cost it would buy little,
since memory is roughly 5% of the injected context while bound tool schemas are
~9000 tokens and re-sent search results ~10 000
(`latency-and-caching-audit-2026-09.md`). Option 4 keeps a store whose contents
the reader cannot see and the agent cannot reach.

What this decides:

- **Memory is retrievable.** A `search_memory` tool sits beside `remember`,
  bounded like every other tool, running the same recall path the digest already
  uses under the same scope and permission rules. The digest becomes the working
  set it always was, and the store behind it is reachable when a question needs
  it.
- **A layer read on every turn is visible where it is read.** Memory gains a
  level in the Wissensbasis tree stating how many notes are carried this turn
  and how many exist, memory lanes in the Herleitung, and a marker under the
  answer naming the notes that were in context. The omission count reaches the
  reader, not only the model.
- **The marker states influence, not evidence.** Memory is not a passage and
  must never render as a citation (ADR-0026, ADR-0037). It says what was *read*,
  never what was *used*, because the second is a claim we cannot verify.
- **Correction is a stated event.** A supersession renders in the transcript
  with an undo, in the pattern mounts use (ADR-0054), and the replaced note
  stays visible in the panel through the `supersedes_id` the write path already
  records.
- **Organization memory fills by proposal and acceptance.** The reflection stage
  may propose organization-scoped findings; they arrive as proposal cards and
  acceptance requires `org:memory:write`. This answers, in full, the objection
  the reflection code itself records: it refused org scope because there was "no
  write-time authorization gate or human review". ADR-0054 added the gate. The
  card is the review.
- **We buy none of it.** `nat.memory` is already installed and is a per-user CRUD
  interface with no scope, kind, confidence or supersession. mem0 puts tenant
  isolation behind its paid tier and wants two datastores. LangMem is pre-1.0 and
  wants LangGraph's store, which has no row-level security. None of them
  pseudonymise attribution in place, which our deletion pipeline does (ADR-0011).

### Consequences

* Good, because the store stops being larger than what any question can reach,
  and the ranking machinery starts serving two callers instead of one.
* Good, because memory reads become ordinary tool calls, so they appear in the
  live status line and the Herleitung using vocabulary that already exists —
  the visibility is mostly a consequence of the tool, not new machinery.
* Good, because the reader can finally answer "what does it think it knows"
  from inside the answer, rather than by navigating to a settings page.
* Good, because the organization memory the Büro reads gains a writer whose
  blast radius is bounded by a human decision.
* Bad, because a turn may now spend a tool call on memory that the digest would
  have covered, which costs a round trip and one of the seven charged calls.
  The prompt tells the model to search only when the digest says items were
  omitted or the question names something it cannot see.
* Bad, because the answer footer gains another element, on a surface the card
  charter already asks to keep quiet. It is one line, collapsed by default.
* Neutral, because the search tool does not change what memory *is*. Nothing
  about the write path, the scoring or the tenancy model moves.

### Confirmation

- `tests/aiq_agent/test_tool_context_contract.py` covers `search_memory`, so
  both entry paths supply the identity it declares.
- A spec asserts the tool cannot read across scopes: a project turn never
  receives another project's notes, and a Büro turn receives organization-scoped
  notes only.
- `turn-events.spec.ts` already asserts the UI declares exactly the keys the
  backend emits, so a memory status key cannot ship without its wording.
- A scope-tree spec asserts the memory level renders in both surfaces and states
  the carried and total counts; the omission count shown to the reader is the
  same number the digest reports to the model.
- The frame-extra parity test (`test_frame_extras_the_client_declares.py`)
  covers the memory context the answer marker renders.
- `rls-coverage.spec.ts` and the tenant-isolation suite are unchanged, because
  no table changes shape.

## Pros and Cons of the Options

### 1. Raise the cap

* Good, because it is a one-line change.
* Bad, because the store is always larger than the cap, so it postpones the
  question rather than answering it, and it spends the one budget the latency
  audit says is already contested.

### 2. Adopt a memory product

* Good, because extraction and temporal consolidation are genuinely solved
  elsewhere, and Graphiti is better at "this fact replaced that one" than the
  polarity matcher we wrote.
* Bad, because the parts that fit are the parts we have, and the parts we need —
  row-level security, purge cascade, pseudonymisation in place, a curation page,
  project and organization scopes — are the parts none of them offer.
* Bad, because every candidate brings a second datastore or a paid tier for the
  tenant isolation our model treats as a floor.

### 3. Make memory readable and visible

* Good, because it reuses machinery that already exists twice over: bounded
  tools with refusals, the status vocabulary, the notice-with-undo pattern, the
  proposal card.
* Neutral, because it grows the tool set by one on a path ADR-0048 wants to
  shrink.
* Bad, because it is four surfaces plus a tool rather than one change.

## More Information

- Revisit if the search tool is rarely called, which would say the digest was
  sufficient and the tool is tax. The signal is the turn-shape trace, not
  argument.
- Revisit the ranking machinery once the tool has a caller: about 1650 lines of
  embeddings, rank fusion, salience and decay serve what `semantic-notes.md`
  itself calls "tens to low hundreds of rows per scope". With a second caller it
  earns more of its keep; without one it is the first thing to cut.
- **Graphiti** (Apache-2.0) is recorded here as the candidate for the compiled
  derivation graph `compliance-derivation-graph.md` already wants, where
  bi-temporal fact invalidation and "what was true at the permit date" are the
  requirement. It should be decided there, once, with memory as a passenger —
  not adopted through memory for a hundred notes per project.
- Follows ADR-0008 (memory model), ADR-0054 (the gate this decision's review
  half completes) and ADR-0052 (one answering agent, so the search is the
  agent's decision and not a router's).
