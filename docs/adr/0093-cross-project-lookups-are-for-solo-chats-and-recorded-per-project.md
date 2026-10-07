---
status: accepted
date: 2026-10-06
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Cross-project lookups are for solo chats, and what they return is recorded per project

## Context and Problem Statement

The upload-and-filing re-triage (`docs/audit/upload-and-filing-retriage-2026-10-06.md`,
ticket 3) proposed a „Bibliothek" page: one search across every project. The
product owner re-scoped it on 6 October 2026: „An agent simply should have a
way to search across those closed projects in a scoped way. You should also
look into general cross-project lookups and stuff like that. It is also fine if
this is just in general for solo chats." A closed project is readable by every
office member, with folders that have their own access list still restricted
(ticket 1).

Every chat turn is signed one project's retrieval scope (ADR-0047), and the
record of what a conversation drew on (`conversation_restricted_folders`,
ADR-0088) was judged against that one project's folder tree. A folder of another
project read as unknown there, which locks the conversation for everyone, its
creator included. Open content of another project was not recorded at all, so a
chat that drew on it could have been shared with someone who may not open that
project, made visible to the project, filed into it, or remembered by it.

## Decision Drivers

* A project the reader may not use is invisible, and inside a project the
  folder rule applies exactly as it does for that project's own search: no
  second rule.
* What another project's documents said must not reach someone who may not open
  that project: not through sharing, and not through anything the whole project
  reads (memory, runs, tasks, the profile, filing).
* The agent never decides access; the BFF does, behind one HTTP API (ADR-0055).
* A control that holds without anyone remembering it beats one a future tool
  has to opt into (the correction ratchet).
* N projects are N collection searches; the cost must be bounded, per call and
  per turn.

## Considered Options

* **Agent lookups over internal BFF routes, solo chats only, recorded by the BFF
  when it hands the content out** (chosen).
