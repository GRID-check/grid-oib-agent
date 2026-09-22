# The Piloti hobble register (2026-09)

> Every constraint in the answering path, ranked, and classified by what it
> actually does: remove a capability the model has, prevent waste that a tool
> should have prevented, or catch a false claim after the fact. It rests on two
> Langfuse traces of the same question and on token counts measured against the
> tree, and it ends in the tool design that came out of it (`ris_lookup`).
>
> **Status** on each row says what has since closed it. A sha names a commit;
> *in this change* means the work ships beside this record and has no sha yet.
> Rows marked *keep* are the ones that must not be removed, and §5 says why.
>
> The decision this produced:
> [ADR-0060](../adr/0060-three-instruction-layers-and-tools-that-answer.md).
> Complements [`latency-and-caching-audit-2026-09.md`](latency-and-caching-audit-2026-09.md)
> (what a reader waits for) and [`rag-system-audit-2026-08.md`](rag-system-audit-2026-08.md)
> (retrieval quality).

---

## 0. The measurements this register rests on

Two Langfuse traces of the **same** question, `„was weißt du über die oib 2"`,
`data_sources: [web_search, ris, knowledge_layer]`:

| | trace A `5ecd335b` | trace B `b301cc32` |
|---|---|---|
| LLM calls | 4 | 8 |
| prompt tokens (trace metadata) | 147 631 | 288 583 |
| completion tokens | 2 007 | 1 137 |
| **output share of tokens** | **1.35 %** | **0.39 %** |
| per-call input | 74 106 / 41 883 / 31 043 | 37 002 → 43 025, six calls |
| cost (sum of `totalCost`) | $0.159 | $0.295 |
| wall clock | 36.3 s | 27.5 s |
| tool shape | `use_skill`, `knowledge_search`, `read_passage`×5 | `use_skill`, `knowledge_search`, `read_passage`, `knowledge_search`, `emit_card` |
| **`status:budget` step** | **present — the turn was truncated** | absent |

Solving the trace's own `totalCost` against `usageDetails` over three calls in
trace B gives ≈ **$1/M input, $6/M output** at the research role's then-current
model. So output is **2.3 %** of trace B's turn cost and **7.6 %** of trace A's.
That is the denominator every "we save output tokens" argument in this repo has
to beat.

The other number that matters: trace A **ran out of research budget on
"what do you know about OIB 2"** — the single most ordinary question the
product answers, and row `was-weisst-du-ueber-oib-2` of the loop eval
(`tests/fixtures/herleitung/loop_eval_questions.yaml`). Not an exotic six-hop
chain. A family overview.

Static prompt weight, measured (`piloti.j2`, 57 007 chars ≈ 14 250 tokens):
`<answer_envelope>` 1 658 · `<cards>` 1 432 · `<stimme>` 1 391 ·
`<output_contract>` 1 147 · `<examples>` 964 · `<research_rules>` 700 ·
`<source_priority>` 509 · `<citation_format>` 367 · `<clarification>` 310 ·
`<query_rewriting>` 114. Plus the `emit_card` schema, whose doctrine renders
at **918 tokens** and whose index renders at **942**
(`aiq_agent.cards.catalog.render_card_doctrine` / `render_card_index`,
measured through the venv).

**Resolved since.** The static prefix is 8,503 tokens (`0e89484`), the card
doctrine has one home (`1762b09`), and the zero-cached-tokens finding is closed
by `8773a95`: each turn's prefix is pinned to one provider cache shard and the
cached/uncached split is reported per turn. §4.5 of the latency audit carries
that half.

**And the half this audit did not measure.** Everything above is the STATIC
prefix. The dynamic half below the `KV CACHE BOUNDARY` marker was never counted
here, and on a realistic turn it was **7,724 tokens** — none of it cacheable,
so all of it charged fresh on every call. It is now **2,962** (row 23). The
pattern was row 8's, three more times: a tool's contract written out in prose
beside the tool that already states it.

---

## 1. The register, ranked

Rank = (quality damage × how often it fires) ÷ cost of the real fix.
Classification: **H** = capability-removing hobble · **W** = waste-prevention
that should be a tool · **R** = safety ratchet, keep · **B** = budget, keep or
retune · **D** = defect.

