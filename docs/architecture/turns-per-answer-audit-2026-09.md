# Turns per answer (2026-09)

> Where one chat turn spends its LLM calls, which of those calls exist only
> because of how the answer is carried, and what takes them out without taking
> a capability with them. It ends in a ranked plan whose every step names the
> loop-eval column that has to move, and in an evaluation of TypeSafe's Jev —
> a decision model, not a language model — against the one rule this repo has
> already made about deciding things before the answer (ADR-0052).
>
> **What it rests on.** The tree at this tip, read call by call
> (`agents/piloti/agent.py`, `answer_pipeline.py`, `common/turn_status.py`,
> `sources/knowledge_layer/src/register.py`, `configs/config_oib_openrouter.yml`);
> the prompt weights measured with `o200k_base` against
> `prompts/piloti_static.md`; the two Langfuse traces the
> [hobble register](hobble-register-2026-09.md) §0 already holds. **What it
> does not rest on:** a fresh trace set. Langfuse was not reachable from the
> session that wrote this and PostHog holds no `$ai_generation` events for
> this project (checked 2026-09-22, last 14 days: zero traces). Every count
> below is therefore the *minimum honest* number of calls a shape needs under
> the code as written, not a p50, and §8 starts by making it one.
>
> Complements the [hobble register](hobble-register-2026-09.md) (which
> constraint sits where), the
> [latency audit](latency-and-caching-audit-2026-09.md) (what the reader waits
> for) and the [RAG audit](rag-system-audit-2026-08.md) (whether the right
> passage comes back). Reads their open items rather than restating them.

---

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

Minimum honest call counts, today and after the changes of §8:

