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
| Level 1 | `skills/runtime.py::prompt_block` | Renders `## Verfügbare Skills` + one line per skill: `` - `name`: description ``, verbatim. This string becomes `state.skills_block` in the agent's system prompt (`agents/shallow_researcher/register.py`). |
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
4. **Know who is in the room.** Today five of six builtins carry
   `grid-agents: deep_researcher`, so the **chat agent's skill list has exactly
   one entry**: `ifc-spatial-reasoning`. Its description is not fighting for
   selection among peers — it is fighting to be noticed at all. The failure mode
   to design against is undertriggering (never loaded) and, second,
   overtriggering on questions where loading it wastes a turn. Verify with:

   ```python
   SkillRuntime(SkillResolver(agent="shallow_researcher").resolve()).prompt_block()
   ```

   Read the block the model will actually read. It takes ten seconds and it is
   the only ground truth about triggering we have.

## 2. What makes a description fire

House pattern, already consistent across the research/synthesis builtins and
worth keeping: **what + when + explicit trigger vocabulary**, third person,
imperative, no "I can help you".

What we changed for `ifc-spatial-reasoning` and why:

- **Bind it to the moment of the tool call.** The description now opens *„Vor dem
  ersten Aufruf von ifc_measure oder ifc_query laden"*. The model's decision
  point is when it reaches for a BIM tool; naming those tools inside the trigger
  text puts the skill at that exact point instead of hoping a topic match fires
  earlier. This is the highest-leverage sentence in the file, and it only works
  because L1 and the tool schemas sit in the same context window.
- **Trigger vocabulary in the user's language.** Austrian architects type
  *lichte Raumhöhe, Brüstungshöhe, Dachüberstand, freier Lichteinfall*. Those
  literal words belong in the description. Generic capability prose ("spatial
  reasoning over BIM models") matches nothing anybody types.
- **Cover the indirect case explicitly.** *„Auch dann, wenn die Frage aus einer
  OIB-Anforderung kommt und das Maß nur der Zwischenschritt ist."* Without this
  the model treats a compliance question as a knowledge-base question and never
  reaches the model at all — which is precisely the incident this whole package
  exists to prevent.
- **Add a negative clause.** *„Nicht für reine Rechtsfragen ohne Modellbezug."*
  Cheap insurance against burning a turn on every OIB question.
- **Do not restate the body.** The description is routing; the body is judgment.

Descriptions fail when they are: capability summaries ("Provides…", "This skill
handles…"), abstract where users are concrete, silent about the adjacent case
where the skill is still right, or written in a language the user does not type.

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
- [ ] Description: one line, ≤1024 chars, no angle brackets, names the tools it
      routes to, carries the user's own vocabulary, has a negative clause.
- [ ] `grid-agents` set only if the skill genuinely cannot run elsewhere — it is
      the single availability gate and it deletes the skill from every other
      agent.
- [ ] `grid-catalog: curated` **only** for capabilities orgs opt into; absent
      means always-on machinery. Getting this wrong either hides the skill from
      everyone or forces it on everyone.
- [ ] Every identifier in the body pinned by a test against the real tool
      surface.
- [ ] No sentence that the tool description already says.
