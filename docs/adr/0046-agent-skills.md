# ADR-0046: Agent skills — user-selected, progressive-disclosure instruction packages

- **Status:** Proposed
- **Date:** 2026-08-10, amended 2026-08-11
- **Deciders:** Platform
- **Related:** ADR-0018 (per-run state), ADR-0020 (Dragonfly shared cache),
  ADR-0022 (org BYOK), ADR-0023 (Workflows — **superseded by this ADR**),
  ADR-0027 (platform workflow templates — **superseded by this ADR**),
  ADR-0026 (unified source-kind model), ADR-0032 (shareable resource model),
  ADR-0041 (row-level security)

> **Amended 2026-08-11, in place** — this ADR is still Proposed, so it is
> corrected rather than superseded. Three things changed, and one of them is a
> reversal that is deliberately still written down instead of edited away:
>
> 1. **`grid-execution` as an availability gate was a mistake and was reverted.**
>    See "One agent vocabulary, and one gate" — the reversal is the most
>    instructive paragraph in this document, so it stays.
> 2. **`grid-execution` and `grid-schedulable` left the skill model entirely.**
>    A skill declares who may use it and which cards it prefers; when and how a
>    run happens belongs to the thing that schedules it.
> 3. **Schedules became jobs.** A job is a prompt on a timer that MAY attach a
>    skill (migrations 0043/0044). New sections: "A job is a prompt on a timer",
>    "A chat job lands in a real conversation" and "The wire rename is tolerated
>    for one deploy window".

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
   been removed: a job is what a saved brief was, and the `skill-scheduler`
   container is that scheduler, claiming due rows out of `jobs` instead of out
   of `workflows`.

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
license/compatibility/allowed-tools, and exactly two reserved GRID metadata
keys — `grid-agents` (who may use it) and `grid-cards` (which output cards it
would prefer). An invalid builtin SKILL.md is a deployment error, never a
silent skip.

A skill therefore says **nothing about time and nothing about output format**.
`grid-execution` and `grid-schedulable` used to be reserved here as well; both
were removed (see "A job is a prompt on a timer"). They are not rejected —
they are simply unreserved, so a stored org row or a pasted SKILL.md still
carrying one keeps it as ordinary free-form metadata and nothing reads it.
Rejecting them would turn a deployed row into a validation error at read time
and take a working skill out of the toolbox to punish a key that costs nothing
to ignore.

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
`force_skills` for job runs — an **empty list** when the job attaches no skill,
in which case the prompt runs alone. Unknown names are dropped silently — a
typo never errors a turn. Skill application is a *request decision*, not a
model decision.

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

**One agent vocabulary, and one gate.** Targeting uses the `AGENT_REGISTRY`
identifiers `shallow_researcher` / `deep_researcher` everywhere — frontmatter,
resolver, BFF. Two spellings for one agent (`deep_research_agent` vs.
`deep_researcher`) meant a `grid-agents` value that was correct in one file and
inert in the other. The five builtin skills declare `grid-agents:
deep_researcher` and nothing else, and the BFF forwards platform metadata
verbatim, so targeting travels with the skill instead of being asserted by
whoever serves it.

`grid-agents` is the ONLY thing that narrows a skill's audience, and it is the
only thing that ever may be. The rule is written twice — `_skill_applies_to_agent`
in `src/aiq_agent/skills/resolver.py` and the module-private `skillTargetsAgent`
in `frontends/ui/src/lib/skills/service.ts` — as a deliberate contract pair,
pinned against the same cases on both sides. Absent means every agent; names
matching no known agent are ignored rather than obeyed, so one typo cannot
delete a skill from every agent at once.

