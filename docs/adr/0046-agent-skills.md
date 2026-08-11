# ADR-0046: Agent skills — user-selected, progressive-disclosure instruction packages

- **Status:** Proposed
- **Date:** 2026-08-10
- **Deciders:** Platform
- **Related:** ADR-0018 (per-run state), ADR-0020 (Dragonfly shared cache),
  ADR-0022 (org BYOK), ADR-0023 (Workflows — **superseded by this ADR**),
  ADR-0027 (platform workflow templates — **superseded by this ADR**),
  ADR-0026 (unified source-kind model)

## Context

The agent needs reusable, versionable instruction packages ("skills") that
extend what it knows how to do — analysis recipes, report formats,
domain-specific procedures. Two prior mechanisms shaped the design space:

1. Deepagents ships a skill substrate (`SKILL.md` files under
   `deep_researcher/skills/<collection>/<name>/`), consumed through
   `SkillsMiddleware` with a `FilesystemBackend`. It is per-agent *sources*:
   the skill filesystem is offered to the model as tool content, and skill
   application is the model's own choice.
2. The workflow scheduler (ADR-0023) fired scheduled deep-research runs but
   had no notion of skills at all. That feature is superseded here and has
   been removed: a skill schedule is what a saved brief was, and the
   skill-scheduler is that scheduler under a name that matches what it fires.

Two forces drove a new design:

- **Selection must be user-driven, not model-driven.** A scheduled run or a
  chat envelope that names a skill ("run the forecast-analysis skill") makes
  a *user/operator decision* about which procedure applies. Letting the model
  pick skills from a catalog is a weaker contract: it can silently skip the
  requested procedure. This mirrors how `data_sources` already works — the
  request names them, the agent does not.
- **Prompt size must stay bounded.** Inlining every skill body into the
  system prompt would blow the context window as the catalog grows.
  Progressive disclosure — one line per skill in the prompt, full body only
  on demand — keeps the prompt constant-size in the number of skills.

The existing deepagents mechanism cannot satisfy either force: it does not
parse a forced skill list, and it offers the whole skill filesystem to the
model rather than a catalog the model opts into.

## Decision

We will build a GRID-owned skills engine for the chat (`shallow_researcher`)
side and keep the deepagents-native mechanism for deep research.

**Skill model.** A skill is a `SKILL.md` with YAML frontmatter
(`src/aiq_agent/skills/models.py`), the agentskills.io contract validated
**strictly**: name (1–64 lowercase hyphenated, must match the directory name
for filesystem skills), description (1–1024 chars), body, optional
license/compatibility/allowed-tools, and reserved GRID metadata keys
(`grid-execution` ∈ `chat`|`deep-research`, `grid-agents`, `grid-schedulable`,
`grid-cards`). An invalid builtin SKILL.md is a deployment error, never a
silent skip.

**Origins and resolution.** Two origins: **builtin** (shipped under
`src/aiq_agent/skills/builtin/<collection>/<name>/SKILL.md`, discovered
deterministically) and **org** (BFF-served rows from the `skills` table via
the internal `GET /api/internal/skills/resolve` endpoint). An org row whose
name matches a builtin **shadows** it, mirroring BYOK's org-over-deployment
ordering (ADR-0022). `SkillResolver` merges both per organization, caches the
org set in the shared Dragonfly/Redis cache (ADR-0020) keyed
`skills:{org}:{agent}` for `GRID_SKILLS_CACHE_TTL_SECONDS` (default 60s), and
fails open to the builtin set on any fetch/validation error — skills are an
additive capability and must never take chat down.

**Selection is user-driven.** `_extract_query_and_sources` /
`_extract_query_from_text` parse a `skills` array out of the chat envelope,
exactly mirroring `data_sources`. `/v1/internal/skills/submit` carries
`force_skills` for scheduled/manual runs. Unknown names are dropped silently
— a typo never errors a turn. Skill application is a *request decision*, not
a model decision.

**Invocation is `/name` in the composer.** The `skills` envelope field needs a
way in from a conversation, and it is a slash command: typing `/` as the first
non-whitespace character of a message opens a picker of the skills this member
may invoke (`GET /api/skills/invocable`), and sending carries the chosen name
as `skills: [name]`. Three decisions inside that:

- **Only the message's opening token triggers it.** Deliberately narrower than
  `@`. Slashes are ordinary punctuation in this domain (`12/05`, `OIB-RL 2/3`,
  `und/oder`, `m/s`, file paths), and a menu that fired on those would
  interrupt someone writing a normal sentence. An invocation applies to the
  whole turn, so the front of the message costs nothing and removes the entire
  class of false positives instead of filtering them.
