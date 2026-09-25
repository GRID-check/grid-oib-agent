---
status: accepted
date: 2026-09-15
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Instructions live in three layers, and a tool delivers an answer

## Context and Problem Statement

Piloti had four places that told the model what to do, and three of them were
the wrong shape for what they were saying.

**Forcing a skill bought a name.** Two mechanisms could require a skill on a
turn: the platform's `delivery: standard` tier, and the `skills` array the
composer put on the WebSocket envelope when somebody picked `/name`. Both
worked the same way — the skill's NAME went into an "Active skills" block, and
its body travelled through exactly one path, the `use_skill` closure. So a turn
that obeyed paid a charged round trip and thousands of tokens for a standing
rule that could have been three sentences of prompt, and a turn that did not
obey read not one word of it. The two house skills that motivated the tier
(`piloti-voice`, `piloti-cards`) had already been retired into the prompt for
exactly that reason; the mechanism outlived its own counter-example.

**The prompt had accumulated procedure.** Rules were added whenever a tool
failed to deliver an answer: a numbered source order deciding which corpus to
try before the question was read, a paragraph telling the model to rewrite its
query before every search (which three tools already do internally), fan-out
rules for opening every member of a Richtlinien-Familie, and a cap of two
searches in the first round. Each was a workflow step written in prose inside an
agent, and each described how to operate a tool rather than what the answer owed
the reader.

Three measurements, from the audit in
[`../architecture/hobble-register-2026-09.md`](../architecture/hobble-register-2026-09.md):

- the static prefix was **12,788 tokens**, re-sent on every call of every turn;
- a family overview — *„was weißt du über die OIB 2"*, a row of the loop eval
  and the most ordinary question the product answers — **exhausted the
  seven-call research budget** and hit forced synthesis, because the prompt told
  it to open five documents and the budget charged five calls for doing so;
- traces showed **zero cached tokens** on every research call, on a workload
  where output is 0.4–1.4 % of the tokens. The prefix was the turn's cost, and
  nothing was reusing it.

## Decision Drivers

- A rule the model can skip is not a rule; an instruction that must hold on
  every answer has to be in front of the model without a tool call.
- The static prefix is paid on every call of every turn, so prose that repeats a
  tool description is charged 4–8 times per question.
- A tool that needs a taught sequence has an incomplete contract: the sequence is
  the tool's own knowledge, sitting in the wrong file.
- What an office always wants applied is a property of the organisation, not a
  per-message choice somebody re-makes or forgets on every send.
- The platform's own words must be changeable without a deploy, and must not
  thereby become a second source of truth that review never sees.

## Considered Options

1. **Keep forcing, fix its delivery** — inline a forced skill's body into the
   prompt instead of naming it, so the instruction is actually present.
2. **Keep teaching sequences in the prompt**, and add a paragraph for each new
   tool that needs one.
3. **Three instruction layers, and tools that deliver answers.** Nothing forces
   a skill; standing instructions are prompt text at two levels; every taught
   sequence moves inside the tool that needed it.

## Decision Outcome

Chosen option: **3**. Option 1 fixes the delivery and keeps the category error —
a skill whose body is always inlined is an instruction wearing a capability's
clothes, and it is paid per turn at a skill body's size rather than a rule's.
Option 2 is the status quo, and the status quo is what produced 12,788 tokens of
prose about how to hold a tool.

**(a) The platform prompt states outcomes and facts, never call sequences.** It
says what must be true of the answer — a value is retrieved or measured this
turn, an unopened document is never described, an overview is complete when
every member of the family was opened — and what each corpus holds. It no longer
says what to call, in what order, or how many times. It is managed as a Langfuse
prompt with **git as the source of truth**: the static half lives in
`prompts/piloti_static.md`, CI checks that file and review reads it, a merge
pushes it to Langfuse, and labels carry experiments. Unset or unreachable,
every process falls back to the committed file. This is ADR-0014's shape one
layer over: the repo holds the boot fallback, the live value is set where it can
reach a running fleet.