**This reverses an earlier decision in this ADR, and the reversal is the point.**
`grid-execution` briefly gated availability too. It answered a different
question — "when this is fired on a timer, do I get a chat or a report" — and
wiring an *output format* into an *availability rule* meant that choosing
`deep-research` silently deleted the skill from the chat agent, and choosing
`chat` deleted it from the deep researcher. Nothing in the product said so: the
skill simply stopped appearing in the other surface, with no error, no log a
user could see, and a plausible-looking frontmatter line that read like a
routing hint. The general lesson, and the reason this paragraph survives rather
than being edited out: a key that answers "what comes out" must never be read
as "who may run it". A skill that genuinely cannot run somewhere says so with
`grid-agents`, in so many words, which is exactly what the five builtins do —
their instructions call `execute` and write `/shared/`, neither of which exists
in a chat turn. Because that key is now load-bearing on its own,
`platform-skills.spec.ts` asserts every shipped builtin still carries it: losing
it would start offering a `/shared/`-writing procedure in chat, and nothing else
in the build would notice.

**A job is a prompt on a timer.** The scheduled object is not a skill and never
was. It is a *prompt* — what a person would have typed into a new thread — that
MAY attach a skill on top, exactly as typing `/name` before that message would
attach it. That is the whole relationship, and it replaces the earlier framing
("a schedule fires one named skill"), which made the skill mandatory, derived
the prompt from it, and left "ask this question every Monday" unexpressible
without first inventing a skill nobody wanted.

Concretely (migration `0043_jobs.sql`, schema `lib/db/schema/jobs.ts`):

- `skill_schedules` → `jobs`, `skill_runs` → `job_runs`, by **RENAME rather
  than recreate**: every already-scheduled row keeps its id, its cron and its
  attached skill, and the ids that run history and the scheduler's claim
  already reference stay valid. A rename carries data, policies, grants and
  indexes but renames none of the indexes or constraints, so each of those is
  renamed explicitly in the same transaction — otherwise `\d jobs` would go on
  calling itself `skill_schedules` in every constraint.
- `jobs.prompt` is **NOT NULL** — it is what a job now IS. It was added
  nullable, backfilled from each row's pinned `skill_snapshot->>'body'` (with a
  COALESCE chain, because nothing in the database guaranteed that key was
  present) and only then made NOT NULL. A column default would have been a lie
  that survived into every future row.
- `skill_name` and `skill_snapshot` are nullable **as a pair**, enforced in the
  database by `CHECK (skill_name IS NULL) = (skill_snapshot IS NULL)`
  (`jobs_skill_pair_check`). A name with no body is unrunnable and a body from
  nowhere is unattributable; the invariant is about the row rather than about
  one writer of it, so it lives in Postgres and not in the BFF.
- `execution` → `output`, same `chat` | `deep-research` domain, same job at fire
  time (it picks the agent). Only the *source* of the value moved: from a
  denormalised copy of a skill's metadata to a column the user chooses.
  "Output" is what they are actually choosing — a conversation they can
  continue, or a report.
- `job_runs.schedule_id` was deliberately NOT renamed to `job_id`: that name is
  taken on the same table by the unrelated backend async-job id, and a
  `job_runs_job_id_fkey` pointing at `jobs` would read as a foreign key on the
  wrong column. Recorded as a `COMMENT ON COLUMN`, because the next reader is
  looking at `\d+ job_runs`, not at migration history.

The fire prompt follows from this: it is the job's prompt, with the attached
skill's body appended only when a skill is attached — no `Skill:`/`Beschreibung:`
block and no dangling fences for a plain prompt (`buildFirePrompt`,
`lib/jobs/service.ts`). Because the builder previews that text as WYSIWYG, the
client mirror (`features/jobs/lib/fire-prompt-preview.ts`) is a byte-identical
transcription and a spec pins the two against each other; the backend's pinned
`input` ceiling (48000 chars) is sized for the composed result rather than for
either half.

**A chat job lands in a real conversation.** An `output: 'chat'` run
materialises into a thread the team opens, reads and keeps typing into — not a
rendering of a report. The BFF creates that conversation at fire time (before
submission, because the backend needs its id), threads the id through the
submit payload to the worker, and the worker writes the question and the answer
into it at completion over the internal messages route
(`aiq_api/jobs/conversation_output.py`) — Python never touches Postgres.

Three properties of that conversation, each forced rather than chosen:

- **`created_by` is the JOB'S OWNER — a real user id, never `'scheduler'` and
  never synthetic.** Four mechanisms read `conversations.created_by` as a
  person, and a synthetic id breaks all four: the sharing roster lists the
  creator as a participant, the last-owner invariant refuses to leave a
  resource ownerless and needs a real user to hold that role,
  `attributeLegacyAuthor` names them as the author of pre-collaboration
  messages, and `recordAuditEvent` requires an actor with a `userId: string`. A
  conversation owned by nobody is one nobody can act as, that notifies nobody,
  and that cannot be audited. It is also the identity the run already carries
  (`user_id` on the payload and in the signed context envelope), so this adds
  no attribution — it stops the conversation from disagreeing with the run.
- **`visibility: 'project'` at creation, not the `'private'` column default.**
  ADR-0032 made `private` the default so that sharing is a deliberate act; this
  IS that act, made at schedule time by someone holding `project:skills:manage`
  on a project whose runs are already readable to anyone with `project:view`. A
  thread only its nominal owner could open would hide a team artefact behind one
  person's account and 404 every colleague following the run-history link. The
  interactive path still passes no visibility and still gets `private`.
- **`conversations.job_id` stamps the provenance** (migration
  `0044_conversation_job_provenance.sql`). Provenance, not ownership: it is what
  lets a list render "Weekly OIB scan" with a job glyph instead of the owner's
  face, and what lets these threads be kept out of the owner's personal chat
  history — a weekly job is 52 of them a year. (The column and its writer are
  in place; the two consumers are follow-up.) Answering either question from `job_runs`
  would mean a join on the hottest list read in the product, per row, to
  establish a fact that never changes after insert. Both foreign keys are
  `ON DELETE SET NULL` in both directions: deleting a job must not delete its
  output, and deleting a conversation must not delete run history. Neither side
  owns the other.

Every conversation write is **best-effort and can never fail a run**. Creation
failure is logged and swallowed and the run submits with no `conversation_id`,
which is exactly the shape of every run that predates the feature; the reverse
trade — refusing to fire because a row could not be written — is the one
outcome nobody wants at 03:00. Nor is the conversation cleaned up when
submission then fails: a submit error is not proof the backend did not receive
the run, and deleting the thread a run is about to write into would destroy the
output to tidy up a row. Because it is created before the outcome is known, a
failed or cancelled run writes a short German notice into it — otherwise
someone opens the thread to find it mysteriously empty, which reads as a broken
product rather than as a failed run. Message ids are `uuid5`-deterministic per
(conversation, job, role) and the internal route upserts, so a retried write is
a no-op rather than a second copy of the answer.

**Jobs get their own project tab; the skills page is the org toolbox alone.**
They sit next to each other in the project rail (`G`+`W`, `G`+`J`) under the
same `showSkills` gate, because they ship together and a job builder whose
skill picker resolves nothing is not worth having. But they are not one page:
the toolbox is organization-wide and asks "what procedures do we have", while
jobs are project-scoped and ask "what should run, and when". Folding the second
into the first is what produced a schedule that had to name a skill.

**The wire rename is tolerated for one deploy window.** `execution` → `output`
is a database rename and a BFF rename, but it is also a *wire* rename on
`POST /v1/internal/skills/submit` — and the BFF and the Python service deploy
separately. A hard rename would 422 every scheduled run in the window between
the two deploys, which is precisely the window nobody is watching. So the
payload accepts both spellings: `output` when present, `execution` as a
deprecated alias, both Optional in the schema with a model validator rejecting
"neither" (structurally legal, and reading an absent key out of the agent table
would be a `KeyError`, i.e. a 500 on a payload the caller got wrong). When both
arrive and disagree, `output` wins and the disagreement is logged rather than
guessed at. The alias and its fallback are deleted once every BFF sending
`output` is deployed — it is a shim with an expiry, not a second name for the
field.

The same reasoning keeps the internal fire contract at its pre-jobs spelling:
the scheduler container still POSTs `{ scheduleId }` to
`/api/internal/skills/fire`, path and field unchanged, because the scheduler
and the BFF also deploy separately. `scheduleId` names a `jobs.id`. Unlike the
`execution` alias this one has no expiry attached — it is a stable internal
contract, not a migration shim.

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
- "Ask this question every Monday" is expressible without inventing a skill for
  it, because the scheduled object is a prompt and the skill is optional.
