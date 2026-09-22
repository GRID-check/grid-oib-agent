---
status: proposed
date: 2026-09-22
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# A decision model decides before the answer, and may only add to the turn

## Context and Problem Statement

A chat turn pays generative frontier calls for questions that are not
generation. The retrieval loop's judge answers "is the head of this pool
enough" — a yes/no — with a frontier call on every search
(`requery_llm: rerank_llm`, the default model at reasoning `none`), and the
turn's first LLM call is spent deciding what the question needs before
anything has been read: which corpus, which Richtlinie, whether to read at
all. The turns audit (`docs/architecture/turns-per-answer-audit-2026-09.md`)
found the search-before-reading round on every researched shape and the
judge on every search.

TypeSafe's Jev, released 2026-09-15 and on OpenRouter's alpha Decisions
endpoint since 2026-09-18, is a model that does not generate: it takes a
state and typed questions (a yes/no, a choice of up to 255, a level on a
rubric) and returns calibrated probabilities in 70–500 ms for $0.042 per
million input tokens. That is the shape of every decision above.

ADR-0052 deleted the intent classifier that ran before every turn, and its
argument was not speed: "a label decided before the answer can only ever
withhold capabilities the answer turns out to need". A 70 ms classifier that
withholds is that classifier again, faster. So the question is not whether
to decide before the answer; it is what a decision may DO.

## Decision Drivers

* ADR-0052: nothing decided before the answer may withhold a tool, a corpus
  or a round.
* The vendor's documented edges: German is "accepted but currently [of]
  lower accuracy"; large unrelated state degrades accuracy; adversarial text
  in the state can move the answer; the endpoint is alpha.
* A hidden call is a cost and a latency the reader cannot see; the technical
  channel must show every decision as numbers.
* An org that enforces ZDR routing, or brings a key that is not
  OpenRouter's, must not be sent to a third-party endpoint.

## Considered Options

1. **No decision model.** Keep the judge on every search and the first round
   as the model's own decision.
2. **A decision model that routes**: intent, corpus, tool set, model tier
   (the uses every write-up leads with).
3. **A decision model that may only add**: prefetch, attach, inline, judge a
   yes/no that a generative call already answered — and never withhold.

## Decision Outcome

Chosen option: **3**, under one rule and four uses.

**The rule.** A decision runs beside something the turn is already doing, is
bounded (1.5 s, a circuit breaker after five failures), returns `None` on any
failure, and every caller treats `None` as "run as today". No caller may drop
a tool, a corpus, a round or a passage on a decision. The state is built from
structured fields the caller chose — the question, the confirmed project
facts, the inventory's families, a passage's text — never from the transcript.
Every decision leaves `status:decision:<slot>` on the technical channel with
its answers as numbers, its latency and, when it did not run, why; its cost
is on the ledger under the `decision` role (`common/decisions.py`).

**Use 1 — the turn-start decision** (`agents/piloti/decisions.py`,
`register.py::_decide_turn`). One request beside the skill resolution:
`needs_evidence`, `corpus` (baurecht / projekt / buero / modell / none), one
noul per Richtlinien-Familie the corpus holds, one noul per content card
type the taught envelope does not already carry, and `model`. What the
answers may do: the question and the top families' overviews run as
**round 0** before the first LLM call (`PilotiAgent._prefetch_node`, the
graph's entry node), through the real tools node — announced as
`status:retrieval:0`, captured, stamped, drawn in the Herleitung, answered
by the duplicate-fetch guard when the model asks again, and **charged to no
round**, because no LLM decision was spent on it; the two most likely card
types get their full shape in this turn's prompt; a model question reads
the one skill body too long to ride the prompt (`ifc-spatial-reasoning`,
ADR-0063) into this turn. Every tool stays bound whatever it says.

**Use 2 — the judge's yes/no** (`knowledge_layer/decisions.py`,
`requery_decider: jev`). One noul per passage of the fused head — "does this
passage state the governing statement the question needs" — beside the
reranker; the head is sufficient when any passage reaches the threshold
(0.55, swept by the eval), and only an insufficient head runs the generative
judge, for the phrasings a decision model cannot write. The same pass asks
whether a passage carries instruction-like text; a flagged passage is
recorded (`status:decision:passage_injection`), never dropped.

**Use 3 — a reranker that is a decision** (`reranker_provider: jev`). One
noul per candidate, sorted by it. An option beside the cross-encoder, not the
default: the vendor's own legal-retrieval numbers (top-1 5 % → 18 %, top-10
38 % → 62 %) are a useful reranker's, not a trained cross-encoder's, and the
golden set decides.

**Not a use.** Intent or model routing, the escalation decision, confidence,
verdict extraction, anything whose wrong answer removes a capability
(ADR-0052, unchanged). Card selection and skill suggestion, which the audit
had listed, were answered without a decision model: the eight common card
shapes and the nine chat skills are cheap enough to sit in the prompt
(`cards/envelope.py`, ADR-0063).

