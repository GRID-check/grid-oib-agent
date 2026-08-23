# Skill authoring notes

*What we learned rewriting `ifc-spatial-reasoning`. Written so the next skill in
this repo does not have to rediscover it. English, because it is about the
substrate; the skills themselves are German because their readers are.*

---

## 1. How a skill actually gets used here — read this before the Anthropic docs

Anthropic's guidance assumes the Claude Code runtime: skills are files on disk,
the harness lists them, the model "invokes" one, and a listing budget trims
descriptions when there are too many. **None of that is how this product works.**
Optimising for the documented mechanism instead of ours is the single easiest way
to write a skill that never fires.

The real path, end to end:

| Stage | Code | What happens |
|---|---|---|
| Discovery | `skills/builtin.py` | `builtin/<collection>/<name>/SKILL.md` is parsed **strictly**. A malformed frontmatter is a deployment error, not a skip. |
| Validation | `skills/models.py` | `name` ≤64 chars and must equal the directory name; `description` ≤1024 chars, non-empty, **no angle brackets** (it lands in a system prompt); `grid-cards` is checked against the live card catalog and a typo raises at parse time. |
| Resolution | `skills/resolver.py` | Per run: every non-`grid-catalog: curated` builtin, plus the org's rows from the BFF (which shadow builtins by name), then filtered by `grid-agents`. Fails **open** to the builtin set. |
| Level 1 | `skills/runtime.py::prompt_block` | Renders `## Available skills` + one line per skill: `` - `name`: description ``, verbatim. This string becomes `state.skills_block` in the agent's system prompt (`agents/shallow_researcher/register.py`). |
| Level 2 | `skills/runtime.py::build_tools` | A LangChain tool named `use_skill(skill_name)` returns the body. **The model must call it.** Nothing else loads a body. |
| Forcing | `forced_block` | If the user pins a skill in the UI, a second block says it is active and MUST be loaded. This is the only non-model-driven path. |

Four consequences that matter more than any generic advice:

1. **Triggering is a tool-call decision, not a routing decision.** There is no
   fuzzy matcher, no `/slash` invocation for the model, no automatic injection.
   The model reads one bullet line and decides whether to spend a tool call on
   `use_skill`. It is competing not with other skills but with *answering
   straight away* using tools whose descriptions are far longer and far more
   actionable (`ifc_measure`'s is ~4 000 characters and always in context).
2. **The description is never truncated.** Claude Code trims descriptions to fit
   a 1 %-of-context listing budget; this substrate does not. The only cap is
   `MAX_DESCRIPTION_CHARS = 1024`, enforced at parse time. So you get the whole
   1024 characters, and you pay for all of them on every turn of every agent the
   skill resolves for. Spend them on triggering, not on prose.
3. **The description must be one line.** `prompt_block` interpolates it into a
   bullet. A YAML folded scalar (`>`) with a blank line in it emits a `\n`, and
   the tail of your description then reads as loose system-prompt text outside
   any bullet. Use `>` with no blank lines. (Pinned:
   `test_the_description_survives_the_level_one_catalog_intact`.)
4. **Know who is in the room.** Research/synthesis builtins carry
   `grid-agents: deep_researcher`. OIB and BIM skills name both agents, so the
   chat catalog is a short list of one-line bait, not a keyword net. The failure
   mode to design against is undertriggering (never loaded) and, second,
   overtriggering on questions where loading it wastes a turn. Verify with:

   ```python
   SkillRuntime(SkillResolver(agent="shallow_researcher").resolve()).prompt_block()
   ```

   Read the block the model will actually read. It takes ten seconds and it is
   the only ground truth about triggering we have.

## 2. What makes a description fire

One sentence. What the skill does, in the words an Austrian architect types.
The description is bait, not a manual: the picker and the L1 catalog show this
line and nothing else, and a keyword net that tries to name every branch
teaches the model to follow the line instead of loading the body.

House shape:

- Outcome first. A concrete noun that earns its place (`Gebäudeklasse`,
  `Bauansuchen`, `Aufenthaltsraum`). Not a synonym list.
- German. The picker is read by a person in Wien.
- Tool names only when the decision point *is* the tool call
  (`ifc_measure` / `ifc_query` in `ifc-spatial-reasoning`).
- Do not restate the body. The description is routing; the body is the method.

A long trigger vocabulary is the failure mode of the first `ifc-spatial-reasoning`
rewrite: it fired more often and taught the workflow in the wrong place.

## 2a. Methods, not rules

The OIB corpus and RIS are the source of thresholds, editions and tables. A
skill that restates them is a cache that goes stale and a second place to be
wrong. Teach the *method*: what to establish first, where to look, how to tell
done, which card carries the answer, the failure mode of the method (Anforderung
vs Nachweis, geschätztes Maß in einer Karte, Neubau-Klausel auf Bestand).

A number that belongs in Richtlinie 2 does not belong in a SKILL.md.

Most questions are not about an IFC model. They are about the Richtlinie, the
Bauordnung, and what is on the plan or in the question. An OIB genre skill
answers from those. It does not send the agent to measure the model. That
method lives in `ifc-spatial-reasoning` and fires from its own description
when the question is actually about the model.

## 3. What makes a body worth its tokens

The rule that did most of the work in this rewrite:

> **The tool description is for CAPABILITY. The skill is for JUDGMENT.**
> If a sentence is already in `_TOOL_DESCRIPTION`, deleting it from the skill
> costs nothing, because the model has already read it — twice now.

`ifc_measure`'s description already covers provenance verbs, `decidable: false`,
"never recompute a number", the per-operation cost table, and "a cut prism does
not ban the window". The previous SKILL.md spent roughly half its length
restating exactly those. That is not merely wasted budget — it *dilutes*: the
model cannot tell which parts of the skill are new information, so the parts that
are new get skimmed at the same rate as the parts it has already seen.

What earns space instead:

- **Routing between sibling tools.** Nothing in either tool description tells you
  that thirty room areas are one `ifc_query` `schedule` call and thirty seconds
  of geometry if you loop `floorArea`. That is judgment, and it lives nowhere
  else.
- **Order of operations,** with the reason (each call yields the id the next one
  needs; the geometric relations build a contact map once, over seconds).
- **Gotchas** — see below. This is the highest-value section per line.
- **Worked chains with real parameter names and real enum values.**

What to cut: restated tool descriptions, motivational prose, "always be
accurate", anything that does not change what the agent does.

The 500-line guidance is not the binding constraint here (the body is ~210
lines). Density is. Every line the model reads is a line it might have spent
reading the answer.

## 4. Gotchas are the payload — and they must come from the code

A "Fallstricke" section made of platitudes is worse than none: it promises
hard-won knowledge and delivers filler. Every entry should be traceable to a
line of code, a caveat string, or a test. The productive way to find them is to
read the operator implementations and their `caveat` text — that is where the
engineers wrote down what the number does *not* mean — and then the end-to-end
battery, which shows the exact German the model reads back.

Two categories to look for specifically:

1. **The number measures something adjacent to what was asked.** Storey pitch vs
   clear room height. Centroid distance vs clear width. Bounding-box extent vs
   element length. These are the dangerous ones, because the answer reads
   perfectly either way.
2. **An empty result that is about the export, not the building.** Zero hits,
   an unpopulated relation, `decidable: false`. Every one of these has a
   "…therefore the building has none" misreading waiting for it.

## 5. Failure modes, with the one that actually shipped

| Failure | What it looks like | Guard |
|---|---|---|
| **Teaching a call that does not exist** | The skill taught `` view: "section" `` and a chain ending in `overhang` before `overhang` existed. The model spends a turn on an error it cannot fix, then invents the number. | `tests/aiq_agent/skills/test_ifc_spatial_skill.py` pins every backticked identifier and every `param: "value"` against the tools' real enums — now for **both** `ifc_measure` and `ifc_query`, including which tool each operation belongs to. |
| **Vague description** | Capability summary, no user vocabulary. Never fires. | Read the rendered L1 block; check the words a real user would type are in it. |
| **Duplicating the tool description** | Half the body is already in context. Dilutes the new material. | Diff the skill against `_TOOL_DESCRIPTION` before shipping. |
| **Missing gotchas** | The model reports a correct number under the wrong name. | Grep the operators for `caveat=` and the battery for its assertions. |
| **Over-length / low density** | Model skims. | Cut anything that does not change behaviour. |
| **Pinning the prose instead of the claim** | A test asserted `"vergrößert die\nerforderliche Lichteintrittsfläche"` — it enforced a *line break*. Reflowing a paragraph would go red without any claim changing. | Assert on whitespace-collapsed text. |
| **Vacuous guard** | A structural test that passes because it checked nothing. | Assert a minimum number of checked items, and feed the historical defect back through the guard (`test_the_check_actually_catches_the_defect_it_was_written_for`). |

## 6. Checklist

Before shipping a skill in this repo:

- [ ] `uv run python -m pytest tests/aiq_agent/skills/ -q` green (strict parse,
      name/dir match, `grid-cards` against the live catalog).
- [ ] Rendered L1 block read by eye, for the agent that will carry the skill.
- [ ] Description: one sentence, ≤1024 chars, no angle brackets, what the skill
      does in the user's words. Tool names only when the decision point is the
      tool call. No encoded thresholds. The body is the method.
- [ ] `grid-agents` set only if the skill genuinely cannot run elsewhere — it is
      the single availability gate and it deletes the skill from every other
      agent.
- [ ] `grid-catalog: curated` **only** for capabilities that belong on the
      Skills tab; absent means always-on machinery. A chat-usable FILE offer
      starts ON; a dashboard offer or a deep-research-only file starts OFF.
      Getting this wrong either hides the skill from everyone or forces it on
      everyone.
- [ ] Every identifier in the body pinned by a test against the real tool
      surface.
- [ ] No sentence that the tool description already says.
