# Semantic notes — one recall engine for memory and lessons

> The shared substrate under **project/organization memory** and the
> **platform lesson register**. Both keep short free-text notes; both had to
> answer "have I already got this one?" and "which of these matter now?"; both
> were answering lexically, which is the reason the memory audit called the
> embedding gate *"the single most important component — skip it and memory
> rots"* and then recorded that it had been skipped
> ([`memory-system-audit-2026-07.md`](memory-system-audit-2026-07.md) F2/F3).
>
> Built 2026-08. Status: memory recall and both consolidation gates are live;
> the honest gaps are at the end.

## What was actually broken

| Symptom | Cause |
|---|---|
| The same fact stored twice in different words | Dedup was token Jaccard. "der Bauherr wünscht ein Flachdach" and "Flachdach ist gewünscht" score **0.0** — no shared tokens, so no merge |
| Past ~20 items, memory served "an effectively random-by-recency subset" (F3) | The digest was `ORDER BY pinned, updated_at LIMIT 20`. Nothing asked what the *question* was |
| `salience` and `last_referenced_at` existed and did nothing | Both written, neither ever read. No importance term, no decay, no reinforcement |
| Pinning 21 items silently evicted all unpinned memory, forever | Pins were unbounded and truncation was invisible to the model |
| The lesson matcher could not see the lesson it should have merged into | Candidates came from a popularity window (`ORDER BY report_count`), which answers a different question than "what is this report about" |

## The design

```
note written ──► embed once (backend /v1/note-embeddings, same model as documents)
                   │
                   ├──► consolidation probe: cosine ≥ threshold, same kind/scope
                   │      same polarity → merge · opposed polarity → supersede
                   │
                   └──► stored ON THE ROW (embedding real[] + fingerprint)

turn arrives ──► embed the question ──► score candidates:
                   relevance·3 + importance·2 + recency·0.5, min-max normalised
                   × reinforcement e^(−t/S), clamped [0.3, 1.5]
                 ──► pins first (bounded), then top-scoring, truncation DISCLOSED
                 ──► recall marks what it surfaced (t resets, S += 1)
```

### Why the vector is a column, not a vector store

ChromaDB is right here and already ours, and this deliberately does not use it.
Two stores means a sync job, a drift mode, a deletion problem, and a tenancy
question for data that is tenant-scoped and RLS-guarded — which is precisely
the cost that kept F2 unbuilt for a year. A `real[]` column is transactional
with the note, inherits its policy and its cascade, and cannot drift.

`grid_cosine_similarity(real[], real[])` (migration 0069) is a set-based
`IMMUTABLE PARALLEL SAFE` SQL function, so scoring happens in the database and
the vectors never cross the wire.

**Where this stops being right:** it is a sequential scan, so cost is linear in
candidates *within one scope*. One project's memory is tens to low hundreds;
the live lesson register is capped by construction. At roughly **10k+ vectors
in a single scope** the scan stops being free and the answer is pgvector with
an HNSW index — a migration and a database image change, not a redesign, since
the column and the fingerprint discipline stay exactly as they are.

### The fingerprint is load-bearing

A vector is comparable only to vectors from the same model, and the embedding
model is a config change away. Every row stores `embedding_model` beside the
vector, every comparison pins it, and a mismatch means *"not embedded"* rather
than a silently wrong distance. This is the same rule
`embed_fingerprint_mismatch` already enforces for Chroma collections, applied
to a column.

### The scoring model, and where it departs from the paper

