# Sharpening the Shallow-Researcher System Prompt

> **Goal:** make the shallow researcher's system prompt (`src/aiq_agent/agents/shallow_researcher/prompts/researcher.j2`) a razor-sharp input→output contract, so the model spends less time deliberating and produces more deterministic answers. The profiler showed the final synthesis LLM call at ~29 s on a simple meta-ish query ("was weißt du über OIB 2"); a large slice of that is the model "thinking" through an overloaded, conflicting prompt before it writes.
>
> This document is the **research + plan**. It is grounded in Anthropic's own published prompt-engineering guidance (primary sources cited below). The actual rewrite is a follow-up, gated on review of this direction.

## Applicability caveat (read first)

The production model on the shallow tier is currently **`x-ai/grok-4.5`** (per-org override; base config is `deepseek/deepseek-v4-flash`), routed via OpenRouter — **not** a Claude model. Anthropic's guidance is the best-documented, most rigorously stated body of prompt-engineering practice, and the **structural** principles below (clarity, explicit output contract, XML sectioning, positive-over-negative instructions, worked examples, matching prompt style to output, avoiding conflicting mandates) are model-agnostic and transfer directly. A few items are **Claude/Anthropic-API-specific** and are flagged `[Claude-specific]` — apply the *principle*, not the API mechanism, since we control effort via OpenRouter's `reasoning_effort`, not Anthropic's `effort` param.

## Primary sources

- Anthropic — *Prompting best practices* (consolidated, current models): <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>
- Anthropic — *Prompting Claude Opus 4.8*: <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8>
- Anthropic — *Prompt engineering overview*: <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview>

---

## Part 1 — Anthropic's principles (what the docs actually say)

Each principle below has: the mechanism, when it applies, Anthropic's stated rationale (quoted), and its relevance to our prompt.

### P1. Be clear and direct; be specific about the output
> *"Claude responds well to clear, explicit instructions... Be specific about the desired output format and constraints."*
> **Golden rule:** *"Show your prompt to a colleague with minimal context on the task and ask them to follow it. If they'd be confused, Claude will be too."*

**Mechanism:** the model infers less (and deliberates less) when the target is explicit. **Relevance:** our prompt describes many rules but never states the *shape* of a finished answer crisply for each turn type.

### P2. Explicit spec upfront reduces thinking/latency and token spend
> *"Providing well-specified, clear, and accurate task descriptions upfront can help maximize autonomy and intelligence while minimizing extra token usage... ambiguous or underspecified prompts... tend to relatively reduce token efficiency and sometimes performance."*
> And directly on prompt size: *"If you find the model thinking more often than you'd like, **which can happen with large or complex system prompts**, add guidance to steer it."* `[Claude-specific mechanism, model-agnostic principle]`

**Mechanism:** an overloaded, multi-mandate prompt makes the model reconcile competing instructions before every answer — that reconciliation *is* thinking. **This is the single strongest validation of the "sharpen it → it thinks less" hypothesis.** **Relevance:** `researcher.j2` is ~135 lines carrying source hierarchy + query rewriting + citation rules + cards + profile-patches + two control markers + project-context Rückfrage logic, all at similar altitude. Every turn, simple or not, pays that reconciliation cost.

### P3. Tell the model what to do, not what not to do (positive over negative)
> *"Tell Claude what to do instead of what not to do. Instead of: 'Do not use markdown in your response' — Try: 'Your response should be composed of smoothly flowing prose paragraphs.'"*
> On Opus 4.8: *"Positive examples showing how Claude can communicate with the appropriate level of concision tend to be more effective than negative examples or instructions that tell the model what not to do."*

**Relevance:** our prompt leans hard on `NEVER`, `CRITICAL:`, `Do not`, `NEVER emit`. Negatives define a boundary but not a target, forcing the model to synthesize the positive from the negation.

### P4. Don't over-prompt with aggressive/emphatic language
> *"Where you might have said 'CRITICAL: You MUST use this tool when...', you can use more normal prompting like 'Use this tool when...'."* (Aggressive language causes *over*triggering and wasted deliberation on modern models.) `[Claude 4.x-specific, but the anti-pattern is general]`

**Relevance:** we have `## CRITICAL: Source Hierarchy`, `**CRITICAL**: When the user asks...`, `MUST use`. Candidates to de-escalate.

