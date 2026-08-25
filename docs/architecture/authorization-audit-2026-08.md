# Authorization / Permissions System — Audit (2026-08)

> Full review of the access-control plane: the permission catalog, the four
> tiers (`org`, `platform`, `project`, `skill`), the route-factory contract, the
> project-membership roster, and the sharing layer's container precondition.
> Complements [ADR-0016](../adr/0016-platform-tier-and-permission-registry.md),
> [ADR-0038](../adr/0038-one-authorization-catalog-and-decision-point.md) and
> [ADR-0041](../adr/0041-row-level-security-for-tenant-isolation.md), and sits next to
> [multitenancy-and-auth-spec.md](./multitenancy-and-auth-spec.md).
>
> Scope reviewed: `frontends/ui/src/lib/authz/*`, `lib/api/handler.ts`,
> `lib/api/platform-handler.ts`, `lib/projects/{service,members-service,repository}.ts`,
> `lib/sharing/access.ts`, `lib/documents/service.ts`,
> `lib/project-profile/profile-service.ts`, `lib/bim/model-service.ts`,
> `lib/proxy/collection-authz.ts`, `lib/collection-scope-request.ts`,
> every `src/app/api/**/route.ts` authz declaration,
> `scripts/provision-workos-authz.ts`, and
> `frontends/aiq_api/src/aiq_api/jobs/access.py`.
>
> **This audit changes no authorization behaviour.** Every finding below was
> confirmed against the code, and F2, F3 and F7 were additionally reproduced with
> throw-away probe specs run against the real modules (removed again — the
> reproductions are written out inline so they can be re-run).
>
> Baseline at time of writing: `npx tsc --noEmit` clean; the authz suites
> (`lib/authz/*`, `app/api/authz-coverage.spec.ts`, `lib/projects/members-service.spec.ts`)
> 77/77 green, and the full frontend suite 7923 passed / 82 skipped (594 files).

## 1. Executive summary

The project tier — the part that was asked about — **is the strongest part of
the system and it works**. Tenancy is checked first and bypassed by nobody, the
FGA round-trip fails closed, denials are 404 so no response is an existence
oracle, the project listing is FGA-filtered rather than org-filtered, soft-deleted
projects are unreachable for everyone including org admins, and the last-admin
invariant holds on every role change. `apiRoute` does not compile without an
`authz` declaration and `authz-coverage.spec.ts` catches anything that escapes the
factories. Nothing in this audit is a cross-tenant leak.

What is wrong is **the gap between the access model the catalog advertises and
the one the code enforces**. Three of the roles ADR-0038 shipped specifically to
prove the extensibility contract do not behave as documented:

- **`project-contributor` does nothing** (F1). Its distinguishing permission,
  `project:chat`, is defined in the catalog, exported from the registry, typed in
  `ProjectPermission` — and **checked in zero places**. Every chat entry point
  gates on `project:view`. So `project-viewer`, documented "Read-only on one
  project", can start conversations and spend LLM budget; the role that was
  supposed to draw that line cannot even be assigned from the UI.
- **`org-platform-support` is not read-only** (F2). Every platform route is
  gated by one binary — `requirePlatformOwner` — and Support passes it. It can
  PUT the platform model defaults, DELETE base-corpus documents, and rewrite
  retrieval settings. ADR-0038 lists "read-only platform staff … now
  constructible without code changes" as a consequence; that is currently false.
- **A restricted org admin is not constructible for projects** (F3). The
  org-admin project bypass keys off the *role slug* `'admin'` in three separate
  places, not off a permission. A custom role holding every `org:*` permission
  gets no project access at all; a role that merely happens to be *named*
  `admin` administers every project in the org while holding nothing.

Underneath that, **`lib/authz/decide.ts` — which `AGENTS.md` calls "the single
decision point" — has zero callers and no spec** (F4). ADR-0038 §6 is honest that
it was additive and adoption incremental; adoption is still at zero. So the named
rules that were supposed to make bypasses visible (`org-admin-bypass`,
`platform-membership`) are never produced by anything, and the `skill` tier exists
only inside that dead module (F5).

F1 and F2 are the two that change who can do what today. F3 is the one that
makes the whole "permission-driven, never role-name driven" claim untrue at its
most load-bearing point.

## 2. What is sound

Recorded so it is not re-litigated, and because it is most of the system.

