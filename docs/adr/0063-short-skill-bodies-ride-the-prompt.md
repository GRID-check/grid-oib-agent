---
status: proposed
date: 2026-09-22
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# A short skill body rides the prompt; the catalog line is for the long ones

## Context and Problem Statement

ADR-0060 made every skill an offer: one catalog line per skill in the system
prompt, and the body delivered only through `use_skill`, called because the
model judged the skill applies. It rejected inlining the body ("keep forcing,
fix its delivery") on two grounds: forcing is a category error, and a body is
"thousands of tokens — paid on every call of every turn to say what a
paragraph says".

The first ground stands. The second was never measured, and it is false for
the skills the chat agent is actually offered. The nine chat-facing platform
methods (`gebaeudeklasse`, `brandschutz`, `einreichcheck`, `bestand`,
`bebauung`, `hygiene`, `nutzungssicherheit`, `waermeschutz`, `diagrams`) are
1,524–1,944 characters each, about 400 tokens; together they render to 4,570
tokens against 356 for their catalog lines
(`tests/aiq_agent/skills/test_inline_bodies.py` measures it). The one long
chat skill is `ifc-spatial-reasoning` at 17,573 characters, and the writers
deep research uses are 7–9k.

What a `use_skill` call costs is a round: the call ends the message, so the
body arrives one full-context call later, with the whole prefix and every
message re-sent and 3–8 s of latency. `brandschutz` opens with "load
`gebaeudeklasse` first", so a fire-safety question paid two rounds before its
first search. The turns-per-answer audit
(`docs/architecture/turns-per-answer-audit-2026-09.md`) found the skill
rounds on every method-shaped question it reconstructed, and on the
measurement turn they were the round the answer did not need.

So the question is not "offer or inline" — an offer is about who decides,
and the model still does — but where an offer of 400 tokens is cheapest to
read: in the prompt, cached with the prefix, or one round later.

## Decision Drivers

* A round is the unit of latency the reader feels; tokens in a cached prefix
  are not.
* ADR-0060's category rule: nothing may require a skill, and a body in the
  prompt must not become a standing instruction by being there.
* The "Skills used" disclosure names what shaped the answer, and must keep
  meaning that.
* Deep research builds the same runtime and has no envelope to name a
  followed skill in.

## Considered Options

1. **Keep every body behind `use_skill`** (ADR-0060 as written).
2. **Inline every body** (ADR-0060's rejected option 1).
3. **Inline within a measured budget; catalog line for the rest; the model
   names what it followed.**

## Decision Outcome

Chosen option: **3**.

**(a) Two caps in characters, set by the agent's config, both 0 by default in
the runtime.** `SkillRuntime(inline_max_body_chars, inline_budget_chars)`:
a body over the per-body cap never rides, and the total is filled in catalog
order (platform, then the org's own), so what an org sees is stable and
changes only when its skills do. Piloti sets 2,400 and 16,000
(`skills_inline_max_body_chars`, `skills_inline_budget_chars` on
`ResearchAgentConfig`); deep research passes nothing and keeps the catalog.

**(b) The block is delimited, and it is still an offer.** Each inlined body
is a `<skill name="…" description="…">` element under `## Skills`, so its own
headings cannot pass for the prompt's; the rest are one line each under
`### Available by name` with `use_skill` as before. The heading says the
model decides which one a question is the subject of. Nothing names a skill
as required; the standing-instruction layers are unchanged.

**(c) The model names what it followed, and only an inlined body counts.**
The envelope gains a CONTROL field `skills_applied: [string]`. The register
hands it to the runtime after the run (`record_applied`), which activates a
name only when that body rode the prompt: a `use_skill` delivery is already
active, and a name that matches nothing had no body reach the model, so it
shaped nothing whatever the model wrote. `skills_activated` is read after
that and means what it meant.

**(d) A card preference rides as names, never as shapes.** `use_skill` still
appends the full shapes of a skill's preferred cards; the inlined block
carries one line naming them. The envelope contract already teaches the
eight shapes answers earn most, and any other miss is repaired by the small
model (`cards/envelope.py`).

### Consequences

* Good, because a method-shaped question no longer pays a round to read a
  400-token method, and the `brandschutz` → `gebaeudeklasse` chain costs
  nothing.
* Good, because the premise is now a test: `TestThePremiseIsMeasured` fails
  when a chat method grows past the cap, so raising the cap is a decision
  someone writes down rather than a drift.
* Bad, because the block is ~4,600 tokens on every call of every chat turn,
  whether or not a skill applies. It sits below the static prefix and is
  cached by the provider's automatic prefix caching within a turn; across
  turns it is re-read once per turn. Per turn that is a fraction of one
  `use_skill` round.
* Bad, because the disclosure for an inlined skill now rests on the model's
  own account. A `use_skill` delivery was no proof the body was followed
  either; both are the model's word, at different times.
* Bad, because the live "Applying the … skill" line for an inlined skill
  fires with the answer rather than mid-turn. The round it saves is the
  reason.
* Neutral, because an org that writes a long method sees no change: its body
  stays a catalog line and loads on demand.

### Confirmation

- `tests/aiq_agent/skills/test_inline_bodies.py`: the two caps, catalog
  order, the delimited block, names-not-shapes, activation only by the
  envelope and only for an inlined body, the `offered` event's
  `inlined_count`, and the platform methods fitting the default budget.
- `tests/aiq_agent/agents/piloti/test_skills_applied.py` and
  `test_register_skills.py`: the field is lifted from the envelope, carried on
  the state, handed to the runtime after the run, and `skills_activated` is
  read after that.
- `tests/aiq_agent/common/test_answer_envelope.py::TestSkillsApplied`: the
  field is taught, strict-enforced as an array of strings, and never on the
  reader's wire.
- `tests/aiq_agent/skills/test_runtime.py` still pins that a runtime without
  a budget is the catalog-only block, which is what deep research gets.

## Pros and Cons of the Options

### 1. Keep every body behind `use_skill`

* Good, because it is the status quo and needs no code.
* Bad, because every method-shaped question pays one or two rounds to read
  400 tokens, measured.

### 2. Inline every body

* Good, because no skill ever costs a round.
* Bad, because `ifc-spatial-reasoning` alone is 17,573 characters and an org
  can write at any length; the block would be unbounded, which is the
  objection ADR-0060 made and the one that was right.

### 3. Inline within a budget; the model names what it followed

* Good, because the cost is bounded and measured, and the round is gone for
  exactly the skills where a round costs more than the body.
* Bad, because there are now two ways a body reaches the model and the
  disclosure has to be told about the second one by the model itself.

## Amendment (2026-09-22): the budget is opt-in; the decision reads the one body in

The measurement stands — a chat method is ~400 tokens, not "thousands" —
and the mechanism was still too costly: nine bodies together are ~4 600
tokens on every call of every turn, paid for methods most turns never use.
The product owner's call, and the right one. So `skills_inline_max_body_chars`
and `skills_inline_budget_chars` default to 0 and are an opt-in budget for an
org that wants a method on every turn regardless; the shipped config sets
neither. What reads a body in now is the turn-start decision (ADR-0064): a
`skill` choice over every resolved skill with `none`, verified by one "fits"
noul per skill — TypeSafe's skill-suggestion cookbook — and the chosen
skill's body rides this turn's prompt through `SkillRuntime.inline_also`,
whatever its size (the 17k-character IFC method on a model question
included), with its preferred card shapes beyond the eight the envelope
teaches. One body, ~400 tokens, only on a turn whose question is that
method's subject; the rest stay one catalog line behind `use_skill`.
Measured on the loop-eval set: the choice named the family's method or
abstained on every row (`decision_eval_2026-09-22.csv`). Everything else
in this ADR — the premise, `skills_applied`, the block's shape, the
opt-in budget's tests — is unchanged.

## More Information

- ADR-0060 (c) is amended by this ADR; its category rule stands.
- Implementation: `src/aiq_agent/skills/runtime.py` (header),
  `common/answer_envelope.py` (`skills_applied`),
  `agents/piloti/register.py` (`_resolve_skill_runtime`, `_report_skills`).
- The measurement that led here:
  `docs/architecture/turns-per-answer-audit-2026-09.md`.
