---
status: accepted
date: 2026-10-06
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# A closed project is read-only and open to the whole office

## Context and Problem Statement

Ticket 1, „Abgeschlossene Projekte mit Eckdaten": an office finishes a building
project and wants to keep it, with its Eckdaten, as reference that everyone can
search. Until now a project had one lifecycle, soft delete then purge
(`lib/projects/service.ts`), and was visible only to the people holding a WorkOS
FGA grant on it (ADR-0038). A finished project either stayed "active" for ever or
was deleted, and the staff who joined later never saw it.

The re-triage of 6 Oct 2026 (`docs/audit/upload-and-filing-retriage-2026-10-06.md`,
ticket 1) put five questions to the product owner, who decided the same day:
every office member may read a closed project and search it; folders with their
own access list stay restricted exactly as before; a closed project is read-only
for files, folders, the profile and project memory, while chat stays allowed;
`project:manage` closes and reopens, both audited.

## Decision Drivers

* Closing must never widen access to a restricted folder, and neither may reopening.
* Read-only must hold for organization admins too, and for the agent's service-token doors.
* One place decides, so no write path can forget the status.
* Closing destroys nothing: the project stays searchable, and a reopen restores it as it was.

## Considered Options

* **A status column, checked at the project seam before the admin bypass** (chosen).
* Close by revoking every write grant in WorkOS FGA and granting every member `project:view`.
* Close by moving the project into the Archiv shelf.

## Decision Outcome

Chosen option: a status column on `projects` checked in `requireProjectAccess`,
because every project permission check already loads the project row there, so
one decision covers every write path at once, and nothing in WorkOS has to be
rewritten and later restored.

**The model.** `projects.status` is `active` or `closed`; `closed_at` and
`closed_by` are set exactly when it is `closed` (migration 0115, two CHECKs).
`PUT /api/projects/{id}/status` closes or reopens (`setProjectStatus`), needs
`project:manage`, and writes `project.closed` or `project.reopened` to the audit
log. A project already in the requested state is a 409, so a double click
writes one event.