**(b) An organisation's standing preferences are one bounded text block.** An
org admin writes it once under Organization settings; it rides on every turn as
`X-Grid-Org-Instructions` (base64url, beside `X-Grid-Project-Context`), bounded
at **1500 characters** by a database CHECK, by the BFF's edit boundary and again
at the header decode. It renders below the KV-cache boundary as the office's
standing preferences on form, focus and workflow, under one static rule: the
platform's rules win, and an instruction is **never a source**. A normative
value comes from a document retrieved this turn and from nowhere else.

**(c) Skills are working methods the model chooses from its catalog.** The
catalog is one line per skill; the body arrives only through `use_skill`, called
because the model judged the skill applies. Nothing can require one — not a
request, not a deployment, not a job. `/name` in the composer writes the skill's
name into the message TEXT and nothing rides beside it on the wire; the model
reads the name and picks the skill out of the same catalog it always chooses
from. The `standard` delivery tier, the `skills` array on the envelope, the
reserved tool iterations that paid for them and the `forced` / `forced_names`
event fields are all removed.

**(d) A tool owns its whole contract — when to call it and what it returns.** A
tool that needed a taught sequence becomes one tool that delivers the answer.
The worked example is RIS: search → pick → fetch → find the paragraph was four
operations the model orchestrated by hand across three charged calls, ending in
a 40,000-character blob with no citation key, and the prompt carried the
workflow that joined them. One `ris_lookup` takes the question, does the
sequence internally under its own bounds, and returns passages in the grounding
grammar citation verification already parses. `read_passage`'s outline mode is
the small version of the same move: naming a document with no locus used to be
refused, and the model guessed a Punkt, was refused again, and searched twice —
now it opens the document's scope passage and Gliederung, and the prompt
paragraph that taught the workaround is gone.

**(e) The graph keeps ratchets and budgets, and drops guards that judged
process.** A ratchet catches a false claim after the fact and cannot invent one:
citation verification, the confidence ceiling, the answer envelope's
deterministic gates. A budget bounds cost without prescribing shape: the
research ceiling, the repair pass's two retrievals, the retrieval bounds of
ADR-0057/0058. The round-zero two-search cap was neither — it judged how the
model spent its first round, on three plausible corpora that do not fit in two
calls — and it is deleted. The duplicate-fetch guard stays, because a repeat
buys the turn nothing and the guard measures the call, not the reasoning.

### Consequences

* Good, because an instruction that must hold is now present on every call at
  the cost of its own text, with no round trip to skip and no half-application.
* Good, because the static prefix fell from 12,788 to 8,503 tokens, and the
  deleted prose was the part that duplicated tool descriptions — one fewer place
  for a tool's contract to drift from itself.
* Good, because "what does this office want" has one answer, one editor, one
  CHECK constraint and one audit trail, instead of a per-message array.
* Bad, because the two retired house skills and any `delivery: standard` row a
  platform owner published **stop running** the moment this ships. They are
  mapped to offers rather than deleted; anything in them that must keep applying
  has to be written into the platform prompt.
* Bad, because the platform prompt is now editable from outside the repo. Git is
  the source of truth and the fallback, but a live label can carry text review
  never saw, and the only signal is the trace.
* Bad, because more of the turn's shape is the model's judgment. The cap and the
  source ordering were crude, and they were also deterministic.
* Neutral, because the org block can do less than the mechanism it replaces: it
  cannot add a tool, cannot switch a data source on, cannot raise a confidence
  ceiling, cannot outrank the platform's rules and cannot be cited. It is
  preferences on form, focus and workflow, and a turn that treats it as evidence
  is a bug in the prompt, not a setting.

### Confirmation

- **The runtime cannot require a skill.** `tests/aiq_agent/skills/test_runtime.py`
  pins that a resolved skill is an ordinary catalog line, that a `standard`
  marker on the BFF payload is ignored, and that only a delivered body counts as
  activated. `tests/aiq_agent/turn/test_payload.py` pins that a `skills` array on
  the envelope is parsed away rather than obeyed.
- **The tier cannot come back by data.** `platform_skills_delivery_check` now
  admits `offer` and nothing else (migration 0088); a row written any other way
  is rejected by the database, not by a reader.