| Shape | Today | After | What comes out |
|---|---|---|---|
| Greeting, memory request, shelf listing | 1 | 1 | — |
| „Fass den offenen Plan zusammen" | 2 (+1 judge) | 1–2 | the judge (§4 J2); the search when the prefetch hits (§8.2) |
| „Was regelt die OIB-Richtlinie 2?" | 3–4 (+1 judge) | 1–2 | the card round (§3.3), the search when the prefetch hits |
| Ruling with a card („Feuerwiderstand tragende Wände GK 5") | 4 (+1 judge; +1 on a wrong card shape) | 2 | the card round and the shape retry (§3.3), the search (§8.2) |
| Bauordnung question via RIS („Unterlagen für die Einreichung in Wien") | 3 (+planner, +extractor) | 2 | the card round; the extractor when a § is named |
| Measurement turn („wie hoch ist der Keller") | 5 | 3–4 | the card round; the skill round when the body is pre-loaded (§4 J5) |
| Follow-up on an opened document („und in GK 4?") | 3 | 2 | the card round |
| Commissioned document („mach daraus einen Aktenvermerk") | 3 | 2–3 | nothing structural; `file_draft` depends on `write_file` |
| Commissioned report (handoff) | 1 (+ the deep path) | 1 | — |

Two things the table says that are easy to miss. First, **the card round is
the one call that appears on every researched shape and buys the reader no
new evidence** — it exists because a card is a tool call and a tool call
ends a message, so the answer needs one more call after it (§3.3). Second,
**the search round is the one the model has to make before it has read
anything**, and on the shapes the product answers most it is a call the
question alone could have made (§8.2).

---

## 1. Anatomy of a turn, call by call

```
WS frame ─▶ gather(context, inventory, registry, subject)      no LLM; one HTTP hop each, in parallel
        ─▶ render_system_prompt                                  no LLM (Langfuse prompt store, cached)
        ─▶ agent node ──▶ tools node ──▶ agent node ── … ──▶ answer
             │ 1 call        │ parallel calls   │ 1 call         │ 1 call, the envelope
             │               │ knowledge_search: embed → chroma → cross-encoder ‖ REQUERY JUDGE (1 frontier call)
             │               │                  → (insufficient?) 2 more retrievals → rerank again
             │               │ ris_lookup:       planner (1 small call) → fetch → extractor (1 small call, 0 when a § is named)
             │               │ ifc_*, surface_documents, emit_card, remember, write_file …: no LLM
        ─▶ verify_citations, verify_quoted_spans                 pure
        ─▶ repair (≤ 2 retrievals + 1 rewrite)                   up to 1 frontier call + 2 judges, only on a failure
        ─▶ sanitize, gate the envelope                           pure
        ─▶ deltas of the FINISHED text                          nothing streamed before this line
        ─▶ post-answer stages (follow-ups, reflection)          async, off the reader's path, on the bill
```

**What every call re-sends.** The static prefix is 9 722 tokens at this tip
(`piloti_static.md`, `o200k_base`; the hobble register's 8 503 predates the
envelope schema growing), of which `<answer_envelope>` is 3 884 and `<stimme>`
1 406. The envelope JSON schema is injected on top. The tool schemas ride on
every call unless deferred; ADR-0048 measured `ifc_query` + `ifc_measure` +
`emit_card` alone at ≈ 14 000 tokens before deferral, and the config still
budgets "~9 000 tokens of tool schema" per round. The dynamic half is
≈ 3 000 (hobble register row 23). History is kept to 40 000. So a research
turn's *third* call carries the prefix, the schemas, the history, two rounds
of tool results and the model's own intermediate messages — 40–80 k tokens,
which is what the traces in the register show (37 k → 83 k across one turn).
Prompt caching (row 6, `common/prompt_caching.py`) makes the prefix cheap to
re-send; it does not make the call faster to start, and it does nothing for
the tool results, which are new every round.

**The hidden calls.** Two are worth naming because they never appear as a
round and are paid on every search:

- **The requery judge** (`sources/knowledge_layer/src/requery.py`,
  `requery_llm: rerank_llm`, which is `${GRID_DEFAULT_MODEL}` — the frontier
  default — at `reasoning_effort: none`). It runs beside the reranker on
  every `knowledge_search`, reads the question and twelve 600-character
  excerpts, and answers "sufficient, or here are two other phrasings". When
  the cross-encoder was the slow half this cost nothing; the cross-encoder is
  now a ~300 ms OpenRouter call (`reranker_provider: openrouter`), so the
  judge is the long pole of every search and a frontier call per search. Its
  job is a yes/no over a state — §4 J2.
- **The RIS planner and extractor** (`ris_planner_llm`, reasoning `none`).
  One or two small calls inside `ris_lookup`, zero when the question names a
  §. Already bounded by design (register §3.3); nothing to take out.

**What is not on the reader's path** and must be left alone: the post-answer
stages, citation and quote verification (pure Python), the client's delta
batching. The latency audit §2 lists them.

---

## 2. Example queries, traced

Each row is a question the office actually asks (the loop-eval set,
`tests/fixtures/herleitung/loop_eval_questions.yaml`, plus the shapes the
config's traced floors name). "Today" is the call sequence the prompt and
tool contracts lead to, with the minimum count; "why" names what each call
needs that the previous one could not have had. Calls the hobble register
already removed (`ris_search → ris_fetch → …`, `describe_card`) are not
re-counted.

### 2.1 „Hallo, was kannst du?" · „Merk dir: Bauklasse III" · „Was liegt im Büroarchiv?"

| | Call | Needs |
|---|---|---|
| today | ① answer (`kind: direct`) — or ① `remember` → ② answer | the inventory is in the prompt; nothing to retrieve |

One call, two for a memory write. Nothing to take out except the 20 k tokens of
prefix the greeting pays, which caching already discounts. A greeting's cost
is a *prefix* problem, not a *turns* problem, and §8 does not touch it.

### 2.2 „Fass den offenen Plan zusammen." (subject document open)

| | Call | Needs |
|---|---|---|
| today | ① `knowledge_search(file_name=EG_Grundriss.pdf)` [+ judge] → ② answer | the passages; the file name is already in the prompt (`## This turn's subject`) |
| after | ⓪ prefetch `knowledge_search(question, file_name=subject)` → ① answer | the subject is known before the model runs; the fetch needs no decision |

The search is a call the *turn* could have made: the subject is bound before
the model sees the question. This is the cleanest case for speculative
retrieval (§8.2) and the first one to measure.

### 2.3 „Was weißt du über die OIB-Richtlinie 2?"

| | Call | Needs |
|---|---|---|
| today | ① `knowledge_search("OIB-Richtlinie 2")` [+ judge] → ② `read_passage` × members *or* `emit_card` → ③ `emit_card` → ④ answer | ① the family shape (every member's scope + Gliederung) — ② the Punkte the answer will name — ③ the card (a `typed_table` of the members or a `summary`) needs the content — ④ the prose needs the marker `[[card:N]]` the tool returned |
| after | ⓪ prefetch the family search (the question is family-shaped: `family_query_number` already recognises it) → ① `read_passage` × members → ② answer + cards in the envelope | ① what ② needs; the card no longer ends a message |

Three or four calls become two. The register's trace A of this exact question
ran 4 calls and truncated; the config's traced floor is 3 rounds + synthesis.

### 2.4 „Welchen Feuerwiderstand brauchen die tragenden Wände in GK 5?" (`kind: ruling`)

| | Call | Needs |
|---|---|---|
| today | ① `knowledge_search` [+ judge] → ② `read_passage(OIB-RL 2, Pkt 2.2 / Tabelle 1b)` → ③ `emit_card(legal_basis)` (+ `typed_table`) → ④ answer; a wrong `legal_basis` shape → ③′ retry with the shape the error handed back | ② the table row the verdict copies — ③ the verbatim `original_text` for the card — ④ the marker |
| after | ⓪ prefetch `knowledge_search(question)` → ① `read_passage(Punkt)` → ② answer + `legal_basis` in the envelope, shape pre-attached (§4 J3) | the passage; the card's shape arrives with the synthesis call, so the first attempt is the right one |

Four (five on a shape miss) become two. This is the product's core shape and
the one where the card round is the most visible: `legal_basis` is emitted on
most rulings, and the doctrine itself says the card is the *proof* margin
(`_LEGAL_BASIS_CARD_TYPE` in `answer_pipeline.py`) — an answer that carries
it pays a full round for it every time.

### 2.5 „Welche Unterlagen verlangt die Baubehörde in Wien für die Einreichung eines Wohnhauses?"

| | Call | Needs |
|---|---|---|
| today | ① `ris_lookup(question)` [+ planner + extractor] → ② `emit_card(document_checklist)` → ③ answer | ① the §§ of the BO Wien — ② the checklist rows need the §§ — ③ the marker |
| after | ⓪ prefetch `ris_lookup` when the question is a Bauordnung question (Land + „Einreichung/Bewilligung/Unterlagen" — the norm registry's `match_entries` already says so) → ① answer + `document_checklist` in the envelope | — |

Three become one on a prefetch hit, two on a miss. `ris_lookup` was the
register's consolidation (five calls → three); the two that remain are the
card and the search-before-reading, which are the two this document is about.

### 2.6 „Wie hoch ist der Keller?" (a model in the project)

| | Call | Needs |
|---|---|---|
| today | ① `use_skill(ifc-spatial-reasoning)` → ② `ifc_query(overview)` → ③ `ifc_measure(storeyHeight, Keller)` → ④ `emit_card` → ⑤ answer | ① the routing table between the two tools (the skill IS the vocabulary, `bim/AGENTS.md`) — ② the storey names, which ③ refuses to guess — ④ the measured value — ⑤ the marker |
| after | ⓪ the skill body pre-attached when the question is model-shaped (§4 J5), or ① `use_skill` → ② `ifc_query` → ③ `ifc_measure` → ④ answer + card | the model step is genuinely serial: the measure needs the storey name the overview returned |

Five become three or four. The serial pair ② → ③ is real work and stays; the
skill round is a *loading* call, which is what the Jev skill-suggestion
pattern removes (§4 J5). This is also the turn whose Herleitung drew two
empty „Suche" layers until this change (§6).

### 2.7 „…und in GK 4?" (follow-up; `OIB-RL 2` is in „Bereits gelesen")

| | Call | Needs |
|---|---|---|
| today | ① `read_passage(OIB-RL 2, Pkt 2.2)` → ② `emit_card` → ③ answer | ① the other column of the same table — ② the card — ③ the marker |
| after | ① `read_passage` → ② answer + card | the digest already names the document; nothing to search |

Three become two. The digest did its job (no search); the card round is all
that is left.

### 2.8 „Erstell mir einen ausführlichen Bericht zum Brandschutz." (handoff)

One call, by design (ADR-0052: "a commissioned report needs no retrieval of
your own first"). The deep path that follows has its own budget shape and is
out of scope here.

### 2.9 „Mach daraus einen Aktenvermerk."

| | Call | Needs |
|---|---|---|
| today | ① `write_file` → ② `file_draft` → ③ answer (+ the `document_draft` system card, pushed by the tool) | ② needs ①'s path; ③ needs the card's marker |
| after | same; the dependency ① → ② is real | — |

Nothing structural. The one thing §3.3 must keep is that `document_draft`,
`document_grid`, `file_operation_proposal` and `task_created` are **system
cards pushed by tools**, not cards the model composes — they stay on the tool
channel whatever happens to the model's own cards.

---

## 3. The output format, questioned

The envelope (`common/answer_envelope.py`) is the right decision and this
section does not reopen it: the verdict, summary, takeaways and callout are
the answer's own anatomy, parsed once and gated deterministically, and they
used to cost a tool call each. What follows is what the envelope *carries*,
and one thing it does not carry yet.

### 3.1 What it buys — keep

- One contract per turn whatever the turn was (a greeting is `kind: direct`
  with one field). The platform never guesses.
- Gates that grade the *output* and never tell the model how to work
  (register §5): a verdict longer than 60 characters is dropped, a summary
  over 320, more than one callout.
- Rendering the schema from the validator's own models, so the prompt and the
  gate cannot drift.

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
- **The cards are not in it.** See 3.3.

### 3.3 Cards are tool calls, and that is the one extra round on every researched turn

`emit_card` is bound as a tool (`cards/register.py`). A message that carries
tool calls is not the answer — `tools_condition` routes it to the tools node,
the cards are validated and pushed into the `CardRegistry`, and the model is
called **again** to write the prose with the `[[card:N]]` markers the tool
handed back. That second call re-sends the whole context (40–80 k tokens on a
researched turn) to produce text the model could have written in the same
breath as the card. On a wrong shape it is a third call: the error returns the
shape (`_shape_hint_for`), the model retries, then answers.

The doctrine already treats cards as part of the answer — "delete the cards
mentally and the answer must still answer", a card is placed "while you
write, not afterwards" — and the envelope already made the same move for
the verdict and the takeaways, for the same reason: "emission was optional
twice (the model had to recognise the trigger AND spend a tool call)"
(`answer_envelope.py`, header). The cards are the last of the model's own
output still travelling on the tool channel.

**The change.** A `cards` field on the envelope: a JSON array of card
objects, each exactly what `emit_card` takes today, validated by the same
`grid_card_adapter`, pushed into the same registry in `finalize_answer`
before `_suppress_cards` runs. `[[card:N]]` keeps its positional meaning: N
indexes that array, in order, so the frontend's resolver
(`features/grid-cards/card-markers.ts`) does not change. What changes:

| | Today | After |
|---|---|---|
| A card on a researched answer | +1 full-context call | 0 calls |
| A card whose shape was wrong | +2 calls (retry, then answer) | one bounded repair on the small tier, with the same shape hint text the error returns today; if that fails the card is dropped and `status:card:invalid` records the type — never the answer |
| System cards (`document_draft`, `document_grid`, `file_operation_proposal`, `task_created`, `ifc_*`) | pushed by their tool | unchanged; `emit_card` stays bound for them and for a model that reaches for it anyway |
| The card doctrine (triggers, craft, honesty) | in the `emit_card` description | moves to the envelope's `cards` field description — the same text, one home, no second copy in the prompt (register row 8 holds) |
| `[[card:N]]` | returned by the tool | the model numbers the array it wrote; the marker contract in `<cards>` stays as is |

**What it must not break, and the tests that say so.** Strict
`json_schema` cannot express the 40-way card union (`envelope_call.py`
already says so about `cards/generate.py`); the synthesis call therefore
stays on the fenced contract or the `json_object` rung, which it is on today
(`envelope_json_mode_with_tools: false`). A card the validator rejects costs
the card, never the answer — the fail-open asymmetry of the envelope header
applies verbatim. `_suppress_cards` and its two vetoes (a system card, a
`legal_basis`) read the registry after it is filled, so the short-overview
rule keeps working. The post-hoc deep-research path (`cards/generate.py`)
does not change. Measure: `loop_eval` gains `card_rounds` (rounds whose
calls were all `emit_card`; today 1 on every card-bearing row, must be 0) and
`cards_invalid` (from `status:card:invalid`; must not rise above today's
shape-retry rate, which `status:action:card` followed by a second
`status:action:card` in one turn already counts).

This is the single change with the largest turn effect and no capability
cost, and it needs an amendment to `cards.md` / ADR-0012 (the "synchronous
card channel" paragraph in `cards/register.py` argues the tool step is a
*visible* step; the envelope makes it visible after the fact, on the wire,
which is what the Herleitung reads anyway).

### 3.4 Envelope or trailer, when streaming is built

Not now; when ledger item 16 is picked up, the carrier is the decision. Two
forms of the *same* schema, same fields, same gates:

- **Envelope** (today): one JSON object, prose inside. Streaming needs an
  incremental string-field reader that withholds `[N]` until the marker
  closes and resolves.
- **Trailer**: the prose first as it is written, then ONE fenced
  `answer_meta` object last (kind, confidence, summary, verdict, takeaways,
  callout, cards). The prose streams natively; the markers are withheld the
  same way; the registry is complete by synthesis time so per-marker
  verification is deterministic; the sources section is rebuilt anyway; a
  handoff's one-line answer streaming and then being replaced by the terminal
  frame is legal on this wire (the frame is authoritative).

The trailer is the cheaper build and the envelope is the cleaner contract;
the gates do not care which. It is an ADR, not a paragraph, and it is
sequenced after §3.3 so the `cards` field exists in whichever carrier wins.

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

**J2 — replace the requery judge.** The judge is a frontier call per search
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

**J1 — gate and shape the speculative prefetch of §8.2.** The prefetch needs
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

**J3 — card selection, so the shape arrives with the synthesis call.** The
user's "multi-select which cards have to be created" is several Nouls in one
call, one per trigger row of `_CARD_TRIGGERS` (twenty-odd), over `{question,
the round conclusions, the retrieved passages' headings}` — never the full
passages (the "large irrelevant state" edge). The top one or two types above
threshold get their L2 shape (`render_card_details`) attached to the
synthesis call. Nothing is withheld: the model may still emit any card, and a
type Jev did not pick simply arrives without its shape, exactly as today.
What it buys, combined with §3.3: the first attempt is the right shape, and a
card costs zero rounds. Measure: `cards_invalid` must fall; `card_rounds` is
already 0 from §3.3. Worth doing only after §3.3, since with the tool channel
the shape still costs a round.

**J5 — skill suggestion.** TypeSafe's *skill suggestion* cookbook is the
`use_skill` round: a Choice over the L1 catalog, and the winner's body
attached to this turn's prompt below the cache boundary. The tension with
ADR-0060's "a skill is an offer" is real and resolvable: the body is offered
*earlier*, the tool stays bound, nothing is forced, and a skill the model did
not need costs its tokens once rather than a round. Measure `skill_calls` on
the model rows of the loop eval (today ≥ 1 on every measurement turn).

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
  it already is.
- **The live line is per round, not per call.** A round of five parallel
  opens shows one line; the judge inside a search shows nothing. Fine while
  the judge is fast; if J2 is not done, a 10 s judge is a silent 10 s.
- **`ask_user` costs a round and a human.** One per turn, six options, and
  the guard is right (register row 11). Nothing here changes it; the
  clarification doctrine ("state your assumption, or ask ONE question") is
  the cheaper path on most turns and the prompt already prefers it.

---

## 8. The plan, ranked

Rank = calls removed per researched turn × how often the shape occurs ÷ what
it risks. Every row names the loop-eval column that must move and the one
that must not.

| # | Change | Calls out | Must move | Must not move | Size |
|---|---|---|---|---|---|
| 1 | **Make the loop eval report calls, not only rounds.** `llm_calls` per row off the cost tracker (`GridCostTracker` already meters every completion of the turn, hidden ones included), `card_rounds`, `judge_calls`. Then run it once at this tip and commit the CSV beside the yaml | 0 | — | — | S |
| 2 | **Cards in the envelope** (§3.3) | 1 on every card-bearing turn, 2 on a shape miss | `card_rounds` → 0 | `cards_invalid`, `verdict`, `punkt_match` | M + an amendment to `cards.md` |
| 3 | **Speculative prefetch, no decision model** (§2.2, §2.3, §8.2 below) | 1 on most researched turns | `rounds` down, `truncated` → 0 on the family rows | `punkt_match`, `family_coverage`; `prefetch_wasted` must be reported | M |
| 4 | **Applicable outlines below the boundary** (§5 b) | up to 1 on Punkt-shaped questions | `read_passage` up, `repeat_query` down | `punkt_match` | S |
| 5 | **The decision eval** (§4.4), then J2, J1, J3, J5 in that order, each behind its adoption rule | 1 hidden frontier call per search (J2); the skill round (J5) | `judge_calls` → 0 (J2), `skill_calls` (J5) | everything the rule names | S for the eval; S each after |
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
repairs, config comment); preloading law texts by project (§5 c); trimming
the envelope's rhetorical fields to save output tokens (output is 0.4–1.4 %
of a turn's tokens, register §0).

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
