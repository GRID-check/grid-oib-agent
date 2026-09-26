# The answering prompt defines no success: audit and current guidance (2026-09)

> **Status:** findings, not yet acted on. Line references are to
> `src/aiq_agent/agents/piloti/prompts/piloti_static.md` and the files named,
> as of the change that added this document.
> **Question:** does the chat prompt tell the model what a good answer is, and
> does anything measure it?
> **Answer:** no, on both counts. The fix order is below.

## 1. What the model receives

A realistic chat turn renders a system prompt of **20.5k tokens** (o200k): the
static half is 16.3k tokens, and the rest is the turn decision's card shapes,
one inlined skill and the project brief. The inventory, the history and about
9k tokens of tool schemas come on top. A replayed call billed 40k input tokens.

`tests/aiq_agent/agents/piloti/fixtures/piloti_prompt_rendered.txt` understates
this: it pins the envelope schema to a placeholder, which removes about 18.5k
characters.

## 2. Findings

### No goal, no precedence

- Nothing states who the answer is for, what a good one is, or how it is judged.
  `<role>` (line 2, 0.7% of the static half) gives a persona and the grounding
  sources. The reader, a Planer who copies a value into an Einreichung, appears
  only in side clauses (lines 35, 83, 85, 97, 252).
- There is no order for which rule wins when two conflict. The only local
  tie-breaks are line 220 (platform rules outrank office instructions) and the
  catalog's rule against invented values.
- The OIB skills each end in a `## Done` section, which is a success
  definition. It holds only for that skill's domain, and only on turns that
  load the skill.

### A pile of patches

- About 316 imperative sentences, **55% of them negative**. "never/nie" 57
  times, "not/nicht/kein" 173, about 100 emphatic capitals (ONE ×14).
- At least 17 rules are written against one specific past failure ("the
  failure that keeps happening", "is the usual mistake", "no node named
  `end`").
- 16 of the 36 commits to `piloti_static.md` are `fix:`, one of them "the
  layering rule no longer contradicts the heading rule".
- Rules keep being added at runtime: `common/platform_lessons.py` appends
  cautions distilled from answers users reported as bad.

### Contradictions

| Topic | One side | Other side |
|---|---|---|
| Citation line | 203–204: a title in front of the file name "is a line the reader cannot resolve" | 263: "A title in front of it is fine"; the example at 274 uses a third form |
| Escalation | 64: a commissioned report is handed off at once | 104: escalate only "after using the available tools"; 64 also says a commissioned document is never a handoff, while the schema says "report or document" |
| Cards | 278: cards come "on every turn" | catalog: none is "the normal case for a walkthrough"; `piloti.j2`: "a preference, not a command"; the ruling example (212) emits none |
| Verfahren | 41: a numbered list | 31: a `process_map` card; 89: a list, or a flowchart if it forks |
| First line | 36/93: the first line gives the value, in bold | 107/110: the first sentence avoids the verdict's words; the ruling example repeats "REI 60" in both |
| Evidence window | 2 and `piloti.j2`: a document retrieved this turn | 71, 79, 234, 239: this turn or the previous one |
| Confidence | 60: carried "when you retrieved" | 103: every researched answer carries one, even one citing nothing; "high" for a measurement, which the platform caps at medium |
| Length | 89, 75: short, no repetition | 20, 131, 135, 139, 253: always add the diagram, the definition level, Bestand, each Landesabweichung, both sources |
| Address | 83: Sie-Form | the examples at 165 and 246 say "du" |

The examples also break the prompt's own rules. Line 109 requires `topic` and
`context` on every walkthrough with a subject, and no walkthrough example
carries them.

### Format crowds out substance

- The output contract (envelope, masthead, cards, formatting, examples) is
  **68%** of the static half. Grounding, sources, research rules and
  clarification are 21%.
- The `answer` field, which carries the answer, gets 22 tokens of description;
  `takeaways` gets about 600, across three places.
- The masthead is written before `answer` (99), so the model commits to its
  verdict and summary before it writes the prose it reasons in.

### The suite does not measure success

- `scripts/turn_census/suite.py` `check()` tests that the envelope parses,
  the `kind`, the cited Richtlinie family, and a few `mentions` and `shape`
  expectations (3 of 29 questions have `mentions`).
- The question file says so: "It is NOT a correctness benchmark"
  (`tests/fixtures/herleitung/loop_eval_questions.yaml`).
- Nothing checks that the first line answers, that a value is right, that a
  citation resolves, calibration, length or duplication. Those are what most
  of the prompt's rules are about. "76/80 checks held" means well-shaped, not
  right.

### Cost

- Time follows reasoning tokens, and most of a turn's final call is thinking
  before the first word ([`turn-latency-measured-2026-09.md`](turn-latency-measured-2026-09.md) §1–2).
- The largest reasoning spike measured (7,263 tokens against 1,961 on the next
  run) was the two-variant Fluchtweg question, where the table, tabs,
  check-table and `process_map` rules meet.
- At low effort the format contract is what breaks first (§5). A whole round
  went on loading a skill whose rules were already in the prompt
  ([`turns-per-answer-audit-2026-09.md`](turns-per-answer-audit-2026-09.md)).
- These are correlations and plausible mechanisms. Nothing yet measures prompt
  conflicts against reasoning time directly.

## 3. What current guidance says

Vendor documentation first; research and practitioner sources are marked.

- **State the outcome and success criteria, then let the model choose the
  path.** "GPT-5.5 is strongest when the prompt defines the target outcome,
  success criteria, constraints, and available context" (OpenAI, [GPT-5.5
  prompt guidance](https://developers.openai.com/api/docs/guides/prompt-guidance?model=gpt-5.5),
  2026). The suggested order is Role, Goal, Success criteria, Constraints,
  Output, Stop rules, each section short. No guide exists yet for gpt-5.6,
  gpt-6 or the -luna/-sol variants; this is the nearest.