- **The block cannot grow.** `organization_instructions_length` (1500 chars) and
  `organization_instructions_not_blank` are CHECK constraints (migration 0087),
  mirrored by the service's zod boundary and by the header decode, which
  truncates with a marker rather than trusting the sender.
  `tests/aiq_agent/agents/piloti/test_org_instructions_prompt.py` pins where the
  block renders and that it sits below the rules it may not override;
  `rls-coverage.spec.ts` pins the tenant boundary on the new table.
- **The prompt keeps its shape by review, plus one gate.** Nothing lints a
  sentence that prescribes a call sequence. What exists is the measurement: the
  loop eval's `rounds`, `truncated` and `repeat_query` columns, and the
  cached-token share now reported per turn. A prompt edit that re-teaches a
  sequence shows up there or nowhere.
- **The published prompt comes from git.** `task prompts:push` (2026-09-24)
  checks a label against the committed `piloti_static.md` and, with `--apply`,
  publishes it as a `git`-tagged version naming its commit (the tag is not
  provenance; see the 2026-09-25 amendment); it refuses a label
  whose version was edited in Langfuse until `task prompts:pull` has brought it
  into review (`tests/test_prompts_push.py`). The publish is a step an operator
  runs, not yet one a merge or a deploy runs: `LANGFUSE_PROMPTS_ENABLED` is set
  in no environment the repository defines, so every fleet renders the
  committed file. (The pull-only first cut, 2026-09-15, had Langfuse as the
  source, contrary to (a).)

## Amendment (2026-09-15): the dynamic half gets the same treatment

The decision above cut the STATIC prefix and left the half below the
`KV CACHE BOUNDARY` marker alone. Measured on a realistic turn (a Viennese
project, twenty inventory files, a focused file, an office block, six already-read
entries), that half was **7,724 tokens**, and it is the expensive one: nothing
below the marker is cacheable, so every token of it is charged fresh on every
call of every turn. It is now **2,962 tokens** on the same turn, plus ~240 for
the applicability section, which the measurement's project-context shape does
not produce.

What it held was the two things (a) and (d) already forbid, arriving by a
different door.

**Tool contracts, moved into the tools that own them.** `<entwuerfe>` (788),
`<aufraeumen>` (329) and `<delegieren>` (383) each taught a bound tool how to
behave, in prose charged per call. Each rule now sits in the description the
provider already sends: the drafting workflow in `write_file` / `edit_file` /
`ls` / `file_draft` / `submit_draft`, the four proposal verbs' own rules in
`tools/files/register.py`, delegation in `_CREATE_TASK_DESCRIPTION`. Two
sentences stayed in `<entwuerfe>`, because no description can carry them: what
„mach daraus ein File" refers to (the transcript knows; the tool does not), and
that filing needs a project. Two rules had no home and were added: the
no-project precondition on `create_task`, and „only when the user asks" on
`move_document` and `create_folder`. The focus-file block lost its retrieval
procedure, which restated `knowledge_search`'s own `file_name=` rule, and kept
the fact; the inventory trailer and the tail of `parcel_note` went the same way.

**The `ris_catalog` Normenregister block (1,544), deleted.** Its own header
said the RIS tools resolve a catalog entry themselves, and `ris_lookup`'s
description says it again. The per-project applicability section that rode
inside `render_block_for_prompt` is the one part no tool can produce from a
free-text question, so Piloti renders that alone
(`prompt.oib_applicability`). Deep research still renders the full catalog: its
researcher orchestrates RIS by hand, which is the situation the catalog was
written for.

**Standing doctrine, moved ABOVE the boundary.** `norm_doctrine` (788) and the
three PROJECT_MEMORY / PROPOSAL_DECISIONS / REVIEW_DECISIONS explanations (718)
were identical bytes on every turn, rendered below the marker where identical
bytes cost the most. They are now `<dokumentrollen>` and `<project_record>` in
`prompts/piloti_static.md`: cacheable, and editable in Langfuse, which is where
platform doctrine belongs under (a). The doctrine's first paragraph was dropped
rather than moved — it reintroduced the retrieval order „Wissensbasis → RIS →
Web" that this ADR deleted from the static half, and its other half (the
authority chain) is already `<domain_brief>`.

