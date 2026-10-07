---
status: accepted
date: 2026-10-07
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# The agent searches other projects as the conversation's audience, and a closed project restricts nobody

## Context and Problem Statement

The upload-and-filing re-triage (`docs/audit/upload-and-filing-retriage-2026-10-06.md`,
ticket 3) proposed a „Bibliothek" page: one search across every project. The
product owner re-scoped it on 6 October 2026: an agent should be able to search
across the office's projects, closed ones above all, in a scoped way; solo
chats would be enough. Ticket 1 (ADR-0082) makes a closed project readable by
every office member, with folders that have their own access list still
restricted.

A first build (6 Oct) allowed the lookups only in a solo chat and treated
everything they returned as confining: no sharing beyond people who may open
the project, no memory, no Tiefenrecherche, no Auftrag, no filing. Reviewing it
on 7 Oct, the product owner asked for more: the agent should go and look in the
office's past projects on its own, without being asked, and know which
reference projects exist. A solo-only lookup that shuts every door also shut
them for content every office member may read anyway, so it protected nobody
and cost the user the feature.

Every chat turn is signed one project's retrieval scope (ADR-0047), and the
record of what a conversation drew on (`conversation_restricted_folders`,
ADR-0081) was judged against that one project's folder tree.

## Decision Drivers

* A project the reader may not use is invisible, and inside a project the
  folder rule applies exactly as in that project's own search: no second rule.
* What a project's documents said must not reach someone who may not read it:
  not through the transcript, a later share, or anything the whole project
  reads (memory, runs, tasks, the profile, filing).
* The agent decides WHEN to look; the BFF decides WHERE it may (ADR-0055).
* Ask the user only when no automatic guarantee exists: confirmation prompts
  that are always answered yes protect nothing (FIDES, CaMeL, RTBAS).
* A control that holds without anyone remembering it beats one a future tool
  has to opt into (the correction ratchet).
* N projects are N collection searches; the cost is bounded per call and turn.

## Considered Options

* **Search as the conversation's audience, record at hand-out, judge the record
  at read time with closed projects restricting nobody, and give the agent a
  catalog of reference projects every turn** (chosen).
* Solo chats only, every hand-out confining (the first build).
* Search as the asker in any chat, and ask the asker to approve each answer
  that used sources not every member may read (Copilot in Teams group chats).
* Sign every reachable project's collections into the turn's scope.
* A „Bibliothek" search page for people, no agent lookups.

## Decision Outcome

Chosen option: the agent looks across projects from any chat, as the
conversation's whole audience; the BFF records what it hands out before it
answers; the record is judged when it is read, so a project closed now
restricts nobody; and the turn starts knowing the office's closest reference
projects. The design, the research behind it and the ladder of scopes:
[`cross-project-escalation.md`](../design/cross-project-escalation.md).

**Three lookups, one agent tool.** Search documents across projects (`POST
/api/internal/cross-project/search`), list and find projects with status,
period and address (`…/projects`), read one project's brief (`…/brief`). The
contract is zod (`lib/cross-project/types.ts`), exported as JSON Schema for the
agent (`frontends/ui/tests/fixtures/cross-project.schema.json`). The agent binds
them as ONE tool, `project_lookup`, with an `action`, because every bound tool's
schema rides on every model call and tool narrowing is off in production. The
tool echoes the turn's signed envelope; the route builds the asker's pinned
session from it (ADR-0054 §4).

**Reach is the audience's** (`lib/cross-project/audience-reach.ts`):

| Conversation | Reach |
|---|---|
| the asker's alone, or not created yet | every project the asker may chat in (`listChatProjects`), restricted folders the asker may read included |
| private, shared with at most 10 named people | closed projects, and the active ones every other reader may open (`project:view`); no restricted folder |
| visible to the project or the office, or shared more widely | closed projects; no restricted folder |

Whatever a lookup returns is therefore readable by everyone already in the
conversation, so no answer needs approving. The conversation's own project is
never in scope; its own tools search it under its own scope.

**Search.** `similar` (default) walks the projects in reach most like the
current one first (`lib/cross-project/similarity.ts`: Bundesland, then
Gebäudeklasse with a neighbouring class counting a little, Bauweise, uses, kind
of work); `closed`, `all` and `named` remain. Optional filters: document type
and OIB discipline (the ingestion tags, after retrieval) and the PROJECT's
period (the Steckbrief's Beginn and Abschluss, else the day it was created in
Piloti), never a file's upload day. Inside each project the search IS
`searchProjectDocuments`, so hidden folders are excluded and a restricted
folder's collection is searched only for a reader who may read it, and only in
a solo chat. The passage is 900 characters (`snippet_max_chars`), the evidence
the agent answers from.

