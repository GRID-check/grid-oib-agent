---
status: accepted
date: 2026-09-29
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# A coverage gap is stated in the block, never enforced on the pool

## Context and Problem Statement

`knowledge_search` fills `top_k` with whatever it found. A question the corpus
cannot answer still gets sixteen formatted excerpts, and the model reads them
as evidence: fill@16 is 1.000 on the golden set's should-refuse rows
([rag-system-audit-2026-08.md](../architecture/rag-system-audit-2026-08.md)
§20). A cosine floor cannot separate the two cases, because the top-1
similarities overlap: 0.799 to 0.933 for answerable questions, 0.795 to 0.865
for should-refuse ones.

A model that reads the question against each passage can tell them apart, and
the search already asks one. [ADR-0064](0064-a-decision-model-decides-and-never-withholds.md)
put the `jev` decider behind the requery judge (`decisions.passage_verdicts`,
p(answers) per passage). This record covers a new use of that decider: its
verdict over the pool the model will actually get.

## Decision Drivers

* A decision may add to the turn and may never withhold a passage (ADR-0064).
* A verdict the model reads before the passages beats one it infers from a
  score it never sees.
* A decision that did not run, or ran on only part of the pool, must claim
  nothing. Missing evidence is not an absent answer.
* No new threshold without a measurement behind it.

## Considered Options

1. **Do nothing.** The model keeps reading nearby text as evidence.
2. **Drop the pool** when the decider says nothing answers, and return "no
   results".
3. **State the verdict in the block** and keep the pool whole.
4. **A rerank-score floor** on the Cohere relevance scores.

## Decision Outcome

Chosen option: 3, **state the verdict, never enforce it**.

* **When it runs.** Only when the requery judge already found the first pool
  insufficient, after the requery round has widened and reranked it
  (`requery.judge_coverage`, called from `_coverage_gap` in `register.py`), and
  only with `requery_decider: jev`. A pinned file, a Richtlinie family
  overview, a skipped judge and a degraded pool (a layer dropped out and may
  hold the answer) are not judged.
* **What it reads.** The delivered pool, best first, up to 24 passages
  (`_COVERAGE_MAX_JUDGED`), in one decider batch, with the question and the
  threshold of the first pass.
* **The threshold is reused.** `decision_sufficiency_threshold`, default
  `DEFAULT_SUFFICIENCY_THRESHOLD` (0.55), the same number the judge already
  uses. No second knob.
* **What it says.** A complete "no", every judged passage below the threshold,
  sets `GroundingBlock.coverage_gap`. The preamble then reads `Found N
  document(s); none of the judged ones answers the question:` instead of
  calling the hits relevant, and one line under it, before any passage, reads
  `Abdeckung: unzureichend — keine der N gezeigten Passagen enthält die
  gesuchte Aussage (…)`. For a pool longer than 24 it reads `keine der 24
  besten Passagen …; die übrigen K Passagen wurden nicht geprüft`, so the
  claim covers the judged passages only. The parenthesis gives the best
  probability and the threshold, and the line says whether the search was
  reworded. Anything less than a complete "no" renders nothing.
* **Nothing is removed.** Every passage still reaches the model, and the
  citation registry reads the same records. ADR-0064 is untouched.
* **The prompt names the label.** `COVERAGE_GAP_LABEL` in
  `grounding_block.py` is the one spelling, and `piloti_static.md`
  `<research_rules>` tells the model what to do with it: say no supporting
  passage was found, name what was searched, answer from none of the
  passages, and do not call it „Nicht geregelt“, because the rule may sit in
  a source this search does not cover.

### Consequences

* Good, because an unanswerable question gets an honest "found nothing that
  states this" instead of an answer built from loosely related text.
* Good, because the pool stays whole: a wrong "no" costs a hedge the model can
  read past, not a passage the model never sees.
* Good, because it costs nothing on a pool the judge accepted, and one decider
  batch on a pool it did not.
* Bad, because the model can ignore a stated verdict. Only the prompt rule and
  the answer suite stand between the line and an answer that uses the
  passages anyway.
* Bad, because a false "no" on an answerable question now reads as a refusal
  prompt. The threshold was chosen for "is the head enough", not for "does
  anything answer", and nothing has measured it for the second question.
* Neutral, because this changes what shapes an answer, so the root obligation
  applies: `task be:eval:answer-suite` before and after, with the report in
  the PR.

### Confirmation

* `tests/knowledge_layer_tests/test_decisions_in_retrieval.py`: every passage
  below the threshold is a gap, one passage that answers is none, an
  unwidened gap claims no rewording.
* `tests/knowledge_layer_tests/test_requery.py`: a coverage decision that did
  not run claims nothing, and a pinned file is never judged.
* `tests/aiq_agent/common/test_grounding_block.py`: the gap is the line under
  the preamble before any passage, no gap renders no line, and the gap does not
  change what the reader registers.
* The answer suite, by hand, before and after. It must show that no question in
  the core set, all of them answerable from the OIB corpus, gets the
  `Abdeckung: unzureichend` line or an answer that says nothing was found. The
  suite has no should-refuse question today, so it cannot confirm the positive
  case; review of a traced unanswerable turn is the only check for that.

## Pros and Cons of the Options

### Drop the pool

* Good, because the model cannot answer from passages it never sees.
* Bad, because it withholds, which ADR-0064 rules out: a wrong "no" loses the
  passage that answered, silently.

### Rerank-score floor

* Good, because the scores are already computed and cost nothing more.
* Bad, because nothing in this repository measures them against labelled
  answerable and unanswerable questions, and the scores are not carried past
  the reranker. A floor without that measurement is a guess.

## More Information

Revisit when the answer suite gains should-refuse questions, which is what
would let the threshold be set for this question rather than borrowed, and when
rerank scores are carried and measured, which would make option 4 a real
candidate.

The code-level rule for producers: [`sources/AGENTS.md`](../../sources/AGENTS.md).
