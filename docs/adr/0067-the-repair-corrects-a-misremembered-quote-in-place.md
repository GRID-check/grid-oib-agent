---
status: accepted
date: 2026-09-24
decision-makers: Grid engineering
consulted:
informed:
---

# The repair corrects a misremembered quote in place, and nothing else

## Context and Problem Statement

When the answer failed verification (a `[N]` whose source line did not
resolve, or a quote no retrieved passage holds verbatim), one repair ran
(`agents/piloti/repair.py`, roadmap L0). It retrieved up to twice more, then
asked the frontier model, with the full history, to rewrite the whole answer.
The rewrite was adopted if it verified better. That cost 10-25 s
(`turns-per-answer-audit-2026-09.md`: 16 s and 23 s).

Since ADR-0066 the reader has the answer's prose, settled and verified, before
the repair runs. An adopted rewrite therefore replaced every byte of an answer
the reader had already read. Recorded live, a settled answer citing nine
sources was replaced 22 s later by one citing two. A card's `[N]`, written
against the original's source list, was read against the rewrite's. Every
repair the audits traced came from a verifier or grammar defect, fixed
upstream, not from the model misquoting. The research behind this decision is
`docs/architecture/repair-pass-alternatives-2026-09.md`.

## Decision Drivers

* A citation or quote that did not verify is never shown as real.
* Once the prose settles, the text the reader is reading stays put.
* A repair must be cheaper than the answer it repairs, and bounded in time.

## Considered Options

* Keep the whole-answer rewrite, with a guard against losing sources.
* Drop the repair; ship the markers only.
* Correct only a misremembered quote, in place, against the passage it came from.
* Prevent citation failures structurally (cite passages by id; the pipeline writes the source list).
* Keep the rewrite and label the swapped answer as revised.

## Decision Outcome

Chosen option: "correct only a misremembered quote, in place", because it is
the one failure where a repair buys the reader something (the passage exists,
the wording is off), and it can be done without moving anything the reader has
read.

* **A removed citation is not repaired.** The settled snapshot has already
  dropped it where the reader can see. Putting one back later is the swap
  again.
* **A quote no passage holds verbatim**, when it comes close to its nearest
  passage (`closeness` ≥ `PATCH_FLOOR` = 0.7), goes with that passage to the
  small card model (`card_repair_llm`). One call per quote, no history, no
  tools, no retrieval, at most three per answer, each within 8 s. The call
  returns the passage's own wording.
* **The correction comes only from a source the sentence cites.** The passage
  a quote is patched against is the nearest one among the sources its own
  sentence cites, never the nearest anywhere in the turn's registry. The
  Bundesländer's building codes hold near-identical sentences, so the nearest
  passage overall can be another Land's, and patching against it would put
  that Land's wording under this one's citation.
* **The correction is kept only if it is in the passage verbatim**, normalised
  as the verifier normalises. The verifier's fuzzy threshold is not used here,
  because a corrected "2,50 m" clears it against a passage saying "2,10 m". The
  correction must also stay similar to what was quoted. Only the text between
  the quotation marks is replaced, so every `[N]`, card number and other byte
  stays as it was. What ships is verified again. A quote that was not corrected
  keeps its marker, which is the floor.
* **An attribution failure (`too_long`, `uncited`) keeps its marker.** It is not
  a wording problem.

`quote_patch.py` replaces `repair.py`. `repair_pass` stays the off switch, and
without `card_repair_llm` the repair is off.

### Consequences

* Good, because the only text that can change after the prose settles is the
  inside of one quotation, and the reader sees the passage's own words there.
* Good, because a repair costs one small call instead of a frontier call and
  two retrievals. Removed-citation failures cost nothing.
* Good, because the card-number mismatch and the repair's reads that no ledger
  showed are gone with the rewrite.
* Bad, because a claim resting on a citation that did not resolve is no longer
  re-sourced; it ships without the citation. If such failures turn out to be
  frequent, the structural option is the fix, and it needs its own ADR.