**Decisions before passages** (added 2026-10-07). The search also returns
the searched projects' recorded decisions: their active `decision` and
`constraint` memory items, matched by Postgres' German full-text search with
OR semantics, at most 6 (`lib/cross-project/decisions-repository.ts`). Each
project's items are filtered exactly as its own memory panel filters them.
In a solo chat, a restricted item is served only when the asker is cleared,
in that project, for every folder it came from. A shared chat gets open
memory only. Decisions are recorded at hand-out like passages, with their
projects and restricted folders. The agent cites each project's matching
decisions as one source, „Projektgedächtnis (‹Projekt›)", listed before the
passages. A decision from a running project, or from a restricted folder,
shuts the turn's doors as such a passage does.

**The catalog.** `POST /api/internal/turn-context` answers `referenceProjects`:
up to 12 closed projects, most like the current one first, one line each with
id, years, Bundesland, Gebäudeklasse, Bauweise, uses, kind of work, what they
share with this project and a short summary (`lib/cross-project/reference-brief.ts`).
The agent renders it as `<referenzprojekte>`, below the KV-cache boundary, only
when `project_lookup` is bound, with the rule to look unasked when a question
is comparative, a past project may have made the same decision, or the
project's own sources do not answer. It lists only closed projects, which every
office member reads, so it is safe in any chat and is not recorded. People from
the Steckbrief never appear (ADR-0083).

**Recorded when the BFF hands the content out.** Before a lookup answers,
`recordCrossProjectHandOut` (`lib/conversations/cross-project-use.ts`) takes
the per-conversation lock every share takes and checks that the audience is
still the one the reach was computed for (`audienceKey`: visibility, creator,
grantees). Then, in one transaction, it records every project the answer says
anything about (`conversation_source_projects`, migration 0116) and every
restricted folder a passage came from (by id, in
`conversation_restricted_folders`). A passage whose folder cannot be named is
dropped. If the audience changed, nothing is recorded or returned: a typed 409
(`CROSS_PROJECT_AUDIENCE_CHANGED`) whose German sentence the agent relays.

**Judged at read time; a closed project restricts nobody.** Every judge reads
`listRestrictingSourceProjects`, which leaves out a recorded project that is
closed now. A recorded folder is judged in its own project's tree with the
reader's clearance IN THAT PROJECT (ticket 1's per-project clearance), so a
restricted folder of a closed project still restricts. What the remaining
record decides:

* who may read the conversation (`peopleWhoMayRead`, `lockedConversationIds`,
  the share check under the lock): people who may open every restricting
  project and read every restricting folder;
* what may leave it (`requireMayLeaveConversation`, `requireMayFileFrom`): no
  run, task, profile patch or filing into anything the whole project reads;
* what may be remembered (`POST /api/internal/memory`, 409
  `CROSS_PROJECT_MEMORY`), and whether card decisions reach the project digest.

A chat that drew only on closed projects' open folders is therefore an
ordinary chat: shareable with anyone in the office, able to remember, to start
a Recherche or an Auftrag. Reopening the project restricts it again, without a
migration, because the record was never deleted.

**The turn knows.** `drewOnOtherProjects` in the turn context, and the tool's
own `restricting` flag per answer (an active project, or a restricted folder),
shut the agent's doors before it offers what would be refused. A closed
project's open folder shuts none.

**What the reader sees.** A source from another project carries its project on
the citation wire (`project: {id, name, status}`), so its chip names it, its
preview resolves the document in that project by the reader's own access, and a
closed one says so by its own status, whatever the chat's. The composer notice
names only RUNNING other projects and what they close; a chat that drew only on
closed projects shows none.