### P5. Structure the prompt with XML tags
> *"XML tags help Claude parse complex prompts unambiguously, especially when your prompt mixes instructions, context, examples, and variable inputs. Wrapping each type of content in its own tag... reduces misinterpretation."* Best practices: *consistent, descriptive tag names; nest when there's a natural hierarchy.*

**Relevance:** we only wrap `<project_context>`. Instructions, the output contract, examples, and dynamic context all run together as markdown headings. Clear tag boundaries reduce the "where does the rule end and the data begin" ambiguity.

### P6. Use worked examples to lock output format (multishot)
> *"Examples are one of the most reliable ways to steer Claude's output format, tone, and structure... Include 3–5 examples for best results."* Make them **relevant, diverse, structured** (wrapped in `<example>` / `<examples>` tags).

**Relevance:** we give exactly one tiny citation snippet. There is **no** worked example of a full meta-turn answer or a full research-turn answer. Two or three end-to-end examples would define the input→output contract far more sharply than the current prose rules — and examples reduce the model's need to reason out the format each time.

### P7. Match prompt style to desired output style
> *"The formatting style used in your prompt may influence Claude's response style... removing markdown from your prompt can reduce the volume of markdown in the output."* Prefer XML **format indicators** (e.g. wrap the desired prose in a named tag).

**Relevance:** the prompt is markdown-dense (headers, bold, bullets everywhere). If we want tight, prose-first answers with minimal scaffolding, the prompt's own heavy markdown works against that.

### P8. Control reasoning depth explicitly; commit to an approach
> *"When you're deciding how to approach a problem, choose an approach and commit to it. Avoid revisiting decisions unless you encounter new information that directly contradicts your reasoning."*
> *"Thinking adds latency and should only be used when it will meaningfully improve answer quality — typically for problems that require multistep reasoning. When in doubt, respond directly."* `[Claude-specific wording; principle transfers]`

**Relevance:** complements the `reasoning_effort: medium → low` config change already made. A short "commit, don't re-litigate; for simple factual/meta questions answer directly" line in-prompt reinforces the effort setting instead of fighting it.

### P9. Be concrete about thresholds, not qualitative
> On self-filtering: *"be concrete about where the bar is rather than using qualitative terms like 'important'."*

**Relevance:** "adequately answer", "genuinely insufficient", "brief, friendly" are qualitative. The escalation/confidence markers especially depend on a fuzzy "adequate" judgment — a concrete bar would make marker emission more deterministic.

### P10. Literal instruction following → state scope explicitly
> *"It does not silently generalize an instruction from one item to another... If you need Claude to apply an instruction broadly, state the scope explicitly."* `[Claude 4.8-specific, increasingly true of frontier models generally]`

**Relevance:** as models get more literal, our implicit "these rules obviously only apply on research turns" assumptions should be made explicit per turn type (we already do some of this via the `requires_sources` Jinja gate — good; extend the pattern).

### P11 (housekeeping). KV-cache-friendly ordering; long-context ordering
> *"Put longform data at the top... Queries at the end can improve response quality by up to 30 percent."* Our prompt already has a deliberate **KV cache boundary** (`researcher.j2:89`) with static contract above and dynamic context below — this is correct and matches Anthropic's static-first guidance. **Keep it.** Any rewrite must preserve a stable static prefix so provider prompt-caching keeps working across tool-loop iterations.

---

## Part 2 — Diagnosis of `researcher.j2` against the principles

| # | Current pattern (file) | Principle | Problem |
|---|---|---|---|
| 1 | 135 lines, ~9 co-equal mandate sections | P2 | Every turn pays a reconciliation/deliberation tax; worst on simple turns. |
| 2 | `## CRITICAL:`, `**CRITICAL**`, `NEVER`, `MUST` throughout | P3, P4 | Emphatic + negative framing; defines boundaries not targets; risks overtriggering. |
| 3 | Only one tiny citation example (`:58-62`) | P6 | Output contract underspecified; model reasons out the shape each turn. |
| 4 | Meta vs research fork split across `:6-11` (prose) + `:64-87` (Jinja gate) | P1, P10 | The two output contracts aren't stated side-by-side and razor-sharp. |
| 5 | Markdown-dense throughout | P7 | Prompt style may inflate answer markdown; works against tight prose answers. |
| 6 | Only `<project_context>` uses tags | P5 | Instructions / contract / examples / dynamic data not delimited. |
| 7 | "adequately", "genuinely insufficient", "brief" | P9 | Fuzzy thresholds → non-deterministic marker + escalation behavior. |
| 8 | KV-cache boundary at `:89`, names-only tools, date-precision datetime | P11 | **Already good — preserve.** |