- **The picker shows L1 and nothing else.** Name and description — the same
  text the model gets at turn start. The menu a person reads and the catalogue
  the model reads being identical is what makes a description that fails to say
  *when* a skill applies visibly unhelpful to both, which is the feedback a
  skill author needs. Bodies are never fetched to draw a menu.
- **No invocation state.** The invoked skill is derived from the composer text
  on every render, so deleting the token removes the invocation and nothing can
  drift from what the user sees. Mentions cannot do this (two people may share
  a display name); a skill name is unique and exact, so the text is a complete
  record.

Consequently `force_skills` no longer depends on the intent classifier: gating
the `use_skill` tool on `requires_sources` alone made forcing a no-op on
exactly the short, imperative messages people type after a slash command.

**Activation is shown, not just recorded.** `skills_activated` rides the
terminal websocket frame into the UI and renders as a quiet disclosure under
the answer: nothing when no skill was activated, one line when some were,
opening to name them and state the mechanism. The moment that distinguishes a
skill from a prompt is the agent deciding to pull a body into context, and it
was previously invisible. Showing it teaches the progressive-disclosure model
at the point where it becomes concrete rather than in documentation nobody
reads. Descriptions for that panel are fetched only on expand — paying an
org-scoped read on every rendered answer to fill a panel almost nobody opens
would be the eager loading this design exists to avoid.

**Authoring is the document, not a form over it.** The org editor writes the
three fields and the reserved metadata, but it shows the `SKILL.md` those
fields produce, split at the progressive-disclosure seam (frontmatter labelled
"always loaded", body "loaded on activation"), and it renders that document
from the *same* assembly function the save uses, so the preview cannot drift
from what is stored. Three consequences follow:

- **The body gets a real Markdown editor** (`@uiw/react-md-editor`, MIT), with
  the preview pane rendered through the app's own `MarkdownRenderer` rather
  than the library's — a skill body *is* Markdown, and the surface that writes
  it should agree with the surface that renders it.
- **The description field states the mechanism.** It is the only text an agent
  reads before deciding to load a skill, so the field says so and shows its
  1024-character budget while it is being written, rather than rejecting it
  afterwards.
- **The whole document is editable, folded away under "advanced".** Skills
  arrive as files and as pastes from agentskills.io, and retyping one field by
  field is busywork. `parseSkillDocument` is the inverse of the renderer and is
  round-trip-tested against it; applying is explicit (a draft, then a button)
  because a keystroke-level sync would let a half-typed `name:` clear a field,
  and frontmatter keys this product cannot store are named rather than dropped
  in silence.

**`grid-cards` is a preference, not a contract.** A skill may name the output
card types it would rather produce; the value is a comma-separated list of
generated card `type`s, SYSTEM cards excluded, and it reaches the agent as a
preference in the loaded body. Absent means no preference — an empty
`grid-cards:` line would read as a setting the author has to understand rather
than one they never touched.

**One agent vocabulary.** Targeting uses the `AGENT_REGISTRY` identifiers
`shallow_researcher` / `deep_researcher` everywhere — frontmatter, resolver,
BFF. Two spellings for one agent (`deep_research_agent` vs. `deep_researcher`)
meant a `grid-agents` value that was correct in one file and inert in the
other. The five builtin skills declare their own
`grid-execution: deep-research` + `grid-agents: deep_researcher`, and the BFF
forwards platform metadata verbatim, so targeting travels with the skill
instead of being asserted by whoever serves it.

**Progressive disclosure, two levels.** L1 is the catalog: one
`- \`name\`: description` line per resolved skill in the system prompt
(`## Verfügbare Skills`), plus a `## Aktive Skills (vom Nutzer erzwungen)`
block for forced names. L2 is the body: the model must call the `use_skill`
tool to load a body before following it; unknown names return an error
listing the available skills, so a hallucinated name is self-correcting.
Both blocks render from the per-run `SkillRuntime`; `None` renders no section.

**Per-run runtime (ADR-0018).** `SkillRuntime` owns the forced/activated name
lists for one run and is never cached on a shared agent instance. Its
`use_skill` closure captures the runtime, so concurrent runs over the same
resolved set never share activation state. `skills_activated` (forced first,
then invoked, deduped) surfaces on the terminal frame.

**Config.** `shallow_research_agent` in the NAT workflow YAML gains
`skills_enabled` (default `true`) and `skill_allowlist` (default empty =
every resolved skill). Both apply only on research turns
(`requires_sources=True`); meta/conversational turns keep the interaction-only
tool partition and never load skills.