**Bounded cost.** One search call searches at most 8 projects, 4 at a time, and
returns the offset of the next page. A shared chat's reach asks WorkOS at most
(other readers ≤ 10) × (active projects in the asker's reach) questions, cached
a minute; beyond 10 readers it is the closed projects alone, asking nothing.
The catalog is one bounded project read per turn, advisory: a failure answers
without it.

### Consequences

* Good, because the agent can consult the office's experience in every chat,
  unasked, and the common case (closed projects) costs the chat nothing.
* Good, because access is decided by rules that already decide it (chat reach,
  `project:view`, the folder rule, ticket 1's closed-project rule) and the
  transcript never holds what a current reader may not read.
* Good, because the record exists before the content reaches the model, and is
  judged when read, so closing and reopening a project need no backfill.
* Bad, because a shared chat cannot reach a restricted folder of another
  project even when every reader may read it: asking per hit and per person is
  deferred. A solo chat can.
* Bad, because a result the agent then drops still counts as used: the safe
  direction, at the cost of over-restricting a chat that asked and ignored.
* Bad, because a listing records every project it lists; naming a running
  project narrows the chat like reading it.
* Bad, because reopening a project re-locks chats that drew on it for readers
  who may not open it, and memory written while it was closed stays: it was
  readable by everyone when it was written.
* Bad, because the similarity weights are hand-set. They should be learned from
  which references readers open (re-triage follow-up).
* Bad, because each project searched also reconciles its hits with the
  ingestion backend, one listing call per collection; hundreds of projects want
  the tags mirrored into Postgres (re-triage slice 3c).

### Confirmation

Every access rule has a test that fails without it (revert-checked):

* `lib/cross-project/audience-reach.spec.ts`: solo, shared with named people,
  visible to the project, too many readers, the creator as a reader.
* `lib/cross-project/service.spec.ts`: reach decides, the own project left out,
  restricted folders only from a solo chat, the record checked against the
  reach's audience, `similar` order, closed scope, the Steckbrief period,
  paging and concurrency, filters, listing and brief.
* `lib/cross-project/similarity.spec.ts`, `reference-brief.spec.ts`: the order,
  and a catalog of closed projects only, bounded.
* `lib/conversations/cross-project-use.spec.ts`: `audienceKey`, the record
  under the lock, the refusal that records nothing, the memory refusal;
  `cross-project-use.integration.spec.ts` against Postgres: the record, the
  foreign folder judged in its own tree, sharing, a closed project restricting
  nobody and restricting again once reopened, erasure, RLS.
* `lib/conversations/restricted-use.spec.ts`, `restricted-egress.spec.ts`: the
  judges and every door.
* Route specs: `app/api/internal/cross-project/routes.spec.ts`,
  `memory/route.spec.ts`, `turn-context/route.spec.ts` (`referenceProjects`,
  advisory).
* `scripts/rls-test-db.sh`: 0116's constraint, its down and its re-apply.
* UI: `other-projects.spec.ts`, `OtherProjectsNotice.spec.tsx`,
  `AnswerSourcesRow.spec.tsx`, and the `/dev/other-projects` preview.
* Agent: `tests/aiq_agent/tools/cross_project/` (a closed project's open folder
  shuts nothing, a running one does, a restricted folder does),
  `tests/aiq_agent/agents/piloti/test_reference_projects_prompt.py`,
  `tests/aiq_agent/turn/test_context_client.py`, and the tool's row in
  `tests/aiq_agent/knowledge/test_collection_read_inventory.py`.

## Pros and Cons of the Options

### Solo chats only, every hand-out confining

* Good, because it needs no question about anyone but the asker.
* Bad, because it confines content every office member may read, so the agent
  cannot use the office's experience in a team chat, and a solo chat that used
  it loses memory, Recherche and Aufträge for nothing.

### Search as the asker, approve per answer (Copilot in Teams)

* Good, because the asker sees everything they may read.
* Bad, because the approval is the asker's, not the content owner's, and a
  prompt on every such answer is answered without reading. The audience search
  needs no prompt at all.

### Sign every reachable project into the turn's scope

* Good, because every read path would search them with no new tool.
* Bad, because N projects' collections ride every turn and every search fans
  out over them, and the turn could no longer tell its own project's content
  from another's.

### A „Bibliothek" page for people only

* Good, because a ranked hit list for a person needs only `hiddenFolderIds`.
* Bad, because the product owner asked for the agent to search, not for a page.

## More Information

* Design and research: [`cross-project-escalation.md`](../design/cross-project-escalation.md).
* Re-triage, ticket 3: `docs/audit/upload-and-filing-retriage-2026-10-06.md`.
* ADR-0047, ADR-0054 §4, ADR-0055, ADR-0060, ADR-0080 and ADR-0081, ADR-0082
  (a closed project), ADR-0083 (the Steckbrief).
* User guide: [`chat.md`](../user-guides/chat.md#searching-other-projects).
* Routes: [`bff-routes.md`](../api/bff-routes.md); the table:
  [`schema.md`](../database/schema.md#conversation_source_projects-migration-0116-adr-0085).