* The same, but recorded by the agent's per-round admission
  (`admit_tool_results` reporting the collections it read, as ADR-0088 does for
  the conversation's own project).
* Sign every reachable project's collections into the turn's scope.
* A „Bibliothek" search page for people, no agent lookups (re-triage slice 3a).

## Decision Outcome

Chosen option: agent lookups over internal BFF routes, usable only in a solo
chat, with every answer recorded on the conversation by the BFF before it is
returned.

**Three lookups, one agent tool.** Search documents across projects (`POST
/api/internal/cross-project/search`), list and find projects with their status,
period and address (`…/projects`), and read one project's brief, its confirmed
facts and summary (`…/brief`). The contract is zod
(`lib/cross-project/types.ts`), exported as JSON Schema for the agent
(`tests/fixtures/cross-project.schema.json`). The agent binds them as ONE tool
with an `action`, because every bound tool's schema rides on every model call
of every chat turn and tool narrowing is off in production (the precedent is
`propose_file_change`). The tool echoes the turn's signed envelope; the route
builds the asker's pinned session from it (ADR-0054 §4) and calls
`lib/cross-project/service.ts`.

**Reach.** A project is in reach when the asker may CHAT in it
(`listChatProjects`, `project:chat` or the legacy `project:edit`): pointing the
agent at a corpus is chatting in it, which is the rule the turn's own scope
already applies, so a project viewer reads documents but does not get the agent
pointed at them. The conversation's own project is never in a lookup's scope;
its own tools search it under its own, audience-narrowed scope.

**Search.** The closed projects, every project in reach, or named ones,
optionally narrowed by document type and OIB discipline (the ingestion tags'
closed vocabulary, filtered after retrieval because the tags live in the
metadata store, not in the chunks) and by the PROJECT's period. Not by a
document's upload day: archived projects are uploaded in bulk, so that day says
nothing about when the work was done. Inside each project the search IS
`searchProjectDocuments`, so hidden folders are excluded and a restricted
folder's collection is searched only for a reader who may read it. A passage is
the evidence the agent answers from and cites, and it cannot open another
project's document further, so the search asks the backend for 900 characters
instead of the hit list's 300 (`snippet_max_chars`). Each hit names its project
and status and carries its document id and collection.

**Solo chats only.** A conversation that does not exist yet, or is private,
created by the asker and granted to nobody else. Anything else is refused with a
typed 409 (`CROSS_PROJECT_SHARED_CHAT`) whose German sentence the agent relays.

**Recorded when the BFF hands the content out.** Before a lookup answers,
`recordCrossProjectHandOut` (`lib/conversations/cross-project-use.ts`) takes the
per-conversation lock every share takes, checks again that the conversation is
the asker's alone, and records, in one transaction, every project the answer
says anything about (`conversation_source_projects`, migration 0125) and every
restricted folder a passage came from (by id, in
`conversation_restricted_folders`). A passage whose folder cannot be named is
dropped rather than handed out unrecorded. A listing and a brief record their
projects too: a project's name and address are use of it. If the chat stopped
being solo, nothing is recorded and nothing is returned.

The agent's per-round admission still gates what the model reads:
`admit_tool_results` withholds any result carrying a restricted collection the
turn did not admit, and the tool admits exactly the collections the BFF returned
and therefore recorded.

**What the record decides, at read time.** A recorded folder is judged in the
tree of the project it belongs to (`treeForRecord`), so its creator keeps the
chat. Who may read the conversation (`peopleWhoMayRead`, `lockedConversationIds`,
the share check under the lock) is narrowed to people who may open (view) every
recorded project now. A project-wide visibility is refused, as is every door the
whole project reads (`requireMayLeaveConversation`, `requireMayFileFrom`).
Nothing is remembered from such a conversation: `POST /api/internal/memory`
refuses a write naming it (409 `CROSS_PROJECT_MEMORY`). Card decisions from it
stay out of the project's digest. The turn learns all this at its start:
`POST /api/internal/turn-context` answers `drewOnOtherProjects`, so the agent
does not offer what would be refused.

**Sharing later**, the product owner's open question: the safe default. Sharing
stays possible, per person, to someone who may open every project the chat drew
on and read every recorded folder.

**Bounded cost.** One search call searches at most 8 projects, 4 at a time, and
returns the offset of the next page; the agent's round budget bounds how often
it asks. A listing returns 10 projects by default and at most 30, a search at
most 20 hits. The share dialog's question asks each person about the recorded
projects one after another and stops at the first refusal.

**Status and period.** Ticket 1 adds `projects.status` and a project period;
until they land every project is `active`, a `closed` scope finds nothing, every
answer carries `statusKnown: false`, and a project's period starts the day it
was created in Piloti and is open. The follow-up is `projectStatusOf`,
`projectPeriodOf` and `PROJECT_STATUS_KNOWN` in `lib/cross-project/service.ts`.

### Consequences

* Good, because access is decided by the rules that already decide it (the chat
  reach of a project, the project's own folder rule), behind one route per
  lookup, with the asker's own session.
* Good, because the record exists before the content can reach the model and
  does not depend on a tool reporting what it read, which is the residual
  ADR-0088 carries for the conversation's own project.
* Good, because a cross-project chat stays its creator's, and a later share, the
  „no rights" gate, memory and every project-wide door follow the record.
* Bad, because a result the agent then drops still counts as used: the safe
  direction, at the cost of over-restricting a chat that asked and ignored.
* Bad, because a chat that used a lookup cannot start deep research or a task,
  change the profile, file a document or teach project memory, even after the
  other project becomes readable by everyone. That is the price of „nothing a
  whole project reads", as for restricted folders (ADR-0088); the remedy for a
  reader is a separate chat for cross-project questions.
* Bad, because a listing records every project it lists. A chat that asked
  „which projects do we have" can only be shared with people who may open all
  of them.
* Bad, because a project deleted later is a project nobody opens, so its chats
  lock (the safe direction).
* Bad, because each project searched also reconciles its hits' rows with the
  ingestion backend (`toListedDocuments`), one listing call per collection. Fine
  for pages of 8; hundreds of projects want the tags mirrored into Postgres
  (re-triage slice 3c), which would also let the type filter run before
  retrieval instead of after it.
* Bad, because a reader's question about who may open the recorded projects is
  a WorkOS check per person and project (`userHoldsProjectPermission`, not
  cached), bounded by the share roster's 200 people and stopped per person at
  the first refusal.
* Bad, because the memory refusal binds writes that name their conversation.
  Both agent writers do, and a test pins it; a writer that named none would not
  be refused by the BFF.
* Bad, because who may open a closed project is ticket 1's rule. The lookups
  ask `listChatProjects`, `requireProjectAccess` and `userHoldsProjectPermission`;
  if ticket 1 opens closed projects anywhere else, these disagree.

### Confirmation

* `lib/cross-project/service.spec.ts`: the shared-chat refusal before any
  search, projects outside chat reach invisible (named or not), the own project
  left out, what is recorded (projects and restricted folders of the hits handed
  out, a passage with no nameable folder dropped, nothing when the record
  refuses), paging and its bound on concurrency, the longer passage, the closed
  scope while status is unknown, the project-period filter, type and discipline
  filters, one project failing, the listing (recorded, the own project not) and
  the brief (chat permission, recorded).
* `lib/conversations/cross-project-use.spec.ts`: the solo rule, the record
  under the lock, the refusal that records nothing, the memory refusal;
  `cross-project-use.integration.spec.ts` the record against Postgres with the
  read-time judges, sharing, erasure and RLS.
* `lib/conversations/restricted-use.spec.ts`: the foreign folder judged in its
  own tree, project-gated readers, locked lists, share refusals, the re-check
  under the lock, and the per-person short-circuit.
* `restricted-egress.spec.ts`: every door refused on a project record alone.
* `app/api/internal/cross-project/routes.spec.ts`: identity, conversation and
  project from the envelope; `app/api/internal/memory/route.spec.ts`: the 409;
  `app/api/internal/turn-context/route.spec.ts`: `drewOnOtherProjects`.
* `lib/projects/service.spec.ts` and `lib/documents/service.spec.ts`: chat reach
  and the snippet length; `frontends/aiq_api/tests/test_document_search.py`: the
  backend's bound on it.
* `lib/cross-project/cross-project-schema.spec.ts` keeps the JSON Schema the
  agent's tool is tested against in step with zod.
* `scripts/rls-test-db.sh`: 0125's constraint, its down (a nil-folder record
  that keeps the chat locked) and its re-apply.
* Agent side: the tool's and the admission's tests under
  `tests/aiq_agent/tools/cross_project/`, and the tool's row in
  `tests/aiq_agent/knowledge/test_collection_read_inventory.py`.

## Pros and Cons of the Options

### Recorded by the agent's per-round admission

* Good, because it is the path the conversation's own restricted folders take,
  and only content the model actually read is recorded.
* Bad, because the BFF would hand content out unrecorded and rely on every
  lookup reporting what it returned; a listing or brief that forgot to would
  leak project names to a later share. It needs a second route and a second
  round trip per tool round for the same record.

### Sign every reachable project into the turn's scope

* Good, because every existing read path would search them with no new tool.
* Bad, because a socket's scope is signed once, so N projects' collections ride
  every turn, every search fans out over them, and the admission's audience rule
  would have to be per project anyway.
* Bad, because the turn could no longer tell its own project's content from
  another's, which is what memory and the egress rules need.

### A „Bibliothek" page for people only

* Good, because a ranked hit list for a person needs only `hiddenFolderIds`.
* Bad, because the product owner asked for the agent to search, not for a page.

## More Information

* Re-triage, ticket 3 and „What folder access per role gives each ticket":
  `docs/audit/upload-and-filing-retriage-2026-10-06.md`.
* ADR-0047 (shelf as data), ADR-0054 §4 (echo the envelope), ADR-0055 (one HTTP
  API), ADR-0060 (rules in tool descriptions), ADR-0087 and ADR-0088 (folder
  access and the record of use).
* Routes: [`bff-routes.md`](../api/bff-routes.md); the table:
  [`schema.md`](../database/schema.md#conversation_source_projects-migration-0125-adr-0093).
