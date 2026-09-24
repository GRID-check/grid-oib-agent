# Chat-turn latency, measured (2026-09-24)

> Where a chat turn's seconds actually go, with numbers from the answer suite
> and a millisecond probe, and what was changed because of them. The companion
> [`latency-and-caching-audit-2026-09.md`](latency-and-caching-audit-2026-09.md)
> ranked the drivers structurally, from the code, and said the ranking was
> waiting on measurement (its §5). This is that measurement for the chat turn,
> read on 2026-09-24 against branch `claude/pr-725-review-fixes-d2wnzy`
> (`deddced8` to `fdb57f4c`). It is a record of that date: re-measure before
> acting on a number (§8).

## 1. Verdict

**A median chat turn takes 31.3 s, and 56% of that is the final answer call**,
most of which is the model thinking before its first token. Since ADR-0066
streams the prose, the reader sees the first word at about 12-14 s; the rest
is the answer being written in front of them.

What that means for the levers:

* **Reasoning effort is the largest single lever and it is not free.** At
  `low` the median turn halves (32.1 → 15.5 s) and the checks drop from 76/80
  to 69/80: the envelope is lost twice, a requested table is not drawn, and
  answers are a quarter of the length (§5). `medium` stays.
* **Search rounds are already mostly parallel.** What remains sequential is
  dependent (search, read the hit, look at its table). One avoidable round,
  a list of RIS paragraphs fetched one per round, is fixed (§4).
* **Before the first model call a turn spends about 3.4 s**, or 5.8-6.7 s on
  the ~30% of turns whose first retrieval is judged insufficient and searched
  again. The query embedding now runs beside the turn decision instead of
  after it (§3); the requery is the biggest startup cost left.
* **The repair pass does not move the median** either way: in two full suite
  runs it never ran (ADR-0067). It matters on the rare turn that fails
  verification, where it now costs one small call instead of 15-25 s.

## 2. Where a turn's time goes

All 27 suite questions, one run each, from the main checkout with the document
inventory in place (§8 says why that matters: without it the median was
38.5 s, and 42 s in the earlier worktree runs).

| Slice | Median per turn | Share |
|---|---|---|
| Final answer call (the `/responses` call that writes the envelope) | 16.2 s | 56% |
| &nbsp;&nbsp;of which thinking before the first token | ≈ 12-14 s | |
| Research-round model calls (each round's decision to search again) | 5.7 s | |
| Round 0: turn decision, prefetch retrieval, sufficiency, requery | 3.7 s | |
| Tool execution (embedding, Chroma, rerank, RIS) | 1.3 s | |
| **Whole turn** | **31.3 s** | |

A fix to the reasoning pass-back landed alongside this and did not change these
numbers: langchain-openai 1.2.2 dropped the model's encrypted reasoning items
from a *streamed* Responses call (it had no handler for
`response.output_item.done`), so every tool round started its thinking from
nothing. 1.6.6 keeps them (`a0ec99d2`, `uv.lock`), and the items now reach the
next request. In a four-question check the thinking time did not drop. It is
kept because it is correct, not because it was faster.

## 3. Before the first model call

The seconds between the message arriving and the first `/responses` request.
Measured with [`scripts/turn_census/startup_probe.py`](../../scripts/turn_census/startup_probe.py),
which prints every provider call and the retriever's phases in ms relative to
the turn's start, and cross-checked against the round-0 spans of the suite
logs.

### 3.1 The sequence

```
t=0  ┬ turn setup (~20 ms)
     ├ gather( draft tools │ turn decision (Jev) │ provider reads )      decision 0.2-0.9 s, median 0.54 s, p90 0.62 s
     │ ── since fdb57f4c: the question's embedding starts here, beside the decision ──
     ├ prefetch: knowledge_search(question) + knowledge_search("OIB-Richtlinie N") per chosen family
     │   ├ query embedding (text-embedding-3-large, remote, synchronous)   280-980 ms per query
     │   ├ Chroma vector + lexical boost                                  50-230 ms
     │   ├ rerank (cohere/rerank-v3.5)          ┐ in parallel              0.6-1.0 s
     │   └ sufficiency: ~12 Jev passage verdicts┘                          ~0.6 s (tail to 1.3 s)
     ├ only when the verdicts say "insufficient" (7/25 and 8/21 turns in two suites):
     │   ├ requery writer (rerank_llm, reasoning none)                     1.7-3.6 s
     │   └ second retrieval + rerank                                       ~1-1.8 s
     └ first /responses call
```

| | Median to the first model call |
|---|---|
| No requery (~70% of turns) | 3.2-3.6 s |
| With requery (~30%) | 5.8-6.7 s |
| First turn of a fresh process | +0.9-1.5 s of lazy initialisation |

One traced example (warm process, the barrier-free question): decision
19-252 ms, prefetch rerank 287-956 ms, verdicts 1011-2323 ms, insufficient, so
requery writer 2326-4274 ms, second rerank 5064-6120 ms, first model call at
6141 ms.

### 3.2 Landed: the question's embedding runs beside the decision (`fdb57f4c`)

The prefetch's search string is known at turn start (the question, whitespace
folded, 300 characters: `decisions.prefetch_query`), but its embedding was
only requested once the decision had named the search. Now:

* `agents/piloti/register.py::_warm_question` starts
  `knowledge.factory.warm_search_query` beside the decision gather, not
  awaited. It warms the retriever the knowledge tool was built with
  (`set_search_retriever`, set at tool build time), with the query the tool
  will send (`augmented_query`).
* The adapter's embedding LRU dedupes a computation in flight
  (`_embed_query_cached`): a search that starts before the warm-up finished
  waits for it instead of embedding the same string again. A failed warm-up
  hands over to the waiting caller.
* A turn that turns out not to search has wasted one embedding call.

Measured with the probe: the warm-up starts at 18-19 ms and the search reuses
it. The saving is bounded by the decision's duration: 0.1-0.25 s on turns with
a 200-280 ms decision, ≈ 0.4-0.5 s at the median decision. On a cold process
the warm-up also absorbs part of the adapter's lazy initialisation.

Tests: `tests/knowledge_layer_tests/test_query_warm_up.py` (one embedding for
three concurrent callers, the take-over after a failure, the warm-up leaves the
vector where the search reads it, never raises);
`tests/aiq_agent/agents/piloti/test_register_decisions.py` (the warmed string
is the prefetch's own; switched-off decisions warm nothing).

### 3.3 Checked and not worth doing

* **Ending the sufficiency check on the first "sufficient" verdict.** The
  median saving over the suites is 0.07 s (max 0.79 s): the verdicts mostly
  finish together.
* **Warming the whole retrieval, not just the embedding.** The static result
  cache stops before the rerank, which is the other half of the cost, and
  a rerank's candidate set includes the session collection, so a speculative
  rerank would rarely match. The embedding is where the waiting was.

### 3.4 Open

| Lever | Expected saving | Cost / risk |
|---|---|---|
| Start the requery writer beside the verdicts, discard it when they say "sufficient" | ~0.6 s on the ~30% of turns that requery | one small-model call on the other ~70% |
| Drop the round-0 requery and let the agent search again in its own round | ~3 s on ~30% of turns | changes answers; needs a suite before/after |
| Warm the adapter at worker boot | 0.9-1.5 s on a process's first turn only | none; matters only with frequent restarts |
| Embed the family branch's per-document lookups without a query | ~0.6 s the first time a family is asked in a process | small; the lookups already cache per process |

## 4. Search rounds

What the rounds send, read off the suite's tool calls:

* **Mostly one query per round**, although parallel tool calls are on. A
  typical second round is `knowledge_search("OIB-Richtlinie 2 Gebäudeklasse 4
  Fluchtweg Wohnungseingang bis ins Freie zulässige Gehweglänge")`, then a
  `read_passage` of the hit.
* **The prefetch already covers the first search.** 7 of 21 answers needed no
  research round beyond round 0, and when the model opens several passages it
  does so in one round.
* **What stays sequential is dependent**: search, read the hit, then the table
  the hit points to. Running those in parallel would mean guessing.
* **Overview questions** ("Was regelt die OIB 4?") walk the Gliederung round
  by round when the family overview is missing. With the inventory in place,
  `knowledge_search("OIB-Richtlinie N")` returns every member's scope and
  Gliederung in one block and those rounds disappear.

Fixed (`e94af899`): **a list of RIS paragraphs was one round per paragraph.**
`§§ 75 und 81 BO für Wien` returned § 75 only and left „und 81" glued to the
law's name, so the catalogue lookup ran on a garbled title and the model spent
another round (11 s in the building-height question) fetching § 81. Now
`Address.sections` carries every paragraph a list names (`§§ 2, 3`,
`§ 5 und § 7`, ranges up to six), extraction reads them all from the one
downloaded law, and the tool description asks for every paragraph in one call.

Open:

* **`use_skill` round trips**: a full model call (2-3 s) only to load a skill.
  The turn decision already picks a skill and inlines it
  (`_apply_decisions`); a skill it did not pick still costs a round.
* **A truncated RIS paragraph** makes the model fetch it again.
* **Guidelines the corpus lacks** (RL 1 and RL 5 in this container) took 5-7
  futile rounds, 20-30 s, before handing off. That is an artefact of a partial
  corpus, and the suite now skips such questions (`not_in_corpus` in its
  report); in a deployment with a partial corpus, the inventory in the prompt
  is what should stop the search.

## 5. The final call: reasoning effort A/B

Same commit (`deddced8`), same inventory, all runnable questions (25), one
run each; the only change is `--override llms.research_llm.reasoning_effort low`.

| | `medium` (shipped) | `low` |
|---|---|---|
| Median turn | 32.1 s | **15.5 s** |
| Median final call | 14.9 s | 5.4 s |
| Median first text | 27.4 s | 12.4 s |
| Median reasoning tokens | 1284 | 0 |
| Median output tokens | 2204 | 535 |
| Median research calls | 2 | 1 |
| Checks held | **76/80** | 69/80 |

What `low` lost, beyond the four `kind` checks both runs miss:

* **The envelope, twice** (`feuerwiderstand-gk5`, `treppenhaus-gk4-tabelle`):
  plain Markdown with a source list, no masthead, no `kind`, no cards.
* **A requested table** (`treppenhaus-gk4-tabelle`, `shape:table`).
* `kind` on `feuchtigkeit-erdberuehrt` and `stellplatz-tirol`.
* **Depth**: answers are a quarter of the length, with fewer searches behind
  them (`was-regelt-oib-4`: 37.6 → 11.0 s, four searches → one). Some of that
  is welcome brevity; the checks cannot tell which.

**Decision: `medium` stays.** A blanket `low` trades the envelope contract for
speed. The YAML's `medium` is a deliberate floor
(`configs/config_oib_openrouter.yml`, the `research_llm` comment), and the
live level is the platform owner's, per agent group, in Platform → Models
([`org-model-configuration.md`](org-model-configuration.md#thinking-level-reasoning-effort)):
moving it is a save, not a commit, and this table is what that save trades.
The open question is a **per-turn effort**:
`low` for a lookup the turn decision is confident about, `medium` otherwise.
That needs the decision to carry the signal and a suite run that holds the
envelope checks at 100%.

## 6. The repair pass

[ADR-0067](../adr/0067-the-repair-corrects-a-misremembered-quote-in-place.md)
replaced the whole-answer rewrite with an in-place quote correction. In both
suite runs before and after it (42.0 → 42.7 s median, inside run-to-run
noise), the repair never ran: no answer had a patchable misquote. It does not
move the median; it bounds the tail, one small-model call of at most 8 s
instead of a frontier rewrite and two retrievals (16 s and 23 s in the audits'
recorded cases).

## 7. Open levers, ranked

| # | Lever | Expected saving | Status |
|---|---|---|---|
| 1 | Per-turn reasoning effort (`low` for confident lookups) | up to ~10 s on the turns it applies to | open; needs the decision signal and a suite |
| 2 | Round-0 requery: writer beside the verdicts, or drop it | 0.6 s or 3 s on ~30% of turns | open; the second changes answers |
| 3 | `use_skill` preloading for skills the decision did not pick | 2-3 s per such round | open |
| 4 | Warm the adapter at boot | 0.9-1.5 s, first turn per process | open |
| 5 | Question embedding beside the decision | ≈ 0.4-0.5 s per searching turn | **landed** `fdb57f4c` |
| 6 | RIS paragraph lists in one call | one round (≈ 11 s) where it applied | **landed** `e94af899` |
| 7 | Reasoning items kept across tool rounds | none measured | **landed** `a0ec99d2`, kept for correctness |

## 8. How these numbers were taken, and how not to take them

* **The answer suite** (`task be:eval:answer-suite`,
  `scripts/turn_census/suite.py --all --runs 1 --workers 4`) runs each question
  in its own process from the working tree. Measure a committed, clean tree:
  the report's header names the commit, `-dirty` when it was not clean. One
  baseline in this series was corrupted by editing code mid-run.
* **Run it where the document inventory is.** `AIQ_SUMMARY_DB` defaults to
  the relative `./summaries.db`, so a `git worktree` read an empty inventory:
  no document list, no family overviews, 7 s more per turn. The ADR-0067
  before/after numbers (42 s) carry that handicap on both sides. The suite now
  refuses to start on an empty inventory.
* **The startup probe** (`scripts/turn_census/startup_probe.py`) runs its
  questions in one process, so the first question is a cold process and the
  rest are warm. From a worktree, shim `knowledge_layer` onto `PYTHONPATH`
  first (`docs/contributing/gotchas.md`): the first probe run of the warm-up
  measured the main checkout's knowledge layer and showed no effect.
* **One process at a time on the Chroma directory.** A probe and a suite
  against the same `/tmp/chroma_data` produced Chroma errors in both.
* Every figure here is from one run per question, on one day's provider
  latency. Differences of a second or two between runs are noise; the effort
  A/B (16 s) and the startup timings (hundreds of ms, repeated across turns)
  are not.