| Property | Where |
|---|---|
| Tenancy checked first, bypassed by nobody — not org admins, not platform owners | `lib/authz/projects.ts:60-68` |
| The cross-tenant probe used to establish tenancy reads *only* `organizationId`/`deletedAt`, under a named bypass | `lib/projects/repository.ts:88-100` |
| FGA check fails closed on any transport/SDK error | `lib/authz/resource-check.ts:54-74` |
| So do the third-party checks: subject membership, project reachability, platform membership, platform-org resolution | `lib/authz/project-membership.ts:58-61,113-118`; `lib/authz/platform.ts:89-91,121-123` |
| Resource tiers deny with 404, never 403 — no existence oracle | `lib/authz/projects.ts:66,93`; `lib/authz/decide.ts:297` |
| `listProjects` filters per-project via FGA; the grid derives counts and activity from the *filtered* list | `lib/projects/service.ts:58-110` |
| Soft-deleted projects are unreachable for everyone, org admins included | `lib/authz/projects.ts:63-68`; `app/app/(shell)/projects/[id]/layout.tsx:74-80` |
| Project *name* is withheld from `generateMetadata` without `project:view` | `app/app/(shell)/projects/[id]/layout.tsx:39` |
| `apiRoute` will not compile without `authz`; the coverage spec catches handlers that escape the factories, and all five hand-rolled routes carry a written gate | `lib/api/handler.ts:97-118`; `app/api/authz-coverage.spec.ts` |
| Last-admin invariant on both role change and bare assignment removal | `lib/projects/members-service.ts:49-63,186,244` |
| Authz cache defaults **off**, is keyed per membership *and* resource type, and never caches tenancy | `lib/authz/resource-check.ts:27-48` |
| Break-glass platform access is audited, throttled per actor **and** active org | `lib/authz/platform.ts:44-79` |
| Losing a project role settles collaboration state that depended on it, and keeps grants inert-but-restorable | `lib/projects/members-service.ts:251-266` |
| Backend async-job access is a strict owner match, 404 on mismatch | `aiq_api/jobs/access.py:309-335` |
| Platform-tier separation is asserted in a spec, since WorkOS will not enforce it | `lib/authz/catalog.spec.ts:55-70` |

## 3. Findings

### F1 — `project:chat` is never checked; `project-contributor` is unreachable and misreported

`project:chat` exists in exactly three places, all of them declarations:

- `lib/authz/catalog.ts:236-241` (the spec)
- `lib/authz/permissions.ts:65` (the registry constant)
- `lib/authz/projects.ts:10` (the union member)

There is no fourth. `grep -rn "project:chat" src` returns no enforcement site.
Every path that starts or continues a conversation gates on `project:view`:

- `lib/conversations/service.ts:270` — create a project-scoped conversation
- `lib/conversations/service.ts:189` — list a project's conversations
- `lib/collection-scope-request.ts:171,179` — the collection scope handed to the
  chat/WebSocket transport

Consequences, all live:

1. **`project-viewer` can chat.** The catalog describes it as "Read-only on one
   project: its documents, memory and conversations" (`catalog.ts:482`). It can
   open a thread and spend LLM budget.
2. **`project-contributor` cannot be assigned from the app.** The API schema
   accepts three slugs (`app/api/projects/[id]/members/route.ts:15-16`) and so
   does the form (`components/projects/project-members-form.tsx:75,304`).
3. **If assigned out-of-band in WorkOS, it is displayed as "Viewer".**
   `PROJECT_ROLE_BY_PERMISSION` (`lib/projects/members-service.ts:66-74`) probes
   only `project:view` / `project:edit` / `project:manage`, and a contributor
   holds only the first.
4. **`requireProjectAccess` can never return it** (`lib/authz/projects.ts:85-98`
   derives from those same three), which makes the `'project-contributor'` case
   in `roleFromProjectRole` (`lib/sharing/access.ts:70`) dead code.
5. The Access tab's permission reference renders the catalog directly
   (`features/organization/components/permission-reference.tsx`), so an admin
   auditing the org is shown a chat permission and a Contributor role that the
   app does not implement.

**Fix shape.** Either enforce it — add `project:chat` to the three gates above
(any-of with `project:view` for back-compat during rollout, since existing
viewers would otherwise lose chat) and widen the role schema, roster mapping and
`ProjectRole` union to carry Contributor — or delete the permission and the role
from the catalog. What must not persist is the current state, where the org
Access tab documents an enforcement that does not exist.

### F2 — `org-platform-support` is not read-only; it holds full platform write

Every platform route goes through one gate:

```ts
// lib/api/platform-handler.ts:56
await requirePlatformOwner(session)
```

`requirePlatformOwner` is binary — it never sees which `platform:*` permission
the route needs. And `isPlatformOwner` accepts the *view* permission as proof:

```ts
// lib/authz/platform.ts:147-152
if (session.organizationId === platformOrgId) {
  return (
    session.role === PLATFORM_OWNER_ROLE_SLUG ||
    session.permissions.includes(PLATFORM_PERMISSIONS.organizationsView)
  )
}
```

`org-platform-support` holds `['platform:organizations:view', 'platform:usage:view']`
(`lib/authz/catalog.ts:469-476`). Acting inside the platform org — which is the
only place the role can be assigned — it passes.

Reproduction (probe run against the real module, mocking only the WorkOS client):

```ts
getOrganizationByExternalId.mockResolvedValue({ id: 'org_platform' })
const s = session({
  organizationId: 'org_platform',
  role: 'org-platform-support',
  permissions: ['platform:organizations:view', 'platform:usage:view'],
})
expect(await isPlatformOwner(s)).toBe(true)   // passes
```

That opens eleven mutating endpoints to a role documented as changing nothing:
`PUT platform/model-defaults`, `PUT platform/retrieval-settings`,
`PUT platform/reasoning-efforts`, `PUT platform/norms`, `POST platform/norms/verify`,
`POST|DELETE|PATCH platform/knowledge/documents*`, `POST platform/knowledge/reingest`,
`POST platform/knowledge/sync`, `POST platform/maintenance/reconcile-vectors`,
`PUT platform/organizations/[organizationId]/storage`, and
`POST|PATCH|DELETE platform/skills*`.

The same role is simultaneously **under**-powered: the cross-org path
(`lib/authz/platform.ts:156`) only recognises `org-platform-owner`, so Support
browsing a tenant organization gets nothing at all. Also confirmed by probe.

**Fix shape.** `platformApiRoute` should take the `platform:*` permission the
route needs (the way `apiRoute` takes `{ permission }`), and the claims path
should check *that* permission rather than collapsing all four to
`isPlatformOwner`. `isPlatformOwner` stays as the membership precondition. The
cross-org path should resolve the membership's permissions instead of matching one
role slug.

### F3 — The org-admin project bypass is role-NAME driven, in three places

`AGENTS.md` and ADR-0016/0038 state the model is "permission-driven, never
role-name driven". At the single most load-bearing point it is not:

- `lib/authz/projects.ts:71` — `if (session.role === 'admin') return { role: 'project-admin' }`
- `lib/projects/service.ts:63` — `if (session.role === 'admin') return projects`
- `lib/authz/project-membership.ts:103` — `if (membership.role === 'admin') return true`

(`lib/authz/decide.ts:201` labels its rule off the same string, but see F4.)

Both directions were reproduced:

```ts
// A custom org role holding EVERY org:* permission gets NO project access.
await expect(
  requireProjectAccess(
    s({ role: 'org-owner-custom', permissions: [...all nine org:* slugs] }),
    'p1', 'project:view')
).rejects.toThrow('Not found')            // passes

// A role NAMED admin holding ZERO permissions administers every project,
// without a single FGA call.
await expect(
  requireProjectAccess(s({ role: 'admin', permissions: [] }), 'p1', 'project:manage')
).resolves.toEqual({ role: 'project-admin' })   // passes
expect(check).not.toHaveBeenCalled()            // passes
```

So the extensibility contract holds for org-tier surfaces (those go through
`hasPermission`) and breaks the moment a persona needs to reach projects — which
is every persona an enterprise buyer actually asks for. And a WorkOS role created
with the slug `admin` for unrelated reasons silently acquires every project in the
tenant.

**Fix shape.** Introduce an explicit permission for the bypass — the honest name
is something like `org:projects:administer` — hold it on the `admin` role in the
catalog, and check `hasPermission(session, …)` at all three sites. Keep the
`role === 'admin'` test as a bounded legacy implication exactly the way
`ORG_ROLE_PERMISSIONS` already does it for org-tier claims
(`lib/authz/permissions.ts:107-142`), so sessions minted before the rollout keep
working. All three sites must change together — `project-membership.ts` mirrors
`projects.ts` deliberately, and a divergence there means sharing offers
invitations that resolve to nothing.

### F4 — `lib/authz/decide.ts` has no callers and no spec

`AGENTS.md` §Authorization, point 3:

> **`lib/authz/decide.ts` is the single decision point** across the org,
> platform, project and skill tiers. Every decision carries the named rule that
> produced it, so bypasses (`org-admin-bypass`, `platform-membership`) are
> visible rather than implicit.

Nothing imports it. `grep -rn "authz/decide" src tests scripts` finds only a
prose reference in `lib/db/tenant-context.ts:77`. There is no `decide.spec.ts` —
the seven green authz spec files are catalog, feature-flags, permissions,
platform, projects, members-service and the coverage gate.

ADR-0038 §6 and its consequences section are honest about this (`decide.ts` is
additive; "two routes to the same answer exist until adoption completes"). The
defect is that adoption is at **zero** while `AGENTS.md` states the outcome as
achieved. Concretely: no authorization decision anywhere in the app carries a
named rule, so the audit property ADR-0038 was written to deliver does not exist
yet, and 298 lines of security-critical code — including the only implementation
of the skill tier and the only `tenancy-mismatch` reporting — are untested.

**Fix shape.** Either adopt it (start with the routes that already declare
`{ enforcedBy }` for a single project permission — mechanical, and it makes the
rule visible) or amend `AGENTS.md` to state the position ADR-0038 actually took.
Either way `decide.ts` needs a spec before it takes its first caller.

### F5 — The `skill` tier is provisioned but has no roles and no resources

- `SKILL_PERMISSION_SPECS` defines `skill:view` / `skill:run` / `skill:manage`
  (`lib/authz/catalog.ts:290-308`), and the provisioner creates them.
- **No `RoleSpec` has `tier: 'skill'`.** Nothing in WorkOS can hold them.
- **No skill FGA resource is ever created.** The only `createResource` call in
  the app is for projects (`lib/projects/service.ts:136`).
- So `decideSkillTier`'s check (`lib/authz/decide.ts:225-232`) can only ever
  return false — after a WorkOS round-trip and a `console.warn` — before falling
  back to `SKILL_FALLBACK`. That is documented as the intended design in the
  catalog comment, but the doomed round-trip is not.
- `catalog.spec.ts`'s "registry constants and the catalog agree" test
  (`catalog.spec.ts:116-145`) omits `SKILL_PERMISSIONS`/`SKILL_PERMISSION_SPECS`
  entirely, so the skill tier sits outside the drift check that covers the other
  three.

Currently inert only because of F4. It becomes live the moment `decide()` gets a
caller.

**Fix shape.** Add the skill tier to the catalog-spec agreement test, and either
short-circuit `decideSkillTier` to the project fallback until skill resources are
actually created, or create the resource in `createJob` alongside the project one.

### F6 — The `project:edit` split is half-migrated

ADR-0038 split the `project:edit` umbrella into `project:documents:write` and
`project:memory:write`, and `requireProjectAccess` grew an any-of form so a
legacy role holding only the umbrella keeps working. Ten sites use it. **Seven
still require the deprecated umbrella alone:**

- `lib/project-profile/profile-service.ts:88` (save profile), `:119`,
  `:247` (consistency check), `:305` (generate summary)
- `lib/bim/model-service.ts:337` (confirm check), `:476` (withdraw confirmation)
- `lib/proxy/collection-authz.ts:131` (uploads through the `/v1` collection proxy)

…and **one requires only the narrow permission with no legacy fallback:**

- `lib/documents/service.ts:905` (`reindexProject` → `project:documents:write`),
  where every sibling document write uses the any-of form (`:193`, `:584`,
  `:1134`, `move-to-folder.ts:66`, `folder-service.ts:81,213,296`).

So a role built the way the catalog recommends — narrow permissions only — cannot
save a project profile, confirm a BIM check, or upload through the `/v1` proxy;
and a legacy `project:edit`-only role can do every document write except reindex.
Neither is a hole; both are the extensibility contract failing quietly for the
next person who builds a custom role.

**Fix shape.** Make all eight consistent with the any-of pattern already in use.
The BIM and profile sites need a decision on *which* narrow permission they map
to (`project:documents:write` is the natural fit for both) rather than a
mechanical substitution.

### F7 — `requireProjectAccess` mis-derives the role when the any-of list contains `project:manage`

```ts
// lib/authz/projects.ts:85-98
const [granted, isAdmin, isEditor] = await Promise.all([
  Promise.all(accepted.map(check)),
  accepted.includes('project:manage') ? Promise.resolve(null) : check('project:manage'),
  accepted.includes('project:edit')   ? Promise.resolve(null) : check('project:edit'),
])
...
if (isAdmin  ?? canonical === 'project:manage') return { role: 'project-admin' }
if (isEditor ?? accepted.includes('project:edit')) return { role: 'project-editor' }
```