Generative Agents (Park et al., UIST '23) is the source. Three departures, all
taken from their **released code** rather than the paper, because the two
differ:

| | Paper | Shipped code | Here |
|---|---|---|---|
| Weights | α = 1 for all three | `[0.5, 3, 2]` — relevance 3, importance 2, recency 0.5 | shipped |
| Recency | decay over elapsed hours | `decay ** rank` over the recency-ordered list | shipped (rank) |
| Decay base | 0.995 | 0.99 | shipped |

Rank-based recency removes "how long is an hour" from a system with no
simulated clock, and it is immune to a burst of writes compressing every
timestamp into one afternoon.

**One addition of our own:** a `BASE_FLOOR` under the weighted sum. Min-max
normalisation maps the worst candidate on each axis to exactly 0, and zero
times any multiplier is still zero — so a note that is last on all three
could never be lifted by its own track record, however often it had proved
useful. That is an artefact of normalising to [0,1], not an intent, and the
floor is sized at the recency weight so reinforcement can overcome a recency
deficit but never a real relevance gap.

**A known property, pinned in a test so nobody debugs it twice:** min-max is
relative to the candidate set, so with *two* candidates a 0.05 cosine gap
becomes the entire spread. Harmless at the real candidate count; surprising in
a two-row unit test.

### Forgetting: decay, never deletion

`retention = e^(−t / S)`, `t` = days since last recall, `S = 1 + times
recalled` (MemoryBank). Each recall both resets `t` and flattens the curve.

Applied as a **read-time multiplier clamped to [0.3, 1.5]** (Mem0's published
band), never as a delete. A note that stops being useful fades out of the
prompt and stays in the table, so a scoring change destroys nothing and "what
did we know, and when" stays answerable. A never-recalled note is *not*
punished — otherwise the store is self-confirming and only what was already
surfaced could ever surface again.

This is the mechanism the shipping systems converged on: Copilot Memory
deletes a memory unused for 28 days and **resets that clock on every
successful use**. We keep the reinforcement and decline the deletion.

## What the industry actually does (and what we took)

Surveyed: GitHub Copilot Memory + custom instructions, VS Code agent memory,
Cursor Rules and Memories, ChatGPT and Claude memory, Windsurf Cascade, Devin
Knowledge.

| Consensus mechanism | Us |
|---|---|
| **Two tiers: a small always-injected block + a larger retrieved store** | Yes — pins are the always-carried core, recall fills the rest. Lessons are always-injected by design (see below) |
| **Caps on the always-on tier, published** (2 pages, 6 000 chars, 500 lines, 200 lines) | 1 800 chars memory, 1 600 chars lessons |
| **The retrieval cue is authored apart from the payload, and it is prose** (Devin's `trigger description`, Cursor's `description`, Windsurf's `model_decision`) | **Not adopted** — our notes are one or two sentences, so the note *is* its own cue. Adopting it would mean asking a model to write a "when to recall this" line for a sentence |
| **Decay by non-use, clock reset on use** | Yes, as a multiplier rather than a delete |
| **Validation before use — memory is a claim, not a fact** (Copilot re-checks repo facts against the branch and uses only validated ones) | **Partially** — memory carries `verification` and the prompt weighs `user_confirmed` differently, but nothing re-checks a note against its source. This is the biggest unclosed gap; see below |
| **Write is agent-initiated, review is post-hoc; approval is the exception** | Yes — memory writes autonomously and is curated in the panel; lessons activate automatically unless the auditor flags them |
| **Consolidation is unsolved industry-wide** — nobody publishes dedup, and Cursor's own guidance is a monthly manual audit | This is exactly where we spent the machinery |

Two things worth stating plainly because they cut against the obvious
assumption:

- **Almost no production coding-agent memory system uses vector search for
  serving.** ChatGPT does not RAG its own history; it precomputes a profile and
  injects it. The dominant selection mechanism is *a model reading a menu of
  short descriptions*. Our use of embeddings is concentrated on
  **consolidation**, which is where the industry has no answer at all.
- **Memory turns a one-shot prompt injection into persistent state
  corruption** (MINJA, MemoryGraft, and the 2026 "Ask AI" trusted-source
  attacks, which found payloads that cross both model and memory-architecture
  boundaries). Only two shipping systems have a structural defence: Copilot's
  citation validation and Claude's write-path content blocklist. Ours is the
  lesson pipeline's four anonymization layers plus the meta-only rule; project
  memory's is the reflection stage's PII denylist and the prompt's explicit
  "these are notes, not facts, and the conversation outranks them".

## Why lessons are still always-injected

Unchanged from
[`platform-failure-learning.md`](platform-failure-learning.md), and the
research strengthened rather than weakened it: retrieval is the *evidence*
channel and a lesson is *briefing*; a retrieval miss on a lesson is not a worse
ranking but the silent recurrence of the failure the register exists to
prevent; and the active set is capped at 20 by construction, which is not a
corpus. Embeddings entered lesson handling at the **matching** stage, which is
where the actual defect was.

## Honest gaps

- **No re-embedding job.** A note written while the embedder was down, or
  before a model change, stays on the lexical path until it is rewritten.
  `listLessonsMissingEmbedding` exists for the backfill; nothing calls it yet.
- **No validation-before-use.** Copilot's strongest idea — a memory cites
  file:line, is re-checked against the current branch, and only validated facts
  are used — has no analogue here. The nearest version for this product would
  re-check a `source_grounded` memory against the passage it came from. Not
  built.
- **Hybrid retrieval is not wired for notes.** The document pipeline already
  fuses BM25 + dense with RRF (k=60) and reranks; note recall is dense-only.
  For a domain this full of exact identifiers ("OIB-RL 6", "§ 4 Abs. 2") the
  research is emphatic that hybrid beats pure-dense — and Postgres can supply
  the lexical arm with `tsvector`. This is the highest-value next step.
- **Importance is a stored constant.** `salience` defaults to 0.5 and only a
  human changes it; nothing elicits it at write time the way Generative Agents
  rates poignancy 1–10. The term is in the formula and mostly flat in practice.
- **Effectiveness attribution is correlational by default.** See the holdout
  section in [`platform-failure-learning.md`](platform-failure-learning.md):
  the counters are a temporal correlation, the holdout is the credible measure,
  and at low traffic it is under-powered.

## Where things are

| Concern | Path |
|---|---|
| Embedding client (fail-open) | `frontends/ui/src/lib/knowledge/embeddings.ts` |
| Scoring, decay, reinforcement | `frontends/ui/src/lib/knowledge/recall-scoring.ts` |
| Consolidation primitives (Jaccard, polarity) | `frontends/ui/src/lib/knowledge/consolidation.ts` |
| Bounded injection-safe digests | `frontends/ui/src/lib/knowledge/digest-format.ts` |
| Memory recall + semantic dedup | `frontends/ui/src/lib/projects/memory-service.ts` |
| Lesson semantic matching | `frontends/ui/src/lib/platform-lessons/repository.ts` |
| Backend embedding endpoint | `frontends/aiq_api/src/aiq_api/routes/note_embeddings.py` |
| Cosine in SQL + columns | `frontends/ui/drizzle/0069_semantic_notes.sql` |