**The country-profile caveat.** `norm_doctrine` resolves through
`country_profile`, and only `at` is registered, so the text is constant per
deployment and the move is safe today. A second country profile makes it vary
per project, and the doctrine then belongs below the boundary again — as a
rendered variable, the way it was, not as two copies of a static file.

Kept below the boundary on purpose: `## Available Tools`, 94 tokens of tool
NAMES, because under deferred loading (ADR-0048) it is the model's only index
of the namespace it can search.

**What pins it.** `tests/aiq_agent/agents/piloti/test_agent.py` asserts, per
moved rule, that the tool description carries it and the rendered prompt does
not (`TestTheDraftingRulesLiveInTheTools`,
`TestTheDelegationRulesLiveInTheTool`, `TestTheTidyingRulesLiveInTheTools`);
`test_ris_catalog_prompt_wiring.py` pins that `piloti.j2` has no `ris_catalog`
variable at all, so a caller cannot reintroduce the block by passing one; and
`test_static_prompt_split.py` holds the whole rendered prompt as a golden file,
so an accidental edit fails a test and a deliberate one arrives as a diff
review reads.

## Amendment (2026-09-25): the tag filters, the commit proves

The confirmation above says `task prompts:push` publishes a `git`-tagged
version. That reads as if the tag marks where a version came from. It does
not.

- **The git tag is a UI filter only.** Langfuse keeps tags per prompt, so
  every later UI edit carries it too.
- **Provenance is the version's commit message** `git <sha> <path>`, plus a
  byte-identical `git show` of that file at that commit. `published_from_git`
  in `scripts/prompts_push.py` checks both.
- **The label is read and written in two calls.** A UI promotion in between
  is overwritten. Nothing closes this yet.
- **Publish with `--apply` only from a commit on `develop`.** A feature-branch
  sha disappears at squash-merge. Later pushes then cannot `git show` it and
  refuse the version as a Langfuse edit.

## Pros and Cons of the Options

### 1. Keep forcing, inline the body

* Good, because the instruction is genuinely present, which is the one thing
  forcing never achieved.
* Bad, because it pays a skill body — thousands of tokens — on every call of
  every turn to say what a paragraph says, and it keeps two objects (a capability
  and an instruction) in one table where only their audience differs.

### 2. Keep teaching sequences in the prompt

* Good, because it is free to write and needs no tool work.
* Bad, because the prompt grows by a paragraph per tool, every paragraph is
  charged on every call, and the tool's contract now lives in two files that
  drift silently. This is how 12,788 tokens happened.

### 3. Three layers, and tools that answer

* Good, because each kind of instruction sits where its cost and its authority
  match: platform rules in the prefix, office preferences in a bounded per-turn
  block, working methods in a catalog the model opens on demand.
* Neutral, because it moves work from prose into tools, which is more code for
  less text — the RIS consolidation deletes four teaching passages and adds a
  pipeline with its own bounds and its own tests.
* Bad, because the layers have to stay separate by review: nothing stops a
  tenant's block from being written as a procedure, or a tool description from
  growing a sequence.

## More Information

- The audit this rests on, with the traces, the token measurements and the
  per-row fix:
  [`../architecture/hobble-register-2026-09.md`](../architecture/hobble-register-2026-09.md).
- The subsystem as it now stands:
  [`../architecture/agent-skills.md`](../architecture/agent-skills.md) (ADR-0046),
  and the prompt's two halves in
  [`../architecture/backend-deep-dive.md`](../architecture/backend-deep-dive.md).
- Related decisions: ADR-0046 (skills), ADR-0052 (one answering agent — a label
  decided before the answer can only withhold what the answer turns out to
  need, which is this record one layer down), ADR-0014 (the live default lives
  outside the YAML), ADR-0022 (explicit org value beats deployment default),
  ADR-0044 (Langfuse), ADR-0048 (tool schemas stay with the provider).
- **Revisit when** a standing instruction genuinely needs to be per project
  rather than per organisation — that is a second block, not a wider one — or
  when a measured turn shows the model skipping a working method often enough
  that a catalog line is not enough. The answer then is a better description or
  a tool, not a way to force a skill again.
