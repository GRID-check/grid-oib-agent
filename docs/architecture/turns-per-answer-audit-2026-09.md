# Turns per answer (2026-09)

> Where one chat turn spends its LLM calls, which of those calls exist only
> because of how the answer is carried or how a tool result is worded, and
> what took them out without taking a capability with them. It reconstructs
> the fifteen-call turn the product owner saw on „was weißt du über OIB 2"
> mechanism by mechanism, says which mechanisms this change closed and
> which remain, and evaluates TypeSafe's Jev — a decision model, not a
> language model — against the one rule this repo has already made about
> deciding things before the answer (ADR-0052).
>
> **What it rests on.** The tree at this tip, read call by call
> (`agents/piloti/agent.py`, `answer_pipeline.py`, `common/turn_status.py`,
> `sources/knowledge_layer/src/register.py`, `read_passage.py`,
> `configs/config_oib_openrouter.yml`); the prompt and catalog weights
> measured with `o200k_base`; and, for every mechanism named in §2.3, a
> local reproduction of it (the script or test that shows it is cited in
> the row). **What it does not rest on:** a trace set. Langfuse was not
> reachable from the session that wrote this and PostHog holds no
> `$ai_generation` events for this project (2026-09-22, last 14 days). So
> §2.3 is a *reconstruction*: the sequence the prompt, the tool contracts
> and the budget lead a model to, with each step's cause verified in
> isolation, landing on the count the owner observed. The first item of §8
> is still to make it a measurement.
>
> Complements the [hobble register](hobble-register-2026-09.md) (which
> constraint sits where), the
> [latency audit](latency-and-caching-audit-2026-09.md) (what the reader waits
> for) and the [RAG audit](rag-system-audit-2026-08.md) (whether the right
> passage comes back). Reads their open items rather than restating them.

---

## Measured, 2026-09-23

The sections below were a reconstruction. This one is a measurement:
`task be:eval:turn-census` (`scripts/turn_census/`) ran the real agent over
the published OIB 2023 corpus with `openai/gpt-5.6-luna`, no project, and
recorded every model call as the provider billed it. Where it contradicts a
later section, it wins.

| „Was weißt du über die OIB 2?" | before the fixes below (5 runs) | after (4 runs) |
|---|---|---|
| research calls | 1, 2, 1, 1, 2 | 1, 1, 1, 1 |
| input tokens per research call | 34–45 k | 33.4 k, of which 26.1 k cached prefix |
| requery judge + 2 extra retrievals | fired in 2 of 5 | 0 |
| parts in the family overview | 2 or 3 (2.2 never) | 2, 2.1, 2.2, 2.3 |
| wall time | 20–24 s | 15–20 s |

What the census found, each closed at its cause:

- **Tool schemas were 38 % of every call and deferral saved nothing.**
  Replaying the research call: 40 154 input tokens with `defer_loading`
  true, 40 154 with it false; the provider echoes the flag and bills the
  schemas. Probed on luna, sol, sonnet-5 and gemini-3.7-flash: none honours
  it. The probe now measures the saving (ADR-0048), and a turn without a
  project is not sent `ifc_query`/`ifc_measure` (~8.2 k tokens), which can
  only answer "no project" there.
- **The turn decision mostly misses its budget.** Jev on OpenRouter's alpha
  endpoint: p50 2.7 s, 10 of 12 calls over the 1.5 s timeout on a warm
  client; in live turns it landed in about half. A miss was silent and took
  the prefetch with it, so the model paid a round for the same search. A
  miss is now logged, and a question that names an OIB family prefetches
  its own search without a decision. The decision's value on the remaining
  shapes (a ruling like „Feuerwiderstand tragende Wände GK 5": 3 research
  calls when it misses) is bounded by that latency, not by its thresholds.
- **The family search carried sixteen ranked hits and a judge.** Half of
  the 25.5 k-character block was Leitfaden and Erläuterungen; the judge,
  whose criterion counts a scope note as not answering, called every
  overview insufficient. The overview now keeps four ranked hits and is not
  judged (`knowledge_layer/register.py`).
- **OIB 2.2 was invisible.** The OIB publishes it as `oib-richtlinie_2.2_…`;
  nothing recognised that spelling, and the exclusion list named an
  Änderungen file that does not exist, so the 2.2 diff leaked into
  retrieval. `norm_registry.canonical_oib_file_name` now feeds every parser.

**The model decides the round count as much as the code does.** Moving the
defaults to `openai/gpt-6-luna` (2026-09-24, same census, same corpus): the
OIB 2 overview took 2 research calls in 3 of 3 runs — given the same round-0
state where 5.6-luna answers, 6-luna opens four or five Punkte with
`read_passage` first — at 34–39 s wall and roughly half the per-token price;
the GK 5 ruling took 1–2 with the decision landing (0.65–2.2 s that day,
`brandschutz` inlined). A round count reported from production is a count
for that deployment's admin-set model.

Still open, measured but not changed: the static prefix is 17.7 k tokens,
6.1 k of it the cards contract (cached, so cheap in money, not in the cold
first call of a turn); `emit_card` is 2.8 k tokens of tool schema whose
description repeats that contract; the research call at `reasoning_effort:
medium` is 8–14 s of the turn. And these numbers are one model and no
project: a project turn adds the inventory and the building-model tools
back, and the platform's live default model is admin-set.

## Measured, 2026-09-24: seconds follow reasoning tokens, not rounds

Thirteen census runs (`openai/gpt-6-luna`, `effort=medium` unless marked, no
project; `scripts/turn_census/census.py`, which now takes `--override`),
timed call by call:

| Run | Wall s | Research calls | Final call s | Reasoning tokens | Largest in one call |
|---|---|---|---|---|---|
| Ruling (Geländer, 13 m) | 26.3 | 1 | 19.7 | 1 107 | 1 107 |
| OIB 2 overview, three runs | 25.5-51.5 | 2-4 | 11.1-15.9 | 726-2 186 | 958 |
| Two variants (Fluchtweg), old index, two runs | 66.8 / 79.9 | 4 / 5 | 35.6 / 48.4 | 3 041 / 3 299 | 2 785 |
| Two variants, table index, two runs | **123.7 / 54.0** | 4 / 3 | 22.7 / 29.6 | **7 263 / 1 961** | **4 335** |
| Table ruling (Treppenhaus GK 4), old / table index | 32.2 / 38.6 | 1 / 2 | 24.4 / 24.4 | 1 426 / 1 836 | 1 501 |
| Same three questions at `effort=low` | 11.2-16.8 | 1-3 | 3.3-5.4 | 0-207 | 139 |