**Read-only is decided before the admin bypass.** In a closed project
`requireProjectAccess` keeps only the permissions a closed project allows
(`CLOSED_PROJECT_KEEPS` in `lib/projects/project-status.ts`): `project:view`,
`project:chat` and `project:members:manage`. A request whose every permission is
a write is refused with a 403, `details.reason: 'project-closed'`, which names
the project's state because every member may see that it exists. The database's
own refusal (`GPC01`, below) answers the same 403 at the BFF's error boundary
(`errorResponse`). The upload and the folder delete, the two writes a tab left
open across a close still offers, name it in the reader's language; other
surfaces show their own refusal. Deep research
and tasks (`project:documents:generate`, `project:skills:manage`) are refused:
the safer reading of the product owner's "may be refused or allowed", because
both file into the project or run on a schedule as if it were live. Refusing
alone was not enough: the agent offered research („Recherche starten") and the
run was refused only after the reader approved its plan. The per-turn flags
(`/api/internal/stages`) now take the turn's project, and a closed one answers
`deepResearch: false` and `tasks: false`, so the turn stays a plain answer
(product owner, 7 Oct 2026). A direct `POST /api/jobs/async/submit` naming a
closed project is refused with the same 403. The thread's own commissioning
(„Klären" on an open finding, „Bericht fortschreiben" on a run) is not offered
either (`useCommissionRun` is null); the matrix and the run block say
„Abgeschlossenes Projekt: keine neue Recherche" where the button would be. When
the agent cannot reach `/api/internal/stages`, `stages/flags.py` keeps its
existing fallback, `deep_research_allowed=True`: research may then be offered
in a closed project, and the run is refused at submit.

**Runs in flight are not cancelled by closing.** A run commissioned before the
close finishes; its report lands in its conversation, which chat still allows,
and filing it as a project document is refused like every other write. Who may
steer a run (cancel it, have it write now) is its requester or a member of the
project, never someone who reads the project only because it is closed; handing
a run a document is a write and is refused.

**The Papierkorb is the one exception.** Restoring a folder undoes a deletion
rather than adding content, and the 14-day purge keeps running after a close,
so whoever holds `project:manage` may restore in a closed project (with write
on the folder, as always). Deleting, moving and purging stay refused. A schedule
in a closed project is recorded as a skipped run, so a reopen resumes it.
`project:manage` is refused too, because it also renames, changes folder access
and empties the Papierkorb; closing, reopening, deleting and restoring a closed
project ask it with `evenWhenClosed`. Deletion stays possible: it is the GDPR
path, soft, with its grace period. `decide` labels the refusal `project-closed`,
so every capability flag reads false and the UI hides its controls.

**Every member reads a closed project.** When the FGA check finds no grant and
every permission asked is `project:view` or `project:chat`
(`CLOSED_PROJECT_OPEN_TO_ORGANIZATION`), the caller gets the viewer rung with
`readsBecauseClosed: true` (`decide` rule `closed-project-open`). `listProjects`
lists every closed project without asking WorkOS. `userHoldsProjectPermission`,
the third-party form, mirrors both rules.

**Reading is not steering.** ADR-0084 lets a caller read and control every job
in the project the BFF signs into a job request. Someone who reads a closed
project only because it is closed may follow and steer their own runs, not a
colleague's, so `buildCollectionScopeFromRequest` reports `projectReadOnly` and
`signJobRequestContext` then signs neither the project nor its project-shelf
collections. The backend lets that caller reach the jobs they own, and read
others through a conversation they may view. The run controls in
`lib/runs/service.ts` apply the same rule before they call the backend
(`requireRunActor`).

**Closing opens no restricted folder.** The folder rule (ADR-0087) assumes the
caller is a member of the project: grants name organization roles, so a person
holding the Geschäftsführung role in a project they never belonged to would
otherwise read its Verträge folder once it closed. A clearance is therefore
always a clearance in one project: `clearanceOf(session, projectId)` and
`clearanceOfMember(organizationId, userId, projectId)` answer, for someone who
reads a closed project only because it is closed, what a member holding no role
clears (`ANY_MEMBER`): the folders open to every member (`*`), and no folder
with a role list. A member keeps exactly what their roles gave them; an
organization admin keeps the bypass. The signature change made the compiler
find every caller (conversation sharing, restricted memory, the agent's
digest, the Papierkorb). The folders granted to `*` open with the project, as
the re-triage said they would: `*` means "everyone who can open the project",
and their documents already live in the project's open collection.

**The agent's doors.** The pinned-session routes reach `requireProjectAccess`
through their services. The two that hold no session check the status
themselves: an agent memory write (`createProjectMemoryItemForProject`) is
refused, and a scheduled task is skipped. Behind all of it, migration 0115's
trigger refuses an INSERT of a document, folder, document version or project
memory row into a closed project (SQLSTATE `GPC01`), reading the project row
`FOR SHARE` so a close and an insert serialize. Updates pass: ingestion
finishing for a file uploaded before the close, and the Papierkorb's sweeps.

**Visibility.** Every page of a closed project opens with a banner (closed
since when, read-only, and for an outsider why they see it). A closed project's
file says so wherever it appears: the projects list (chip and the Aktiv /
Abgeschlossen / Alle filter), the preview pane, the chat's source chips and the
download log. The layout provides `CurrentProjectProvider`, so a surface inside
the project reads the status without asking again.

### Consequences

* Good, because one seam decides; a new write path that asks `requireProjectAccess` is read-only in a closed project without knowing it.
* Good, because closing changes nothing in WorkOS, so reopening restores exactly what was.
* Good, because the database refuses what the application forgot to.
* Bad, because a clearance now reads the project's status, one indexed probe, and for a closed
  project one FGA check per person; only in projects with a folder that has its own list.
* Bad, because the derived role of a closed project's editor is still `project-editor`: a
  surface that reads the role, not a permission, must also read `closed` (the settings page does).

### Confirmation

`lib/authz/projects.spec.ts` (writes refused for an editor and an admin, reads open to
non-members), `lib/authz/folder-access.spec.ts` (the outsider clearance), and
`lib/projects/project-status.integration.spec.ts` on real Postgres through
`scripts/rls-test-db.sh`: the real tree, rule and listing SQL show a person holding the
granted role not seeing a restricted folder of a closed project, before and after a
reopen; the CHECKs; and the trigger. The script also takes 0114 down and up.

## Pros and Cons of the Options

### Revoke and grant in WorkOS FGA

* Good, because the existing checks would answer without code.
* Bad, because reopening has to restore every grant exactly, from a record of them we would have to keep.
* Bad, because the folder rule would then match every member's roles: the leak this ADR prevents.

### Move the project into the Archiv

* Good, because the Archiv is already readable by every member.
* Bad, because the Archiv cannot restrict a folder (re-triage, cross-cutting section), so every restricted folder would open.
* Bad, because it re-ingests everything into another collection and breaks citations.

## More Information

* Re-triage: [`audit/upload-and-filing-retriage-2026-10-06.md`](../audit/upload-and-filing-retriage-2026-10-06.md#1-abgeschlossene-projekte-mit-eckdaten--l-overall-first-slice-sm).
* Folder access: [ADR-0087](0087-folder-access-is-read-write-per-role.md). Authorization: ADR-0038.
* User guide: [`user-guides/projects.md`](../user-guides/projects.md#closing-a-project).
* Table: [`database/schema.md`](../database/schema.md#projects).
