---
status: accepted
date: 2026-10-01
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Folder access follows WorkOS roles, and a restricted folder is its own retrieval collection

> **Partly superseded by [ADR-0087](0087-folder-access-is-read-write-per-role.md)** (2026-10-06):
> who may see a folder (a role list on `restricted_roles`, replaced by per-role read/write
> grants that only narrow when nested), the per-conversation mark and the per-socket
> confinement check (replaced by a per-person record of source folders, judged at read time).
> The retrieval collection per restricted folder, the egress refusals, the memory rule and the
> IFC rule below still hold. Paragraphs marked
> „Superseded" below say which.

## Context and Problem Statement

Not everyone in an office may see everything: fee agreements, contracts,
personnel files (ticket „Zugriffsrechte für Ordner und Dateien", 2026-10-01).
The managing director wants every carpenter's offer across all housing
projects; the intern must not see them. Such files should still live in
Piloti, visible only to the people entitled to them, and **nothing may leak
indirectly**: not in search, not in Piloti's answers, not as a fee amount
quoted in a reply.

Today access is per project and nothing finer. Roles are fixed in
`lib/authz/catalog.ts` and provisioned into WorkOS; a custom role exists only if
an operator creates it in the WorkOS dashboard; the session reads `role` and
`permissions`, not `roles`. `documents.visibility = 'private'` can be set and
nothing on the read side enforces it. Retrieval is scoped by the signed
collection list the BFF puts in the request envelope (ADR-0047), and every
Python read path — search, inventory, `read_passage`, browse, surfacing,
`view_image` — stays inside that list. Chunks carry no folder or document id;
the folder filter is applied after retrieval (ADR-0049).

The product owner decided (2026-10-01): roles are managed in WorkOS, as custom
roles (workos.com/docs/rbac/custom-roles), and anything role-shaped held
outside WorkOS moves there; organization admins see everything.

## Decision Drivers

* A restriction must hold in retrieval by construction, not by every read path remembering it.
* An office builds its own roles without the Piloti team, and assigns them where it already
  assigns roles.
* Files uploaded into a restricted folder later are restricted too.
* Someone must always be able to see and change a restriction (no lock-out).
* No second source of truth for who holds which role (ADR-0007).

## Considered Options

* **Who:** WorkOS custom roles (organization-scoped, named on the folder) · WorkOS Groups ·
  a Grid-owned group table.
* **Where it is enforced in retrieval:** a deny-list of files in the signed envelope, applied at
  each Python read path · a separate retrieval collection per restricted folder, included in the
  signed scope only for those cleared.
* WorkOS FGA with a `folder` resource type.

## Decision Outcome

**Who: WorkOS custom roles.** *(The folder's role list and the clearance rule in this
paragraph are superseded by ADR-0087: per-role read/write grants, the minimum over the path;
the session's roles now come from the WorkOS membership, at most 60 s stale.)* An office creates roles such as
„Geschäftsführung" in Piloti (Organisation → Personen & Zugriff → Eigene
Rollen), which calls WorkOS's organization role API: slug `org-…`, permissions
chosen from the organization tier of the catalog, and only permissions the
editor holds (composing a role is granting). Roles are assigned on the People
tab through WorkOS's own widget. A folder names one or more roles
(`project_folders.restricted_roles`). A member is cleared for a folder when they
hold `org:projects:administer` (admins see everything) or, for **every**
restricted folder on its path, one of the roles it names. The session's roles
are the token's `roles` claim, else its single `role`; WorkOS's
environment-wide "multiple roles" switch lets a member hold a clearance role
beside their working role, and until it is on, the clearance role is the
member's role and carries the permissions they work with.

**Where: a restricted folder is its own collection.** A document under a
restricted folder is ingested into `<project collection>_r<12 hex of the
folder id>`, the collection of its nearest restricted ancestor. The BFF adds
that collection to the signed scope, as shelf `project`, only for a member
cleared for it, and only for interactive chat turns. Deep research and
scheduled tasks, whose reports are filed for the whole project, never include
it. Every Python read path already stays inside the scope, so a new tool
inherits the restriction without knowing it exists. Restricting a folder,
opening it, or moving a document across the boundary re-ingests the affected
documents into the right collection: chunks are purged from the old collection
before the row moves, so the restriction is in force before the new copy
exists.

**The BFF's read paths ask one decision point.** `lib/authz/folder-access.ts`
answers, per session and project, which folders are hidden and which restricted
collections are cleared. Listing, search, by-name resolution, the upload name
probe, item routes, folder listing, the folder-upload resolver
(`folders/ensure`), the project overview, document-role bindings, every BIM
read path, the quarantine queue and resource access (inbox, sharing) all take
its answer. A folder a member is not cleared for is absent, not greyed out.
Deleting a restricted folder, or moving a folder so the restricted folders
above it change, is a change of folder access: it requires `project:manage`
and is audited as `project.folder.access_changed`, like drawing a restriction.

**Indirect leaks** are closed where the answer can travel. *(Superseded by ADR-0087: the
mark, the per-turn confinement check and the `4412` close are replaced by a per-person record
of the source folders a conversation drew on, admitted per tool round and judged against the
folders' current access.)* A conversation that
ran a turn with a restricted collection in its signed scope cannot be shared,
escalated or widened beyond its owner: the per-turn confinement check records
the turn (a `conversation_restricted_turns` row, replaced before it shipped) before the turn
produces anything, because the inventory block can put a restricted summary
into an answer that cites nothing, and because a share made while the answer
streams must already be refused. Stored answers that cite or read a restricted
collection remain a second signal, and a share that races the turn's check is
undone after its write. A thread that is already shared never gets restricted
collections in its scope; because a socket's scope is signed once, the chat
socket asks the BFF before every such turn whether the thread is still its
asker's alone, and closes the socket when it is not. The cached project
context names no document in a restricted folder; a chat turn whose signed
scope carries a restricted collection gets an uncached context built for its
session. A generated document filed into a restricted folder is indexed into
that folder's collection.

**Escalated** means every door that writes something the whole project reads,
and each refuses at the BFF service a client cannot route around, with a typed
403 (`CONVERSATION_CONFINED`, `details.action`) whose sentence says why
(`lib/conversations/restricted-egress.ts`, German and English in
`errors.confinement`). A conversation counts as confined when the share refusal
would say so (`isConversationConfined`: the mark, or a stored answer that cites
or read a restricted collection), and a call carrying the turn's verified
envelope is also refused on the envelope's own restricted collections:

- a deep-research run (`commissionResearchRun`, from the agent's
  `POST /api/internal/tasks` and the UI's `POST /api/projects/[id]/runs`): its
  question and context are model-written with restricted content in front of
  the model, its job gets an open scope and digest, and its title, plan and
  report are listed to every member;
- a task (`delegateTask`), for the same reason;
- a `project_profile_patch` accepted from such a thread
  (`POST /api/projects/[id]/profile/patches` with the card's `conversationId`):
  the profile is read by every member and every chat;
- a filing (`fileGeneratedDocument` for drafts and diagrams, and the agent
  rewriting a draft's content): allowed only into a folder whose path carries
  every current restricted collection of the project, so that whoever can open
  the document is cleared for everything the thread could have drawn on.
  Generated documents go to the root folder „Berichte", so in practice this
  refuses unless „Berichte" is itself the project's one restricted folder.
- a run's Unterlagen (`requirePlanDocumentsOpen`, `details.action`
  `planDocument`), in `commissionResearchRun` on both lists and in
  `addRunDocument`. This door is about the document, not the conversation: a
  cleared member can pick a restricted document from their own inventory in an
  open thread, and its name and title then reach every member through the
  run's plan, its job stream and the report's „Nicht gelesene Unterlagen",
  which ADR-0084 opens to every `project:chat` member. A plan document is a
  file name, so it is resolved against every project document by that name,
  restricted folders and archived rows included, and refused when any of them
  sits in a folder not every member may read; an Archiv entry is not checked.
  The async proxy does not forward `job/{id}/documents`, so `addRunDocument` is
  the only way a document reaches a running run.

The agent does not offer what will be refused: a turn whose signed scope holds a
restricted collection withdraws deep research and tasks for the turn, its
prompt names the shut doors and the reason, the one validator of model-composed
cards refuses a `project_profile_patch`, and a commission the BFF refuses as
confined is answered with that reason and never run in process. The job
runner's reflection carries no restricted-scope check: a run's scope is never
restricted, so such a check could not fire, and the input that could carry
restricted content is refused where the run is commissioned.

**Nothing from a restricted turn is remembered.** Project memory is read by
everyone on the project, and organization memory by every project, so a turn
whose scope holds a restricted collection it may draw on, or whose
conversation already drew on a restricted folder, writes no memory: the
`remember` tool refuses (project and organization scope alike) and emits no
`memory_proposal` card, because accepting a card is the same write by another
door, and the reflection stage skips the turn (`restricted_content`). The test
is the scope and the conversation's record, not the hits: the history the turn
answers from may already hold what an earlier turn read.

**Re-classified here as "roles outside WorkOS"** and fixed: third-party
permission checks (invitations, quarantine reviewers, storage alerts) consulted
only environment roles and the catalog, so an office's own roles were invisible
to them. They now ask WorkOS for the organization's roles first.

### Consequences

* Good, because retrieval cannot return restricted content to someone not cleared: the
  collection is not in their scope, whatever tool asks.
* Good, because roles live in one place (WorkOS), are built by the office, and are assigned
  where roles are already assigned.
* Bad, because changing a restriction re-ingests the folder's documents: minutes, and model
  cost, for a large folder. The folder reads as being processed meanwhile.
* Bad, because a WebSocket's signed scope is fixed for the socket's lifetime, so a withdrawn
  role takes effect on the next connection, not mid-conversation. (A thread shared mid-socket
  is caught: the per-turn confinement check closes the socket.)
* Bad, because a conversation that can read a restricted folder remembers nothing. Every chat
  of a cleared member in a project with a restricted folder is such a conversation, so for
  them Piloti's memory is off in chat in that project: the safe direction, but a loss.
* Bad, because nothing a whole project reads can come out of a restricted conversation: no
  deep-research run, task or profile patch, and no filing except into a folder restricted as
  narrowly as every restricted folder of the project. The scope builder gives a cleared member's
  private chat every restricted collection they are cleared for, from its first turn, so EVERY
  chat of a cleared member (an organization admin is cleared for every folder) in a project with
  a restricted folder is such a conversation: for them, deep research, tasks and profile patches
  are unavailable from chat in that project. A per-chat choice to leave restricted folders out of
  the scope would give them back; that is a product decision this change does not take. The
  person can still edit the brief, or upload a file themselves: a deliberate human act, which
  the product does not try to prevent.
* Bad, because a `project_profile_patch` card and a diagram name their conversation in the
  request body. A client that leaves it out writes what it sends as a person would by hand; the
  refusal holds for the card and the diagram button, not for a caller writing its own request.
* Bad, because a move whose purge fails (backend unreachable), a document whose ingest is
  still running, and a restriction over more documents than one call moves (100) leave
  documents in the open collection until a later call or the scheduler's placement sweep
  reaches them. The sweep walks every restricting project round-robin, 50 per tick.
* Bad, because whoever holds `org:members:manage` assigns roles, and so can assign themselves
  a clearance role. That is the trust WorkOS role assignment already carries; WorkOS records
  each assignment.
* Bad, because with "multiple roles" off, a clearance role must also carry its holder's working
  permissions; offices that want clearance separate from function need that switch on, which
  is environment-wide and set in the WorkOS dashboard.
* Bad, because filename uniqueness is per collection in the database: two documents of the same
  name, one restricted and one open, are prevented by the upload path, not by a constraint.
* Bad, because BIM model data is keyed by project, not collection, and an IFC digest's chunks
  are filed under `digest.md`, a name the placement purge does not address. Restricted folders
  therefore refuse IFC models: an upload into one, a document moved into one, a folder holding
  one moved under one, and a restriction drawn over one each answer 409
  (`lib/projects/ifc-folder-guard.ts`). A model filed in a restricted folder before that
  refusal existed is hidden on every BIM read path, but its digest may remain searchable in
  the open collection until it is moved out.

### Confirmation

* `lib/authz/folder-access.spec.ts` pins the clearance rule (nested restrictions, admin bypass,
  roles claim).
* The real-Postgres suite (`task db:test:rls`) seeds a restricted folder and proves each listing
  repository hides its documents from a member not cleared.
* `collection-scope-request.restricted.spec.ts` proves the restricted collection is in a cleared
  member's chat scope and absent from an uncleared member's, from a shared thread's, and from
  every deep-research and scheduled scope.
* `collection-placement.integration.spec.ts` proves against Postgres that the purge comes before
  the re-point, a failed purge leaves the row, the sweep finishes it, a misplaced row behind a
  thousand placed ones is moved, an in-flight row waits, and a project beyond the first page of
  restricting projects is swept.
* `restricted-turn-sequence.spec.ts` proves a share made after a turn's confinement check
  (mid-stream, nothing stored) is refused; `restricted-turns.integration.spec.ts` proves the
  mark's upsert, RLS and erasure against Postgres.
* `ifc-folder-guard.spec.ts`, `model-service.folder-access.spec.ts` and the IFC describe in
  `folder-access.integration.spec.ts` pin the BIM side; `folder-service.access-change.spec.ts`
  pins the `project:manage` rule for folder deletes and moves.
* `test_chat_socket.py` and `test_internal_api_confinement.py` prove the per-turn confinement
  check closes a socket whose thread was shared, and fails closed.
* `restricted-egress.spec.ts` pins which conversations are confined and each refusal;
  `delegation.spec.ts` proves a run and a task are refused before any row exists (mark, cited
  restricted answer, signed scope); `generated.spec.ts` and `diagrams/filing.spec.ts` prove a
  filing into an open folder is refused before anything is rendered or written and one into a
  folder restricted as narrowly goes through; the profile-patch route spec proves a confined
  card's patch is refused with a typed 403 and writes nothing; `lifecycle.spec.ts` and the
  internal document-versions and tasks route specs pin the joins; `folder-access.spec.ts` pins
  `restrictedCollectionsOnPath` against the clearance rule.
* `tests/aiq_agent/turn/test_context.py` and `test_confined_turn.py` prove a confined turn
  withdraws deep research and tasks, renders the shut-doors block and refuses a
  `project_profile_patch` card; `test_commission.py` and `test_deep_research_gate.py` prove a
  confined refusal is told as such and never run in process.
* `tests/aiq_agent/memory/test_register.py`, `stages/test_memory_reflection_stage.py` and
  `turn/test_response.py` prove a turn with a restricted collection in scope, or whose
  conversation drew on a restricted folder, writes no memory and offers no card.
* `authz-coverage.spec.ts` covers the new routes.
* Nothing enforces yet that a NEW read path asks `folder-access.ts`; review is the gate for that.

## Pros and Cons of the Options

### WorkOS Groups

* Good, because a group is exactly "a set of people", separate from permissions.
* Bad, because group membership is not in the token: every request would call WorkOS.
* Bad, because the product owner chose roles, which offices already know from the People tab.

### A deny-list in the envelope

* Good, because nothing moves when a restriction changes.
* Bad, because about ten Python read paths would each have to apply it, and an absent field
  would have to be read as "deny" to fail closed. The next tool written would leak.

### WorkOS FGA folder resources

* Bad, because FGA is additive only: it cannot express "this child folder is narrower than its
  project" (exclusions are "coming soon" in WorkOS's docs).
* Bad, because every folder would be mirrored into WorkOS, a second source of truth.

## More Information

* Feasibility study of the Python side, and the touch-point table:
  `plans/2026-10-01-upload-governance-worklog.md`.
* ADR-0007 (no local identity sync), ADR-0038 (one decision point), ADR-0047 (shelf travels as
  data), ADR-0049 (folders as a materialised path).