**The finding.** The model writes at a steady ~85 tokens per second (82-90
across every call measured), so a call's seconds are its output tokens / 85,
and most output tokens are hidden reasoning. The same question on the same
index spent 1 961 reasoning tokens on one run and 7 263 on the next — one
tool-deciding round alone thought for 4 335 tokens (54 s) before asking for
two more passages. That spread, not the round count, is the depth variance:
three extra rounds cost less than one reasoning spike. And nothing streams
(latency audit §3.1), so every one of those seconds is time to first
character. *(Since ADR-0066 the prose streams: the reasoning before the final
call's first token still waits, the writing no longer does.)*

**Defects found on the way, closed at their cause:**

- **A skill round that bought nothing.** Both OIB 2 runs spent a full
  research call (2.5-2.7 s plus a re-sent 35 k-token context) on
  `use_skill("diagrams")`, whose every rule already sat in the static prompt;
  its description said "load the moment a diagram is in play". Retired.
- **A repair rewrite for a citation nobody lost.** Two Punkte read from one
  page are one registry entry, so an answer listing „…pdf, p.4" as [1] and
  [5] had [5] merged into [1] — correctly, inline citations rewritten — and
  the merge was then counted as a failure, triggering the repair pass (16 s
  and 23 s in two runs) and a "Belege entfernt" note. Merged duplicates are
  no longer failures (`citation_verification.lost_citations`), neither for
  the trigger nor for the count nor for the reader's note.
- **Tables read across their columns.** OIB-RL 2's Tabelle 3 was indexed as
  „an der obersten an der obersten an der obersten Stelle …", filed under
  Punkt 12 on p. 23; the agent searched „Tabelle 3 GK 4 REI 60" for three
  rounds. Captioned tables are now read as tables (`captioned_tables`,
  chunk format 4): 104 Markdown chunks addressed `Tabelle N`, and 12 table
  rows the chunker had accepted as Punkte gone. On the table index the agent
  opens `read_passage(punkt="Tabelle 3")` directly, the loop fell from three
  searches to one, and the Fundstelle is the table's own page (p. 30, p. 27)
  where it had been p. 23, which holds none of the values. Round count is not
  lower on every question: on the direct table ruling the new index cost one
  more read (6 s) for a citation a reader can check.

**`effort=low` is not the switch.** It was 3-5× faster and worse on all
three: the variants answer lost its `answer_json` envelope and every value
(„Anforderungen der Tabelle 3 … unter anderem Wände"), the OIB 2 overview
claimed OIB-RL 2.1 is „im verfügbaren Korpus nicht enthalten" (it is), and
the ruling spent two extra rounds on a skill load and an `emit_card` call
the envelope makes free.

**What would move the number, ranked:**

1. **Stream the answer** (latency audit §3.1, its own ADR). The final call
   is 11-48 s, of which the visible answer is ~7-30 s at 85 tok/s; streaming
   it shows text when reasoning ends instead of when verification ends, and
   streaming the Responses API's reasoning *summary* (not requested today:
   `summary: []`) fills the rest with what the model is weighing. The
   citation constraint the design doc names still holds: markers stay
   unresolved until the terminal frame.
2. **Model throughput.** 85 tok/s is this model through OpenRouter; the live
   default is admin-set, and the census is how to compare candidates on
   seconds *and* answers.

**First answer-suite baseline** (`task be:eval:answer-suite`, core set, two
runs each, table index, 2026-09-24): every check held on every run, and the
spread is one question wide. Median wall 27-44 s for five of six; the
two-variant Fluchtweg question is the outlier at 91 s (72-109), 3-4 research
calls with up to eleven tool calls, and reasoning spikes of 2 950-3 710 tokens.
It answers correctly and in tabs; it is the question to work on next.

**Full sweep, then the Bauordnung rows** (27 questions, 2026-09-24). The two
RIS questions were the slowest in the set, 87-100 s over 4-5 serial
`ris_lookup` rounds, each ending in a repair pass. The agent's own
checkpoints named the cause ("der Auszug bricht bei lit. f ab"): a named §
arrived as its first 2 500 characters, a third of them RIS's screen-reader
twins, beside a header stub of the same §. With the whole § (bounded at
8 000), the twins dropped and the stub folded in, three runs each: 87 → 29 s
and 88 → 33 s, no repair in six runs. The repair itself was the answer
copying the block's `Source URL:` (the whole law, the same for every §) as a
citation; the line is gone, and a key-cited line that carries a link is now
verified by its key. The same sweep showed a turn whose envelope lost its
opening `{"answer": "` and leaked its JSON tail as text, now salvaged and
counted (`envelope_salvaged`).

The other Bauordnung rows had causes of their own. Salzburg escalated to deep
research because the catalog held only the Bautechnikgesetz and the permit
rules live in the Baupolizeigesetz (added, `baupolg-sbg`); it then read § 2
one Absatz per lookup until a named Absatz came with its whole § beside it.
Tirol returned § 8 twice because its law opens with a table of contents. The
two rows that still escalate here, Tragwerk and Schallschutz, ask about OIB-RL
1 and 5, which this environment's corpus lacks; the suite now skips a question
whose Richtlinie the corpus lacks. And a skill the turn decision picks wrongly costs a round: "Bauklasse I"
chose `gebaeudeklasse`, and the agent loaded `bebauung` itself.

**The prose streams** (ADR-0066, core set, two runs each): every check held
but one `kind` split the variants row already had, and the new "First text s"
column is what the reader waits for now: 19-35 s on the five single-answer
rows against walls of 24-40 s, the first words 4-9 s before the turn ends,
with the rest written while they are read. The thinking before the final
call's first token is the block left in front of them.

Decided against: a reasoning level that changes from round to round (e.g.
`medium` for the first round, `low` after). A turn runs at ONE level, the one
its role is configured with; the level is a property of the run, not of a
round.

Measurement caveat: `nat run` is a fresh process per question, so every
census pays the deferred-loading probe (2.3-3 s) and cold-start gaps a warm
replica does not; production's preamble is ~3-4 s, not 6.5 s.

## 0. The claim, in one table

"Turns" is four different currencies, and the product feels each one
differently:

| Currency | Who pays | Where it is counted |
|---|---|---|
| **Rounds** — LLM decisions that emitted tool calls | the research budget (`max_tool_iterations: 7`) | `status:budget`, `loop_eval.rounds` |
| **LLM calls** — every completion, hidden ones included | the bill; ~25 k tokens of prefix re-sent per call | `llm_usage_events`, nothing per turn yet |
| **Serial seconds** — the calls the reader waits behind, in order | the reader | the profiler root span (latency audit §5) |
| **Layers** — what the Herleitung draws | the reader's trust | `retrieval_ledger`, `status:checkpoint:N` |

A round is one call, but a call is not always a round: the answer-writing
call is not a round, the requery judge inside `knowledge_search` is not a
round, the repair rewrite is not a round. This document counts **calls**,
because that is what costs money and seconds, and says where each one comes
from.

The first version of this document counted the *minimum* calls a shape needs
and put „Was weißt du über OIB 2" at three or four. The product owner saw
about fifteen. The gap is not the model being careless: every one of the
extra calls is the reasonable next step given what a tool result said, what
a prompt taught, or what a budget did — and each of those was a defect
that a local reproduction could show. §2.3 lists them; the table below is
the before and after per shape, with the calls that this change removed
named by the mechanism that caused them.

| Shape | Reconstructed before | After this change | What came out (§ where it is verified) |
|---|---|---|---|
| Greeting, memory request, shelf listing | 1 | 1 | — |
| „Fass den offenen Plan zusammen" | 2 (+1 judge) | 2 (+1 judge) | nothing yet; the search when the prefetch lands (§8.2) |
| „Was weißt du über OIB 2?" | **14–15** | 3–4 (+1 judge) | the two skill rounds (§2.3 a), the second and third open round (b, c), the card round and its retry (d, e), the repair pass (f); the post-answer pair stays, off the path |
| Ruling with a card („Feuerwiderstand tragende Wände GK 5") | 6–7 (+1 judge) | 3 (+1 judge) | the skill rounds, the card round and the shape retry |
| Bauordnung question via RIS („Unterlagen für die Einreichung in Wien") | 4 (+planner, +extractor) | 3 | the skill round (`einreichcheck`), the card round |
| Measurement turn („wie hoch ist der Keller") | 5 | 4 | the card round; the skill round stays (`ifc-spatial-reasoning` is over the inline cap, §2.6) |
| Follow-up on an opened document („und in GK 4?") | 3 | 2 | the card round |
| Commissioned document („mach daraus einen Aktenvermerk") | 3 | 3 | nothing structural; `file_draft` depends on `write_file` |
| Commissioned report (handoff) | 1 (+ the deep path) | 1 | — |

Two things the table says that are easy to miss. First, **the calls that
came out were not decisions the model made badly; they were decisions it
was led to** — by a skill body that says "load the other one first", by an
outline with no excerpts, by a shape the catalog rendered wrong, by a
citation format the verifier did not recognise. Each is closed at the layer
that produced it (§2.3), which is why the count falls without a prompt
sentence telling the model to hurry. Second, **the search round is the one
the model still has to make before it has read anything**, and on the
shapes the product answers most it is a call the question alone could have
made (§8.2). That is the next structural change and it is not in this one.

---

## 1. Anatomy of a turn, call by call

```
WS frame ─▶ gather(context, inventory, registry, subject)      no LLM; one HTTP hop each, in parallel
        ─▶ render_system_prompt                                  no LLM (Langfuse prompt store, cached);
        │                                                        the short skill bodies ride it (ADR-0063)
        ─▶ TURN DECISION (Jev, ≤1.5 s, beside the skill resolve)  no LLM: needs_evidence, corpus, families, cards, model
        │                                                        since 2026-09-24: the embedding warm-up runs beside the decision
        ─▶ prefetch node: ROUND 0, the fetches the decision named  through the tools node; charged to no round
        │                 (or, when the decision did not run, the family search; since 2026-09-23)
        ─▶ agent node ──▶ tools node ──▶ agent node ── … ──▶ answer
             │ 1 call        │ parallel calls   │ 1 call         │ 1 call, the envelope: prose, anatomy, CARDS
             │               │ knowledge_search: embed → chroma → cross-encoder ‖ PASSAGE VERDICTS (Jev, 1 noul per passage)
             │               │                  → (insufficient?) the judge writes 2 phrasings (1 frontier call, minority)
             │               │                  → 2 more retrievals → rerank again
             │               │ read_passage:     deterministic; outline with excerpts; member aliases resolve
             │               │ ris_lookup:       planner (1 small call) → fetch → extractor (1 small call, 0 when a § is named)
             │               │ ifc_*, surface_documents, emit_card, remember, write_file …: no LLM
             │               │   (since the envelope carries cards, emit_card is no longer bound on chat)
             │               │ every grounding block: Trace-Lanes JSON stripped before the model reads it
        ─▶ register the envelope's cards; repair a wrong shape ONCE on card_llm (bounded), or drop and record
        ─▶ verify_citations (filename OR display title + page), verify_quoted_spans   pure
        ─▶ repair (≤ 2 retrievals + 1 rewrite)                   up to 1 frontier call + 2 judges, only on a failure
        │     since ADR-0067: ≤ 3 misremembered quotes corrected in place on card_repair_llm, ≤ 8 s each, no retrieval
        ─▶ sanitize, gate the envelope                           pure
        ─▶ deltas of the FINISHED text                          nothing streamed before this line
        │     since ADR-0066: the prose streams while the model writes it, and settles once verified
        ─▶ post-answer stages (follow-ups, reflection)          async, off the reader's path, on the bill
```

**What every call re-sends.** The static prefix is 9 722 tokens at the
previous tip (`piloti_static.md`, `o200k_base`) and the envelope schema
injected into it grew by the cards contract: doctrine 1 477, index 919,
the eight common shapes 3 515, in all 6 083 tokens, so the taught envelope
is now 6 820. The skills block below the boundary is 4 570 tokens with the
nine chat methods inlined against 356 for their catalog lines. Both sit in
the part of the prompt the provider's automatic prefix caching covers
(`common/prompt_caching.py`), so they are re-read once per turn, not once
per call. The tool schemas ride on every call unless deferred; ADR-0048
measured `ifc_query` + `ifc_measure` + `emit_card` alone at ≈ 14 000 tokens
before deferral. History is kept to 40 000. What is *not* cached and grows
per round is the tool results, and there this change took something out
too: every knowledge grounding block used to carry a `## Trace-Lanes` line
of JSON (file ids, lane names, scores) meant for the ledger and read by the
model; it is stripped before the message reaches the transcript
(`strip_trace_lanes`, `_tools_node`), and the repair's retrievals get the
same treatment.

**The hidden calls.** Two are worth naming because they never appear as a
round and are paid on every search:

- **The requery judge** (`sources/knowledge_layer/src/requery.py`,
  `requery_llm: rerank_llm`, which is `${GRID_DEFAULT_MODEL}` — the frontier
  default — at `reasoning_effort: none`). It runs beside the reranker on
  every `knowledge_search` that reaches the retrieval loop and that
  `should_skip_judge` does not exempt (a pinned file, a judge that already
  fired this search; the family overview is a branch that returns before the
  loop — since 2026-09-23 an explicit judge skip inside the loop,
  recorded as `search_input["requery_skipped"] = "family"`), reads the question and
  twelve 600-character excerpts, and answers "sufficient, or here are two
  other phrasings". With the cross-encoder a ~300 ms OpenRouter call, the
  judge is the long pole of every search and a frontier call per search.
  Its job is a yes/no over a state — §4 J2.
- **The RIS planner and extractor** (`ris_planner_llm`, reasoning `none`).
  One or two small calls inside `ris_lookup`, zero when the question names a
  §. Already bounded by design (register §3.3); nothing to take out.

And one new bounded call, off the round budget: the **card repair**
(`cards/repair.py`, `card_repair_llm: card_llm`), a few thousand tokens on
the small tier, only when the envelope carried a card the validator refused
and only once per card. It replaces a full-context retry round.

**What is not on the reader's path** and must be left alone: the post-answer
stages, citation and quote verification (pure Python), the client's delta
batching. The latency audit §2 lists them.

---

## 2. Example queries, traced

Each row is a question the office actually asks (the loop-eval set,
`tests/fixtures/herleitung/loop_eval_questions.yaml`, plus the shapes the
config's traced floors name). "Before" is the call sequence the prompt and
tool contracts led to at the previous tip; "why" names what each call
needed that the previous one could not have had, or the defect that made it
happen. Calls the hobble register already removed (`ris_search → ris_fetch →
…`, `describe_card`) are not re-counted.

### 2.1 „Hallo, was kannst du?" · „Merk dir: Bauklasse III" · „Was liegt im Büroarchiv?"

| | Call | Needs |
|---|---|---|
| before, after | ① answer (`kind: direct`) — or ① `remember` → ② answer | the inventory is in the prompt; nothing to retrieve |

One call, two for a memory write. Nothing to take out except the prefix the
greeting pays, which caching already discounts. A greeting's cost is a
*prefix* problem, not a *turns* problem, and §8 does not touch it.

### 2.2 „Fass den offenen Plan zusammen." (subject document open)

| | Call | Needs |
|---|---|---|
| before, after | ① `knowledge_search(file_name=EG_Grundriss.pdf)` [judge skipped: file pinned] → ② answer | the passages; the file name is already in the prompt (`## This turn's subject`) |
| next | ⓪ prefetch `knowledge_search(question, file_name=subject)` → ① answer | the subject is known before the model runs; the fetch needs no decision |

The search is a call the *turn* could have made: the subject is bound before
the model sees the question. This is the cleanest case for speculative
retrieval (§8.2) and the first one to measure.

### 2.3 „Was weißt du über OIB 2?" — the fifteen calls, reconstructed

The owner's report was "about 15 turns". Here is the sequence the code led
to, with each step's cause and the reproduction that confirms the cause.
Every row is a mechanism, not a guess about the model's mood; the count is
what the mechanisms add up to.

| # | Call | Why it happened | Verified by |
|---|---|---|---|
| 1 | `use_skill(brandschutz)` | The catalog offered ten one-line skills; "OIB 2" is fire safety, and the doctrine said to load a skill before following it | `brandschutz/SKILL.md` description; `SkillRuntime.prompt_block` at the previous tip |
| 2 | `use_skill(gebaeudeklasse)` | The Brandschutz body opens with „Gebäudeklasse zuerst … `gebaeudeklasse` laden, bevor eine Zahl fällt" | the body, verbatim |
| 3 (+judge) | `knowledge_search("OIB-Richtlinie 2")` | The family search; `family_query_number` recognises the shape and returns every member's outline | `sources/knowledge_layer/src/register.py::family_overview` |
| 4 | `read_passage` × 12 | The outline listed ~26 Punkte across OIB 2, 2.1, 2.2 and 2.3 with **nothing but their headings**; an overview answer needs their content, so the model opened them — and `max_calls_per_round: 12` ran twelve and answered the rest „not run this round, ask again next round" | `_outline_lines` before this change; `status:width:N` in `piloti/AGENTS.md` |
| 5 | `read_passage` × 12 | the withheld opens, as told | the width cap's own notice |
| 6 | `read_passage` × 2, some by member label | The rest — and an open addressed as „OIB 2.1" or „OIB-Richtlinie 2.1" **missed**, because `_document_names` matched the filename and the derived title only, so the tool answered with suggestions and the model re-issued it | `tests/knowledge_layer_tests/test_read_passage.py` alias tests, red before this change |
| 7 | `emit_card(typed_table)` → **rejected** | The card of the members: the catalog rendered `TypedColumn = { label* }` and the validator required `type` too, so every first `typed_table` failed (7 of 12 first attempts across the common shapes failed in the local experiment, this being the certain one) | `tests/aiq_agent/cards/test_envelope_cards.py::TestTheRenderedShapeIsTheValidatedShape`, red before |
| — | budget ceiling | Seven rounds spent; `max_tool_iterations: 7` forces synthesis, strict schema, **no cards possible** on that call | `agent.py` forced-synthesis branch |
| 8 | synthesis (forced) | the answer, written from what was gathered | — |
| — | `verify_citations` | The answer cited the way the prompt teaches a Fundstelle — „OIB-Richtlinie 2, S. 5" — and the verifier matched **filenames only**, so every title-style citation was removed and the answer was graded ungrounded | `tests/aiq_agent/common/test_citation_verification.py::TestATitleCitationResolves`, red before |
| 9, 10 (+2 judges) | repair retrievals | The repair pass (`repair_pass: true`) fetched twice for the „failing" text | `piloti/repair.py::_retrieve` |
| 11 | repair rewrite | and rewrote the answer with the citations it could resolve | same |
| 12, 13 | follow-ups, memory reflection | the post-answer stages, off the reader's path | `stages/runner.py` |

Eleven calls on the reader's path, thirteen with the post-answer pair,
fourteen to fifteen with the hidden judges (the family overview is its own
branch in `knowledge_search` and returns before the retrieval loop, so it
runs none; the repair's two retrievals run theirs). And the answer
that shipped had **no card**, because the round that would have carried it
was the one the ceiling cut, and the strict synthesis schema cannot express
a card.

What each mechanism became:

| | Mechanism | Closed by | Calls out |
|---|---|---|---|
| a | the skill chain (1, 2) | ADR-0063: the nine chat methods ride the prompt; `brandschutz`'s "load `gebaeudeklasse`" is read in place | 2 |
| b | the opens the overview forced (4, 5, 6) | every chapter line of an outline carries its opening sentence (`OutlineEntry.excerpt`, 120 characters), so an *overview* answer is written from the overview; the opens that remain are the Punkte the answer will quote | 2–3 |
| c | the member-label miss (6) | `_document_names` resolves `OIB 2.1`, `OIB-RL 2.1`, `OIB-Richtlinie 2.1` and the edition-less title | the re-issue |
| d | the card round (7) | cards travel in the envelope's `cards` field, registered by `finalize_answer`; the marker contract is unchanged | 1 |
| e | the rejected shape (7) | `catalog._is_discriminator` renders `TypedColumn.type`; and a shape the model still gets wrong is repaired once on `card_llm`, not by a round | 1 |
| f | the repair pass (9, 10, 11) | `_match_registry_title`: a citation by display title, with or without a page, resolves to the registry entry — longest unambiguous name wins, an ambiguous head resolves nothing | 3 (+2 judges) |
| g | Trace-Lanes JSON in every block | stripped before the transcript; not a call, but every call after a read was carrying it | tokens per call |
| — | the family search (3) and its overview | stays: it is the one retrieval the question needs | 0 |
| — | the post-answer pair (12, 13) | stays, off the path | 0 |

After: ① the family search → ② the opens the answer quotes (0–1 round) →
③ synthesis with the members' table in the envelope; two post-answer calls
behind it; one judge at most. Three to four on the reader's path.

### 2.4 „Welchen Feuerwiderstand brauchen die tragenden Wände in GK 5?" (`kind: ruling`)

| | Call | Needs |
|---|---|---|
| before | ① `use_skill(brandschutz)` → ② `use_skill(gebaeudeklasse)` → ③ `knowledge_search` [+ judge] → ④ `read_passage(OIB-RL 2, Pkt 2.2 / Tabelle 1b)` → ⑤ `emit_card(legal_basis)` (+ `typed_table`) → ⑥ answer; a wrong shape → ⑤′ retry | ④ the table row the verdict copies — ⑤ the verbatim `original_text` for the card — ⑥ the marker |
| after | ① `knowledge_search` [+ judge] → ② `read_passage(Punkt)` → ③ answer + `legal_basis` in the envelope, its shape in the prefix | the passage; the method and the shape are already in front of the model |
| next | ⓪ prefetch `knowledge_search(question)` → ① `read_passage(Punkt)` → ② answer | §8.2 |

Six or seven become three. This is the product's core shape and the one
where the card round was the most visible: `legal_basis` is emitted on most
rulings, and the doctrine itself says the card is the *proof* margin
(`_LEGAL_BASIS_CARD_TYPE` in `answer_pipeline.py`) — an answer that carried
it paid a full round for it every time.

### 2.5 „Welche Unterlagen verlangt die Baubehörde in Wien für die Einreichung eines Wohnhauses?"

| | Call | Needs |
|---|---|---|
| before | ① `use_skill(einreichcheck)` → ② `ris_lookup(question)` [+ planner + extractor] → ③ `emit_card(document_checklist)` → ④ answer | ② the §§ of the BO Wien — ③ the checklist rows need the §§ — ④ the marker |
| after | ① `ris_lookup(question)` → ② answer + `document_checklist` in the envelope | — |
| next | ⓪ prefetch `ris_lookup` when the question is a Bauordnung question (Land + „Einreichung/Bewilligung/Unterlagen" — the norm registry's `match_entries` already says so) → ① answer | — |

Four become two. `ris_lookup` was the register's consolidation (five calls →
three); what remains is the search-before-reading, which §8.2 is about.

### 2.6 „Wie hoch ist der Keller?" (a model in the project)

| | Call | Needs |
|---|---|---|
| before | ① `use_skill(ifc-spatial-reasoning)` → ② `ifc_query(overview)` → ③ `ifc_measure(storeyHeight, Keller)` → ④ `emit_card` → ⑤ answer | ① the routing table between the two tools (the skill IS the vocabulary, `bim/AGENTS.md`) — ② the storey names, which ③ refuses to guess — ④ the measured value — ⑤ the marker |
| after | ① `use_skill` → ② `ifc_query` → ③ `ifc_measure` → ④ answer + card | the skill body is 17 573 characters, over the inline cap on purpose; the model step is genuinely serial: the measure needs the storey name the overview returned |

Five become four. The serial pair ② → ③ is real work and stays; the skill
round is a *loading* call for the one method too long to ride the prompt,
which is the case J1's `corpus` question is for (§4.3). This is also the
turn whose Herleitung drew two empty „Suche" layers until this change (§6).

### 2.7 „…und in GK 4?" (follow-up; `OIB-RL 2` is in „Bereits gelesen")

| | Call | Needs |
|---|---|---|
| before | ① `read_passage(OIB-RL 2, Pkt 2.2)` → ② `emit_card` → ③ answer | ① the other column of the same table — ② the card — ③ the marker |
| after | ① answer + card | the previous turn's passages are still in the transcript: a turn writes its whole transcript back, not the answer alone (`conversation._answer_update`), and the turn before it is pruned to what was said (`history.prune_tool_results`) |

Three become one, with no fetch at all. Only the final answer used to be
written back to the conversation, so every follow-up re-fetched what the
turn before it had just read — the round every follow-up paid, and the
reason the digest existed. Now the last turn's tool results ride into the
next turn (older turns keep their prose, so the 40k history budget still
holds answers), the research rules say to answer a follow-up from the
transcript and fetch only what it does not hold, and the decision's
`self_contained` keeps the fragment out of round 0 — a follow-up prefetches
nothing. Measured on six follow-ups (`follow_up_questions.yaml`,
`task be:eval:decisions`): all six held back.

### 2.8 „Erstell mir einen ausführlichen Bericht zum Brandschutz." (handoff)

One call, by design (ADR-0052: "a commissioned report needs no retrieval of
your own first"). The deep path that follows has its own budget shape and is
out of scope here.

### 2.9 „Mach daraus einen Aktenvermerk."

| | Call | Needs |
|---|---|---|
| before, after | ① `write_file` → ② `file_draft` → ③ answer (+ the `document_draft` system card, pushed by the tool) | ② needs ①'s path; ③ needs the card's marker |

Nothing structural. What §3.3 kept is that `document_draft`,
`document_grid`, `file_operation_proposal`, `task_created` and
`memory_proposal` are **system cards pushed by tools**, not cards the model
composes — they stay on the tool channel, and the envelope refuses them by
name.

---

## 3. The output format, questioned

The envelope (`common/answer_envelope.py`) is the right decision and this
section does not reopen it: the verdict, summary, takeaways and callout are
the answer's own anatomy, parsed once and gated deterministically, and they
used to cost a tool call each. What follows is what the envelope *carries*
— including, since this change, the cards — and the one thing it still
does not do.

### 3.1 What it buys — keep

- One contract per turn whatever the turn was (a greeting is `kind: direct`
  with one field). The platform never guesses.
- Gates that grade the *output* and never tell the model how to work
  (register §5): a verdict longer than 60 characters is dropped, a summary
  over 320, more than one callout.
- Rendering the schema from the validator's own models, so the prompt and the
  gate cannot drift — and now the cards contract from the card catalog, for
  the same reason (`cards/envelope.py::render_envelope_cards_contract`).

### 3.2 What it costs

- **The prose lives inside a JSON string.** `answer` is markdown with `\n`
  escaped, and nothing can be shown before the closing brace is parsed. The
  latency audit §3.1 names the consequence (the first delta is the last thing
  computed) and the fix (an incremental JSON-string reader), and ledger item
  16 sizes it L. The envelope did not cause the buffering — verification did
  — but it is the reason the fix needs a JSON stream reader rather than a
  token relay.
- **`kind` is decided at the end**, which is correct (the model knows what
  the turn was only once it has answered) and means nothing upstream can act
  on it. Fine.
- **A forced synthesis ships without cards.** The strict provider schema
  cannot express the card union, so the field is omitted there
  (`json_schema_extra={"strict_schema": "omit"}`); the truncated turn ships
  without cards rather than without an answer. That is the right asymmetry
  and it is one more reason a turn must not reach the ceiling.

### 3.3 Cards travel in the envelope (done in this change)

`emit_card` was bound as a tool, and a message that carries tool calls is
not the answer: the cards were validated, pushed into the `CardRegistry`,
and the model was called **again** to write the prose with the `[[card:N]]`
markers the tool handed back — 40–80 k tokens re-sent for text it could have
written in the same breath, and a third call on a wrong shape. The doctrine
already treated cards as part of the answer ("delete the cards mentally and
the answer must still answer"), and the envelope had made the same move for
the verdict and the takeaways for the same reason.

What shipped (`cards/envelope.py`, `answer_pipeline.py::_register_envelope_cards`,
`cards/repair.py`, `docs/architecture/cards.md`):

| | Before | Now |
|---|---|---|
| A card on a researched answer | +1 full-context call | 0 calls: the `cards` field of the envelope, same objects, same validator, same registry |
| A card whose shape was wrong | +2 calls (retry, then answer) | one bounded repair on `card_llm` (`card_repair_llm`), with the same clauses and shape the tool error returned; failing that the card is dropped and `status:card:invalid:N` records the type — never the answer |
| The shapes the model is taught | the one-line index; the shape arrived with the error | the doctrine, the index and the full shapes of the eight cards answers earn most (`ENVELOPE_SHAPE_TYPES`, 3 515 tokens) in the cached prefix; the other thirty-odd keep their index line |
| A shape the catalog rendered wrong | every first `typed_table` failed | `_is_discriminator`: a field called `type` is skipped only when it is the card's one-value discriminator |
| System cards | pushed by their tool | unchanged; the envelope refuses them by name, as `emit_card` does |
| `emit_card` | the only channel | still bound, for a card shown before the answer is written and for deep research, whose writer has no envelope; its description keeps the doctrine and index for that reader |
| `[[card:N]]` | returned by the tool | the model numbers its array from 1, after any marker a tool handed it this turn; `_renumber_envelope_markers` moves array numbers to registry positions and removes a dropped card's marker |

Measure: `loop_eval` gains `card_rounds` (rounds whose calls were all
`emit_card`; must be 0) and `cards_invalid` (from `status:card:invalid`;
must stay below the old shape-retry rate). Neither column exists yet — §8
row 1.

### 3.4 Envelope or trailer, when streaming is built

Not now; when ledger item 16 is picked up, the carrier is the decision. Two
forms of the *same* schema, same fields, same gates:

- **Envelope** (today): one JSON object, prose inside. Streaming needs an
  incremental string-field reader that withholds `[N]` until the marker
  closes and resolves.
- **Trailer**: the prose first as it is written, then ONE fenced
  `answer_meta` object last (kind, confidence, summary, verdict, takeaways,
  callout, cards, skills_applied). The prose streams natively; the markers
  are withheld the same way; the registry is complete by synthesis time so
  per-marker verification is deterministic; the sources section is rebuilt
  anyway; a handoff's one-line answer streaming and then being replaced by
  the terminal frame is legal on this wire (the frame is authoritative).

The trailer is the cheaper build and the envelope is the cleaner contract;
the gates do not care which. It is an ADR, not a paragraph, and the `cards`
field now exists in whichever carrier wins.

---

## 4. Jev, evaluated

### 4.1 What it is (as of 2026-09-22)

TypeSafe AI's Jev is the first of what the company calls "System One models":
a model that does not generate text. It takes a *state* (a string, JSON
object or array) and a map of typed *questions*, and returns a typed answer
per question with a calibrated probability, evaluated "in parallel and in
isolation against the same state". Three primitives: **Choice** (one option
of up to 255, with a probability per option), **Score** (a level on a 2–10
step rubric) and **Noul** (a yes/no as a probability). Facts that matter here,
with their sources in §9:

| | |
|---|---|
| Latency | 70–500 ms end to end (vendor) |
| Price | $0.042 / M input tokens, output free |
| Context | 64 k tokens of state + questions; 32 k for state + the longest question |
| Access | `POST https://api.typesafe.ai/v1/systemone`, or **OpenRouter's alpha Decisions endpoint** (`POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13` / `typesafe/jev-latest`) — the same body, plus `usage.cost`; **not** reachable through chat/completions |
| Language | "Jev's primary training language is English; other languages … are accepted but currently have lower accuracy" (vendor docs, *State*) |
| Released | early access 2026-09-15; on OpenRouter since 2026-09-18, in beta |
| Independent evidence | none on calibration yet; one third-party comparison (Every's) on English defect-finding: 6 of 7 planted defects vs 7 of 7 for a frontier model, at ~25× the speed |

Its documented jagged edges (vendor page, *Jev 1.13 jaggedness*) are the ones
that decide where it may sit in this product: it reads questions literally
(negations and scoping words at face value), it cannot count or compare
dates, multi-hop questions cost accuracy, **large irrelevant state degrades
it**, and **state is not treated as hostile** — an injected instruction in
the state can move the answer. And: "Jev cannot return a value outside the
schema you define… It can still pick the wrong option."

### 4.2 The rule this repo already made

ADR-0052 deleted the intent classifier that ran before every turn, and the
argument was not that it was slow (it was, ~1 s) but that **"a label decided
before the answer can only ever withhold capabilities the answer turns out to
need."** Register row 5 applied the same argument to the source ordering; the
`<output_contract>` opens with it: "Nothing classifies a turn before you see
it."

So the two uses of Jev that every write-up leads with — intent routing and
model routing — are out here, by decision, and the decision was right: the
misroutes it fixed („Zeig mir die Grundrisse" answered without
`surface_documents`) are exactly what a 70 ms classifier would reintroduce at
70 ms. The test for any decision model in this product is therefore not
"is it accurate" but:

1. **Additive.** A wrong answer costs tokens or a wasted fetch, never a tool,
   a corpus or a route. The model keeps every tool on every turn.
2. **Parallel.** It runs beside something the turn is already waiting for
   (the setup gather, the reranker), so a hit saves a call and a miss costs
   nothing the reader feels.
3. **Measurable on the loop eval** before it ships, in German, against the
   27 rows that already carry `family`, `kind` and `punkt`.
4. **Fail-open.** An alpha endpoint that is down or slow (1.5 s bound) is a
   turn that runs exactly as today, with one `status:decision:<slot>` record
   saying so — the cache module's contract (ADR-0020), applied to a decision.

### 4.3 Where a decision earns its place — ranked

**J2 — replace the requery judge — shipped (ADR-0064,
`requery_decider: jev`).** The judge is a frontier call per search
answering a yes/no ("does the head of this pool contain what the question
needs") and, when no, generating two alternative phrasings. The yes/no is a
Noul per candidate over `{question, passage}` — TypeSafe's own *RAG passage
classification* cookbook is this exact shape, four Nouls per passage with
fixed thresholds, and its *re-ranking* cookbook ran one Noul per
`{query, candidate}` pair over 3 565 US-court passages and moved top-1 from
5 % to 18 % at $0.06 for 1 200 calls. Sufficiency then is `max(p) ≥ τ`; the
generation half (the two phrasings) stays on a small model and runs only on
the insufficient case, which is the minority. Saves one frontier call on
every search and, when the cross-encoder is on, takes the long pole off the
search. **Measure offline first**, on the retrieval golden set
(`frontends/benchmarks/oib_retrieval`): the judge's decisions against Jev's
on the same pools, in German. The language caveat is the whole risk; a
German Punkt passage is not a US court opinion.

**J1 — gate and shape the speculative prefetch of §8.2 — shipped (ADR-0064,
`turn_decisions: true`, `PilotiAgent._prefetch_node`).** The prefetch needs
no decision model to exist (the retriever is itself a classifier: run
`knowledge_search(question)` and see). What a decision adds, in one parallel
call of four questions against `{question, project facts, inventory
families}`: `needs_evidence` (Noul — skip the prefetch on a greeting or a
shelf listing, which is the case the register's trace shows paying 20 k
tokens for nothing), `family` (Choice over the inventory's families, ≤ 12
options, "none" included), `bundesland` (Choice), `corpus` (Choice:
knowledge / RIS / model / none). Each answer narrows the prefetch
(`doc_class=`, `family`, `ris_lookup` instead of `knowledge_search`) and none
of them narrows the *model*: every tool stays bound, and a wrong family costs
one unread grounding block. Measure: `rounds`, `truncated`, and a new
`prefetch_used` (did the answer cite a passage the prefetch returned) against
`prefetch_wasted`.

**J3 — card selection, so the shape arrives with the synthesis call —
answered without a decision model.** The user's "multi-select which cards
have to be created" was going to be several Nouls in one call, one per
trigger row, picking whose L2 shape to attach to the synthesis call. Measured
(§3.3), the eight shapes answers earn most are 3 515 tokens together, cheap
enough to sit in the cached static prefix on every call; a selector that
picks two of them per turn saves ~2 700 cached tokens and costs an alpha
endpoint on the reader's path. The whole catalog's shapes are 23 376 tokens,
and the rest of it is served by the small-model repair (§3.3) at a few
thousand tokens on the rare miss. There is nothing left for a selector to
buy until `cards_invalid` says the repair is running often, and if it does
the answer is a ninth shape in the prefix, not a classifier.

**J5 — skill suggestion — answered without a decision model.** The
`use_skill` round is gone for the skills where it cost more than the body
(ADR-0063, §2.6): the nine chat methods are ~400 tokens each and ride the
prompt; `ifc-spatial-reasoning` (17 573 characters) stays on the catalog
line. A Choice over the catalog to pre-attach *that* one is the remaining
case, on model-shaped turns only, and it is the same shape as J1's `corpus`
question (`model` is one of its options): fold it into J1 rather than a
question of its own. Measure `skill_calls` on the model rows of the loop
eval, which J1 must bring to 0.

**J4 — a grounding score after the fact.** "Does the cited passage support
this sentence" per citation is the *citation check* cookbook and would be a
semantic sibling to the pure verifiers. It may only ever LOWER a confidence
or add a flag (the two-currencies rule in `piloti/AGENTS.md`), so it is
additive by construction. Later: the pure verifiers are good, and this is the
one use where a wrong Jev answer touches what the reader is told.

**Not Jev, and why.** Intent or model routing (ADR-0052). The escalation
decision (the agent emits it in its own envelope, ADR-0052). Confidence
(comes from grounding, never from a classifier). Verdict extraction (the
gates are deterministic and the model already fills a slot). Anything whose
wrong answer removes a tool from the turn.

### 4.4 Integration shape, if the eval says yes

- `common/decisions.py`: one `decide(state, questions, *, timeout=1.5)` that
  posts to the OpenRouter Decisions endpoint with the key every deployment
  already holds, returns `None` on any failure, and emits
  `status:decision:<slot>` on the technical channel with the probabilities
  (numbers, never the reader's text). BYOK orgs and ZDR-only orgs
  (`get_zdr_only_from_context`) skip it: an alpha third-party endpoint is
  not a ZDR route.
- Every caller treats `None` as "run as today". No caller may drop a tool,
  a corpus or a round on a decision.
- State is built from **structured fields**, never from the raw transcript:
  the question, the project's `confirmed:` facts, the inventory family
  lines, the round conclusions. That is the vendor's own guidance
  (filter in code first) and the injection edge: a tool result is data and
  must not reach the state as instructions.
- One `scripts/decision_eval.py`: the loop-eval questions and the retrieval
  golden set through each question set, German, with accuracy per question,
  the threshold sweep and the cost. The adoption rule is written before the
  run: J2 ships if its sufficiency agreement with the frontier judge is
  ≥ 90 % on the golden set; J1 ships if `family` top-1 ≥ 85 % on the 21
  OIB rows and `needs_evidence` never says "no" on a `ruling` row.

---

## 5. Pre-loading the applicable OIB-Richtlinien and laws

The idea: know from the project which Richtlinien and which Bauordnung apply,
and have them in front of the model before the question, so the turn does
not have to fetch them. Three different things hide in "have them in front
of the model", and they fare differently.

**(a) The applicability verdicts — exists.** `common/applicability.py`
derives from the project's `confirmed:` facts which Richtlinien are
`verbindlich`, `voraussichtlich` or `zu prüfen` and renders them as
`### Für dieses Projekt voraussichtlich einschlägig` on every turn
(`prompt.py::oib_applicability`); the norm registry's RIS catalog used to sit
beside it and was deleted in ADR-0060 (d) because `ris_lookup` resolves a
pointer from the question. This is orientation and it is already there.

**(b) The outlines — the experiment worth running.** What the model does not
have before its first call is what each applicable Richtlinie *contains*: the
`## Gliederung` that `read_passage(document=…)` returns deterministically (no
reranker, no judge, no LLM). One bounded block per `required` Richtlinie
(≤ 1 500 tokens for all six; cached per project because it changes only when
the corpus does) lets the first call be `read_passage(Punkt)` rather than
`knowledge_search` — the locator the second landing built, used from the
first round. Its RIS twin: the § headings of the project's Land's Bauordnung,
one cached fetch. This is the "smart new hire reads the table of contents"
move. Measure on the loop eval: `rounds` and `read_passage` up, `repeat_query`
down, `punkt_match` not worse. It sits below the cache boundary, so it is paid
per call; the bound is the price of the experiment and the reason to keep it
to outlines.

**(c) The passages — no.** Loading the text of six Richtlinien for a project
puts thousands of tokens of law nobody asked about on every call, including
„Hallo", and the vendor guidance for any model — frontier or System One — is
the same: unrelated state is a distractor. The question-driven prefetch of
§8.2 loads the *right* passages for the *this* question, which is what "load
them so we don't have to fetch" actually wants, and it costs nothing on a
greeting once J1 gates it.

So: (a) stays, (b) is one bounded block and one loop-eval run, (c) is the
prefetch by another name and should be built as the prefetch.

---

## 6. The Herleitung's empty layers (closed in this change)

A round is announced as a *retrieval* by its tool name — `_SEARCH_CORPORA` in
`common/turn_status.py` maps `ifc_`, `surface_documents`, `ris_`, `web_search`
and the two knowledge tools to a corpus — but the layer the Herleitung draws
under that announcement is built from the **lane hits** the tool recorded
(`record_lane_hit`, joined per round in `common/retrieval_ledger.py`). Only
the evidence tools recorded any. An `ifc_query`, `ifc_measure` or
`surface_documents` round therefore entered the ledger with `hits: 0`,
byte-identical to a search that found nothing, and the frontend's one word
for both was „Suche". A measurement turn (§2.6) drew two of them.

Closed on both layers: the IFC tools file the model with the operation as its
locus (`tools/bim/measurement_sources.note_model_read`), `surface_documents`
files each surfaced file on its shelf, and a ledger round that still has no
documents is a *miss* and reads „Kein Treffer" (`roundKind` in
`ReasoningFlow.tsx`); a turn stored before the ledger keeps „Suche", because
there an empty layer may only be an unstamped hit. The rule that survives:
**a tool added to `_SEARCH_CORPORA` owes the ledger its hits**, or its
rounds read as misses. `docs/contributing/gotchas.md` carries the symptom.

What this does not fix, and should be said: the layer for a genuine miss is
now honest, but the *reason* a search missed (the query the tool was asked,
the retry the tool suggested) stays in the tool result the model reads and
never reaches the layer. That is a second, smaller change to the ledger
entry (`miss_hint`), not this one.

---

## 7. Smoothness that is not a turn count

Three things the reader feels that no round count captures, listed so the
plan below does not pretend to have addressed them:

- **Nothing streams** (latency audit §3.1, ledger item 16). The largest felt
  wait on a chat turn is the synthesis call, and it is shown all at once. §3.4
  is the format half of that decision; the reader-facing half is the L item
  it already is. *(Since ADR-0066 the prose streams while the final call
  writes it.)*
- **The live line is per round, not per call.** A round of five parallel
  opens shows one line; the judge inside a search shows nothing. Fine while
  the judge is fast; if J2 is not done, a 10 s judge is a silent 10 s.
- **The card repair is one more thing on the path.** A wrong-shaped card
  now costs a bounded small-model call (≤ 20 s, `cards/repair.py`) after
  the answer is written and before it ships. Rare by design (§3.3: the
  common shapes are in front of the model), and it must stay rare:
  `status:card:invalid` is the count to watch.
- **`ask_user` costs a round and a human.** One per turn, six options, and
  the guard is right (register row 11). Nothing here changes it; the
  clarification doctrine ("state your assumption, or ask ONE question") is
  the cheaper path on most turns and the prompt already prefers it.

---

## 8. The plan, ranked

What this change did, and what is left. Rank = calls removed per researched
turn × how often the shape occurs ÷ what it risks. Every open row names the
loop-eval column that must move and the one that must not.

**Done in this change**, each at the layer that produced the call (§2.3):

| Mechanism | Closed by | Ratchet |
|---|---|---|
| the skill rounds | ADR-0063: short bodies ride the prompt, the model names what it followed | `test_inline_bodies.py::TestThePremiseIsMeasured` fails when a chat method grows past the cap |
| the card round and its retry | cards in the envelope; one small-model repair | `test_envelope_cards_pipeline.py`; `status:card:invalid` counts what the repair could not fix |
| the shape the catalog hid | `_is_discriminator` | a test writes a card from the rendered shape and validates it |
| the opens an overview forced | outline lines carry an excerpt | `test_read_passage_outline.py` |
| the member-label miss | `_document_names` aliases | `test_read_passage.py` |
| the repair pass on a title citation | `_match_registry_title` | `TestATitleCitationResolves` |
| Trace-Lanes JSON on the model's context | `strip_trace_lanes` in `_tools_node` and the repair | `test_trace_lanes_off_context.py`, through the compiled graph |
| the Herleitung's empty „Suche" layers | §6 | `ReasoningFlow.spec.ts` |
| the search-before-reading round (§8.2) | ADR-0064: the turn-start decision names the question and the top families; they run as round 0 through the tools node, charged to nothing | `test_prefetch_round.py`, through the compiled graph; `test_turn_decisions.py` |
| the frontier judge on every search (J2) | per-passage nouls decide sufficiency; the judge writes phrasings only on the insufficient case | `test_decisions_in_retrieval.py` |
| the last skill round (`ifc-spatial-reasoning`) | the decision's `model` answer reads it into the turn | `test_register_decisions.py` |
| the shapes the inlined skills lost (`fire_compartment`, `guardrail_check`, …) | the decision's `skill` choice, verified by a fit noul, attaches the chosen skill's shapes beyond the eight | `test_turn_decisions.py::TestTheSkillsShapes` |
| cards dropped under 800 characters of prose | the floor was the price of a card round; the round is gone, the floor is 400 | `test_answer_pipeline_suppression.py` |

**Open**, ranked:

| # | Change | Calls out | Must move | Must not move | Size |
|---|---|---|---|---|---|
| 1 | **Make the loop eval report calls, not only rounds.** `llm_calls` per row off the cost tracker (`GridCostTracker` already meters every completion of the turn, hidden ones included), `card_rounds`, `judge_calls`, `skill_calls`, `cards_invalid`. Then run it at this tip and commit the CSV beside the yaml, so §2.3 stops being a reconstruction | 0 | — | — | S |
| 2 | ~~Run the decision eval and quote it~~ **Done 2026-09-22** (`tests/fixtures/herleitung/decision_eval_2026-09-22.csv`): 27/27, family top-1 1.00, corpus 1.00, ruling floor held, 467–899 ms. Re-run on every change to `decisions.py`'s criteria | — | — | — | — |
| 3 | **`prefetch_used` / `prefetch_wasted` on the loop eval**: did the answer cite a passage round 0 returned | 0 — the measurement of row 2's effect | `rounds` down, `truncated` → 0 on the family rows | `punkt_match`, `family_coverage` | S |
| 4 | ~~**RIS prefetch**~~ **Done 2026-09-25** (ADR-0064, use 6): the turn decision's `landesrecht` noul (≥ 0.65) and `land` choice start `ris_lookup_tool` as round 0, the Land from the question or the project's facts; 5/5 Bauordnung rows, 0 OIB rows on `task be:eval:decisions`. Still to measure: `ris_calls` and `paragraph_match` on the answer suite | 1 on the Bauordnung rows | `ris_calls` | `paragraph_match` | S |
| 5 | **A miss says why** — `miss_hint` on the ledger entry (§6) | 0 — trust, not calls | — | — | S |
| 6 | **Streaming, with the carrier decision** (§3.4, ledger 16) | 0 — seconds, not calls | time to first token on the root span | the terminal frame stays authoritative | L, ADR |

**8.2, the prefetch in one paragraph, because it is the least obvious row.**
Before the first LLM call the turn already has the question, the subject
document, the project facts and the inventory; the setup gather is already
waiting on three HTTP hops. Run the evidence fetch the model would make in
round one *beside* that gather — `knowledge_search(question, file_name=
subject)` when a subject is bound, the family search when
`family_query_number` recognises one, `ris_lookup` when `match_entries` hits
a Bauordnung, `knowledge_search(question)` otherwise — and hand the grounding
block to the model as the first observation of the turn, announced as round 0
on the ledger („Vorab abgerufen") with its `conclusion` empty. The model's
first call then either answers (the common case on §2.2–2.5) or searches
again with a better query (which it does today in round two anyway). The
duplicate-fetch guard already answers a repeat with the earlier result, so a
model that re-issues the prefetch pays nothing. Cost of a miss: one unread
grounding block, ~2–4 k tokens, and the judge until J2 lands. Cost of running
it on a greeting: the same, which is why J1 gates it and why the first
version gates on the cheap signals only (a subject bound, a family or a
Bauordnung recognised, a `?` and a domain noun). ADR-0052 is not touched: the
model keeps every tool and decides what the turn is; the prefetch only makes
the round it would have spent already spent.

**What not to do**, each of which has been proposed once: an intent router
in front of the agent (ADR-0052); a smaller tool set (the register measured
what that costs); lowering the round ceiling (the ceiling is a floor plus two
repairs, config comment — and §2.3 shows what a turn that hits it loses: its
cards); preloading law texts by project (§5 c); trimming the envelope's
rhetorical fields to save output tokens (output is 0.4–1.4 % of a turn's
tokens, register §0); a prompt sentence telling the model to use fewer
rounds, which treats the symptom of every mechanism in §2.3 and removes the
signal that points at the next one.

**Two things a PR of this change must carry**, said here because nothing
local checks them: the static prompt in production is the Langfuse-managed
copy (ADR-0060 a), so the envelope schema change reaches it through the
injected placeholder on its own, and the rewritten `<cards>` prose reaches
it only when the Langfuse prompt is updated from the committed file; and
the Herleitung label change (§6) needs visual evidence on the PR or the
`no-visual-evidence` marker with its reason.

---

## 9. Sources for §4

Read on 2026-09-22. Vendor material is marked as such; nothing here has an
independent calibration study yet.

- TypeSafe AI, *Introducing System One Models & Jev* (vendor):
  <https://typesafe.ai/blog/introducing-system-one-models-and-jev>
- TypeSafe AI docs (vendor): *HTTP API* <https://docs.typesafe.ai/api.md>;
  *State* <https://docs.typesafe.ai/concepts/state.md> (the language
  sentence); *Choice* <https://docs.typesafe.ai/primitives/choice.md>;
  *Jev 1.13 jaggedness* <https://docs.typesafe.ai/model-jaggedness/jev-1.13.md>;
  cookbooks *Re-ranking* <https://docs.typesafe.ai/cookbooks/rerank_typesafe.md>,
  *RAG passage classification* <https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md>,
  *Skill suggestion* <https://docs.typesafe.ai/cookbooks/skill_suggestion.md>,
  *Double-checking citations* <https://docs.typesafe.ai/cookbooks/citation_check.md>
- OpenRouter, *Jev 1.13* <https://openrouter.ai/typesafe/jev-1.13> and the
  Decisions endpoint reference
  <https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request>
- Firecrawl, *What Is Jev?* (third party; the Every comparison and the
  CLERC numbers are quoted from it): <https://www.firecrawl.dev/blog/what-is-jev>
- LangChain, *Building a harness with Jev* (third party; tool-risk gating
  and model routing — the two uses ADR-0052 rules out here):
  <https://www.langchain.com/blog/building-a-harness-with-jev>
- TrueFoundry, *TypeSafe AI's Jev: What "System One Models" Actually Are*
  (third party; the note that the benchmark workflows were written by the
  vendor's own team): <https://www.truefoundry.com/blog/typesafe-ai-jev>
- Wikipedia, *Jev (AI model)*: <https://en.wikipedia.org/wiki/Jev_(AI_model)>
