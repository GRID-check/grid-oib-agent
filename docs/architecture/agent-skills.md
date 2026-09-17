# Agent Skills and Jobs (ADR-0046)

Skills are reusable, versioned instruction packages (the agentskills.io
format) that extend what the model can be told how to do on:
- **Interactive chat turns** (`researcher`), and
- **Async deep-research jobs** (`deep_researcher`).

A skill is a **working method the model chooses**, never one it is told to run:
it reaches the model as one line in a catalog, and its body arrives only when
the model calls `use_skill`. Nothing can require one — not a request, not a
deployment, not a job. What must hold on every answer is prompt text instead,
at two levels (the platform prompt and the organization's own instruction
block); that split is [ADR-0060](../adr/0060-three-instruction-layers-and-tools-that-answer.md),
and the two mechanisms it retired are recorded below under "The `standard`
tier, and why it is gone".

A **job** is the other half of the feature and a separate object: a
project-scoped *prompt on a timer* that MAY attach a skill, whose body is then
inlined into the fire prompt it sends. That is the whole relationship. A skill
knows nothing about time and nothing about output format; a job needs no
skill.

This doc is the whole subsystem: the backend half (where skills come from, how
they are selected per run, how the model is told about them) and the BFF half
(the org toolbox, project jobs, the fire path, the conversation a chat job
lands in, the scheduler worker and the UI). It replaces
`docs/architecture/workflows.md` — the Workflows feature (ADR-0023) was
removed, and this is its successor: the `skill-scheduler` container is the
workflow scheduler, and a job is what a saved research brief used to be. API
surfaces are tabulated in `docs/api/python-endpoints.md` and
`docs/api/bff-routes.md`.

Feature gate: `FEATURE_FLAGS.skills` (`skills` in WorkOS) with the dark-launch
env fallback `GRID_SKILLS_ENABLED` (default off) while
`GRID_ENFORCE_FEATURE_FLAGS` is off — `isSkillsEnabled` /
`requireSkillsEnabled` in `frontends/ui/src/lib/authz/feature-flags.ts`. Jobs
ride the same flag: the two ship as one feature and are turned on together, so
a second flag would only add a way for them to disagree.

## Skill model

A skill is a `SKILL.md` with YAML frontmatter (agentskills.io contract),
validated strictly by `src/aiq_agent/skills/models.py`:

| Field | Rule |
|-------|------|
| `name` | 1–64 chars, lowercase `a-z0-9` + hyphens; for filesystem skills it must equal the parent dir name |
| `description` | 1–1024 chars, non-empty; the one-line L1 summary the model sees |
| `body` | The full markdown instructions (L2), loaded only via the `use_skill` tool |
| `metadata` | String-map; reserved GRID keys are validated — `grid-agents` (who may use it), `grid-cards` (preferred output card types), `grid-title`, `grid-hidden` (mute the live line), `grid-catalog` (`curated` = offer, absent = machinery). Every other key is opaque |
| `license` / `compatibility` / `allowed_tools` | Optional free-form strings |

`Skill` carries one more field that is **not** frontmatter and cannot be written
by a skill author: `origin`, where the document came from. It is set by the
resolver from the source it read, never parsed out of a `SKILL.md`.

There was a second, `standard` — whether the platform published the skill as
fleet standard equipment, which the runtime then forced onto every run. The tier
is retired (ADR-0060); the backend has no such field, and a `standard` marker
left on a BFF payload is ignored rather than obeyed.

Unlike deepagents' warn-and-continue scan, GRID's substrate validates
**strictly**: an invalid builtin SKILL.md is a deployment error
(`builtin.py` raises), an invalid org row is dropped individually with a
warning (`resolver._build_org_skills`), never silently half-loaded.

**A skill says nothing about when or how it runs.** `grid-execution` and
`grid-schedulable` used to be reserved keys here; both were removed when
schedules became jobs. Scheduling is a property of the job, and so is the
output kind (`jobs.output`). The removed keys are **not rejected** — they are
simply unreserved (`GRID_METADATA_KEYS` in `src/aiq_agent/skills/models.py`,
`METADATA_AGENTS`/`METADATA_CARDS` in `frontends/ui/src/lib/skills/types.ts`),
so a stored org row or a pasted SKILL.md still carrying one keeps it as
ordinary free-form metadata and nothing reads it. Rejecting them would turn a
deployed row into a read-time validation error and take a working skill out of
the toolbox to punish a key that costs nothing to ignore.

`grid-cards` is a **preference, not a contract**: a comma-separated list of
generated card `type`s (SYSTEM cards excluded — those are emitted by tools on
sanctioned paths, and asking the model for one would invite it to fabricate a
card the product treats as trustworthy). It costs nothing until the skill is
activated, at which point `SkillRuntime._preferred_cards_block` appends a short
block naming those types to the loaded body — **and their full shapes with it**,
by calling the card catalog's `render_card_details()`. A skill that names its
cards is the moment we know which of the 38 card shapes this turn could possibly
need, so it is the moment to spend context on them, and it saves the activated
turn the `describe_card` round-trip it would otherwise always pay (see
`cards.md` § The vocabulary is two levels). The block stays phrased as a
*preference* either way: an author naming three cards must not be able to force a
`comparison_table` onto an answer that has nothing to compare. Unknown names
are a parse error for a builtin
(authored in this repo, reviewed) and are logged-and-dropped for an org row
(tenant data over the wire, where one stale name must not delete the skill).

### Origins

- **Builtin** (`origin="platform"`): SKILL.md files shipped under
  `src/aiq_agent/skills/builtin/<collection>/<name>/SKILL.md`, discovered
  deterministically by `discover_builtin_skills()`. The BFF sees the same
  files through the generated `@/lib/skills/platform-skills` module
  (`frontends/ui/scripts/sync-platform-skills.mjs`), so both tiers read one
  source of truth.
- **Org** (`origin="org"` / `"platform-clone"`): rows in the `skills` table,
  authored in the organization. The backend reads them through the BFF internal
  endpoint `GET /api/internal/skills/resolve`. An org row whose name matches a
  builtin **shadows** it — the tenant's version wins, mirroring BYOK's "explicit
  org value beats deployment default" ordering (ADR-0022).
  `platform-clone` is a legacy origin: it recorded a skill CLONED from a builtin
  (see below), a flow the product no longer has. Existing rows keep the value
  and behave as ordinary org rows; nothing writes it any more.

### Three sources, three audiences

| source | who writes it | who sees it |
|---|---|---|
| `src/aiq_agent/skills/builtin/**` (files) | this repository | **nobody.** Pipeline machinery: never listed, never switchable, always resolved. |
| `platform_skills` rows, `delivery: 'offer'` | the platform owner, in **Platform → Skills** | every organization, as an OFFER it may switch on. |
| `skills` (rows) | an organization | that organization. |

The middle row is the fleet-wide channel: write a skill once in the platform
dashboard, publish it, and it reaches every organization — as something it may
take or leave. The body lives in that one row, so an edit reaches every org
running the skill immediately, with nothing to re-take.

There used to be a fourth audience in the same table, `delivery: 'standard'`:
published rows that every organization ran, unlisted, unswitchable and FORCED
onto each run. Migration 0088 retired the tier and narrowed the CHECK to one
legal value; the history and the reasoning are below.

Both of the table's defaults are closed, and they close different doors:
`published` defaults to false so a draft is invisible, and `delivery` is `offer`
so a published skill is one an organization may take or leave. Nothing a
platform owner can write imposes a skill on a turn.

That is what replaced **clone**. The Skills tab used to list every builtin
as equal cards with a "Clone" button, which copied the whole instruction into
the org as a `platform-clone` row — leaving the tenant maintaining an
instruction nobody there wrote and missing every improvement shipped afterwards.
(The button also never seeded the editor, so what it actually opened was a blank
form.) A switch replaces it: one living copy, ours, and switching off returns
the org to where it started.

An org's decision lives in `curated_skill_activations` (one row per
organization × skill it has decided about). No row means the default: a
chat-usable FILE offer starts ON, a dashboard offer or a deep-research-only
file starts OFF. It is NOT a `skills` row, precisely because a `skills` row
carries a body and a body is a copy that drifts.

### The `standard` tier, and why it is gone