**The adoption gate.** `scripts/decision_eval.py` (`task be:eval:decisions`)
runs the turn-start questions over the loop-eval set — German, the family
each row names — and holds three floors: family top-1 ≥ 85 % on the OIB rows,
corpus `baurecht` on ≥ 90 % of the regulation rows, and `needs_evidence`
never below 0.5 on a ruling row. Below them, `turn_decisions: false`.

**Measured 2026-09-22** from the branch that introduced this, committed as
`tests/fixtures/herleitung/decision_eval_2026-09-22.csv`: 27 of 27
decided; family top-1 **1.00** (the expected family's probability ran
0.54–0.97; no Bauordnung row's top family passed 0.49); corpus `baurecht`
on **1.00** of the regulation rows and `projekt` (0.91) on the one
project-file row; `needs_evidence` 0.81–0.97, the ruling floor held; latency
467–899 ms, mean 614 — above the vendor's 70–500 ms envelope, inside the
1.5 s bound. The family threshold is 0.5 because the sweep put recall at
1.00 there and at 0.90 at 0.6, both at precision 1.00. The card nouls are
weaker: six of 27 rows put a type over 0.6, two of them doubtful
(`change_impact` on the high-rise question, `calculation` on a parking
question) — harmless, since a shape attached is only a shape, and the
reason the card threshold stays at 0.6. The judge use is measured live by
the loop eval's `judge_calls` column once it exists (audit §8 row 1).
Nothing here rests on a calibration study, because there is none yet; the
numbers above are one run on German questions the product actually gets.

### Consequences

* Good, because the search-before-reading round is gone on the shapes the
  prefetch hits, and a miss costs one unread grounding block rather than a
  capability.
* Good, because the frontier judge runs on the insufficient minority of
  searches instead of all of them, and a flagged upload is visible.
* Good, because "which OIB documents does this question need" is now a
  question the platform asks and records, per turn, in numbers.
* Bad, because a turn now depends on an alpha endpoint's latency for up to
  1.5 s at its start — measured 467–899 ms, mean 614, which is ~0.6 s the
  first LLM call waits for beside the skill resolution, bought back by the
  round the prefetch removes only when the prefetch hits. The breaker and the timeout bound it; the eval and
  the technical record are how an operator sees it.
* Bad, because a prefetch that misses spends a search, its judge and ~2–4k
  tokens the model reads for nothing. `needs_evidence` and the corpus
  threshold are the gate, and the loop eval's `prefetch_wasted` column
  (audit §8) is the measurement to add.
* Bad, because a decision model is one more thing a prompt engineer cannot
  see: its criteria live in `decisions.py` in English, and a change to them
  is a change to what the turn prefetches.
* Neutral, because an org without the key, with ZDR, or with a foreign BYOK
  key gets every turn exactly as before, and the record says so.

### Confirmation

- `tests/aiq_agent/common/test_decisions.py`: the wire contract, `None` on
  every failure, the breaker, ZDR and BYOK skips, the ledger row.
- `tests/aiq_agent/agents/piloti/test_turn_decisions.py`,
  `test_register_decisions.py`: the question set, the bounded state, the
  mapping to effects, and that a decision that did not run changes nothing.
- `tests/aiq_agent/agents/piloti/test_prefetch_round.py`, through the
  compiled graph: round 0 runs before the first call, costs no budget, is
  drawn as `status:retrieval:0`, answers the model's repeat, and never runs
  for an unbound tool or a switched-off source.
- `tests/knowledge_layer_tests/test_decisions_in_retrieval.py`: a sufficient
  head costs no judge call, an absent decision runs the judge, a flagged
  passage is kept, the reranker's order.
- `tests/test_decision_eval.py`: the adoption gate's arithmetic;
  `tests/fixtures/herleitung/decision_eval_2026-09-22.csv`: its last result.

## Pros and Cons of the Options

### 1. No decision model

* Good, because nothing new can fail.
* Bad, because the audit's two structural costs — the judge on every search
  and the round before anything is read — stay.

### 2. A decision model that routes

* Good, because it is what the model is marketed for, and fast.
* Bad, because it is the classifier ADR-0052 deleted, and every misroute it
  fixed would return at 70 ms.

### 3. A decision model that may only add

* Good, because a wrong answer costs tokens and never a capability, so the
  eval can be run in production rather than before it.
* Bad, because "only add" is a discipline held by review and by the tests
  above; nothing in the type system stops a future caller from reading
  `None` as "no".

## More Information

- Wire contract: OpenRouter, *Decisions* (alpha),
  `POST https://openrouter.ai/api/alpha/decisions`, model
  `typesafe/jev-1.13`; TypeSafe docs (*HTTP API*, *State*, *Choice*, *Jev
  1.13 jaggedness*, the *re-ranking* and *RAG passage classification*
  cookbooks) — all read 2026-09-22, cited in the turns audit §9.
- Amends the turns audit §4 (J1 and J2 shipped; J3 and J5 answered without
  a decision model).
- Related: ADR-0052 (no router), ADR-0060 (three instruction layers),
  ADR-0063 (short skill bodies ride the prompt).