## Part 3 — Concrete rewrite recommendations

Ordered by expected impact on "sharpness + less thinking". Each is a discrete, reviewable change.

### R1 — Lead with a one-block "Output Contract" per turn type *(highest leverage; P1, P2, P6, P10)*
Put, near the top (inside the static/cacheable prefix), a compact contract that says exactly what a finished answer looks like for each of the two turn classes. Example direction:

```
<output_contract>
Meta / conversational turn (no research needed):
  → 1–3 sentences, direct, in the user's language. No tools. No citations.
    No [CONFIDENCE] or [ESCALATE_TO_DEEP] markers.

Research turn:
  → Answer prose (user's language), inline [N] citations, then a
    **References:** section (one `- [N] Title — URL` per source), then
    exactly one [CONFIDENCE:low|medium|high] line, then [ESCALATE_TO_DEEP]
    only if sources were insufficient.
</output_contract>
```
This is the single change most aligned with P2: it front-loads the spec so the model matches a template instead of deliberating the format.

### R2 — Add 2–3 worked end-to-end examples in `<examples>` *(P6)*
One meta-turn example (question → short answer, no markers) and one research-turn example (question → cited answer + References + confidence marker). Wrap each in `<example>`. Diverse and relevant per Anthropic. This does more to pin output shape than any amount of prose rules — and reduces per-turn format reasoning.

### R3 — Flip negatives to positives; de-escalate CRITICAL/NEVER/MUST *(P3, P4)*
- "NEVER use ellipses"-style → state the positive target.
- `## CRITICAL: Source Hierarchy` → `## Source Priority` with "Use sources in this order:".
- `**CRITICAL**: ...knowledge_search NOT web search` → "For uploaded documents, use `knowledge_search` (only it can see uploaded files)."
- Keep genuine safety/guardrail negatives (e.g. "don't answer off-topic", "don't invent URLs") — those are boundaries by nature.

### R4 — Delimit sections with consistent XML tags *(P5)*
Wrap the durable instruction blocks: `<role>`, `<output_contract>`, `<source_priority>`, `<citation_format>`, `<examples>`, and keep `<project_context>`. Keeps the model from confusing rules with data, and makes the meta/research fork legible.

### R5 — Make thresholds concrete *(P9)*
Define "insufficient" (→ escalate) with a concrete test, e.g. "escalate only if, after your tool calls, no retrieved source directly supports the core of the question." Same for confidence tiers (already fairly concrete at `:75-77` — mirror that precision into the escalation rule).

### R6 — Reinforce "answer directly when simple; commit to an approach" *(P8)*
One line in the static prefix: for straightforward factual or meta questions, answer directly without multi-step deliberation; once you choose a search approach, commit unless results contradict it. Reinforces the `reasoning_effort: low` config change rather than fighting it.

### R7 — Reduce prompt markdown density where answers should be prose *(P7; lower priority)*
Trim decorative bold/headers in the instruction body. Secondary to R1–R4; do it opportunistically during the rewrite.

### Guardrails for the rewrite
- **Preserve the KV-cache boundary** (`:89`) and keep all dynamic content (date, tools, docs, catalog, project context) below it — do not move variable content into the static prefix (P11).
- Keep control tokens byte-identical: `[ESCALATE_TO_DEEP]`, `[CONFIDENCE:...]`, `**References:**` label rules, and the requires_sources Jinja gating.
- Change is behavior-critical: validate against the shallow-researcher tests (`tests/aiq_agent/agents/shallow_researcher/`, `chat_researcher/`) and a few real prompts before/after, measuring both answer quality and the final-synthesis span in the profiler.

## Part 4 — Sequencing

1. **Done:** `shallow_llm` `reasoning_effort: medium → low` (config_oib_openrouter.yml) — cuts the silent think-time directly.
2. **This plan** (research + direction) — review.
3. **Rewrite** `researcher.j2` per R1–R6 (R7 opportunistic), preserving guardrails.
4. **Measure:** re-run the profiler on the same query class; compare final-synthesis span and answer quality; run the agent test suites.
