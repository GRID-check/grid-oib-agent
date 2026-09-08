---
status: proposed
date: 2026-09-08
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# The Büro-Chat reads the office and mounts projects on demand, never all projects at once

## Context and Problem Statement

Every chat in Piloti is bound to one project. The BFF computes the retrieval
scope as `[oib_knowledge, archiv_<org>, proj_<id>, s_<conversation>]`
(ADR-0006, ADR-0024), the gateway injects one project's profile and memory
digest as headers, and every prompt and state class carries one
`project_context` string. The composer's scope chip already shows an "Alle
Projekte" row, disabled with "Bald verfügbar" (`docs/user-guides/chat.md`), and
the click-dummy spec records the reason: the backend has no cross-project
retrieval, "do not fake it".

The product needs a place above projects. Two kinds of question do not belong
to a project: a pure Baurecht question asked before any project is chosen, and
an office question that spans projects ("in welchen Projekten haben wir GK5 mit
Holzbau?", "wie haben wir das im Projekt Seestadt gelöst?"). The knowledge
hierarchy the system already has, platform → organization → project →
conversation (`docs/architecture/system-overview.md` §5.2), has no surface at
its second level.

The obvious design, putting every project collection the user may read into
the scope, does not survive the numbers. Retrieval is one vector query per
collection per pass, doubled by the HyDE draft and multiplied again by the
requery loop (`sources/knowledge_layer/src/register.py:1638-1685, 1707-1729,
1810-1822`), so an org with forty projects would run well over a hundred
queries per turn. The rank fusion, the base-first tie-break and the inventory
eviction were tuned for four shelves. Readability is a per-project WorkOS FGA
check with no bulk listing (`frontends/ui/src/lib/projects/service.ts:63-85`),
uncached by default. And the answer would cite forty projects' chunks with no
way to say which project a passage came from.

## Decision Drivers

- A member must never see, be told about, or retrieve from a project they may
  not read. Readability is decided by the BFF per project (ADR-0038) and the
  set can change between turns.
- Per-turn cost and latency must not grow with the number of projects in the
  organization. The product is sold to offices with dozens of projects.
- One answering agent, no router (ADR-0052): what a turn reads is the agent's
  decision, made with the tools it has, not a label decided before it runs.
- Every project-sourced claim must name its project and cite a passage a
  person can open (ADR-0037, ADR-0044).
- The two chat surfaces must be the same product: same components, same
  answer shape, same provenance chips, so a user reads both without learning
  two systems.
- The design must be the seed of the cross-project roadmap
  (`docs/roadmap/cross-project-rag-vision.md`), not a detour around it.

## Considered Options

1. **Full fan-out.** The BFF puts every readable `proj_<id>` collection in the
   scope; retrieval and fusion do the rest.
2. **A cross-project chunk index.** A second vector collection per org holding
   every project's chunks with a `project_id` filter, queried once per turn
   (the roadmap's pgvector sketch, applied to chunks).
3. **Register plus mount.** The office turn reads base, Archiv, organization
   memory and a small per-project index of fingerprints (the *Projektregister*
   of *Projektsteckbriefe*); the agent, or the user, mounts a bounded number
   of projects into the conversation, and only mounted projects' collections
   join the retrieval scope. Portfolio-wide questions go to deep research.
4. **Do nothing; keep chat project-bound** and route office questions to the
   Archiv page.

## Decision Outcome

Chosen option: 3, "register plus mount", because it is the only option whose
per-turn cost is bounded by a number we choose rather than by the size of the
organization, and the only one where "which project is this from" is known by
construction rather than recovered from a chunk.

What the system is, under this decision:

- **A workspace conversation** is a `conversations` row with `project_id =
  NULL` and `scope = 'workspace'`, with a CHECK that `scope = 'project'` if and
  only if `project_id` is set, mirroring `documents.scope`. It belongs to the
  organization, so the deletion pipeline treats it as organization-level
  (ADR-0011); a project purge cascades only the mount rows that name it.
- **The Projektregister** is a `grid_app` table with one Steckbrief per
  project: name, status, Bundesland, the profile prompt view that already
  exists (`projects.profile_prompt_view`), a bounded memory headline, the
  document inventory, last activity; at most 3000 characters, with a
  row-resident embedding exactly as `project_memory` carries one
  (`drizzle/0069_semantic_notes.sql`). The BFF writes it through on profile
  save, memory write, ingest completion and rename, and a nightly reconcile
  rebuilds rows marked stale. It lives in Postgres rather than in the vector
  store because the readable-project filter is an application fact only the
  BFF can apply, and because the register is small.
- **Register recall rides the memory-recall seam.** At turn start the agent
  fetches one *workspace digest* from an internal BFF endpoint: the
  organization memory digest plus the top five Steckbriefe for the question,
  filtered to projects the caller may read. A `find_projects` tool serves
  explicit discovery on follow-ups. Register hits are navigation and
  structured facts: the agent may name a project and quote a profile fact from
  its Steckbrief, cited as source kind `projekt` on a new shelf `register`;
  any claim about a project's *content* must be grounded in a mounted
  project's documents or memory.
- **Mounting** is one BFF endpoint, reached by the user from the scope tree
  and by the agent through the `open_project` tool. It checks `project:chat`
  for this caller on that project, persists the mount on the conversation,
  and returns a grant signed with the request-context secret. The tool
  registers the grant for the rest of the turn and the knowledge layer unions
  it into the scope after verifying the signature; from the next WebSocket
  upgrade on, the persisted mounts arrive through the ordinary scope header,
  re-authorized on every upgrade. The BFF stays the sole naming authority
  (ADR-0006); the grant is how that authority reaches the middle of a turn.
- **The cap** is `GRID_WORKSPACE_MAX_MOUNTED_PROJECTS`, default 5, enforced in
  the mounts endpoint and nowhere else. Beyond it the agent says so and offers
  deep research, which is the only path that reads more than the cap: a
  portfolio run iterates readable projects one sub-run at a time under its own
  budget.
- **The agent is the same agent.** The Büro turn enters
  `chat_deepresearcher_agent` with its full tool set plus `find_projects` and
  `open_project`; its context block is a workspace shape (organization memory,
  register recall, one prompt view per mounted project) and the prompt gets an
  office branch. `remember` writes organization memory in the Büro and
  requires a new `org:memory:write` permission, which closes the gate ADR-0008
  left open; until that permission exists the tool is unbound there.
- **The hierarchy is visible on both surfaces** through one scope-tree control
  (Basiswissen → Büroarchiv → Projektregister → Projekt(e) → Diese
  Unterhaltung), and the Herleitung groups hits by the same levels. The
  project chat's disabled "Alle Projekte" row becomes the action "Im Büro
  fragen", which opens the Büro with that project mounted.

### Consequences

- Good, because a turn's retrieval cost is bounded by the cap, not by the
  organization: at most base + Archiv + five project collections.
- Good, because access is decided per mount by the same `decide()` path every
  project route uses, and the readable filter on register recall is the same
  `listProjects` function the home grid uses; there is no second readability
  computation to drift.
- Good, because "which project" is data on the scope entry and the chunk from
  the moment the BFF builds the scope (ADR-0047 applied to projects), so
  citations and the Herleitung attribute projects without guessing.
- Good, because the Steckbrief table is the cross-project roadmap's first
  artifact: similar projects, precedents keyed to requirements and a named
  project set (a Bezirk, a client) are queries and rows over it, not a new
  store.
- Bad, because a question whose answer lies in a project nobody mounted is
  answered from the register alone, and the agent must be honest about that.
  This is model judgment pinned by prompt, like the two behaviours ADR-0052
  moved from code to prompt, and it needs the same live eval.
- Bad, because the register is a derived copy of four sources and can go
  stale between a write and the reconcile; a stale Steckbrief points at the
  right project with slightly old facts, which is tolerable, but the writers
  and their invalidation points are one more thing to keep in step.
- Bad, because a mount grant is a second signed artifact beside the request
  envelope, and the knowledge layer now has an in-turn scope it did not have.
  Both are verified with the secret the envelope already uses; neither adds a
  new trust boundary.
- Bad, because in-connection revocation has a window: a mount granted at the
  start of a WebSocket connection stays readable until the grant expires or
  the connection is upgraded again. Project chat has exactly this window
  today; the cap keeps it to five projects.
- Neutral, because the register introduces a fifth shelf, `register`. Both
  twins (`source_kinds.py`, `source-kinds.ts`) fail closed on an unknown
  member, so a shelf added on one side renders unattributed on the other
  until both are updated, which is the behaviour ADR-0047 chose.

### Confirmation

Nothing enforces this yet; review is the only gate until the first phase
lands. The gates the implementation must add, so that the next person doing
it the other way is caught by something other than a reviewer:

- A CHECK constraint on `conversations` (`scope = 'project'` ⇔ `project_id IS
  NOT NULL`) and the RLS coverage spec (`task db:test:rls`) covering
  `project_register` and `conversation_mounts`.
- An integration test with the fake FGA: a member without `project:view` on P
  never receives P in register recall, gets 403 on mounting P, and is refused
  a shared workspace conversation that mounts P.
- `tests/aiq_agent/test_tool_context_contract.py` extended with `open_project`
  and `find_projects`, so both entry paths (WebSocket, job worker) supply what
  they need.
- The cap has one implementation and one test; the knowledge layer refuses an
  unsigned or expired grant, with a test.
- The retrieval harness (`task be:eval:retrieval`) runs a Büro golden set
  (right project in the top three register hits ≥ 90%, no regression on the
  Baurecht set) and a latency check at the cap (p95 time-to-first-token at
  five mounts ≤ 1.5× one mount) before the cap may be raised.
- The turn-shapes live eval (`task be:eval:turn-shapes`) gains the office
  shapes: an office question that mounts nothing must say it answered from
  the register; a question naming a project must mount it before claiming
  its content.

## Pros and Cons of the Options

### 1. Full fan-out

- Good, because it needs no new table, no new tool and no prompt branch; the
  scope header already accepts any number of collections.
- Bad, because cost and latency scale with the organization and the header
  itself would not fit forty project ids with their names.
- Bad, because readability must be recomputed for every project on every
  upgrade, and a stale preference or a revoked membership widens retrieval
  silently, which is the failure ADR-0038 closed on the home grid.
- Bad, because fusion across forty channels is unmeasured; the base-first
  tie-break and the diversity cap would need retuning with no harness for it.

### 2. A cross-project chunk index

- Good, because one query per turn, filtered by project id, is the cheapest
  retrieval shape.
- Bad, because it duplicates every project's chunks into a second collection
  and doubles the ingest, the deletion pipeline and the quota accounting
  (ADR-0042) for the same bytes.
- Bad, because the readable filter has to travel into the vector store as a
  list of project ids per query, which is the header-size problem again, or
  the index must be re-sharded by visibility, which WorkOS FGA does not expose.
- Bad, because the roadmap's readiness gate for this (profiles stable, ten
  real projects through intake) is not met, and the register is the artifact
  that gate needs first anyway.

### 3. Register plus mount

- Good, because cost is bounded by a chosen cap, access is decided at the one
  decision point per mount, and attribution is data.
- Neutral, because the agent needs one more step to reach a project's content
  (find, then mount, then search), which the seven-call ceiling accommodates
  since recall is injected and mounting is cheap.
- Bad, because it is the largest option to build: a table, its writers, an
  endpoint, a grant, two tools, a prompt branch, a control on both surfaces.

### 4. Do nothing

- Good, because it costs nothing.
- Bad, because the product's second knowledge level has no surface, a Baurecht
  question requires choosing a project first, and the disabled "Alle Projekte"
  row keeps promising something the product does not do.

## More Information

- Revisit the cap when the latency check at five mounts passes with room to
  spare and users hit the cap in the turn-shapes eval's real traces; raise it
  by measurement, never by request.
- Revisit "register in Postgres" if an organization's register exceeds a few
  thousand rows or hybrid recall over it exceeds the digest's time bound; the
  answer then is the roadmap's dedicated index, fed from this table.
- Revisit "one agent" if the office prompt branch and the project branch drift
  into two prompts that share nothing; that is the signal for a shared persona
  core, which ADR-0052 declined to build ahead of evidence.
- Supersedes nothing. Closes the "cross-project scope, ship disabled" note in
  `docs/design/click-dummy-overhaul-spec.md` §2.3 and gives
  `docs/roadmap/cross-project-rag-vision.md` its first artifact.
- The requirements: `docs/design/workspace-chat-spec.md`. The surface:
  `docs/design/workspace-chat-ui.md`. The build order:
  `plans/2026-09-08-workspace-chat-implementation.md`.