**Deep research stays deepagents-native.** The deep researcher's skills come
from `DeepResearchSkillsConfig` (a `deep_research_skills` config function-ref)
wired through `SkillsMiddleware` + `FilesystemBackend` with read-only
filesystem permissions. `force_skills` is never passed to deep research — the
chat orchestrator drops it. Two engines exist because their constraints
differ: deep agents run sandboxed filesystem tools natively, while the chat
side needs prompt-level catalogs and request-driven forcing. The skill model
and strict validation are shared.

## Consequences

### Positive

- Request-driven selection: "run the forecast-analysis skill" is a contract
  the agent cannot silently skip; forced skills are visible on the wire
  (`skills_activated`), not inferred.
- Prompt size is constant in the number of skills; bodies load only on demand.
- Org skills reach tenant customization without touching the deployment;
  org-over-builtin shadowing matches the BYOK ordering users already know.
- Fail-open resolution keeps chat up when the BFF is down; the strict model
  contract catches malformed skills at deploy time, not mid-turn.
- Per-run runtime aligns with ADR-0018: no shared mutable activation state.
- One affordance covers invocation and authoring feedback: the `/` menu is the
  catalogue, so an unhelpful description is discovered by the person best
  placed to fix it.
- Activation is auditable from the answer itself, so "did the skill actually
  run?" stops being a question only a log can answer.

### Negative

- Two skill mechanisms (chat `use_skill` vs. deepagents sources) instead of
  one; a skill author must know which surface a skill targets
  (`grid-execution`).
- The catalog is only as good as descriptions: a poor L1 line hides a skill
  from the model (mitigated by forced selection, which bypasses the catalog).

### Risks

- **Prompt-injected skill forcing.** A chat envelope's `skills` array can
  force activation of any resolved skill. Bounded by: skills are vetted
  instructions, not code; org skills are validated against the same strict
  contract; and the `use_skill` tool only returns the body — it cannot read
  arbitrary files. Scheduled/manual runs go through the token-guarded submit
  route.
- **Org skills cache staleness.** Up to `GRID_SKILLS_CACHE_TTL_SECONDS` (60s)
  between a BFF edit and the backend seeing it; bounded and documented, and
  the cache is shared (ADR-0020), so replicas converge together.
- **Description drift.** A renamed skill leaves stale `skills:` mentions in
  requests; fail-open means they no-op, which is visible on the wire but not
  loud. The `use_skill` error message lists available names to self-correct.

## Alternatives Considered

- **Model-selected skills (catalog + "choose skills" instruction)** — rejected:
  the model could skip a user-requested procedure; selection belongs to the
  request, exactly as with `data_sources`.
- **Inline all skill bodies in the system prompt** — rejected: unbounded
  prompt growth; defeats the progressive-disclosure point.
- **Reuse deepagents `SkillsMiddleware` for the chat side** — rejected: it
  offers the skill filesystem as tool content rather than a catalog the model
  opts into, and has no request-driven forcing.
- **One engine for both sides** — rejected: the chat side needs prompt
  catalogs + request forcing; the deep side runs sandboxed filesystem tools
  natively. Forcing one engine onto both would distort one of them.
- **A `/` menu that opens anywhere in the message** (the `@` behaviour) —
  rejected: false positives on ordinary German punctuation, for no gain, since
  an invocation applies to the whole turn anyway.
- **Remembering the invoked skill as composer state** — rejected: the token
  stays editable in a plain textarea, so state and text would drift; the text
  is the record.
- **Always showing which skills were available** — rejected as noise: the
  disclosure reports what was *loaded*, because availability is the constant
  and activation is the event.

## Open Questions / Follow-ups

- Embeddings/execution sandboxes for org skills (Modal token env vars exist;
  execution is not yet wired).
- Whether `grid-execution: chat` skills should also be surfaced to the deep
  researcher's writer — currently they are not.
- Scheduler-side per-skill `allowed_tools` enforcement is declarative today;
  enforcement semantics for the `use_skill` path are follow-up.

## References

- `docs/architecture/agent-skills.md` (subsystem doc)
- `docs/api/python-endpoints.md` (`/v1/internal/skills/submit`)
- `docs/api/bff-routes.md` (`/api/internal/skills/*`, `/api/skills/*`)
- `docs/api/websocket-protocol.md` (`skills` on the message envelope,
  `skills_activated` on the terminal frame)
- ADR-0023 / ADR-0027 (Workflows and its template gallery, superseded here)
- agentskills.io format spec (SKILL.md frontmatter contract)