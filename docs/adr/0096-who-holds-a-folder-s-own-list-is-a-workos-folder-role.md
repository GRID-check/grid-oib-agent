---
status: accepted
date: 2026-10-09
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Who holds a folder's own access list is a WorkOS folder role

> **Supersedes the "who" of [ADR-0087](0087-folder-access-follows-workos-roles-and-a-restricted-folder-is-its-own-collection.md)
> and [ADR-0088](0088-folder-access-is-read-write-per-role.md):** a folder's own list no longer names
> organization roles in `project_folder_grants`; it is a WorkOS `folder` resource on which people hold a
> folder role. Everything else those two decided still holds: the minimum over the path, the
> project ceiling, the admin bypass, the retrieval collection per read-restricting folder, the
> egress refusals, the per-person record of source folders, and tombstones that keep answering.

## Context and Problem Statement

ADR-0087 put folder access on WorkOS custom roles, and ADR-0088 gave each folder its own list
of role grants with a level each, stored in `project_folder_grants` and evaluated by our own
rule. Projects, meanwhile, already sit on WorkOS FGA: a project is a WorkOS resource, a
project role is assigned on it, and `authorization.check` answers who may do what
(ADR-0038).

The product owner decided (2026-10-09) that the folder half is the wrong way round: WorkOS has
resource types for exactly this, and access to a folder should be held there, on the folder,
rather than in a grants table of ours keyed by role. Roles were also the wrong subject for a
folder: an office restricts the fee agreements to the two people who negotiate them, not to
whoever holds a role.

## Decision Drivers

* Buy, don't build: who holds access is WorkOS's domain, as it already is for projects.
* A folder can still be narrower than its parent and than its project, and never wider.
* One decision point stays one (ADR-0038): every caller keeps asking `folder-access.ts`.
* Nothing that was restricted becomes readable during the change.
* WorkOS's limits, verified against the live Staging environment on 2026-10-09: a resource type
  cannot be its own parent ("Adding this parent type would create a cycle"), a hierarchy is
  five levels deep at most, a resource cannot be moved to another parent, roles only ADD down a
  tree (exclusions are "coming soon"), and about 5,000 resources of one type per organization is
  the soft limit.

## Considered Options

* **Folders with their own list are `folder` resources directly under their project; access is a
  folder role assigned to a person; the walk over the path stays ours** (chosen).
* Every folder a `folder` resource, mirroring the tree in WorkOS.
* Keep ADR-0088's role grants in Postgres.

## Decision Outcome

Chosen option: register only the folders that have their own list, flat under their project,
because it is the one shape WorkOS can hold that keeps nesting narrowing.

**The resource.** A folder with its own list (`project_folders.access_mode = 'custom'`) is a
WorkOS resource of type `folder`, external id = the folder id, parent = its PROJECT whatever
its depth. A folder that inherits is not registered. Moving a folder inside its project never
touches WorkOS, and the hierarchy is three levels deep for any tree.

**The roles.** `folder-reader` holds `folder:read`; `folder-editor` holds `folder:read` and
`folder:write` (`lib/authz/catalog.ts`, provisioned by `provision:authz`). They are assigned on
the folder to an organization membership. **No project role holds a `folder:*` permission**, so
being in the project grants nothing on a registered folder: that is how a folder is narrower
than its project without an exclusion.

**Everyone reads.** The one part of a list that names no person stays on the folder row,
`project_folders.everyone_reads` (migration 0128; the old reserved `*` entry): every project
member reads it, and the folder roles decide who may write. A list must name at least one person
or have everyone reading it.

**The decision.** A person's clearance in a project is the level their folder roles give on each
registered folder there: two `listResourcesForMembership` calls (`folder:read`, `folder:write`)
scoped to the project, cached for `GRID_AUTHZ_CACHE_TTL_MS` like every FGA answer, dropped for
everyone a change touches, and skipped entirely for a project with no folder of its own (one
indexed probe). `effectiveFolderLevel` is unchanged in shape: the minimum over the folder and
every ancestor with its own list, each list now answering with the level the person holds there
(or read when everyone reads). WorkOS only adds access down a tree; the narrowing walk is ours.
Organization admins write everywhere, from the admin bypass as before. A lookup that fails
clears nothing.

**Writing a list** (`setFolderAccess`) orders its writes so no moment is wider than the old or
the new list: to give a folder its own list, register it and assign the roles first, then flip
the row to `custom`; to make it inherit, flip the row first, then delete the resource. Replacing
the people removes before it assigns. Folder roles on a folder that inherits are never read.

**Purge and tombstones.** A deleted folder's resource is kept, as its row is, because what was
derived from it is still judged by who could read it (`unchanged` policy).

**The carry-over.** Migration 0128 turns a `*` entry that read into `everyone_reads`, and a `*`
entry that wrote back into `inherit` (everyone writing is what inheriting gives). The role
entries become folder roles of the people who hold those roles today
(`bun run migrate:folder-grants`, plan by default, `--apply` to write). Until it has run, a
folder with its own list is readable only by organization admins and, when everyone reads it,
by every project member: the narrow direction. `project_folder_grants` is dropped by a later
migration once the script has run in every environment.

### Consequences

* Good, because who holds access to a folder is held where access to a project is, checked the
  same way, and visible in the WorkOS dashboard.
* Good, because a list names people, which is what offices restrict to.
* Good, because the 60-second role cache, the grants table and the grant-count trigger are no
  longer in the folder decision.
* Bad, because a role grant followed the role and a folder role does not: someone given the role
  later no longer reaches the folder. Lists of whole groups of people wait for WorkOS groups,
  which a later change can assign the same folder roles to.
* Bad, because opening a project with a folder of its own costs two WorkOS calls per person per
  cache period, and changing a list is several WorkOS writes instead of one transaction.
* Neutral, because the walk over the path stays in our code: WorkOS cannot narrow.

### Confirmation

* `lib/authz/folder-access.spec.ts` pins the rule over levels; `folder-roles.spec.ts` pins the
  WorkOS calls, the fail-closed read and the remove-before-assign order;
  `folder-access-settings.spec.ts` pins the write order.
* `catalog.spec.ts` fails when a tier has no resource type, and `provision:authz --check` fails
  CI when WorkOS drifts from the catalog.

## Pros and Cons of the Options

### Every folder a `folder` resource, mirroring the tree

* Good, because WorkOS would hold the whole tree.
* Bad, because a `folder` cannot be the parent of a `folder` (WorkOS refuses the cycle), a tree
  deeper than five levels does not fit, and a move would be a delete and re-create of a subtree.
* Bad, because inheritance only adds, so a narrower subfolder still needs our walk.
* Bad, because mail imports and the Büroablage create many folders, toward the 5,000 soft limit.

### Keep the role grants in Postgres

* Good, because nothing changes.
* Bad, because it keeps a second place, ours, deciding who holds access, which is what the
  product owner rejected, and lists name roles where offices mean people.

## More Information

* Implementation: `lib/authz/folder-roles.ts` (every WorkOS call), `lib/authz/folder-access.ts`
  (the clearance), `lib/authz/folder-access-rule.ts` (the walk), `lib/projects/folder-access-settings.ts`
  (writing a list), `scripts/migrate-folder-grants-to-workos.ts` (the carry-over).
* ADR-0038 removed a `document` resource type because a resource per file is an unbounded
  synchronisation problem. A resource per restricted folder is bounded by how many folders an
  office restricts, and changes only when someone edits a list.