* Bad, because the model no longer sees its failed check as an observation
  (roadmap ledger row 20). That observation fed the rewrite, and there is no
  rewrite left to feed.
* Bad, because `PATCH_FLOOR` was read off test fixtures. A flagged quote whose
  sentence cites a source now logs its closeness to the nearest passage of
  that source, and the answer suite counts `unverified_quote` and
  `quote_patch`, so the floor can be reset from real answers. A quote with no
  cited passage logs "no cited passage" and no number, since
  `UnverifiedQuote.nearest` is chosen only among the sources the quote's own
  sentence cites (`citation_verification._nearest_cited`).
* Neutral: a source line that carries both a registry citation key and a link
  nothing retrieved is valid by its key. The link is dropped from the line,
  not the citation (`citation_verification._drop_url`). RIS is filed by key,
  and the model copies a link beside it from a tool's source line or from the
  prompt's `Title - URL` format. Only a line with no resolvable key is removed
  as `url_not_in_registry`. An error or no-result tool output is never a
  source, even when it contains a link: `_is_non_citable_status_output` runs
  before the URL extractor. So fewer citations fail, and none of them reaches
  this repair.

### Confirmation

* `tests/aiq_agent/agents/piloti/test_quote_patch.py`: a misremembered quote is
  close and an invented one is not; a correction off by one digit, or another
  sentence of the passage, is refused; only the words between the quotation
  marks move; an attribution failure and a slow patch leave the quote as it
  was; a passage from a source the sentence does not cite is never used.
* `tests/aiq_agent/agents/piloti/test_agent.py::TestPilotiRepairPass`: through
  the agent, the text outside the quote is byte-identical, there is no second
  frontier call and no second search, and a clean answer makes no call.
* `tests/aiq_agent/common/test_lost_citations.py`: a removed citation never
  calls the repair.

* The answer suite, all 27 questions, before (the whole-answer rewrite
  repair still in place) and after (the quote patch in `quote_patch.py`, with
  the settle also dropping a restated mindmap), 2026-09-24: checks 76/86 and
  74/86, wall medians 42.0 and 42.7 s. **This comparison does not show the
  change. Correction, 2026-09-25.** Each run was started from a worktree of
  its commit, but until the census learned to put the checkout's own code
  first (`census.tree_pythonpath`) it set `PYTHONPATH` to `scripts/turn_census`
  alone. The worktrees had no venv of their own (`task setup` never ran in
  them), so both runs used the main checkout's `.venv`, whose editable install
  imported the main checkout's `aiq_agent` and `knowledge_layer`. Both arms
  measured the same code, the main checkout as it stood at run time, while
  each report named its worktree's commit. The census now puts the checkout's
  own `src/` and `sources/` packages first (`census.tree_pythonpath`), and the
  suite refuses to start when a run would still import code from elsewhere
  (`suite.foreign_imports`). The repair's effect on real answers has no valid
  before/after yet. The unit and agent tests above still pin its behaviour.
* What those runs still show, since they are true of the code they did run:
  no settled text was replaced (`settled_replaced` 0), and the suite had no
  misquote to repair. They ran before the cited-source restriction
  (`UnverifiedQuote.nearest` taken only from a source the quote's sentence
  cites, `citation_verification._nearest_cited`): the two flagged `uncited`
  quotes logged closeness 0.62 and 0.91, which today's code would not log,
  because only a quote with a cited passage gets a closeness. The worktrees' relative `./summaries.db` was
  empty: no document inventory and no family overviews, so the absolute
  seconds do not describe a normal turn (31.3 s per turn with the inventory,
  38.5 s without). The suite now refuses to start on an empty inventory.

## More Information

Amends ADR-0066, whose "Bad, because the text can still change" names the
repair. Supersedes the repair design in roadmap L0 and ledger row 20.