- Choosing what a job produces can no longer change which skills exist. The one
  gate (`grid-agents`) is the same rule in both resolvers, and the job's
  `output` only picks the agent that rule is evaluated against.
- A scheduled chat run leaves something a person can continue, rather than a
  report they can only read.

### Negative

- Two skill mechanisms (chat `use_skill` vs. deepagents sources) instead of
  one; a skill author must know which surface a skill targets
  (`grid-agents`).
- The catalog is only as good as descriptions: a poor L1 line hides a skill
  from the model (mitigated by forced selection, which bypasses the catalog).
- Two vocabularies survive in the plumbing where a rename would have cost more
  than it bought: `job_runs.schedule_id`, and `{ scheduleId }` on the internal
  fire route. Both are documented at the point of use (column comments, route
  docstring) rather than left to be rediscovered.
- A job conversation is created before its outcome is known, so a failed run
  leaves a thread containing only a notice. That is the deliberate trade against
  a mysteriously empty thread, but it does mean job runs can produce threads
  with no answer in them.

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
- **Silent service-to-service auth.** The internal submit route is guarded by a
  shared token, and its guard once read only `x-internal-token` while every
  caller in the repo sends `x-grid-internal-token` — so every scheduled run
  403'd in a real deployment, and nothing caught it because the two sides are
  tested separately and each test pinned its own spelling. The guard now accepts
  both (`routes/internal_auth.py::_TOKEN_HEADERS`), matching the ASGI envelope
  middleware that already did. The general risk stands: a fire path with no
  human on it fails silently, so its contract needs a test that crosses the
  service boundary rather than two that agree with themselves.

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
- **Keeping `grid-execution` as a gate and adding an override** — rejected: it
  would have kept an output format in the availability rule and added a second
  key to explain why the first one did not apply. Removing the reading was
  cheaper than documenting it.
- **Recreating the tables under the new names (CREATE / COPY / DROP)** —
  rejected: it would have thrown away the ids that `skill_runs` rows and the
  scheduler's claim already reference, to gain nothing a rename does not give.
- **Rejecting stored rows that still carry `grid-execution`/`grid-schedulable`**
  — rejected: a deployed row would become a validation error at read time and
  vanish from the toolbox, to punish a key that costs nothing to ignore.
- **Rendering a job's report as a pseudo-conversation** — rejected: the point of
  `output: 'chat'` is a thread somebody can *continue*. A rendering cannot be
  replied to, and it would need its own access rules instead of reusing
  ADR-0032's.

## Open Questions / Follow-ups

- Embeddings/execution sandboxes for org skills (Modal token env vars exist;
  execution is not yet wired).
- Delete the `execution` alias on `/v1/internal/skills/submit` (and the
  `resolved_output` fallback) once every BFF sending `output` is deployed.
- The scheduler's environment variables still carry skill-era names
  (`GRID_SKILL_SCHEDULER_POLL_MS`, `GRID_SKILL_RUNS_RETENTION_DAYS`), as does
  the compose service `skill-scheduler`. Renaming them is a deployment change
  with no product value; it is a follow-up, not an omission.
- Scheduler-side per-skill `allowed_tools` enforcement is declarative today;
  enforcement semantics for the `use_skill` path are follow-up.

## References

- `docs/architecture/agent-skills.md` (subsystem doc)
- `docs/api/python-endpoints.md` (`/v1/internal/skills/submit`)
- `docs/api/bff-routes.md` (`/api/internal/skills/*`, `/api/skills/*`,
  `/api/projects/{id}/jobs/*`)
- `docs/api/websocket-protocol.md` (`skills` on the message envelope,
  `skills_activated` on the terminal frame)
- `docs/database/schema.md` (`skills` / `jobs` / `job_runs`, and
  `conversations.job_id`)
- `frontends/ui/drizzle/0043_jobs.sql` and
  `0044_conversation_job_provenance.sql` — the rename and the provenance
  column, each with the reasoning in its header
- ADR-0023 / ADR-0027 (Workflows and its template gallery, superseded here)
- agentskills.io format spec (SKILL.md frontmatter contract)