`delivery: standard` claimed to be fleet standard equipment — "resolved for
every organization, never listed, not switchable" — and resolving it only put
the skill's one-line **description** in the L1 catalogue. The answer at the time
was to FORCE it: name it in an "Active skills" block and tell the model to open
it. That bought less than it looked like. Forcing puts a NAME in the prompt and
nothing else, because the body travels through exactly one path (the `use_skill`
closure), so a model that skipped the call read not one word of the instruction
while a model that made it paid a tool call and thousands of tokens for a
standing rule that could have been three sentences of prompt.

The first standard skills were `piloti-voice` (seeded by
`0053_piloti_voice_standard_skill.sql`) and `piloti-cards`, and both were
**retired** into prompt text (`0071_retire_piloti_house_skills.sql`) long before
the mechanism was: their craft moved into Piloti's system prompt and the deep
writer's prompt, because the house voice was absent from exactly the answers
that skipped the call, while every turn that did call paid two reserved tool
iterations and ~7,800 tokens of body. ADR-0060 applied that reasoning to the
mechanism itself. Both ways of forcing a skill are gone — the tier, and the
composer's `skills` array on the WS envelope — and so are the reserved
iterations, the `Skill.standard` field and the `forced` / `forced_names` event
fields.

What replaced them is where those two skills had already gone: **standing
instructions are prompt text**, in two places, neither of them this table.
The platform's own rules are the platform prompt, whose static half is
committed in this repo and served to the fleet through Langfuse with git as the
source of truth, so changing a house rule is a prompt edit rather than a
published row. An organization's standing preferences are its
bounded instruction block (`organization_instructions`, migration 0087, 1500
characters, sent per turn as `X-Grid-Org-Instructions`). Both cost no tool call
and cannot be half-applied.

Migration 0088 is what makes it a fact rather than a convention:

| what the tier had | what happened to it |
|---|---|
| `delivery IN ('offer','standard')` | `platform_skills_delivery_check` now admits `offer` alone; existing standard rows were UPDATEd to `offer`, not deleted |
| `idx_platform_skills_standard` (partial index on the resolver's hot path) | dropped — nothing asks that question any more |
| `assertNameNotStandardised` at the org write boundary | deleted. A standard row outranked an org row of the same name, so authoring one was a green save with no effect; every platform skill is an offer now and an org row **shadows** it, ADR-0022's "explicit org value beats deployment default" |
| the `standard` flag on `ResolvedSkill` | deleted from the wire. `resolver.py` ignores the key if an older BFF sends it |
| `resolveSkillSnapshot`'s standard-first lookup | deleted; the ordinary rule applies again — the org's own row wins, then the platform's |
| `listPublishedStandardRows` (deliberately uncapped, because a truncated read would have stopped fleet policy silently) | deleted with its query. `listPublishedOfferRows` keeps the 200-row catalogue rail |

The consequence is deliberate and worth stating plainly: a row that was
standard **stops running** for everyone. It is listed on each organization's
Skills tab and starts OFF until that organization switches it on. Anything in it
that must keep applying to every turn belongs in the platform prompt.

**One property of the retired tier survives as a general rule.** A dashboard row
never replaces a shipped FILE of the same name. The write boundary refuses that
create, and the other direction is a deploy — a new `SKILL.md` matching a row
published months ago — which no write boundary can see coming, so
`livePlatformSkills()` skips any published row whose name `findPlatformSkill`
knows. The file is product code, the row is dashboard copy, and product wins.

**And what every skill inherits: `grid-agents` still applies.** That gate
answers "which agent CAN run this", which is a different question from "who
decides that it runs". A skill written for deep research is not offered to a
chat turn that cannot execute it.

**Activation transparency is unchanged, and now says one thing.** The
disclosure under an answer reports what shaped it, and a product built on
traceable sourcing must not have a class of instruction it declines to admit
ran. With forcing gone there is one way a skill runs — the model read its line
in the catalog and called `use_skill` — so the panel names exactly the bodies
that were delivered.

**Fail-open drops offers and keeps machinery** — see Resolution below. Offers
reach a run through the BFF payload, and the backend's fail-open baseline is the
filesystem, so a BFF outage suspends the org's chosen skills for the duration
rather than taking chat down. The 60s resolver cache also means a newly
published offer reaches a given org's runs within a cache TTL, not instantly.

### Machinery vs. offers (`grid-catalog`)

A builtin FILE has one of two audiences, declared by `grid-catalog` in its
frontmatter metadata:

| value | meaning |
|---|---|
| *(absent — the default)* | **Machinery.** The pipeline's own instructions. Never listed on the Skills tab, never switchable, always resolved. |
| `curated` | **An offer.** Listed on the Skills tab with a switch. A chat-usable FILE starts ON; a dashboard offer or a deep-research-only file starts OFF. |

Machinery is the default deliberately: a new builtin that says nothing about
itself stays invisible, and exposing one to every tenant has to be a sentence
somebody wrote. The door exists so a builtin can become org-facing without
first becoming a database row; day to day, curation happens in `platform_skills`.
Genre methods (Brandschutz, Gebäudeklasse, Hygiene) stay
machinery so an ordinary question still auto-loads them. Job playbooks
(`einreichcheck`, `bestand`) declare `grid-catalog: curated`: they appear on
the Skills tab. A chat-usable FILE offer starts ON; a dashboard offer starts
OFF. The org can still switch a file offer off. Deep research's skill
filesystem hides curated directories, so an offer the org did not take up is
not readable via `read_file` either.

The split is enforced on both tiers, and both must agree:

- BFF — `isCuratedPlatformSkill` (`lib/skills/types.ts`) and
  `livePlatformSkills()` (`lib/skills/service.ts`), which reads the published
  offer rows, unions them with any `grid-catalog: curated` file, and skips a row
  whose name a builtin already has. `curatedOffers()` is the thin wrapper over
  the result. `listSkills` lists org rows plus offers — never machinery;
  `resolveSkillsForAgent` and `resolveSkillSnapshot` gate offers on the
  activation; `setCuratedSkillEnabled` 404s anything that is not an offer, so
  the machinery cannot be switched off by hand-crafting a request.
- Backend — `_is_curated` and `SkillResolver.always_on`
  (`src/aiq_agent/skills/resolver.py`). `resolve()` starts from `always_on`
  rather than every builtin, because the BFF payload can only ADD to that
  baseline: a curated skill left in it would be on for every tenant regardless
  of what any of them decided. An activated one arrives through the org payload
  like any other row — which is also how a `platform_skills` row reaches a run,
  since the backend has no copy of those at all. Fail-open therefore drops offers and keeps machinery,
  which is the right way round — offers are additive, machinery is how deep
  research works.

Anything unrecognised in `grid-catalog` reads as machinery on both sides: a typo
must not expose an internal instruction to every tenant as something switchable.

## Resolution

`SkillResolver(agent)` in `src/aiq_agent/skills/resolver.py` produces the
effective skill set for one run:

1. Builtin set is discovered once per resolver instance (never per turn).
2. Org rows are fetched per organization from the BFF fail-open:
   - Cached in the shared Dragonfly/Redis cache
     (`aiq_agent.common.cache`, ADR-0020) keyed
     `skills:{organization_id}:{agent}` for
     `GRID_SKILLS_CACHE_TTL_SECONDS` (default 60s).
   - Any failure (no `GRID_INTERNAL_API_TOKEN`, timeout, non-2xx, malformed
     payload) degrades to the builtin set — skills are an additive
     capability and must never take chat down.
3. Per-agent filtering (below).
4. The NAT config's `skills_enabled` / `skill_allowlist` (see Config).

### Agent targeting

ONE gate, `grid-agents`, read from reserved frontmatter metadata and applied
identically on both tiers:

| Tier | Function | File |
|------|----------|------|
| Backend | `_skill_applies_to_agent` (delegating to `_agent_allows`) | `src/aiq_agent/skills/resolver.py:89` |
| BFF | `skillTargetsAgent` — **module-private**, called by `resolveSkillsForAgent` | `frontends/ui/src/lib/skills/service.ts:320` |

They are a deliberate contract pair, kept close in shape as well as behaviour,
and `service.spec.ts` pins the TypeScript against the same cases the Python
tests use. The rule:

- `grid-agents` is a comma-separated allowlist of agent identifiers; **absent
  means every agent**.
- A name matching no known agent is **ignored** rather than obeyed. If *every*
  listed name is unknown the allowlist is treated as absent, so one typo cannot
  silently delete a skill from every agent at once. The backend logs the
  unknown names; the skill editor carries them through a save rather than
  rewriting somebody's metadata on their behalf
  (`features/skills/lib/agent-scope.ts`).

**Nothing else narrows a skill, and no other key may.** This is a reversal:
`grid-execution` briefly gated availability too. It answered a different
question — what a *scheduled* run produces — and reading an output format as an
availability rule meant that declaring `deep-research` silently deleted the
skill from the chat agent, with no error and no log a user could see. The key
no longer exists on the skill at all; the output kind is now `jobs.output`,
chosen by the user, and it decides only **which agent runs the job**
(`routes/skills.py::_OUTPUT_AGENT_TYPES`, mirrored by `AGENT_FOR_OUTPUT` in
`frontends/ui/src/lib/jobs/types.ts`). The skill picker in the job builder then
offers exactly the skills this one gate resolves for that agent — which is the
payoff of consolidating availability onto a single key.

The agent vocabulary is the `AGENT_REGISTRY` identifiers
(`frontends/aiq_api/src/aiq_api/registry.py`): **`researcher`** and
**`deep_researcher`**. There is one spelling; the older `deep_research_agent`
name is gone from the skills path entirely, because two vocabularies for one
agent meant a `grid-agents` value that was correct in one file and inert in
the other.

`researcher` was called `shallow_researcher` until the chat agent was renamed.
It stayed `researcher` when that agent's package was renamed again, to
`agents/piloti`: this string is a wire name, stored in
`platform_skills.grid_agents` and hand-written into skill frontmatter, so
moving it costs another migration and another alias pair.
Because the name is author-written and was seeded by ten migrations, both
resolvers read the old spelling as the new one (`AGENT_ALIASES` in
`src/aiq_agent/skills/resolver.py`, `SKILL_AGENT_ALIASES` in
`frontends/ui/src/lib/skills/types.ts`, and the mirror in
`features/skills/lib/agent-scope.ts`), and
`frontends/ui/drizzle/0081_grid_agents_researcher_rename.sql` moved the stored
rows. The alias is not decoration: an unknown name is IGNORED, and an allowlist
of only ignored names reads as absent — so dropping it would silently offer
every chat-scoped skill to deep research as well.

Every builtin declares `grid-agents`, and the value splits the corpus in two.

The five in `research/` and `synthesis/` declare `deep_researcher` **and nothing
else**. They are DeepAgents subagent skills: their instructions call `execute`,
read and write `/shared/` and return `ResearchNotes`, none of which exists in a
chat turn. That one key is what keeps Piloti from being
offered a procedure it cannot carry out.

The six in `bim/`, `oib/` and `presentation/` are chat skills and say so.
`ifc-spatial-reasoning` and the four `oib/` domain skills name both agents;
`diagrams` names **`researcher` alone**, and the reason is
worth stating because it looks like an omission. A builtin FILE does not reach
deep research through `grid-agents` at all: `resolve_served_skills` keeps only
BFF-served rows (`origin == "org"`), and the builtins reach deep subagents
through the collection assignment in `deep_research_skills` instead — which
today names `research` and `synthesis` and nothing else. So naming
`deep_researcher` on a file in a new collection would claim a channel that does
not exist. The four `oib/` skills carry it harmlessly; a skill added now should
not copy it without checking.

Since `grid-agents` is the ONLY thing doing the targeting,
`platform-skills.spec.ts` asserts every builtin still declares it. The BFF forwards platform metadata
The research and synthesis builtins declare `grid-agents: deep_researcher`
and nothing else. They are DeepAgents subagent skills: their instructions call
`execute`, read and write `/shared/` and return `ResearchNotes`, none of which
exists in a chat turn. That one key is what keeps Piloti
from being offered a procedure it cannot carry out. The OIB and BIM skills
name both agents, because the questions they are about get asked in chat.
`platform-skills.spec.ts` asserts every builtin still declares `grid-agents`. The BFF forwards platform metadata
**verbatim** on the resolve endpoint (an empty `metadata: {}` would merge over
the backend's own filesystem copy and erase this targeting), and the agent
filter applies to platform rows as well as org rows.

## Selection & progressive disclosure

Skill selection is **model-chosen, and only model-chosen**. Nothing can force a
skill onto a turn: not the request, not the deployment, not a job.

- Chat turns: `src/aiq_agent/turn/payload.py` parses `data_sources` out of the
  turn input and nothing else. The `skills` array it used to read is gone
  (`force_skills` with it), so a client that still sends one is ignored. The
  `/name` composer invocation below writes a MENTION into the message text
  instead — the model reads the mention and decides, exactly as it decides
  whether to search.
- Remote submissions: `/v1/internal/skills/submit` still takes a `skills` name
  list, for the log. The attached skill's BODY is already inside the composed
  `input` the BFF sends, so the run has the instruction without a tool call and
  the worker's agent state carries no force list. Agent selection follows the
  JOB's `output`, never anything read off the skill. Deep-research runs get
  their skills the deepagents-native way (see Config).
- Standing instructions are not skills. What must hold on every answer is
  prompt text: the platform prompt, and the office's own bounded block
  (`X-Grid-Org-Instructions` → `## Anweisungen des Büros`, rendered below the
  KV-cache boundary, never a source and never above the rules it may not
  override).

Progressive disclosure has exactly two levels:

- **L1 — the catalog.** One line per RESOLVED skill (`name: description`)
  under the system prompt's `## Available skills` heading, and nothing else —
  there is no second, "active" block any more, and nothing a person sets takes
  a row out. `grid-auto-invoke: false` used to; its author-facing switch is
  gone, so honouring the stored token would hide a skill from every turn with
  nobody able to bring it back. The key still parses on an old document and
  decides nothing. The block is pre-collated by the register layer
  (`piloti/register.py::_skills_block`, `deep_researcher/agent.py::_skills_block`)
  and renders via the runtime's `prompt_block()`; `None` renders no section.
- **L2 — the body.** The model must call the `use_skill` tool to load a
  body before following it. A failed lookup returns an error listing the
  available names, so a hallucinated skill name is self-correcting rather
  than a fatal turn.

**Every scaffolding string in the runtime is English**, and that is a decision
rather than an oversight. The one heading left was German once (`## Verfügbare
Skills`; its sibling `## Aktive Skills (vom Nutzer erzwungen)` is gone with
forcing). The agent answers in the
user's language, and that is decided per turn from the question — not baked into
the machinery — so a prompt that mixes German block headings into English
instructions is neither localised nor language-agnostic. It is also a country
coupling of exactly the kind `country-extensibility.md` exists to remove: text
that assumes Austria in a mechanism that has nothing to do with Austria.
Country- or language-specific wording belongs in `CountryProfile` or in an
authored skill body, never in string constants in `runtime.py`.

`SkillRuntime` (`src/aiq_agent/skills/runtime.py`) is **per run**
(ADR-0018 — never cached on a shared agent instance): it owns the activation
list, so `skills_activated` on the terminal frame records exactly which bodies
were delivered this run — and nothing else, because delivery is the only event
there is.

## Invoking a skill in chat (`/name`)

Typing `/` as the first non-whitespace character of a composer message opens a
picker of the skills this member may invoke; picking one inserts a `/name`
mention into the message TEXT, and that text is what is sent. Nothing rides
beside it on the wire: the model reads the mention in the question, sees the
skill's line in its catalog, and calls `use_skill` if it agrees the skill
applies.

- **Endpoint:** `GET /api/skills/invocable` → `listInvocableSkills`, filtered
  to enabled *offers* and org-authored skills a chat turn can actually run
  (`researcher`). Pipeline machinery is not in
  this list: it is resolved for every run anyway, and putting it in a `/` menu
  would hand somebody a name they cannot look up, edit or switch off. Deep-research
  skills stay out for the same reason they stay out of chat. Any org member
  may list: invoking a skill is *using* the product, not administering it
  (authoring stays `org:skills:manage`).
- **Level 1 only.** The picker shows name and description and nothing else.
  For the skills that *are* in the menu, that is exactly the metadata the
  agent is given at the start of a turn, so a description that fails to say
  when a skill applies is visibly unhelpful to both. Bodies are never fetched
  to draw it; they enter the conversation only when the agent calls
  `use_skill`.
- **Why only at the start of a message.** The trigger is deliberately narrower
  than `@`: slashes are ordinary punctuation in this domain (`12/05`,
  `OIB-RL 2/3`, `und/oder`, `m/s`, `/etc/hosts`), and a menu firing on those
  would interrupt someone writing a normal sentence about a Richtlinie. An
  invocation applies to the whole turn, so the front of the message costs
  nothing and removes the entire class of false positives.
- **The text IS the invocation.** Nothing structured leaves with the message,
  and the named skill is derived from the composer text on every render, so
  deleting the token removes the reference with no bookkeeping and nothing can
  drift from what the user sees. Mentions cannot do this (two people may share
  a display name); a skill name is unique and exact, which is what lets the
  text be the complete record. A leading slash that names no real skill is
  ordinary text: no chip, and nothing offering to remove a token that is part
  of the sentence.
- **Degradation.** With the feature off, or if the request fails, `/` is an
  ordinary character again. A successful empty answer still opens the panel —
  that panel is where the product explains what a skill is.

Files: `frontends/ui/src/features/skills/lib/slash-command.ts` (pure text
logic), `hooks/use-slash-command.ts` (composer behaviour),
`components/SlashCommandPicker.tsx` (the menu, deliberately the same keyboard
contract and panel as `MentionPicker`) and `components/InvokedSkillChip.tsx`
(the composer chip naming the attached skill and its description).

## Activation transparency (`skills_activated`)

The runtime records which skills were actually **loaded** — the ones invoked
via `use_skill`, in call order, deduped — and the agent lifts that list onto the
terminal `system_response_message` as `skills_activated`; the reconnect path
persists it into assistant-message metadata
(`docs/api/websocket-protocol.md`).

The UI renders it as a quiet disclosure under the answer
(`features/skills/components/SkillsUsedDisclosure.tsx`): nothing at all when
no skill was activated, one muted line when some were, opening to name them
and state the mechanism — every skill contributes its name and description to
the catalogue on every turn, and only the activated ones had their full
instructions loaded. That is the progressive-disclosure model shown at the
moment it becomes concrete, rather than explained in documentation nobody
reads. It is also the distinction worth surfacing: "this skill was available"
is not news, "this skill's instructions shaped this answer" is.

Descriptions are fetched only when the panel is opened. Paying for an
org-scoped read on every rendered answer to fill a panel almost nobody opens
would be precisely the eager loading the skills model exists to avoid. A row
whose skill has since been deleted keeps its name rather than vanishing — the
name is still a true record of what ran.

## Config

`configs/config_oib_openrouter.yml`, `shallow_research_agent` (the NAT
workflow YAML — NAT's own vocabulary for an agent config):

```yaml
skills_enabled: true        # default true; false disables the use_skill tool + catalog
skill_allowlist: []         # empty = every resolved skill is offered
```

Both are fields on `ResearchAgentConfig`. `use_skill` and the skill
index are bound on **every** turn, greetings included: there is no classifier
and no `requires_sources` gate in front of the answering agent any more
(ADR-0052), so whether a turn loads a skill is the model's call, pinned by the
prompt. The allowlist filters to the actual resolved set; an unknown name in it
is simply ignored (fail-open, so a typo never errors a turn).

The deep-research side is different by construction: it does NOT use the
`use_skill` tool or these config keys. Its skills are deepagents-native
(`deep_research_skills`, a `DeepResearchSkillsConfig` function-ref in the
config): per-agent skill *sources* wired through `SkillsMiddleware` with a
`FilesystemBackend` over `src/aiq_agent/skills/builtin/` and read-only
filesystem permission rules (`factory.runtime_skill_filesystem_permissions`).
The writer's BFF-served skills reach it the same way they reach chat: as the L1
catalog it may pick from, never as a body it was told to open.

## Data model (grid_app, Drizzle)

**Since migration 0086 the trigger and the attempt live in two tables of their
own: `task_definitions` (kind, plan, requester, `trigger` = manual | once |
schedule, and the schedule/due columns live per arm) and `task_runs` (one
attempt, including skipped/errored fires that never reached the agent; runner
fields from `job_runs`, lifecycle/filing/review from `tasks`).**
`frontends/ui/src/lib/db/schema/task-model.ts` declares them; `jobs`,
`job_runs` and `tasks` are LEGACY, read only by the 0086 backfill until
migration 0087 drops them. `conversations.job_id` was repointed to
`task_definitions.id` in 0086 (job ids were reused for their definitions).
The sections below still describe the shipped `skills` table and the pre-0086
shape of the others.

Five tables. `skills`/`jobs`/`job_runs` live in
`frontends/ui/src/lib/db/schema/jobs.ts`, created by
`frontends/ui/drizzle/0041_agent_skills.sql` as `skills`/`skill_schedules`/
`skill_runs` and reshaped by `0043_jobs.sql`; `0044_conversation_job_provenance.sql`
adds the link from a conversation back to the job that produced it, and
`0046_curated_skill_activations.sql` adds `curated_skill_activations`,
`0047_platform_skills.sql` adds `platform_skills`,
`0050_platform_skill_delivery.sql` adds its `delivery` column and
`0053_piloti_voice_standard_skill.sql` seeds the first `delivery: standard` row
(a seed, not a source of truth: `ON CONFLICT DO NOTHING`, so re-running
migrations cannot revert what the platform owner has since written) and
`0071_retire_piloti_house_skills.sql` deletes the two house rows again — guarded
on the md5 of the body each chain last wrote, so an owner-edited row survives.
`0088_platform_skills_drop_standard_delivery.sql` ends that line: every
surviving standard row becomes an offer, the CHECK narrows to `offer` and the
partial index goes. Its counterpart `0087_organization_instructions.sql` adds
`organization_instructions`, the tenant-side home for what the tier was misused
for (ADR-0060). Each
tenant table joins the tenant boundary with a `grid_secure_table()` line (ADR-0041) —
re-emitted by 0043 under the new names, because a rename carries the policy
along but leaves its stored predicate written against the old table name.
`0086_task_definitions.sql` adds the collapsed pair and re-secures them the same
way.

`skills` — the org toolbox
- `id` uuid PK, `organization_id` text NOT NULL (denormalized WorkOS org id,
  never a FK — ADR-0007)
- `name` / `description` / `body` — the SKILL.md contract, validated at the
  routes by the same rules the backend applies
- `metadata` jsonb NOT NULL default `{}` — the reserved keys are `grid-agents`
  (the one availability gate) and `grid-cards`; scheduling and output delivery
  are **not** here, they belong to the job
- `origin` text NOT NULL default `'org'` (`org` | `platform-clone`),
  `cloned_from` text (the platform name a clone came from)
- `enabled` boolean NOT NULL default true, author columns, timestamps
- Indexes: unique `idx_skills_org_name` on `(organization_id, name)` — one
  skill per name per org, and the point query the fire/resolve paths make —
  plus `(organization_id)`
- Platform-authored skills are **not** rows here — they are files
  (`builtin/**`) or rows of `platform_skills` (see Origins).

`platform_skills` — the fleet-wide catalogue
- `id` uuid PK, `name` text with a UNIQUE index (`idx_platform_skills_name`):
  the name is the key an organization's activation decision refers to, so two
  curated skills sharing one would make that decision ambiguous
- `description` / `body` / `metadata` — the same SKILL.md contract as an org row
- `published` boolean NOT NULL default **false** — a draft is invisible
  fleet-wide, which is what makes the dashboard usable as a writing surface
- `delivery` text NOT NULL default **`'offer'`** (migration 0050), constrained by
  `platform_skills_delivery_check` to `offer` and nothing else since 0088. The
  column is kept with one legal value rather than dropped: it still says
  something true — a curated skill is OFFERED — and a column with one legal
  value and no CHECK is a column that accepts the next typo. Orthogonal to
  `published`, and the two closed defaults mean different things: unpublished is
  *invisible*, `offer` *requires consent*
- No `organization_id`: one row reaches every tenant at once. Secured with
  `grid_secure_platform_table` — every tenant reads it, only the platform role
  writes it, so the fleet catalogue is an enforced boundary rather than a
  convention

`organization_instructions` — one standing instruction block per tenant (0087)
- PK `organization_id` text, `instructions` text, `updated_by` /
  `updated_by_email`, `updated_at`
- `organization_instructions_length` CHECK at **1500 characters** (`char_length`,
  not `octet_length` — the editor counts characters down and an umlaut must not
  cost two), and `organization_instructions_not_blank`, because a row that says
  nothing would encode a header carrying nothing. Clearing the text DELETES the
  row, so "never written" and "written, then emptied" are one state
- Its own table rather than a key in `organizations.settings`, for three things
  the jsonb bag cannot hold: the bound in SQL, attribution for "who told the
  agent to do that", and its own cache entry on the WS-upgrade hot path
- Secured with `grid_secure_table('organization_instructions',
  'organization_id = grid_current_org()')` and listed in `rls-coverage.spec.ts`
- It is **not a skill** and does not appear in any catalog: see ADR-0060

`curated_skill_activations` — an org's decision about one curated skill
- PK `(organization_id, skill_name)`, `enabled` boolean NOT NULL default false
- No row = the default, and for an offer the default is OFF
- `skill_name` is plain text, not an FK: its referent may be a file. A row
  naming a skill that no longer ships is inert, and survives if it returns

`jobs` — project-scoped prompt on a timer (was `skill_schedules`)
- `project_id` uuid NOT NULL → `projects.id` ON DELETE CASCADE,
  `organization_id` text NOT NULL (denormalized)
- `name` text, `prompt` text **NOT NULL** — the message the job fires, as if
  typed into a new chat. This is what the job IS. 0043 added it nullable,
  backfilled it from each row's pinned `skill_snapshot->>'body'` through a
  COALESCE chain (nothing guaranteed that key was present, and one malformed
  row would have aborted the migration) and only then set NOT NULL — a column
  default would have been a lie surviving into every future row
- `skill_name` text and `skill_snapshot` jsonb — the attached skill, **nullable
  as a pair**. `CHECK (skill_name IS NULL) = (skill_snapshot IS NULL)`
  (`jobs_skill_pair_check`) is in the database rather than the BFF because the
  invariant is about the row: a name with no body is unrunnable, a body from
  nowhere unattributable. The snapshot is `{name, description, body, metadata,
  origin}` copied at save time, so a run is a deterministic WYSIWYG copy that
  cannot drift when the skill is later edited — the workflows "compiled prompt"
  contract, mirrored as JSONB
- `output` text NOT NULL — `chat` | `deep-research`, the **user's** choice on
  the job; it picks the agent and decides whether the finished run becomes a
  conversation or a report. Was `execution`, denormalized from the skill's
  `grid-execution` metadata; same domain, same effect at fire time, only the
  source of the value moved
- `data_sources` jsonb — `string[] | null`. User-selected entries are
  **additional** sources; `knowledge_layer` (project documents + OIB base
  corpus) is always included and prepended on save (`withAlwaysOnKnowledge`),
  and enforced again at fire time so legacy rows are covered. `null` still =
  all sources available to the agent. Those documents plus the base corpus are
  the product's factual/normative basis — a run without them is never intended
- `enabled` boolean NOT NULL default true, `schedule_cron` (5-field, NULL =
  manual-only), `schedule_timezone` (IANA, default UTC), `next_run_at`
  (computed at save time; NULL when no cron or disabled), `last_run_at`,
  author columns, timestamps
- Indexes: `idx_jobs_project_id`, `idx_jobs_organization_id`, and the partial
  `idx_jobs_due` on `(next_run_at)` WHERE
  `schedule_cron IS NOT NULL AND enabled` — only rows that can ever fire are
  indexed, so the per-tick due probe stays a tiny scan. Partial indexes are
  not expressible in the Drizzle builder, so it lives in the SQL migration

`job_runs` (append-only) — submission history (was `skill_runs`)
- `schedule_id` uuid NOT NULL → `jobs.id` ON DELETE CASCADE, denormalized
  `project_id` / `organization_id`. **Deliberately not renamed to `job_id`**:
  that name is taken on this table by the backend async-job id, and a
  `job_runs_job_id_fkey` pointing at `jobs` would read as a foreign key on the
  wrong column. 0043 records this as a `COMMENT ON COLUMN`, because the next
  reader is looking at `\d+ job_runs`, not at migration history
- `job_id` text — backend async-job id; NULL when `skipped`/`error`
- `trigger`: `'manual' | 'schedule'`; `status`: `'submitted' | 'skipped' |
  'error'` — submission outcome only. Live job progress/results stay in the
  backend job store, joined by `job_id`
- `detail` text — skip reason (job cap, feature gate) or submission error
- `conversation_id` text — where an `output='chat'` run landed; NULL for
  deep-research, skipped/error, and pre-0043 runs. Composite FK to
  `conversations (id, organization_id)` (the house pattern from 0032), so a run
  cannot name another tenant's conversation, with `ON DELETE SET NULL
  ("conversation_id")` scoped to the one column — an unscoped SET NULL would
  try to null the NOT NULL `organization_id`. Deleting a conversation must not
  delete run history; the run survives, having forgotten where it landed
- `skill_snapshot` jsonb NOT NULL — the job's snapshot at fire time, so run
  history stays self-describing after the job is edited or purged. NOT NULL
  even though `jobs.skill_snapshot` is nullable: a skill-less job records `{}`
  here, so history keeps one shape to read (`emptySkillSnapshot()`)
- `triggered_by` — user id for manual runs, `'scheduler'` for cron
- Indexes: `idx_job_runs_job_created` on `(schedule_id, created_at DESC)` for
  the newest-first history, `(project_id)`, `(organization_id)`, and a
  standalone `(created_at)` the retention prune needs (the composite cannot
  serve it without a `schedule_id` predicate)

`conversations.job_id` uuid (migration 0044) — provenance, not ownership: the
job that produced this thread, or NULL when a person started it. See "Job
conversations" below.

**0043 renames, it does not recreate.** Every already-scheduled row keeps its
id, its cron and its attached skill, and the ids that `job_runs` and the
scheduler's claim already reference stay valid — a CREATE/COPY/DROP would have
thrown those away for no gain. `ALTER TABLE … RENAME TO` moves the table with
its data, policies, grants and indexes, but renames none of the indexes, the
primary key or the foreign keys, so 0043 renames each dependent object
explicitly; otherwise the Drizzle schema (which declares index names) and the
database would disagree and `\d jobs` would go on calling itself
`skill_schedules` in every constraint.

## BFF API

All routes are feature-gated (`requireSkillsEnabled`). Authorization is
enforced in the service, not the route (ADR-0017); the routes are thin
adapters. Every query is additionally org-filtered.

Org toolbox (`frontends/ui/src/app/api/skills/…`):

- `GET  /api/skills` — what the organization has: its own rows plus the
  platform's **offers** (each carrying the org's on/off decision), org
  rows shadowing an offer of the same name. Never the machinery. Any member
  may read.
- `POST /api/skills` — author a skill (`org:skills:manage`). Validates the
  name/description rules and the reserved `grid-cards` value against the
  model-facing card catalog. No name is reserved fleet-wide any more: an org row
  named after a platform offer shadows it, and the tenant's version is the one
  that runs. (`clonedFrom` is still accepted for compatibility but nothing sends
  it: the clone flow is gone.)
- `PATCH`/`DELETE /api/skills/{skillId}` — `org:skills:manage`.
- `PATCH /api/skills/curated/{name}` — switch a platform **offer** on or
  off for this organization, body `{ enabled }` (`org:skills:manage`).
  Addressed by NAME, not by id: a curated skill's id belongs to the platform
  catalogue, and handing it to a tenant would invite a PATCH against the
  fleet's copy. The service 404s any name that is not a published offer, so
  the machinery cannot be switched off by hand-crafting a request.

Platform catalogue (`frontends/ui/src/app/api/platform/skills/…`) — platform
owners only (ADR-0016), no per-org feature flag; this is the layer *under*
every tenant's skill list:

- `GET  /api/platform/skills` — the whole catalogue, drafts included, each row
  carrying its `delivery`.
- `POST /api/platform/skills` — add one. Created as a DRAFT and as an OFFER
  unless `published` / `delivery` say otherwise. A name that belongs to a builtin
  is refused: a curated skill shadowing the machinery would silently replace how
  deep research writes its report for every org that switched it on.
- `PATCH`/`DELETE /api/platform/skills/{skillId}` — edit (including publishing
  and withdrawing) or withdraw from the fleet. A withdrawal leaves activation
  rows alone, so re-creating the skill under the same name restores the fleet as
  it was. `delivery` takes one value, so there is no promotion to make: a
  published row is an offer, and each organization decides.
- `GET  /api/skills/invocable` — the `/name` picker's list (name +
  description only, chat-executable, enabled). Any org member.

Organization settings (`frontends/ui/src/app/api/organization/instructions`) —
not a skill route, and here because it is where forcing went:

- `GET  /api/organization/instructions` — the org's standing instruction block.
  Any member may read it: it shapes every answer they get, so it is not a secret
  from them, and the read is keyed by `session.organizationId`.
- `PUT  /api/organization/instructions` — write it (`org:settings:manage`, the
  same gate as `/api/organization/settings`). An empty body clears the block,
  which deletes the row. The service caps at 1500 characters, the CHECK caps
  again, and `server.js` sends the result on every WS upgrade as
  `X-Grid-Org-Instructions` (base64url) beside the project context.
- `GET  /api/skills/attachable?output=chat|deep-research` — the job builder's
  skill picker: the skills the chosen output kind's agent can run, resolved
  through the same one gate. Carries bodies, because the builder previews the
  composed fire prompt.
- `POST /api/skills/review` — ask the backend reviewer what is wrong with a
  draft. Deliberately looser validation than the create schema (the point is to
  review something not yet valid) and always 200 with `{ findings, error? }` —
  a review must never block a save.

Project jobs (`…/api/projects/[id]/jobs/…`, read = `project:view`, mutate/run =
`project:skills:manage` via `requireProjectAccess`):

- `GET`/`POST /api/projects/{id}/jobs` — list / create. `prompt` is required
  (1–8000 chars); `skillName` is optional — when given it is resolved (org row
  first, builtin fallback; unknown name → 404) and snapshotted, and name +
  snapshot are always written as a pair. `output` is a plain enum on the
  request, not something derived from the skill. Validates the cron (5-field,
  IANA timezone, minimum interval) and computes `next_run_at`. There is no
  longer any veto from the attached skill: whether something may run on a timer
  is a property of the job.
- `GET`/`PATCH`/`DELETE /api/projects/{id}/jobs/{jobId}` — PATCH re-resolves
  the snapshot and recomputes `next_run_at`. `skillName: null` detaches the
  skill; omitting it leaves the attachment alone.
- `POST …/{jobId}/run` — manual "Run now" through the shared fire path;
  409 when the job is disabled; a backend 429 (job caps) comes back as a
  `skipped` run rather than an error.
- `GET  …/{jobId}/runs` — run history, newest first.

Internal (shared-token, `internalApiRoute`, unreachable from outside the
compose network):

- `POST /api/internal/skills/fire` — body `{scheduleId}`; the scheduler's
  entry point. The path and the field keep their pre-jobs spelling on purpose:
  the scheduler container and the BFF deploy separately, so renaming the wire
  contract would fail every scheduled run in the window between the two
  deploys. `scheduleId` names a `jobs.id`. The route loads the job with no
  session (platform access, narrowly scoped to that lookup — everything the run
  then does is one organization's work and runs as that organization),
  re-checks `enabled` and the org's `skills` gate under flag enforcement
  (fail-closed, so a revoked flag pauses jobs with visible `skipped` runs),
  then fires.
- `GET /api/internal/skills/resolve?organization_id=…&agent=…` — the backend
  resolver's source for org skills. Note the **snake_case** query contract and
  that `agent` is optional but must be non-empty when present.

### The fire path

`fireJob(job, trigger, actor)` (`frontends/ui/src/lib/jobs/service.ts`) is the
single submission path for both manual and scheduled runs. Tenancy is derived
from the job row itself, and it never throws for a skip:

1. Build the run context in parallel — budget snapshot, effective model
   overrides (ADR-0014), the project's ordered collection scope, project
   context, Bundesland, **the project-memory digest** (ranked against the
   fire prompt, the way a chat turn's digest is ranked against its question)
   and **the organization's memory-reflection flag** — exactly what the
   interactive path attaches. The signed `X-Grid-Request-Context` envelope is
   built from those same values through the shared builder, so the job path's
   wire format cannot drift from the interactive one. The digest travels as
   the worker's FALLBACK: the worker fetches a live one first (a queued job
   may wait minutes) and keeps the fired one only when that fetch fails.
2. For an `output: 'chat'` job, create the conversation the run will land in
   (see below). Before submission, because the backend needs its id.
3. POST the backend `POST /v1/internal/skills/submit` with
   `input` = `buildFirePrompt({ prompt, skill })`, `skills` = the attached
   snapshot's name **or an empty list**, `output` — which selects the agent —
   and `conversation_id` when there is one.
4. Record a `job_runs` row: `submitted` (+ `job_id` + `conversation_id`),
   `skipped` (a 429 with `Retry-After` → detail) or `error`, and touch
   `last_run_at`. Context building sits inside the try, so a transient
   DB/WorkOS failure surfaces as an `error` run row rather than an unrecorded
   throw. A skip never throws: an occurrence is not retried before its next
   slot.

Admission caps (`GRID_MAX_ACTIVE_JOBS[_PER_ORG]`) therefore apply to scheduled
runs automatically, and every run — however triggered — is visible in history.

### The worker's side, and the outcome

Inside the run the worker places the job's project, organization and user
identity into its request context, the way the WebSocket upgrade does for a
chat turn, so every project-scoped tool (`remember` included) resolves the
same project a chat turn would; before this a deep-research run's `remember`
answered "no project in scope" every time. The reflection pass at the end of
a deep run compares the report against the live memory digest, and resolves
the reflection model from the worker's own config — the BFF evaluates the
flag, the worker knows the model.

When the run ends — success, failure or cancellation — the worker reports
the outcome to `POST /api/internal/jobs/[jobId]/outcome` by the backend job
id, only when it was the one that wrote the terminal status (a run the reaper
already finalized is reported by nobody). The BFF turns that into a
`job.completed` or `job.failed` inbox item for the job's creator, one row per
run, landing on the project's automation page. Best-effort by contract: the
run is already final in the job store, and a missed notification never
unmakes a good run.

### The fire prompt

`buildFirePrompt` is the job's prompt, trimmed, **plus** the attached skill's
name, description and full body under a `---` fence when a skill is attached.
With no skill the output is the prompt and nothing else — no
`Skill:`/`Beschreibung:` block and no dangling fences.

The builder shows that text as a WYSIWYG "what the agent receives" pane, so
there is a client mirror, `features/jobs/lib/fire-prompt-preview.ts`, that is a
byte-identical transcription of the server function.
`fire-prompt-preview.spec.ts` runs in the node environment, imports the real
`server-only` service and pins the two against each other, so one side cannot
change without the other. The backend's `input` ceiling is 48000 chars — sized
for the composed result, since either half alone fits under the 32000-char
skill-body limit but their sum need not — and an over-long prompt is a 422,
never a silent truncation. The BFF caps `prompt` at 8000 chars so a job
attaching the largest legal skill still fits.

### Job conversations (`output: 'chat'`)

A chat-output job materialises into a REAL conversation: a thread the team
opens, reads and keeps typing into, not a rendering of a report. The BFF
creates it at fire time (`createRunConversation`), threads the id to the
worker, and the worker writes the turn at completion.

The conversation id is minted exactly as the interactive path mints one —
`s_` + a uuid with hyphens as underscores — because that id doubles as the
session's Qdrant collection name (`lib/collection-scope.ts`,
`lib/proxy/collection-authz.ts` both key off the `s_` prefix).

Three properties, each forced rather than chosen:

- **`created_by` is the JOB'S OWNER**, a real user id, never `'scheduler'` and
  never synthetic. Four mechanisms read `conversations.created_by` as a person:
  the sharing roster lists the creator as a participant, the last-owner
  invariant needs a real user to hold that role, `attributeLegacyAuthor` names
  them as the author of pre-collaboration messages, and `recordAuditEvent`
  requires an actor with a `userId: string`. It is also the identity the run
  already carries, so this adds no attribution — it stops the conversation from
  disagreeing with the run.
- **`visibility: 'project'`**, not the `'private'` column default. ADR-0032
  made `private` the default so sharing is a deliberate act; this IS that act,
  made at schedule time by someone with `project:skills:manage` on a project
  whose runs are already readable to anyone with `project:view`. A private
  thread would 404 every colleague following the run-history link.
- **`conversations.job_id`** (migration 0044) is the provenance stamp — the
  only thing on the row that says "nobody typed this". It exists so a list can
  render the job's name and a job glyph instead of the owner's face, and so
  these threads can be kept out of the owner's personal sessions list (a weekly
  job is 52 of them a year) while staying fully openable by URL and from run
  history. Answering either question from `job_runs` would mean a join on the
  hottest list read in the product, per row, for a fact that never changes
  after insert. The column and the fire path that writes it are in place; the
  list rendering and the sessions-list filter that consume it are not shipped
  yet.

Both foreign keys are `ON DELETE SET NULL`: deleting a job must not delete its
output (those threads were read, replied to and shared), and deleting a
conversation must not delete run history. Neither side owns the other.

**Every conversation write is best-effort and can never fail a run.** A failed
create is logged and swallowed; the run then submits with no `conversation_id`
and its `job_runs` row records none, which is exactly the shape of every run
that predates the feature. The conversation is deliberately NOT cleaned up when
submission subsequently fails — a submit error is not proof the backend never
received the run (a timeout is the common case), and deleting the thread a run
is about to write into would destroy the output to tidy up a row.

## Backend internal route (Python, aiq_api)

`POST /v1/internal/skills/submit` (`aiq_api.routes.skills`) — guarded by
`GRID_INTERNAL_API_TOKEN` (constant-time compare, dev-default-token refusal
outside dev — the `maintenance.py` pattern; NOT on the external-path
allowlist). It wraps `submit_agent_job`, so admission control, cost tracking
and `job_access` ownership apply exactly like the public submit route; the
`skills` name list is recorded in the log and the attached skill's body rides
inside the composed `input`, so nothing is forced on the worker. Error mapping matches the public route: 429 + `Retry-After`,
409 duplicate, 503 scheduler-not-configured, 403 bad/missing token. Full
payload and response in `docs/api/python-endpoints.md`.

**Agent selection is deterministic from the JOB's output kind**, never from
anything read off the skill: `_OUTPUT_AGENT_TYPES` maps `chat` →
`researcher` and `deep-research` → `deep_researcher`, and `agent_type`
is an explicit escape hatch for future output kinds.

**Two spellings on the wire, for one deploy window.** The field is `output`;
`execution` is the pre-rename alias and is read only when `output` is absent.
The BFF and this service deploy separately, and a hard rename would 422 every
scheduled run in the window between the two deploys — the window nobody is
watching. Both are Optional in the schema, which leaves "neither" structurally
legal, so a model validator rejects that case as the 422 it always was rather
than letting an absent key become a `KeyError` (a 500 on a payload the caller
got wrong). When both arrive and disagree, `output` wins and the disagreement
is logged. Delete `execution` and the `resolved_output` fallback once every BFF
sending `output` is deployed.

**Both internal-token header spellings are accepted**
(`routes/internal_auth.py::_TOKEN_HEADERS`: `x-grid-internal-token` first, then
`x-internal-token`, with every candidate compared even after one matches so the
comparison count does not depend on which spelling arrived). This is a bug fix,
and worth remembering: the guard used to read `x-internal-token` **only**,
while every caller in the repo — the BFF's skill submit and model-config fetch,
and the nine Python clients under `src/aiq_agent` — sends
`x-grid-internal-token`. So `/v1/internal/skills/submit` 403'd every real
request and scheduled runs never worked in a deployment. Nothing caught it
because the two sides are tested separately and each test pinned its own
spelling, and because the ASGI envelope middleware
(`context_envelope._INTERNAL_TOKEN_HEADER_NAMES`) already accepted both — so a
request got far enough to look healthy before the route guard refused it.

### Writing the run into its conversation

`aiq_api/jobs/conversation_output.py` is the other half of the chat-output
path. When the finished run has a `conversation_id`, `write_job_turn` posts the
job's prompt as a `user` message and the report as an `agent_response`,
carrying the cards in metadata. A run with a run message writes its report
through the run report route instead, onto the block (ADR-0062).

- **Python never touches Postgres.** `grid_app` is single-writer and the BFF
  owns it, so this goes over `POST /api/internal/conversations/{id}/messages`
  with the service token, exactly as the memory-reflection step already does
  from inside a worker.
- **Order is by timestamp, not by insertion.** The reader sorts by `createdAt`
  and breaks ties on a random uuid, so the question is stamped one second
  earlier than the answer; otherwise two rows written in the same millisecond
  would display in a coin-flip order.
- **Message ids are deterministic** (`uuid5` over
  `grid:job:{conversation}:{job}:{role}`) and the internal route upserts with
  `onConflictDoNothing`, so a retried write is a no-op rather than a second copy
  of the answer.
- **Failure and cancellation write a short German notice** (`FAILURE_NOTICE` /
  `INTERRUPTED_NOTICE`, from the runner's `except` paths). The conversation is
  created when the job FIRES, before the outcome is known, so without this a
  failed run leaves a thread someone opens to find completely empty — which
  reads as a broken product rather than as a failed run. The interactive path
  never needs it: there is always a human on a socket watching it happen. The
  text is deliberately factual and short, and points at the run history for the
  real status, rather than maintaining a second error taxonomy that drifts from
  the first.
- **Nothing here may fail a run.** Every call is wrapped and logged; the report
  is already stored on the job, and the thread is a convenience layered on top
  of it.

### The task row (ADR-0051)

Every submitted run is also a **task** (`tasks`, `lib/tasks/`): the durable
unit of delegated work. `fireJob` inserts it beside the `job_runs` row with the
requester pinned (`jobs.created_by`, never the scheduler), the plan frozen
(prompt, skill snapshot, data sources) and the backend job id recorded. The
worker's outcome callback closes it (`succeeded` / `failed` / `interrupted`)
and, for a finished deep-research task, **files the report into the project as
the requester**: `lib/auth/pinned-session.ts` resolves that person's membership,
role and the organization's flags into a session, and `fileResearchReport` runs
exactly as it does on the interactive report GET, keyed on the same backend job
id, so the two paths collapse onto one document. A requester who left the
organization, lacks `project:documents:generate`, or whose organization has
agent-authored documents off is a `refused` filing recorded on the row — a
permission the person does not hold is not one the scheduler may borrow.

Review is a second axis on the row: `POST /api/projects/[id]/tasks/[taskId]/review`
with `{ decision: accepted | rejected, reason? }` (`project:edit`). A rejection's
reason is quoted into the next run of the same job as a `PREVIOUS_DECISIONS`
block on the fire prompt (`previousDecisionsBlock`), so what a person told
Piloti "no" about reaches the run rather than a log line.
`GET /api/projects/[id]/tasks` lists a project's tasks, newest first.

## Scheduler worker (`frontends/ui/scheduler/`)

Plain-Node worker (purger idiom: CommonJS, `postgres` client, `.spec.mjs`
tests), compose service `skill-scheduler` (container `grid-skill-scheduler`)
running `node scheduler/index.js` off the frontend image. It refuses to start
— clean log, exit 0 — unless the deployment gate is on
(`GRID_SKILLS_ENABLED=true` or `GRID_ENFORCE_FEATURE_FLAGS=true`), read
case-insensitively exactly as the BFF reads it, so `TRUE` cannot enable the UI
while silently no-op'ing this container.

Tick (default 30 s), with a reentrancy guard so a slow tick never overlaps the
next interval:

1. Claim, in one transaction:
   `SELECT id, schedule_cron, schedule_timezone FROM task_definitions WHERE
   trigger = 'schedule' AND enabled AND schedule_cron IS NOT NULL AND
   next_run_at <= now() ORDER BY next_run_at LIMIT $batch FOR UPDATE SKIP
   LOCKED`, compute each row's next occurrence **strictly in the future**
   (`cron-parser`, per-row timezone; misfires coalesce — no backfill) and
   `UPDATE task_definitions SET next_run_at = $next`. Commit.
   The WHERE clause must keep matching the predicate of the partial index
   `idx_task_definitions_due` for the due-scan to stay an index scan. A row
   whose cron is unparseable — impossible in principle, since cron is validated
   at save time — is disabled with a loud error and skipped, so one bad row can
   never wedge every subsequent due-scan.
2. THEN fire each claimed row: `POST
   {FRONTEND_INTERNAL_URL}/api/internal/skills/fire` with the shared internal
   token (`x-grid-internal-token`), concurrently (rows cluster on popular slots
   like daily-at-9, and sequential 30 s-timeout fires would let one slow BFF
   hop stall the tick). A 200 is not always a fire — the BFF answers
   `{fired:false, reason}` for disabled or gated rows, and those are logged as
   skips so operators see them. Fire failures are logged loudly and swallowed;
   the BFF records run rows, and if the BFF itself was unreachable the
   occurrence is missed once and the next occurrence heals it (ADR-0023 risks).
3. Retention: `DELETE FROM task_runs WHERE created_at < now() - interval
   '$GRID_SKILL_RUNS_RETENTION_DAYS days'` (batched by id-subselect so each
   statement locks a bounded set). The definition survives its pruned runs, so
   a schedule keeps firing after its oldest attempts age out.

Claiming advances the job **before** firing, which is what makes a run
at-most-once per occurrence across replicas and crashes.

The container, its compose service (`skill-scheduler`) and its environment
variables keep their skill-era names. They were never product surface, and
renaming them is a deployment change with no user-visible gain.

## Cron semantics

- 5-field cron, validated at save time in the BFF with `cron-parser`.
- Per-job IANA timezone (DST handled by the library).
- Minimum interval between occurrences: `GRID_SKILL_MIN_INTERVAL_MINUTES`
  (default 15) — enforced at save time by sampling successive occurrences.
- **No skill can veto a schedule.** `grid-schedulable` is gone: whether
  something may run on a timer is a property of the job, not of a skill that
  knows nothing about time (`resolveScheduleInputs`, `lib/jobs/service.ts`).

## Environment variables

| Variable | Service | Default | Purpose |
|---|---|---|---|
| `GRID_SKILLS_ENABLED` | frontend, skill-scheduler | `false` | Dark-launch fallback gate while flags are unenforced; also the scheduler's start gate |
| `GRID_SKILL_SCHEDULER_POLL_MS` | skill-scheduler | `30000` | Tick interval |
| `GRID_SKILL_SCHEDULER_BATCH` | skill-scheduler | `20` | Max claims per tick |
| `GRID_SKILL_MIN_INTERVAL_MINUTES` | frontend | `15` | Minimum cron cadence accepted at save time |
| `GRID_SKILL_RUNS_RETENTION_DAYS` | skill-scheduler | `90` | Run-history retention |
| `GRID_SKILLS_CACHE_TTL_SECONDS` | aiq-agent | `60` | Backend org-skill resolution cache TTL (ADR-0020) |

(Existing: `GRID_APP_DATABASE_URL`, `FRONTEND_INTERNAL_URL`,
`GRID_INTERNAL_API_TOKEN`, `BACKEND_URL` are reused, not new.)

The workflow-era names (`GRID_WORKFLOWS_ENABLED`,
`GRID_WORKFLOW_SCHEDULER_POLL_MS`, `GRID_WORKFLOW_SCHEDULER_BATCH`,
`GRID_WORKFLOW_RUNS_RETENTION_DAYS`, `GRID_WORKFLOW_MIN_INTERVAL_MINUTES`) are
**not** read as fallbacks: they gated a feature that never shipped enabled, so
there is no deployment to ease off them.

## UI

**Two project sections, not one.** The project rail carries a flag-gated
`skills` entry (`G` then `W`) and, next to it, a flag-gated `jobs` entry
(`G` then `J`) — both under the same `showSkills` gate in
`components/shell/project-sections.ts`, because they ship together and a job
builder whose skill picker resolves nothing is not worth having on its own.
They are separate pages because they answer different questions: the toolbox is
organization-wide ("what procedures do we have"), jobs are project-scoped
("what should run, and when").

- `app/app/projects/[id]/skills` — the org toolbox **alone**
  (`features/skills/components/skills-panel.tsx` → `skill-toolbox.tsx`,
  `skill-editor-dialog.tsx`). Read-only without `org:skills:manage`.
- `app/app/projects/[id]/automation?tab=schedule` — the project's schedules
  (`features/jobs/components/schedule-panel.tsx`, `schedule-timetable.tsx`,
  `schedule-card.tsx`, `schedule-detail.tsx`, `schedule-wizard.tsx`,
  `job-run-history.tsx`). The tab stacks the WEEK GRID over the schedule cards:
  the grid answers how the week is arranged (what collides, what is empty), the
  cards what each schedule is. The wizard replaces the list while creating or
  editing one — four steps, one required decision each, with the next real fire
  times on the timing step. `app/app/projects/[id]/jobs` still redirects here.
  Managed with `project:skills:manage`.

Both pages use the same server shell (session → flag `notFound()` →
`requireProjectAccess` → project lookup → capabilities). Org skill authoring
and job management are independent permissions, so each capability is computed
by the page and passed down.

Run history rows carry the **live** job status, not just the submission badge:
the history joins its rows against
`GET /v1/jobs/async/jobs?project_collection=<proj_…>` — the same list the
History page uses — and shows `Queued / Running / Completed / Failed /
Cancelled`, repeating every 10 s while a run is still active. Best-effort:
without the join (backend unreachable, run outside the lookup window) the row
falls back to its submission badge. The row's action follows that status
(running → `?job=<id>&tab=tasks`, completed → `?job=<id>`, failed/cancelled →
`?job=<id>&tab=thinking`), and "Run now" opens the history and offers a *View
progress* action into the live job.

A **deep-research** run has no owning conversation, so the research panel
attaches to the job without writing banners or error cards into whatever chat
thread happens to be open; TasksTab's outcome notice reports how the run ended
instead. A **chat** run does have one, and the run row carries its id
(`conversationId` on `adapters/api/jobs-client.ts`) — the handle a link into
the finished thread is built from. The thread itself is an ordinary
project-visible conversation today: it is reachable from the project's chat and
history surfaces, and the run-history link and job-glyph rendering that
`conversations.job_id` was added for are not shipped yet.

## Tests

- `tests/aiq_agent/skills/` — model validation, builtin discovery, resolver
  caching/shadowing/fail-open (including the resolve query contract: URL,
  token header, both param cases), runtime prompt/tool wiring, and the rule
  that nothing may require a skill: `test_runtime.py` pins that the runtime
  offers and cannot require, that a `standard` marker on the payload is an
  ordinary catalog entry, and that only a delivered body counts as activated.
- `tests/aiq_agent/turn/test_payload.py` and
  `tests/aiq_agent/turn/test_payload_parsing.py` — the envelope parsing,
  including that a `skills` array from an older client is dropped rather than
  obeyed.
- BFF vitest, toolbox: `lib/skills/service.spec.ts` (authz, tenant filters,
  snapshot and targeting semantics — pinned against the Python cases — plus the
  `a published platform row, after the standard tier was retired` block, which
  asserts that such a row is an ordinary offer: it starts off, an org row of the
  same name shadows it, a job may snapshot it, and nothing marks it on the wire),
  `lib/skills/platform-service.spec.ts` (the closed `delivery` default and
  editing a row without touching the document),
  `lib/skills/types.spec.ts`, `lib/skills/platform-skills.spec.ts` (which
  asserts every builtin still declares `grid-agents`, now the only thing
  keeping them out of chat), `features/skills/lib/slash-command.spec.ts`,
  `agent-scope.spec.ts`, `card-catalog.spec.ts`, `skill-document.spec.ts` and
  `components/skills-transparency.spec.tsx`.
- BFF vitest, jobs: `lib/jobs/service.spec.ts` (the fire path, the skill pair,
  the conversation creation and its best-effort contract),
  `lib/jobs/types.spec.ts`, `lib/jobs/schedule.spec.ts` (cron + min interval +
  timezone), `lib/jobs/backend-client.spec.ts`, and
  `features/jobs/lib/fire-prompt-preview.spec.ts` — which imports the real
  server builder and pins the client mirror byte-for-byte against it.
- The feature-gate spec (`isSkillsEnabled` / `requireSkillsEnabled`, including
  the dark-launch property) covers both surfaces: jobs ride the same `skills`
  flag.
- Scheduler: `.spec.mjs` unit tests for next-occurrence computation, misfire
  coalescing, claim/advance SQL (mocked sql), and the start gate.
- Backend pytest: `test_skill_submit.py` (token guard 403/503 dev-default,
  payload validation including the `output`/`execution` window, admission-error
  mapping, `submit_agent_job` call shape, external allowlist non-exposure),
  `test_job_conversation_output.py` (turn ordering, deterministic message ids,
  notices, and that a write failure never propagates) and
  `test_skill_review.py`.