When `project:manage` is present but is *not* `accepted[0]`, the redundant check
is skipped and the fallback compares against `canonical` — which is a different
slug — so the branch is never taken. Reproduced:

```ts
check.mockImplementation(({ permissionSlug }) =>
  Promise.resolve({ authorized: permissionSlug === 'project:manage' }))
await requireProjectAccess(s(), 'p1', ['project:documents:write', 'project:manage'])
// → { role: 'project-viewer' }   (a project admin, reported as a viewer)
```

The three live call sites in this shape are `members-service.ts:92,171,230`
(`['project:members:manage', 'project:manage']`), and all three discard the
returned role — so this is **latent, not live**. It becomes live the first time a
caller passes such a list and uses the result to render a capability.

**Fix shape.** Compare against `accepted.includes('project:manage')`, matching the
editor branch one line below.

### F8 — WorkOS FGA resources are created but never deleted, and creation is not transactional

`createResource` is called once, in `createProject` (`lib/projects/service.ts:136`).
There is no `deleteResource` call anywhere in `src/` — a purged project leaves its
FGA resource and every role assignment on it in WorkOS permanently. Project ids
are UUIDs so nothing is re-used; the cost is unbounded growth and a role roster in
WorkOS that no longer corresponds to anything.

Separately, `createProject` performs four non-transactional steps: insert row →
create resource → store resource id → assign creator `project-admin`. A failure
after step 1 leaves a project row with no FGA resource and no admin. Because the
only way in is then the org-admin bypass (F3), a non-admin creator loses the
project they just made, and the app offers no repair path.

**Fix shape.** Delete the resource in the purge worker. For creation, either
compensate (delete the row when resource creation fails) or make the project row
reconcilable — a nullable `workosResourceId` already exists
(`findProjectWorkosResourceId`), so a repair job can find the orphans.

### F9 — The roster mapping does not see the new project permissions (minor)

`PROJECT_ROLE_BY_PERMISSION` (`lib/projects/members-service.ts:66-74`) probes
`project:view` / `project:edit` / `project:manage`. A custom role holding
`project:documents:write` and `project:memory:write` but not the deprecated
umbrella lists as **Viewer** in the project Settings roster. Same root cause as
F6: the roster was not updated when the umbrella was split.

## 4. Not defects

Checked and deliberately not raised:

- **`hasPermission`'s role implication** (`lib/authz/permissions.ts:135-142`) is
  bounded by the catalog and cannot reach `platform:*` by construction. Note that
  it means a *restricted admin built by editing the `admin` role in WorkOS* would
  still be granted everything by the implication — the supported way to build one
  is a new role slug, and `bun run provision:authz --check` catches the drift.
- **`isOrgAdmin` accepting `widgets:users-table:manage`**
  (`lib/authz/organizations.ts:26-31`) makes `org-user-admin` see the org nav
  entry. The page gates each section on its own permission, so this is a nav
  affordance, not access.
- **`/app/dev/*` preview pages** are gated on a Server Component layout
  (`src/app/dev/layout.tsx`) and 404 outside development.
- **`REQUIRE_AUTH=false`** skips project checks in `collection-scope-request.ts`.
  That is the documented anonymous/self-hosted mode; both production compose files
  and the Pulumi app config default it on.
- **`decideProjectTier` reporting `no-grant` for a tenancy mismatch**
  (`lib/authz/decide.ts:193-196`) loses the `tenancy-mismatch` rule, because
  `requireProjectAccess` collapses both into `NotFoundError`. Cosmetic, and moot
  under F4.
- **Backend job access is ownership-scoped, not project-scoped**
  (`aiq_api/jobs/access.py`). A project admin cannot read another member's job
  stream. That is a deliberate different model, documented in the route's
  `HAND_ROLLED` entry.

## 5. Suggested order

1. **F2** — a role documented as read-only holds platform write today.
2. **F1** — decide whether `project:chat` is enforced or removed; the org Access
   tab currently advertises it either way.
3. **F3** — the bypass that makes "permission-driven, never role-name driven"
   true or false.
4. **F4** — adopt `decide.ts` or correct `AGENTS.md`; give it a spec first.
5. **F6 / F9** — finish the `project:edit` split, roster included.
6. **F7 / F5 / F8** — latent correctness and lifecycle hygiene.