- **Contradictions cost reasoning.** Contradictory or vague instructions are
  "more damaging to GPT-5 than to other models, as it expends reasoning tokens
  searching for a way to reconcile the contradictions" (OpenAI, [GPT-5
  prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide),
  Aug 2025). Conflicting instructions at higher effort "can lead to
  overthinking, unnecessary searching, or output quality regressions" (GPT-5.5
  guidance).
- **Carry over less.** "Legacy prompts often over-specify the process because
  earlier models needed more help." Keep ALWAYS/NEVER/must for true invariants
  and write judgment calls as decision rules (GPT-5.5 guidance). Say what to do
  rather than what not to do, and say why (Anthropic, [prompting best
  practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).
- **Examples over edge-case lists; less is more.** Aim for "the minimal set of
  information that fully outlines your expected behavior" and "diverse,
  canonical examples" rather than "a laundry list of edge cases" (Anthropic,
  [effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
  Sep 2025). Research: instruction-following decays with instruction density,
  and the dominant failure is omission, biased toward earlier instructions
  ([IFScale](https://arxiv.org/abs/2507.11538), 2025); accuracy drops as input
  grows even on simple tasks ([Chroma, Context Rot](https://www.trychroma.com/research/context-rot), 2025).
- **Let the schema carry the format.** "Avoid describing the expected output
  schema in the prompt. Use Structured Outputs" (GPT-5.5 guidance).
- **Stop rules for tools.** Retrieve again only when a required fact or source
  is missing, not to improve phrasing (GPT-5.5 guidance).
- **Eval first.** Define the success criteria before the prompt, and avoid
  "vibe-based evals" (OpenAI, [evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)).
  Start with "20-50 simple tasks drawn from real failures", graded on outcome;
  a good task is one "two domain experts would independently" pass or fail
  alike (Anthropic, [demystifying evals for agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
  Jan 2026). Prefer binary pass/fail and validate any LLM judge against human
  labels (practitioner: Husain & Shankar, [AI Evals FAQ](https://hamel.dev/blog/posts/evals-faq/)).
  Change one thing at a time against a fresh baseline (OpenAI, [GPT-5.2
  guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-2_prompting_guide)).
- **For legal answers, success has two parts.** An answer hallucinates if it is
  "incorrect or misgrounded", meaning its source does not support it
  (research: Magesh et al., [Hallucination-Free?](https://arxiv.org/abs/2405.20362), 2025,
  where commercial legal RAG tools did so 17–33% of the time). Say what counts
  as enough evidence and what to do when it is missing: "Absence of evidence
  shouldn't automatically become a factual 'no'" (GPT-5.5 guidance).

## 4. Fix order

Changing the prompt first would repeat the mistake: nothing could show it got
better.

1. **Define success.** A short `<goal>` block at the top of the static prompt:
   who reads the answer and for what; the question answered in the first line,
   with the value; every normative value retrieved and cited to a source that
   supports it; uncertainty named (Bundesland, edition, Bestand); as short as
   the question allows. Add the tie-break order: grounding, then answering the
   question, then brevity, then masthead fields, then cards.
2. **Make the suite grade it.** Binary checks per criterion, an expected value
   on every ruling question read off the corpus, citation resolvability, and
   masthead/prose duplication. Re-run the develop baseline on the new checks.
3. **Rewrite against it, one change at a time.** Goal first; one owner per topic
   (citation format, escalation, cards, confidence); delete rules the goal
   implies; keep NEVER for invariants; fix the examples and pin them with a
   test that they obey the prompt; let the schema carry the envelope. New
   failures go to the eval and to deterministic layers (validator, renderer,
   verifier) before they go into the prompt.
