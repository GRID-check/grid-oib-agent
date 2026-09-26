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

*Amended 2026-09-25:* one exception to "run as today". When the decision did
not run, a question that `family_query_number` recognises still prefetches
its own search (`agents/piloti/decisions.py::_undecided_prefetch`). It is the
evidence question by construction, and the decision missed its 1.5 s budget
in 10 of 12 live calls (p50 2.7 s, measured 2026-09-23). The next day's suites
measured it at a median 0.54 s, p90 0.62 s
([turn-latency §3.1](../architecture/turn-latency-measured-2026-09.md#31-the-sequence)),
with the same endpoint (OpenRouter's alpha `/decisions`), timeout and shared
client; the one change to `common/decisions.py` in between logs a skipped
decision and does not touch the call. The difference is
the alpha endpoint's own latency on those days, not a change in the repo, and
the later figure, taken over two suites rather than twelve calls, is the
current one. The exception stays for the turns it still misses (a timeout,
the breaker open, a first message too short to be decided). This adds a
fetch and withholds nothing. It shipped on 2026-09-23 with the logging of
every skipped decision and its reason (`common/decisions.py`; a first
message too short to be decided is logged and recorded as `too_short` by
`agents/piloti/register.py`). Only on a first
message: on a follow-up (the turn has a previous message) nothing is
prefetched without a decision, as the decided path refuses a follow-up that
cannot be searched on its own.

**Use 1 — the turn-start decision** (`agents/piloti/decisions.py`,
`register.py::_decide_turn`). One request beside the skill resolution:
`needs_evidence`, `corpus` (baurecht / projekt / buero / modell / none), one
noul per Richtlinien-Familie the corpus holds, one noul per content card
type the taught envelope does not already carry, `self_contained`
(whether the message can be searched without the previous one — a follow-up
cannot, and searching „und in GK 4?" would hand the model a block about
nothing; a follow-up prefetches nothing, because the previous turn's
passages are still in the transcript — a turn writes its whole transcript
back, `conversation._answer_update`, and older turns are pruned to prose), and `skill`: a choice over the skills riding the prompt with
`none`, verified by one "fits" noul per skill, which is TypeSafe's own
skill-suggestion cookbook (rank, then check the candidate does the specific
thing asked; abstain under 0.30). What the
answers may do: the question and the top families' overviews run as
**round 0** before the first LLM call (`PilotiAgent._prefetch_node`, the
graph's entry node), through the real tools node — announced as
`status:retrieval:0`, captured, stamped, drawn in the Herleitung, answered
by the duplicate-fetch guard when the model asks again, and **charged to no
round**, because no LLM decision was spent on it; the chosen skill's
preferred card shapes beyond the eight the envelope teaches — what
`use_skill` handed over with the body before ADR-0063 moved the bodies into
the prompt, at 1.1–1.6k tokens per skill too much to carry for all nine —
and the two most likely card types get their full shape in this turn's
prompt (at most five shapes); and the chosen skill's BODY rides this turn's
prompt — the one method the question is the subject of, ~400 tokens, or
the 17k-character IFC method on a model question — because inlining every
method by size cost ~4 600 tokens on every call (ADR-0063, amended). Every
tool stays bound whatever it says.

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

*Amended 2026-09-25, thresholds.* A re-run of `task be:eval:decisions`
(35 rows, all decided, mean 253 ms) and ten messages that need nothing
(greetings, thanks, a memory note, rewrite and e-mail requests) moved four of
them up, each into the gap the numbers left: `needs_evidence` 0.5 → 0.6
(nothing-needed 0.03–0.24, questions 0.70–0.98), `corpus` 0.5 → 0.7
(regulation questions 0.94–1.00; the one row below was a folder listing that
`surface_documents` answers), `self_contained` 0.5 → 0.6 (standalone
0.71–0.95, follow-ups ≤ 0.25), the card shape 0.6 → 0.7 (`norm_chain` at
0.60–0.69 on nine different rulings is noise; the picks that named the
answer's shape ran 0.73–0.87). The family threshold stays at 0.5: its
precision is 1.00 at every level from 0.3 to 0.9, so raising it only loses
recall (0.96 → 0.93 at 0.6). The skill choice stays at 0.6: it was right or
abstained on every row (Schallschutz → `waermeschutz` is right; that skill's
description is „U-Wert, HWB und Schall"). The fit question was the weak
part: worded "is this exactly the case the method is written for", it rated
right picks at 0.12–0.17 and a folder listing at 0.47. Reworded as "would
an expert apply this method to answer it", right picks ran 0.27–0.95 inside
the whole decision and the two project-file questions that name Brandschutz
0.06 and 0.11, so the fit veto moves from 0.1 to 0.2 and now holds back the
Brandschutzkonzept question the old one let through.

*Amended 2026-09-26, every decision at 0.7 or 0.8, checked on held-out
data.* Every threshold now acts on a confident answer: 0.8 for
`needs_evidence`, `corpus`, `self_contained`, card shapes, document type
and disciplines, Dokumentart and feedback causes; 0.7 for family, skill,
skill veto, supersede and the reflection skip, where held-out data showed
0.8 cost right answers. Two gates were turned round so they, too, act on a
confident yes: reflection is skipped when "is there nothing about this
project here?" reaches 0.7 (was: "does it establish something?" below 0.3),
and a skill is withheld when "does the message ask for something other than
an expert answer?" reaches 0.7 (was: a per-skill "fits" noul above 0.2).
The family is one choice over the Richtlinien and `none`, not a noul per
family: independent nouls read each scope as a keyword list and missed
questions whose words were not on it. The skill options carry the heading
each skill's body opens with. The second document type is gone: a choice's
runner-up cannot reach 0.8.

The criteria were tuned on the sets the earlier numbers were measured on,
so those numbers overstate. A held-out set per use, written blind to the
wording from plain label definitions (`tests/fixtures/decisions/holdout/`,
`task be:eval:decisions:holdout`), was scored once per structural change and
never tuned on. On it: tags 24/24 types, no false discipline; reflection
13/13 empty passes skipped, none lost; supersede 15/15, no wrong
retirement; Dokumentart 13/13; feedback causes 20/24; turn `needs_evidence`
30/30, `self_contained` 25/27, family 16/21 (the reworded nouls 15/21, the
original 9/21), skill 25/30 (24/30 before). Four one-row wording fixes made
on the tuning sets (Projekt/Grundstück, a Konzept is a Gutachten, a bare
`too_slow` chip, summer overheating in the family scope) changed nothing on
the held-out set; they stay because they are true, not because they were
measured to help.

*Amended 2026-09-25:* two uses off the reader's path.

**Use 4 — ingestion tags** (`knowledge/document_classification.py`,
`decide_document_tags`). The 1–2 document types and 0–3 OIB disciplines
stored with every upload were a generative call on `summary_llm` returning a
JSON array that a post-filter held to the vocabulary. They are one choice
over the twelve types and one noul per discipline, over the text the summary
reads; the prompt runs only when no decision did. Tags annotate a file (the
inventory line, the Files panel), nothing filters on them, so a wrong tag
withholds nothing. Measured on twelve hand-labelled German document openings:
types 12/12 (the prompt on the default model: 11/12, a Statik-Vorbemessung
typed `Sonstiges`), 0.2–0.3 s against 0.8–1.9 s, $0.00005 per document. The
decider tags fewer disciplines (4 of 8 labelled, no false tag, against the
prompt's 8 with one false). Its answers split: clear disciplines at
0.96–0.98, the rest at or below 0.52, with a false tag at 0.47 and a true
one at 0.52; the threshold is 0.7, mid-gap, because a tag rides in every
prompt's inventory line and a false one misinforms the agent, where a
missing one only says less. It does not tag a plan Brandschutz for drawing
a compartment line, which is what the prompt's own „nur wenn der
Fachbereich eindeutig zutrifft" asks. Ingestion has no request
context, so the org id travels in the job config and the endpoint resolves
ZDR by the id it is given (`common/decisions._zdr_only_blocking`).

**Use 5 — whether memory reflection runs** (`memory/reflection.durable_probability`,
`stages/memory_reflection._handler`). Reflection is a reasoning call on the
memory group's model after every project turn, and its prompt calls an empty
result "the common and correct outcome". One noul over the question and the
answer's opening — does the exchange establish anything about this project —
skips the call below 0.3. This is the one use whose wrong answer loses
something (a memory row the in-turn `remember` tool also did not write), so
the threshold sits far below the evidence: on sixteen German exchanges the
reflection call itself agreed with the hand labels on all sixteen, every
exchange that produced a finding scored 0.45–0.94, and seven of the nine
that produced none scored 0.03–0.16. A decision that did not run reflects;
a turn whose `remember` call wrote something reflects without asking; the
skip is `StageEmpty("decided_nothing_durable")` on the stage's span, so its
rate is measured in production like every other stage outcome. It never
touches the answer, which has shipped before the stage starts.

**Use 7 — which memory entry a correction retires** (`memory/supersede.py`).
A yes/no per pair: does this new finding make that stored entry wrong. The
single writer already retires an entry the writer quotes as `supersedes`, or
one worded closely enough for its polarity split; a correction worded
differently and not quoted („Das Grundstück liegt in St. Pölten" against
„Das Projekt liegt in Wien") left both live, which the memory design names as
outstanding (§3.2). Both agent writers — the `remember` tool on a project
write and reflection — now ask it for every project entry of the digest when
the model gave no quote, and send the most likely entry at 0.75 or above as
the quote, through the same field: the writer's rules still hold (a quote
that does not resolve is ignored; a pinned, user-confirmed or user-authored
entry is never retired by an agent). Measured on a twelve-entry memory and
sixteen findings: the eight corrections named the right entry at
0.80–0.97, the next entry at most 0.22; the eight additions at most 0.37.
The model's own quote always wins and is not second-guessed.

**Use 8 — a Dokumentart for a person to accept** (`knowledge/document_classification.suggest_doc_class`).
A base-corpus file whose name carries no OIB hint lands in `sonstiges`, the
neutral lane, until a platform owner reclassifies it. At ingestion the
decision model chooses one of the nine classes from the text; a pick at 0.8
or above that is not `sonstiges` is stored BESIDE the class
(`document_metadata.doc_class_suggestion`), never as it, and the
base-knowledge page offers it under the picker („Aus dem Text erkannt: …
Übernehmen"). Accepting is the same PATCH the picker sends, and any PATCH
clears the offer. `doc_class` drives lanes and source kinds, so it stays
human-set, as it was (`doc_class` beats every guess). Measured on twelve
openings under hint-less file names (`tests/fixtures/decisions/doc_class.yaml`):
12/12 at 0.97–1.00, where the filename guess had 3/12.

**Use 9 — why a down-vote was cast** (`common/feedback_causes.py`, the
feedback digest route). A down-vote carries one of four coarse chips and
sometimes a comment; the comment names the defect („In GK 4 ist es R 60",
„Das ist die Wiener Regelung, wir sind in Tirol" are both `inaccurate` to the
chip). When the digest is built, each sampled down-vote is filed under one of
ten causes by a choice over its question, chip and comment; the counts go into
the digest's brief and back to the Quality page as one line. A label below 0.6
is left unlabelled, not guessed, and nothing a reader sees depends on it. The
comment now leaves the BFF with its sample, fenced as data like the question.
Measured on sixteen down-votes (`tests/fixtures/decisions/feedback_causes.yaml`):
16/16 at 0.79–1.00.

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
reason the card threshold stays at 0.6. The skill choice, re-run with the
same set over all ten skills: a body loads on 18 of 27 rows, the family's
method on 0.74 of the rows by a crude family→skill map, and the rest are
abstentions the cookbook is for — `none` on the two overview questions and
the structural one, a fit of 0.19 on the project-file question — with one
disagreement the map is wrong about (`gebaeudeklasse` for the high-rise
question, which does turn on the class). Latency 507–685 ms, mean 602.
`self_contained` ran 0.74–0.95 on the 27 standalone questions and
0.02–0.26 on six follow-ups (`follow_up_questions.yaml`: „Und in
Gebäudeklasse 4?", „Genauer bitte", „Warum?"), all six held back from a
search of the fragment, the family right on all six from the previous
message, and the skill choice reading them as intended (`bestand` for „und
im Bestand"). Six rows is a start, not a study. The judge use is measured live by
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
  1.5 s at its start. First measured at 467–899 ms, mean 614; of that ~370 ms
  was the TLS handshake of a client built per call, and on the shared
  keep-alive client the same call answers in ~60 ms (measured 2026-09-22,
  `gotchas.md`). The provider reads run beside it, so the first LLM call
  waits for the slowest of the three, bought back by the round the prefetch
  removes only when the prefetch hits. The breaker and the timeout bound it;
  the eval and the technical record are how an operator sees it.
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
  *Amended 2026-09-25:* except the family question's own prefetch above,
  which adds a fetch and withholds nothing.
- `tests/aiq_agent/agents/piloti/test_prefetch_round.py`, through the
  compiled graph: round 0 runs before the first call, costs no budget, is
  drawn as `status:retrieval:0`, answers the model's repeat, and never runs
  for an unbound tool or a switched-off source.
- `tests/knowledge_layer_tests/test_decisions_in_retrieval.py`: a sufficient
  head costs no judge call, an absent decision runs the judge, a flagged
  passage is kept, the reranker's order.
- `tests/knowledge_layer_tests/test_document_classification.py::TestTagsAreDecided`:
  the questions are the vocabulary, a decision replaces the generative call,
  a failed or off-vocabulary decision falls back to it.
- `tests/aiq_agent/stages/test_memory_reflection_stage.py::TestTheDecisionSkipsOnlyAConfidentNo`
  and `tests/aiq_agent/memory/test_reflection.py::TestDurableProbability`.
- `tests/aiq_agent/memory/test_supersede.py`: the digest read back
  unescaped, org-wide entries left out, the writer's quote first, both
  writers send the decided one; `memory_supersede.yaml` in the off-path eval.
- `tests/conftest.py::_no_live_decisions`: the suite never reaches the live
  endpoint unless a test turns decisions on and stubs it.
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
