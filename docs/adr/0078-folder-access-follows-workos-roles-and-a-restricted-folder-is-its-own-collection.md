---
status: accepted
date: 2026-10-01
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Folder access follows WorkOS roles, and a restricted folder is its own retrieval collection

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

**Who: WorkOS custom roles.** An office creates roles such as
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
probe, item routes, folder listing, the quarantine queue and resource access
(inbox, sharing) all take its answer. A folder a member is not cleared for is
absent, not greyed out.

**Indirect leaks** are closed where the answer can travel. A conversation whose
answers cite a restricted collection cannot be shared beyond its owner. The
agent writes nothing to project memory in a turn that read restricted content.
A generated document filed into a restricted folder is indexed into that
folder's collection.

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
  role takes effect on the next connection, not mid-conversation.
* Bad, because with "multiple roles" off, a clearance role must also carry its holder's working
  permissions; offices that want clearance separate from function need that switch on, which
  is environment-wide and set in the WorkOS dashboard.
* Bad, because filename uniqueness is per collection in the database: two documents of the same
  name, one restricted and one open, are prevented by the upload path, not by a constraint.
* Bad, because BIM model queries are keyed by project, not collection: an IFC model in a
  restricted folder is listed as hidden but its building data is not partitioned. Restricted
  folders should not hold IFC models until that is closed.

### Confirmation

* `lib/authz/folder-access.spec.ts` pins the clearance rule (nested restrictions, admin bypass,
  roles claim).
* The real-Postgres suite (`task db:test:rls`) seeds a restricted folder and proves each listing
  repository hides its documents from a member not cleared.
* `collection-scope-request` specs prove the restricted collection is in a cleared member's chat
  scope and absent from an uncleared member's, and from every deep-research scope.
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