| # | Constraint | Where | Removes / prescribes | Class | Real fix | Status |
|---|---|---|---|---|---|---|
| 1 | RIS is three tools plus a prompt-taught sequence | `configs/config_oib_openrouter.yml`, `sources/ris_adapter/src/register.py`, `piloti.j2` | Model must spend 2–3 of 7 charged calls (catalog → search → fetch) to reach one citable §; the fetched blob is not a grounding block, so nothing downstream can resolve a § | **H** | `ris_lookup` — §3 below | **In this change** (the design in §3 is what is being built) |
| 2 | Research budget is charged per **emitted call**, never refunded; forced synthesis at the ceiling | `max_tool_iterations: 7`; `agent.py`, `_SYNTHESIS_ANCHOR` | A parallel round of five costs five. Trace A truncated on a family overview | **H** (the ceiling is fine; the *unit* is the hobble) | Charge **rounds**, not calls; keep 7 as a round ceiling, add a token/wall-clock stop | **In this change** |
| 3 | `reasoning_effort: low` on `research_llm` | `configs/…` | The one role that decides *what to retrieve* is the only role denied deliberation; `clarifier`, `deep_*`, `card` all get `medium` | **H** | `medium` on the research role; re-measure latency, which is what the comment actually argues about | **In this change** |
| 4 | Web search returns 8 snippets, each truncated to 1 000 chars, and there is no web fetch | `configs/…` `max_results: 8`, `max_content_length: 1000` | Nothing quotable comes back, and the prompt has no "fetch the page" move to offer — the RIS advice ("prefer the fetched text over search snippets") has no web twin | **H** | `web_lookup(question, conclusion=)`: search → fetch top 2 → extract passages → same grounding block. §4 | **Open** — deliberately after RIS, so the eval delta stays attributable |
| 5 | `<source_priority>` "Choose sources in this order" | `piloti.j2` | A fixed 1→4 ordering over corpora, decided before the question is read. A Wiener Bauordnung question is told to start in the OIB corpus | **H** | Delete the ordering; keep the *facts* (what each corpus holds, what it does not) in the tool descriptions where they already are | **Closed** `0e89484` — the section is a description of what each corpus holds |
| 6 | Data-source toggles delete tools from the binding and from the prompt | `common/data_sources.py`; `configs/…`; `piloti.j2` | A toggle changes both the tool set and the prompt text → a different `prompt_cache_key` shard, so every toggle combination pays a cold prefix on a turn that is 99.6 % input tokens | **H** + cost | Keep the tool bound, make it **refuse** with a reason (mask, don't remove). One cache shard per org/model, not per toggle combination | **In this change** |
| 7 | History trimmed to 8 000 tokens | `conversation_register.py`, `conversation.py`, `history.py` | On a model carrying 37–83 k tokens per call, the *conversation* is the one thing cut. A user's correction three turns back is gone while 14 k of static prompt is re-sent | **H** | Raise to ~40 k, or budget history as "what is left after prompt + tools + this turn's observations", which is the only budget that means anything | **In this change** |
| 8 | Card doctrine exists twice: `<cards>` in the prompt **and** `emit_card`'s rendered doctrine + index; shape needs a `describe_card` round trip | `piloti.j2`; `cards/register.py`; `catalog.render_card_doctrine/index` | ≈ 1 432 + 918 + 942 ≈ 3 300 tokens on **every** call of every turn, plus one charged interaction call to learn a shape | **H** (the split) / **W** (`describe_card`) | One home for triggers (the tool schema — it is the thing that is called). Return the shape *with the validation error* `emit_card` already returns, and drop `describe_card` from the bound set | **Closed** `1762b09` — trigger table is data, a failed `emit_card` teaches the shape, `describe_card` off the chat surface |
| 9 | `<query_rewriting>` — "Before calling any search tool, rewrite the user's question" | `piloti.j2` | Prescribes a step three tools already perform: `ris_search` has `ris_planner_llm`, `knowledge_search` has the requery gate, the web tool rewrites internally | **H** (redundant instruction, ~114 tok/call) | Delete. If a tool does not rewrite, fix the tool | **Closed** `0e89484` |
| 10 | Round-zero fan-out cap: first round runs at most two searches | `agent.py` `_ROUND_ZERO_SEARCH_LIMIT = 2` | Three plausible corpora (knowledge, RIS, web) do not fit in two calls. `ris_fetch` / `ris_catalog_lookup` counted as "searches" although a document number is an address, not a guess | **H** | Delete it: it judged the model's process, and the budget bounds cost without prescribing a round's shape | **Closed** `47b2be9` (locator calls stopped counting), then `7f6270c` (the cap is gone). What remains is `max_calls_per_round` (12, config), a runaway guard on the width of ONE round that no batch the prompt asks for comes near; the calls past it are answered with „ask again next round", not refused |
| 11 | "Ask at most one question" + one `ask_user` per turn, hard | `piloti.j2`; `ask_user.py`, `AskUserGuard`, `MAX_OPTIONS = 6` | A turn that genuinely needs two facts (Bundesland **and** Gebäudeklasse) must guess one | **R** for the transport guard (one outstanding prompt is a real transport invariant), **H** for "one per turn" | Keep the transport guard. Let a turn ask twice if it answers between them; drop the prompt sentence | **Open** |
| 12 | Every retrieved passage truncated | `knowledge_layer/register.py` `_CHUNK_TRUNCATE_CHARS = 2500`; RIS `max_chars: 40000`; web `max_content_length: 1000` | An OIB table longer than 2 500 chars loses rows — the comment says so and then keeps the cut | **B** at 2 500 (defensible), **H** at web 1 000 | Cut on a **row/paragraph boundary** with a stated remainder and a way to open it, not mid-table. RIS's 40 k becomes an extractor bound rather than a model-facing one (§3) | **Partly, in this change** — the RIS half is §3; the web half rides with row 4 |
| 13 | Four tools over one index | `knowledge_search`, `read_passage`, `surface_documents`, `view_knowledge_image` | Each description spends a paragraph saying *not* to call the other three | **H** (mild) | Lower priority than RIS: each is addressed differently and the pairing is now coherent. Revisit after RIS lands; `surface_documents` is the merge candidate (`mode=one/many` is `knowledge_search` with a different renderer) | **Open**, deferred on purpose |
| 14 | Off-topic decline: "Do NOT answer the question, even when you happen to know the answer" | `piloti.j2` | Removes capability by policy | **R** — product scope, not a hobble | Keep | **Keep** |
| 15 | Duplicate-fetch guard withholds an identical call | `agent.py`, `_drop_repeat_fetches` | Right intent, wrong return: the model gets a German scolding instead of the result | **W** | Return the **cached result** with a one-line note that it is a repeat. Costs nothing, keeps the transcript append-only, removes the retry loop the notice is trying to talk the model out of | Guard added `d1792bb`; the cached-result return is **in this change** |
| 16 | `_INTERACTION_TOOL_ALLOWANCE = 9` | `agent.py` | Cards/memory/drafts do not eat research budget | **B**, keep | It exists only because #2 charges calls. Charging rounds makes most of its derivation unnecessary | **In this change**, with row 2 |
| 17 | Repair: 2 retrievals, 1 rewrite | `repair.py` | Bounds the post-verification repair | **B**, keep | None. This is the model of a good bound: it caps cost without prescribing the shape | **Keep** |
| 18 | `max_llm_turns: 10` is dead, and the config reasons from it | `configs/…`; `register.py` warns it is ignored; real limit `agent.py::_recursion_limit` | The config comment computes "well under `recursion_limit` 30 (`max_llm_turns * 2 + 10`)". The code gives **46**, from a different formula | **D** | Delete the key, fix the comment. A stale derivation in the one file people tune is how the next budget decision goes wrong | **In this change**, with row 2 |
| 19 | `top_k: 16`, `max_chunks_per_document: 5`, `rerank_candidates: 60`, relevance floor | `configs/…`; ADR-0057/0058 | Retrieval-side bounds with measured derivations | **B**, keep | None | **Keep** |
| 20 | `tool_search` off; `deferred_tool_loading` on with `min_intelligence_index: 50` | `configs/…`; `piloti/tool_search.py`; ADR-0048 | Both *add* capability or leave it untouched; the off switch is argued from measurement (71 % answering-tool recall) | **B/R**, keep | None. `tool_search.py` names the real constraint — "turns are the scarce resource" — which is row #2 | **Keep** |
| 21 | Citation verification only ever removes; confidence capped without verified citations | `piloti.j2`; `piloti/grounding.py`; `piloti/AGENTS.md` "two currencies" | Catches a false claim **after** the fact | **R**, keep | None. This is the archetype of what must stay | **Keep** |
| 22 | `conclusion=` required on every retrieval call | `knowledge_layer/register.py`; `turn_status.py` | One sentence per call, deliberately unread by the tool | **R** (it is the Herleitung's evidence, and it is a *slot*, not a sequence) | Keep. Extend to `ris_lookup` | **Keep**, and extended in §3 |
| 23 | The DYNAMIC half restates tool contracts and standing doctrine | `piloti.j2` below the boundary: `<entwuerfe>` 788 · `<aufraeumen>` 329 · `<delegieren>` 383 · `ris_catalog` 1 544 · `norm_doctrine` 788 · the three `project_context` explanations 718 | 7 724 tokens on a realistic turn, none of it cacheable, so every call of every turn pays all of it. Row 8's pattern, three more times: a bound tool's contract written out beside the tool that already states it | **H** | Each rule into the tool description that owns it; standing doctrine ABOVE the boundary, where identical bytes are cached; the catalog deleted, because `ris_lookup` resolves a pointer from the question | **Closed** — ADR-0060 amendment. 7 724 → 2 962; two sentences of rule survive (`<entwuerfe>`: the anaphora, and that filing needs a project) and per-turn FACTS are all that is left |

---

## 2. The top eight, one paragraph each

**1 — RIS is three tools and a taught sequence.** The config binds
`ris_search_tool`, `ris_fetch_tool` and `ris_catalog_lookup_tool`, and the
prompt then taught the workflow that joins them: *"Search with the RIS search
tool (German terms), then fetch the ENTIRE relevant document with the RIS fetch
tool … Prefer the fetched text over search snippets."* Each tool's own
description repeated the chain — `ris_search`'s docstring ends "pass the
document number (or Source URL) to ris_fetch_document and read the entire
document before citing it", `ris_catalog_lookup`'s says "Then call
ris_fetch_document". Three charged calls, three round trips of ~40 k input each,
to arrive at a 40 000-character blob that carries `Source:` and `Title:` but no
`Citation:` key, no `Punkt:` and no per-passage block — so
`_parse_knowledge_layer` never sees it (that parser is registered on
`"knowledge" in name`), and the RIS text falls through to the generic URL
extractor. The paragraph that answers the question is somewhere in 40 k
characters; the answer cites a URL. This is the row Anthropic's tool guidance is
written about — *"Tools can consolidate functionality, handling potentially
multiple discrete operations (or API calls) under the hood"* — and OpenAI's
*"The issue isn't solely the number of tools, but their similarity or overlap."*
Fix in §3.

**2 — The budget charges emitted calls, and a family overview exhausts it.**
`max_tool_iterations: 7`, charged as `new_iterations += len(response.tool_calls)`
when the model *emits*, never refunded; the config's own comment states all three
consequences, including "PARALLEL calls each cost one, so a model emitting three
per turn gets two round trips out of five". Trace A is that sentence happening:
one `knowledge_search` plus five parallel `read_passage` opens — exactly the
family overview the prompt *instructs* — and `status:budget`, the
forced-synthesis telemetry step. The prompt and the budget are in direct
contradiction: the prompt says open every member of the family in one round, the
budget says a five-member family costs five of seven. The root cause is the
unit, not the number. A round is one LLM decision; parallel calls within it are
the model using the round well, which is precisely what should be *cheap*. Fix:
charge one unit per tool-calling round, keep 7 as the round ceiling (it then
means seven think–act cycles, which is what everyone already believes it means),
and add the bound that actually protects the user — wall clock, or cumulative
input tokens. It deletes more code than it adds, because the interaction
allowance and the fan-out cap both exist only to protect a per-call budget.
Measure on `loop_eval` `truncated` (must fall to 0 on the four family-overview
rows), `rounds`, and turn cost.

**3 — `reasoning_effort: low` on the role that decides what to retrieve.** The
config's comment argues **latency**, not cost: "medium spent a large hidden-token
'think' budget before emitting the first answer token … final synth ≈29s on a
simple meta-ish query". Every other role in the file runs `medium` (`clarifier`,
`deep_orchestrator`, `deep_planner`, `deep_researcher`). So the agent that must
decide, with no results in hand, which of four corpora holds the answer — the
decision the whole 7-call budget is then spent executing — is the one told not to
think. The traces price the trade: output is 0.39 % and 1.35 % of tokens, 2.3 %
and 7.6 % of cost. Tripling output tokens at `medium` costs single-digit percent
of a turn; one wasted retrieval round costs ~40 k input tokens, i.e. ~14 % of
trace B, plus a round off a budget that already truncates. The latency claim is
real but was measured on "a simple meta-ish query" — the case where deliberation
is worth least. Fix: `medium`, and re-measure on the loop-eval set rather than on
a meta query. Risk: p95 latency rises; the honest mitigation is that a truncated
answer at 27 s is worse than a complete one at 35 s.

**4 — Web search cannot produce evidence.** `web_search_tool` returns up to 8
results truncated to 1 000 characters each, with `ris.bka.gv.at` excluded
(correctly — RIS has its own adapter). There is no web *fetch*. So
`<source_priority>`'s rung 4 handed the model snippets it is forbidden to quote
from (`<citation_format>`: "Cite only what a tool actually returned"), with no
move available to turn a snippet into a passage. The RIS half of the prompt knew
this problem exists and solved it with a second tool; the web half did not. Fix
is the same shape as §3: `web_lookup(question, conclusion=)` searches, fetches
the top two pages, extracts the passages that answer the question, and emits the
same grounding block. Lower rank than RIS only because Austrian building law is
the product and the web is the fallback.

**5 — A source ordering decided before the question is read.** `piloti.j2`
numbered the corpora 1 → 4 and said "Choose sources in this order, based on the
query". Rung 1 claimed primacy for the knowledge base "because the binding text
sits here and carries a page"; rung 2 sent statutes to RIS. But the loop-eval row
that exercises RIS — `einreichung-wien-unterlagen`, "Welche Unterlagen verlangt
die Baubehörde in Wien für die Einreichung eines Wohnhauses?" — is a Bauordnung
question whose answer is *only* in RIS, and the prompt still pointed it at the
corpus first. This is ADR-0052's argument one layer down: that ADR deleted the
intent classifier because "a label decided *before* the answer can only ever
withhold capabilities the answer turns out to need", and a numbered source
ranking is the same label, written in prose. Every fact the ordering carried is
already in the tool descriptions, stated as fact rather than as sequence:
`_KNOWLEDGE_SEARCH_DESCRIPTION` says "Live Austrian law (statutes, Bauordnungen)
is the RIS tools, not this index"; `ris_search`'s docstring has a full WHEN NOT
TO USE block. Fix: delete the rungs and keep only the image rule, which is a
*capability* hint rather than an ordering. ~509 prompt tokens per call, and one
fewer place for the tool contract to drift from itself.

**6 — Toggling a data source deletes the tool and rewrites the prompt.**
`filter_tools_by_sources` drops the tool from the binding; the prompt then tells
the model "Use only the tools listed in Available Tools below … With no web
search tool listed, you have no web access." Two costs. First, the masking point:
*"Unless absolutely necessary, avoid dynamically adding or removing tools
mid-iteration"*, and the answer — *"Rather than removing tools, it masks the
token logits during decoding"*. Second, this repo's own cache design:
`prompt_cache_key` hashes "the tenant, the model, the system prompt and the tool
set" (`common/prompt_caching.py`), so each toggle combination is a separate
shard, on a workload where input is 99.6 % of tokens and the prefix is re-sent
3–8 times per turn. Fix: keep every tool bound; a disabled source's tool returns
`"Web search is switched off for this organisation — answer from what you have,
and say that you could not check the web."` One prompt, one tool set, one cache
shard. Org-disabled sources (ADR-0022) stay enforced — by the tool, which is the
layer that cannot be talked around, rather than by absence.

**7 — The conversation is the only thing trimmed.** `max_history_tokens: 8000`,
applied by `trim_message_history` before the agent runs. Meanwhile a single call
in trace B carries 83 515 input tokens and the static prompt alone was ~14 250.
The 8 k budget predates the current context sizes and now trims the only part of
the context nobody else can reconstruct: what the user said, and what they
corrected. `<project_brief>` and `PROJECT_MEMORY` exist partly to carry facts
*across* the gap this trim creates. Fix: make the history budget the residual —
model context minus prompt minus tool schemas minus this turn's observations
minus a synthesis reserve — and floor it at something like 40 k. Measure: turns
where a fact stated earlier in the same conversation has to be re-asked.

**8 — The card doctrine is paid twice on every call.** `<cards>` in the prompt
was 1 432 tokens; `emit_card`'s description renders `render_card_doctrine()`
(918) plus `render_card_index()` (942) into the tool schema. The comment in
`cards/register.py` was explicit that the split was deliberate — contract in the
tool, craft in the prompt — and equally explicit about why the doctrine itself
moved to `catalog.py`: "a trigger table that exists twice is a trigger table that
will disagree with itself." The same argument applies one level up. Then
`describe_card` cost a charged interaction call and a full round trip to learn a
shape, which the prompt had to talk the model into paying ("one `describe_card`
call is cheaper than the card that does not come"). Fix: triggers and craft both
in the tool schema, `<cards>` reduced to the one thing only the prompt can say
(the `[[card:N]]` marker contract, which is about the *answer*), and shapes
returned with `emit_card`'s validation error — the retry path `_shape_hint_for`
already implements. Saves ~1 400 tokens/call and one round trip per card-bearing
turn.

---

## 3. `ris_lookup` — the consolidation, in detail

### 3.1 What exists

| Tool | Signature | Returns | Cost |
|---|---|---|---|
| `ris_search_tool` | `(query, application="BrKons", title, bundesland, date_from, date_to, page)` | up to 20 numbered *references*, each with title, doc number, citation URL, plus "call ris_fetch_document" | 1 charged call + 1 `ris_planner_llm` call |
| `ris_fetch_tool` | `(reference, application="")` | up to 40 000 chars of raw law text, header `Source/Title/Retrieved`, ingested into the session collection | 1 charged call |
| `ris_catalog_lookup_tool` | `(topic)` | up to 8 verified pointer blocks from the norm registry | 1 charged call |

Plus `ris_search`'s internal catalog shortcut, which already does the catalog
lookup *inside* the search when no title/date/case-law signal is present — so
`ris_catalog_lookup_tool` is largely a second door onto a path the first tool
already walks.

### 3.2 The tool

```python
async def ris_lookup(
    question: str,                 # the legal question, in German
    conclusion: str = "",          # Herleitung checkpoint; empty on the turn's first call
    jurisdiction: str = "",        # "Wien" | "Tirol" | … ; "" = derive
    instrument: str = "",          # optional address: "Bauordnung für Wien", "§ 63 BO Wien",
                                   # a NOR/ Gesetzesnummer, or a ris.bka.gv.at URL
    application: str = "",         # escape hatch for case law / gazettes: "Vfgh", "Justiz",
                                   # "Begut", … ; "" = decided internally
) -> str
```

One tool. `question` is what the user needs answered, not a search string —
the rewriting happens inside, where the planner already lives.

### 3.3 Internal pipeline, with its own bounds

```
question ─┬─► [1] address parse (deterministic)
          │      § / Art / Abs in question or instrument?   → §-locator
          │      named law?                                 → catalog / title filter
          │      Bundesland: jurisdiction > instrument > question > project brief `bundesland=`
          │        (reuses extract_bundesland / focus_entries, ris_adapter/catalog)
          │
          ├─► [2] candidates, CAP 3
          │      a. norm registry: match_entries → focus_entries
          │      b. miss → live OGD-RIS via the existing ris_planner_llm plan,
          │         page_size 20, take top 3
          │
          ├─► [3] fetch, CAP 2, in parallel
          │      fetch_document_cached — shared read-through cache, FULL text (the
          │      40 000-char cut becomes an extractor bound, not a model-facing one)
          │
          ├─► [4] extract, CAP 6 passages across at most 2 documents
          │      a. DETERMINISTIC when a § / Art / Abs was named in [1]:
          │         split on the RIS consolidated-text paragraph grammar
          │         (`§ 63.`, `Artikel 5`, `(1)`), return that § with its Absätze.
          │         No LLM call at all.
          │      b. OTHERWISE one ris_planner_llm call (already configured,
          │         reasoning_effort: none, max_tokens 8192, timeout 60):
          │         input is the question plus the fetched documents' § HEADINGS ONLY
          │         (never the bodies — that is what keeps it cheap and bounded),
          │         strict json_schema output = up to 6 ranked § ids + one reason each.
          │         The deterministic splitter then cuts those §§ out of the text.
          │      c. each passage capped at knowledge_layer's own _CHUNK_TRUNCATE_CHARS
          │         (imported, never restated), cut on an Absatz boundary
          │
          ├─► [5] ingest (unchanged from ris_fetch_document)
          │      full text → session collection under _safe_document_name, marker-guarded,
          │      so read_passage can reopen a § later in the conversation and the
          │      „Bereits gelesen" digest picks it up
          │
          └─► [6] render: the knowledge_search grounding grammar, verbatim
```

Worst case per call: 1 planner call + 2 HTTP fetches (cached after the first)
+ 1 extractor call = **one charged research call**, versus three today.
Best case (a named §, a catalog hit, a warm cache): one charged call, zero LLM
calls, one cache read.

### 3.4 The return format

Byte-compatible with `_format_results` (`knowledge_layer/register.py`), because
that is the only thing that makes the rest of the system treat RIS as evidence:

```
Found 2 relevant passage(s):

--- Result 1 ---
Source: Bauordnung für Wien
Collection: ris_bundesrecht/lr_wien
Shelf: base
Dokumentart: gesetz — Gesetz
Punkt: § 63 Abs 1
Citation: Bauordnung für Wien, § 63 Abs 1 (Fassung 2026-03-14)
Content Type: text
Relevance Score: 0.91

(1) Dem Ansuchen um Baubewilligung sind anzuschließen: …

--- Result 2 ---
…

## Trace-Lanes
{"lanes": [{"lane": "gesetz", "kind": "baurecht", …}]}
```

Four load-bearing details:

* **`Citation:`** carries the Kurztitel, the § and the Fassung date, and the
  Fassung date rather than the retrieval date — `_RIS_TITLE_FASSUNG_RE` exists
  because the retrieval stamp made the same law ingest as a new document daily.
  The same reasoning applies to the citation key: a citation must name a
  *version*, not a *download*.
* **`Punkt:`** is the § (with Absatz where the extractor resolved one). The
  knowledge parser reads it into `SourceEntry.punkt`
  (`citation_verification.py::_parse_knowledge_layer`, `_KL_PUNKT_RE`), which
  is what puts a paragraph number in front of the reader instead of a URL.
* **`Dokumentart: gesetz`** is what `lane_for_hit` reads first, so the chip
  renders as law rather than unknown, and `source_kinds` maps it to the coarse
  `baurecht` kind with no new kind added (the `AGENTS.md` rule holds: no mirror
  change in `source-kinds.ts` is needed).
* **`Source:` line plus a `Source URL:` line.** The URL stays so the reader can
  open the consolidated law; the `Citation:` key is what the answer copies. The
  `Konsolidierte Fassung` disclaimer (`_legal_status_note`) rides as its own
  header line and is never inside a passage body.

Registration: `register_source_parser(lambda name: "ris_lookup" in name,
_parse_knowledge_layer)` — one line in `common/citation_verification.py`, reusing
the existing parser rather than writing a second grammar. (Alternatively name
the format-emitting helper in a shared module and have both tools call it; the
parser registry already supports a predicate, so the one-liner is enough.)

### 3.5 What a miss returns

Never empty, never a bare error. The same vocabulary `_empty_search_message`
gives `knowledge_search`, carrying four facts:

1. what was actually searched — the planner's `suchworte` and `application`,
   not the user's words, because the model needs to see the rewrite it did not
   write;
2. which Bundesland was assumed and **where that came from** (argument /
   instrument / question / project brief). A wrong jurisdiction is the
   commonest silent RIS failure and `focus_entries` already drops other states'
   law;
3. the catalog entries that matched but were not fetched, if any — including
   the honest `Not in RIS - no accessible full text (reference only, say so
   openly)` case and the `Not in RIS - web source: <url>` case, which hands the
   web tool its next move;
4. **one** concrete retry: name the Land, name the instrument, or pass
   `application=` for case law.

A fetch that succeeded but whose extractor found no answering § returns the
document's § *headings* — the RIS analogue of `read_passage`'s `## Gliederung` —
labelled as an index, not evidence. That is a real answer ("the law is here,
these are its paragraphs, none of them answers this") and it is the shape that
lets the model ask a better question next round instead of guessing.

### 3.6 What happens to the three tools

* **Chat surface (`shallow_research_agent`):** all three come off the config;
  `ris_lookup` goes on. They stay `@register_function`-registered — the entry
  point does not change, nothing in `pyproject.toml` moves — and become internals
  of `ris_lookup`, which imports `RisClient`, `fetch_document_cached`,
  `_build_search_params`, `_make_planner`,
  `load_registry`/`match_entries`/`focus_entries`, `_safe_document_name`,
  `_ingest_document_sync`, `_legal_status_note` and `_capture_lane_hits` — every
  one already exists and is already tested.
* **A pasted RIS URL** is `ris_lookup(question=…, instrument="<url>")`: step [1]
  recognises it, step [2] is skipped, [3] fetches it. No separate fetch tool on
  the chat surface.
* **Deep research** keeps all three until its own consolidation. It has a
  different budget shape (six parallel researchers, its own ceilings) and folding
  both surfaces in one change would make the loop-eval delta unreadable.
* **`data_source_registry`**: the `ris` source's `tools` list becomes
  `[ris_lookup, ris_search_tool, ris_fetch_tool, ris_catalog_lookup_tool]`, so
  `get_source_id_for_tool` resolves the new name — required, or nothing it
  returns is captured as a citable source (the registry's own comment makes
  exactly this point about `read_passage`).

### 3.7 Prompt text deleted

The two-step instruction collapses:

> 2. Austrian law (RIS), for statutes, Bauordnungen or case law, which is what
> the knowledge base does NOT hold. ~~Search with the RIS search tool (German
> terms), then fetch the ENTIRE relevant document with the RIS fetch tool. The
> exact wording of a paragraph matters, and fetched documents become citable
> sources. Prefer the fetched text over search snippets.~~ → `ris_lookup`.

Also deleted: the chain instructions inside the tool docstrings themselves —
`ris_search.__doc__` ("This returns document REFERENCES, not full texts… pass
the document number… before citing it"), `ris_catalog_lookup.__doc__` ("Then
call ris_fetch_document…"), `_format_hit`'s trailing "To read a document in
full, call ris_fetch_document" and the catalog's "fetch the full text with
ris_fetch_document". Four places that teach the same sequence, all of them
unnecessary once the sequence is inside the tool.

### 3.8 Ledger, lanes, Herleitung

* `_capture_lane_hits` is called once per **returned passage**, not once per hit
  scanned. Today a RIS search captures 20 hits it never read; the Herleitung then
  draws twenty documents for a round that produced one. After the change the
  ledger says what was read.
* `turn_status._SEARCH_CORPORA` maps the prefix `"ris_"` → `"ris"`, so
  `ris_lookup` keeps its lane with **no change** to that table.
* `ris_lookup` is a **search**, not a locator: it takes a question. It stays out
  of `_LOCATOR_TOOL_BASENAMES`. One RIS tool means a cross-corpus first round is
  `knowledge_search` + `ris_lookup` = two calls.
* `conclusion=` is in the signature, so `CONCLUSION_ARG` finds it and the round
  gets a checkpoint from the `argument` channel rather than from prose. The
  `_QUERY_KEYS` tuple already contains `"question"`, so the status line quotes
  the right string with no change.
* `emit_retrieval_span` with `tool_name="ris_lookup"` plus `citation_keys` and
  `punkt_ids` in `picks`, mirroring `knowledge_search` — that is what makes
  `loop_eval`'s `cross_turn`, `repeat_query` and `punkt_match` columns see RIS
  at all. They currently cannot.

### 3.9 Tests

1. `test_ris_lookup_format.py` — the returned block parses through
   `extract_sources_from_tool_result` into `SourceEntry`s with a non-empty
   `citation_key`, a `punkt`, and `doc_class == "gesetz"`. This is the test
   that makes "citation verification treats it as evidence" a fact rather than
   a claim.
2. `test_ris_lookup_deterministic_locator.py` — "Was verlangt § 63 BO Wien?"
   makes **zero** extractor LLM calls (planner mock asserts not-called) and
   returns `§ 63` with its Absätze.
3. `test_ris_lookup_jurisdiction.py` — a Tyrolean project asking about
   "Bauordnung" never receives Viennese law; the assumed Land and its
   provenance appear in the output. Extends the existing `focus_entries`
   coverage to the tool boundary.
4. `test_ris_lookup_miss.py` — four miss shapes (no catalog entry, no live
   hits, `Not in RIS` entry, fetched but no answering §) each return their own
   vocabulary, and none returns an empty string or a fabricated citation.
5. `test_ris_lookup_bounds.py` — a 12-hit catalog match fetches at most 2
   documents and returns at most 6 passages; a 900 kB consolidated law does not
   put 900 kB in the transcript.
6. `test_ris_lookup_ledger.py` — through the **compiled graph** (the
   `piloti/AGENTS.md` ContextVar rule): lane hits equal returned passages, each
   stamped with the executing round.
7. `test_repeat_fetch_guard.py` — extend: two identical `ris_lookup` calls in
   one turn, the second withheld (or, with row 15 landed, served from cache).

### 3.10 The eval

`loop_eval_questions.yaml` had **one** `family: Bauordnung` row —
`einreichung-wien-unterlagen`. One row out of twenty-three cannot measure a
retrieval path. Before touching RIS, add four more, each naming a Land whose
Bauordnung the registry actually points at, with `punkt: null` (the file's own
rule: "Bauordnung rows carry no `punkt`: their paragraphs come from RIS, and
nothing committed here can verify one"). Suggested:

* `bauhoehe-wien` — Gebäudehöhe / Bauklasse under the Wiener Bauordnung
  (`kind: ruling`);
* `stellplatz-tirol` — Stellplatzverpflichtung, Tirol (`kind: ruling`,
  and the row that catches a Viennese answer to a Tyrolean question);
* `abstandsflaeche-noe` — Abstandsflächen, Niederösterreich
  (`kind: walkthrough`);
* `bewilligungsfrei-salzburg` — bewilligungsfreie Vorhaben, Salzburg
  (`kind: walkthrough`).

Then lift the file's own rule and add a **`paragraph`** field for Bauordnung
rows: not a remembered § but one read off the fetched consolidated text and
committed alongside, the same discipline `punkt` gets from
`punkt_index.json`. That gives the harness a checkable fact for the half of the
corpus it currently cannot check.

New `loop_eval.py` columns:

* `ris_calls` — RIS tool calls in the turn. Today's shape is 2–3; after the
  change it must be 1. This is the whole claim, as one integer.
* `paragraph_match` — did the answer cite a § the fetched document actually
  contains? Same three-value shape as `punkt_match`.
* `ris_citation_resolved` — did at least one RIS citation survive
  `verify_citations`? Today this is structurally near-zero (no `Citation:` key
  in the fetch output); after the change it is the headline number.

Existing columns that must move in a known direction: `truncated` down on
Bauordnung rows (three calls become one), `rounds` down, `family_coverage`
unchanged (RIS rows carry no family), `repeat_query` unchanged or down.

---

## 4. The same pattern for web search

It applies, with one difference. `web_search_tool` is search-only — there is
no fetch tool to consolidate *with* — so the consolidation adds a capability
rather than merging two. `web_lookup(question, conclusion=)`: web search
(≤ 8 results, unchanged), fetch the top **2** pages, extract the passages that
answer the question with the same `ris_planner_llm` role, emit the same
grounding block with `Citation: <site> — <page title>` and the URL. `Dokumentart`
stays absent (web has no doc class), which puts it on the coarse `web` kind,
exactly where `source_kinds.py` already wants it. Then `max_content_length: 1000`
stops mattering, because the snippet is a routing signal and the fetched passage
is the evidence. Do this **after** RIS: RIS is the product, web is the fallback,
and shipping one consolidation at a time is what makes the loop-eval delta
attributable.

The knowledge quartet (`knowledge_search` / `read_passage` /
`surface_documents` / `view_knowledge_image`) does **not** get the same
treatment. Those four take genuinely different inputs — a question, an address,
a browse intent, an image — and the recent work (`206979b`, `47b2be9`) has
just finished making the search/locator pair coherent. `surface_documents` is
the one merge candidate on the horizon, and it can wait.

---

## 5. What is NOT a hobble, and must stay

* **Citation verification that only ever removes** (`piloti.j2`,
  `common/citation_verification.py`). It catches a false claim after the fact
  and cannot invent one. The archetype.
* **The confidence ceiling** — a measurement never buys more than `medium`, and
  an answer touching the law without verified citations is capped whatever it
  measured (`piloti/grounding.py`, `piloti/AGENTS.md` "two currencies that do
  not convert"). It closes a laundering path; it removes no capability.
* **`conclusion=` on every retrieval call** (`turn_status.py`). A slot, not a
  sequence: it says *write down what you now know*, never *do this next*. The
  docstring explains why an argument beats prose. Extend it to every new tool.
* **The envelope's deterministic gates** (`common/answer_envelope.py`): a verdict
  must be a copyable value, is exclusive to `kind=ruling`, and a `summary` over
  320 chars is dropped. These grade the *output*; they do not tell the model how
  to work.
* **`REPAIR_MAX_RETRIEVALS = 2`** (`repair.py`). A budget in the honest sense —
  "Two is a repair; more is a second research turn" — bounding cost without
  prescribing the shape.
* **`ask_user`'s transport guard**: one outstanding prompt per conversation,
  because a second registration orphans a future another participant is looking
  at. That is a transport invariant, not a doctrine. ("At most ONE `ask_user` per
  turn" is the doctrine half — row 11.)
* **The retrieval bounds** (`top_k: 16`, `max_chunks_per_document: 5`,
  `rerank_candidates: 60`, the relevance floor, ADR-0057/0058). Each derivation
  is written down and each was measured.
* **`deferred_tool_loading`** (ADR-0048) and the *off* switch on `tool_search`.
  Both add capability or decline to remove it, and both are argued from numbers.
* **The duplicate-fetch guard's intent** (`agent.py`) — a fetch whose signature
  already ran this turn buys the turn nothing. Only its *return* was wrong
  (row 15).
* **The off-topic decline** (`piloti.j2`). Product scope, decided by the people
  who own the product.

---

## 6. The outside frame

Fetched while writing this; URL and what was actually read, verbatim where
marked.

**Aschenbrenner, *Situational Awareness*, part I** —
<https://situational-awareness.ai/from-gpt-4-to-agi/>. Verbatim:

> "Finally, the hardest to quantify—but no less important—category of
> improvements: what I'll call 'unhobbling.'"

> "Imagine if when asked to solve a hard math problem, you had to instantly
> answer with the very first thing that came to mind. It seems obvious that you
> would have a hard time, except for the simplest problems. But until recently,
> that's how we had LLMs solve math problems. […] Despite excellent raw
> capabilities, they were much worse at math than they could be because they
> were hobbled in an obvious way, and it took a small algorithmic tweak to
> unlock much greater capabilities."

> "Tools: Imagine if humans weren't allowed to use calculators or computers."

> "[A frontier model] has the raw smarts to do a decent chunk of many people's
> jobs, but it's sort of like a smart new hire that just showed up 5 minutes
> ago: it doesn't have any relevant context, hasn't read the company docs or
> Slack history or had conversations with members of the team."

Applies to rows 2, 3 and 7. The chain-of-thought passage is row 3 stated
exactly: a role denied deliberation is worse at its job "than it could be", for
an algorithmic reason, and the fix is small. The "smart new hire" passage is
row 7 — 8 k of history is how much of the company's Slack we let it read.

**Anthropic, "Writing tools for agents"** —
<https://www.anthropic.com/engineering/writing-tools-for-agents>:

> "Tools can consolidate functionality, handling potentially *multiple*
> discrete operations (or API calls) under the hood."

> "tool implementations should take care to return only high signal information
> back to agents. They should prioritize contextual relevance over flexibility,
> and eschew low-level technical identifiers (for example: `uuid`,
> `256px_image_url`, `mime_type`)."

> "When writing tool descriptions and specs, think of how you would describe
> your tool to a new hire on your team."

Row 1 is the first quote's worked example: search → pick → fetch → extract is
four discrete operations the model is currently made to orchestrate by hand.
The second quote is why `ris_fetch`'s 40 000-char blob is the wrong return and
a `Citation: … § 63 Abs 1` block is the right one.

**Anthropic, "Building effective agents"** —
<https://www.anthropic.com/research/building-effective-agents>:

> "One rule of thumb is to think about how much effort goes into
> human-computer interfaces (HCI), and plan to invest just as much effort in
> creating good *agent*-computer interfaces (ACI)."

> "you should consider adding complexity *only* when it demonstrably improves
> outcomes."

The piece's own distinction — workflows are "orchestrated through predefined
code paths", agents "dynamically direct their own processes and tool usage" —
is the line rows 5 and 9 sit on: `<source_priority>` and `<query_rewriting>`
were workflow steps written in prose inside an agent.

**Manus, "Context Engineering for AI Agents"** —
<https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus>:

> "Keep your prompt prefix stable. Due to the autoregressive nature of LLMs,
> even a single-token difference can invalidate the cache from that token
> onward."

> "Make your context append-only. Avoid modifying previous actions or
> observations."

> "Rather than removing tools, it masks the token logits during decoding to
> prevent (or enforce) the selection of certain actions based on the current
> context."

> "error recovery is one of the clearest indicators of true agentic behavior"

Row 6 is the masking point exactly, and this repo has independently arrived at
the prefix-stability half — `common/prompt_caching.py` and commit `8773a95`
exist to pin one turn's prefix to one shard, which the toggles then fragment.
The "keep failures in context" point is row 15: a withheld call answered with a
scolding is a modified observation; the cached result plus a note is
append-only.

**Sutton, "The Bitter Lesson" (2019)** —
<http://www.incompleteideas.net/IncIdeas/BitterLesson.html>. Verbatim:

> "We have to learn the bitter lesson that building in how we think we think
> does not work in the long run."

> "AI researchers have often tried to build knowledge into their agents, this
> always helps in the short term, and is personally satisfying to the
> researcher, but in the long run it plateaus and even inhibits further
> progress."

> "We want AI agents that can discover like we can, not which contain what we
> have discovered."

`<research_rules>`, `<source_priority>` and `<query_rewriting>` were 1 300
tokens of "how we think we think" about retrieval, re-sent on every call of
every turn. The repo had already started paying this down deliberately:
`206979b` — *"Four paragraphs added over one week asked the model to fan out
over a Richtlinien-Familie, never to repeat a search, and to open members it
had no address for. The outline mode, the furniture-page filter and the
duplicate-fetch guard enforce those in the tools, so the prose goes"* — is the
ratchet this register extended, and `0e89484` is where it finished.

**OpenAI, "A practical guide to building agents"** —
<https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf>
(extracted locally with `pdfplumber`). Verbatim:

> "Think of guardrails as a layered defense mechanism. While a single one is
> unlikely to provide sufficient protection, using multiple, specialized
> guardrails together creates more resilient agents." (p. 25)

> "Set up guardrails that address the risks you've already identified for your
> use case and layer in additional ones as you uncover new vulnerabilities."
> (p. 27)

> "Tool safeguards: Assess the risk of each tool available to your agent by
> assigning a rating—low, medium, or high—based on factors like read-only vs.
> write access, reversibility, required account permissions, and financial
> impact." (p. 26)

> "The issue isn't solely the number of tools, but their similarity or overlap.
> Some implementations successfully manage more than 15 well-defined, distinct
> tools while others struggle with fewer than 10 overlapping tools. Use
> multiple agents if improving tool clarity by providing descriptive names,
> clear parameters, and detailed descriptions doesn't improve performance."
> (p. 16)

> "A single agent can handle many tasks by incrementally adding tools, keeping
> complexity manageable and simplifying evaluation and maintenance." (p. 14)

The guardrail framing is the §5 list: a guardrail is an *output* check layered
beside the model, which is what citation verification and the confidence
ceiling are. The tool-overload quote is row 1 and row 13: eleven tools is not
the problem, three overlapping RIS tools is. Note also what the same guide says
about instructions — "Define clear actions: Make sure every step in your
routine corresponds to a specific action or output" (p. 11) — which is the
honest counterweight: a *routine* is legitimate where the work really is a
fixed procedure. Piloti's retrieval is not; its output envelope is, and that is
why `<answer_envelope>` stays and `<research_rules>` shrank.

**Cognition, "Don't build multi-agents"** —
<https://cognition.com/blog/dont-build-multi-agents>. Verbatim:

> "Share context, and share full agent traces, not just individual messages"

> "Actions carry implicit decisions, and conflicting decisions carry bad
> results"

> "Subagent 1 and subagent 2 cannot see what the other was doing and so their
> work ends up being inconsistent with each other."

Relevant twice. First as an endorsement of what Piloti already is — ADR-0052's
single answering agent with the full tool set. Second as the constraint on the
`ris_planner_llm` extractor pass inside `ris_lookup`: it must receive the
*question and the § headings*, and it must not make a decision the answering
model then cannot see — which is why step [4] returns the extracted passages as
evidence, in the transcript, rather than a summary the model has to trust.

---

## 7. Sequencing

1. **Row 18** (delete the dead `max_llm_turns`, fix the stale recursion
   arithmetic). Ten minutes; it is the comment the next budget decision will be
   read from.
2. **Row 3** (`reasoning_effort: medium`). One line, reversible, measurable on
   the existing loop eval in one run.
3. **Row 1** — `ris_lookup`, with the four new Bauordnung rows and the three
   new columns landing *first* so the before/after exists.
4. **Row 2** (charge rounds, not calls). Bigger, and it deletes the interaction
   allowance and most of the fan-out machinery, so it wants the RIS change and
   the eval columns already in place.
5. **Rows 5, 9, 8** — the prompt cuts. Cheap, and each one is a `206979b`-shaped
   commit: the tool already enforces it, so the prose goes. *(Done: `0e89484`,
   `1762b09`.)*
6. **Rows 6, 7, 4** — toggles-as-masks, the history budget, `web_lookup`.
