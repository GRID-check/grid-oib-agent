# Authorization / Permissions System — Audit and Remediation (2026-08)

> Full review of the access-control plane, **and the fixes that followed**: the
> permission catalog, the four tiers (`org`, `platform`, `project`, `skill`), the
> route-factory contract, the project-membership roster, the sharing layer's
> container precondition — and the state of the two live WorkOS environments the
> catalog is supposed to describe.
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
> `scripts/provision-workos-authz.ts`,
> `frontends/aiq_api/src/aiq_api/jobs/access.py`, and the **live WorkOS
> Production and Staging environments** (read-only, via the WorkOS API).
>
> §3 records each finding and the fix that landed. §6 records the WorkOS drift,
> which is **not fixed by code** and is the remaining work.

## 1. Executive summary

The project tier — the part that was asked about — was already the strongest
part of the system, and the structural guarantees all held: tenancy is checked
first and bypassed by nobody, the FGA round-trip fails closed, denials are 404 so
no response is an existence oracle, the project listing is FGA-filtered, and
soft-deleted projects are unreachable for everyone. **No cross-tenant leak was
found, before or after.**

What was wrong was the gap between the access model the catalog advertises and
the one the code enforces. Nine findings, all now fixed in code:

- **`project:chat` was defined and checked nowhere** (F1), so `project-viewer` —
  documented read-only — could run the agent and spend LLM budget, and
  `project-contributor` was unassignable and displayed as "Viewer".
- **`org-platform-support` was not read-only** (F2). Every platform route was
  gated on one binary that Support passed, giving a role documented as changing
  nothing write access to model defaults, retrieval settings and the base corpus.
- **The org-wide project bypass keyed off the role slug `admin`** (F3), so a
  custom role holding every `org:*` permission reached no project, while any role
  merely named `admin` administered all of them.
- Plus a dead-but-untested decision point (F4), an unprovisioned skill tier (F5),
  a half-migrated write-permission split (F6), a role-derivation bug (F7),
  a non-transactional project creation (F8), and an under-reporting roster (F9).

**Then the same review against the live WorkOS environments found the larger
problem** (§6): the catalog has shipped ahead of provisioning, in both Production
and Staging. `project:skills:manage` does not exist there — WorkOS still holds
the pre-rename `project:workflows:manage` — so **Agent Skills is unreachable
today for any project admin who is not also an org admin**, and `org:skills:manage`
does not exist as a permission at all. No code change fixes that; the catalog is
the source of truth for the app, not for WorkOS.

That finding also killed a tenth change that was drafted here and reverted: the
plan to make the bounded role implication yield to any session carrying claims.
It is a sound idea in a reconciled environment and a silent permission removal in
this one — every admin would have lost the org skills toolbox the day it shipped.
Recorded in §5 so it is not re-proposed before §6 is done.

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

**Fixed — enforced.** `lib/authz/chat.ts` holds the permission list
(`['project:chat', 'project:edit']`, any-of) and both chat entry points now use
it: creating a project-scoped conversation, and the collection scope the chat
transport retrieves against. Listing conversations stays on `project:view` —
reading is reading. The umbrella is accepted alongside so no editor or admin
loses chat in an environment whose provisioning has not been replayed;
`project-viewer` holds neither and is now genuinely read-only.

Contributor became real in the same change: the members API schema, the form's
role list, the `ProjectMemberRole` type and the German and English role copy all
carry it. `ProjectRole` — the *derived* ladder — deliberately does not: it maps
onto the viewer rung either way, and deriving it would cost a third concurrent
FGA check on every project access to tell two identical answers apart. That
split is now documented on both types.

Note the deployment order: the permission must exist in WorkOS for
`project-contributor` to be assignable there. See §6, W1.

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

**Fixed.** `platformApiRoute` no longer compiles without
`{ permission: PLATFORM_PERMISSIONS.* }`, and all 30 platform handlers now
declare one — reads take a `*:view` permission, writes take `*:manage`. The four
service-level gates (`getAnswerFeedbackHealth`, `updatePlatformOwnedOrgSettings`,
`setStorageQuota`, `mintWidgetToken`) take one too.

`isPlatformOwner` split into `isPlatformStaff` (the precondition — used by the
nav flag and the platform shell) and `platformPermissions` /
`hasPlatformPermission` / `requirePlatformPermission` (the decision). The
cross-org path now resolves the membership role's actual permission list from
WorkOS instead of matching `org-platform-owner` by name, so Support works while
browsing a tenant org — it previously got nothing there.

A new permission, `platform:settings:view`, splits reading platform
configuration from changing it; Support holds it, and a bounded platform-tier
implication (`permissionsForPlatformRole`) covers sessions minted before it was
provisioned.

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

**Fixed.** `org:projects:administer` is in the catalog, held by Admin, and
checked with `hasPermission` at all three sites. The bounded implication carries
existing admin sessions across with no re-login, because the catalog grants Admin
the new permission.

The third-party site needed more than a substitution: `canUserAccessProject` has
a role SLUG and no claims, so a new module (`lib/authz/org-role-permissions.ts`)
asks WorkOS what that role actually holds — cached per environment, falling back
to the catalog, never to "yes". Without it the mirror would have refused to
invite somebody a custom admin role legitimately grants access to, which is the
exact divergence the module's header warns about.

One half of this waits on provisioning: a CUSTOM role cannot hold a permission
WorkOS does not have. See §6, W3.

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

**Fixed — the doc, not the adoption.** `AGENTS.md` now states what ADR-0038
actually decided: `decide.ts` is the *intended* single decision point, adoption
is incremental, and it dispatches to the same three gates the code calls
directly so the two cannot diverge. Wiring it into `apiRoute` was considered and
rejected — `decide.ts` pulls the database and the WorkOS client into a module
every route imports, which is precisely what splitting `platform-handler.ts` out
was for, and the decision is discarded at that call site anyway.

What did land is the part that was indefensible: `decide.spec.ts`, 21 tests
covering all four tiers, the fail-closed paths, both denial shapes and every
named rule. Two real bugs surfaced while writing it — the project tier reported
`no-grant` for a tenancy mismatch, and it named the bypass off `session.role`.
Both fixed.

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

**Fixed.** `catalog.spec.ts`'s registry-agreement check now covers all four
tiers, so `skill:*` can no longer drift alone. `decideSkillTier` skips the FGA
call behind a named `SKILL_RESOURCES_PROVISIONED` constant (`false`), so a
guaranteed-false round-trip and its warning line no longer run on every skill
decision — the constant is where per-skill grants turn on, alongside creating the
resource in `createJob`.

§6 W1 found the larger version of this: the skill tier is not merely
role-less, it is entirely absent from both live environments.

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

**Fixed.** All eight now use the any-of form. The profile writes map onto
`project:memory:write` (`PROFILE_WRITE`) — the intake brief and the standards the
agent reasons from are structured project knowledge, not files. BIM check
confirmations and the `/v1` collection proxy map onto `project:documents:write`
(`BIM_WRITE`, `PROJECT_UPLOAD`). `reindexProject` gained the umbrella it was
missing. Each list carries the deprecated umbrella so pre-split roles keep
working.

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

**Fixed, and further than proposed.** The derivation now reads the permissions
the caller actually HOLDS — `accepted.filter((_, i) => granted[i])` — rather than
the permissions that were asked about, so no fallback can compare against the
wrong slug.

Writing the test exposed a second inconsistency the original audit missed: the
editor rung was keyed on `project:edit` alone, so `['project:documents:write',
'project:edit']` returned `project-editor` for a narrow-write holder while
`'project:memory:write'` returned `project-viewer` for one — two existing specs
that contradicted each other. The rung is now "holds a write permission", which
is what the first spec already documented as intended. Consequence: a
narrow-write custom role is a collaborator rather than a reader on shared threads
in a project whose corpus it can change.

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

**Half fixed.** `createProject` now compensates: any failure across the four
non-transactional steps deletes the project row and rethrows, so a member who
creates a project can no longer lose it to a WorkOS hiccup. Postgres is the side
that undoes cleanly, and a leaked FGA resource with no row pointing at it is
inert — project ids are UUIDs, so it can never be re-hit. If even the rollback
fails, that is logged as an error rather than swallowed.

**Not fixed:** deleting the FGA resource when a project is purged. Nothing in the
repository consumes `deletion_queue` — there is no purge worker in the app or the
Python backend — so there is no correct place to hang the cleanup. Soft delete
must keep the resource (restore during the grace period depends on it). This is
an unbuilt feature, not a defect in the permissions system, and it belongs to
whoever builds the worker.

### F9 — The roster mapping does not see the new project permissions (minor)

`PROJECT_ROLE_BY_PERMISSION` (`lib/projects/members-service.ts:66-74`) probes
`project:view` / `project:edit` / `project:manage`. A custom role holding
`project:documents:write` and `project:memory:write` but not the deprecated
umbrella lists as **Viewer** in the project Settings roster. Same root cause as
F6: the roster was not updated when the umbrella was split.

**Fixed.** The ladder now probes every rung the catalog defines — `project:view`,
`project:chat`, `project:edit`, `project:documents:write`,
`project:memory:write`, `project:manage` — with a later match overwriting an
earlier one, so each member reads as the strongest rung they reach. Six
concurrent WorkOS list calls instead of three, on a screen loaded rarely and
whose entire job is to report access accurately. Contributor and narrow-write
roles both display correctly now.

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

## 5. A tenth change, drafted and reverted

Recorded so it is not re-proposed before §6 is done.

`hasPermission`'s bounded role implication applies even to a session that
already carries permission claims. That makes two things true that the model
says are false: an operator cannot build a restricted admin by editing the
Admin role (the catalog keeps granting what they removed), and a WorkOS role
whose slug merely happens to be `admin` is handed the whole Admin bundle
whatever it actually holds. The obvious fix — apply the implication only to a
session with an empty claim list, which is the unambiguous pre-rollout signal —
was written, tested green, and then reverted.

It was reverted because §6 makes it a live regression. **Both environments hold
an Admin role without `org:skills:manage`**; the permission does not exist in
WorkOS at all. Every admin holding claims therefore reaches the org skills
toolbox *only* through the implication, and the narrower rule would have taken it
away the day it shipped. Turning every catalog/WorkOS gap into a silent
permission removal is a worse failure than the one it fixes.

The order is: reconcile §6, keep the drift job green, *then* narrow the
implication — at which point it can be retired outright rather than narrowed.

## 6. The WorkOS side — the catalog has shipped ahead of provisioning

Read-only inspection of the live environments on 2026-08-25, via the WorkOS API:

| | |
|---|---|
| Production | `environment_01KEF0YGNYDFAFAS77EZEFQ839` (client `client_01KEF0YGXCZ6QCJGGBWD7Z266J`, the `prod` Pulumi stack) |
| Staging | `environment_01KEF0YG238CSMNF731TEG010E` (client `client_01KEF0YGNPX7S4SF952ZX46V1K`, the `dev` Pulumi stack) |

**Both environments carried the same drift**, and none of it was fixable in code
— the catalog is the source of truth for the app, not for WorkOS. **W1–W3 were
reconciled on 2026-08-25**; what each one was, and what the fix was, is below.
W4 is unchanged and still worth acting on.

### W1 — Agent Skills was unprovisioned, so project admins could not reach it — RECONCILED

The rename from Workflows to Agent Skills landed in the catalog and never
reached WorkOS. Neither environment has:

- the permission `project:skills:manage` — both still hold the pre-rename
  `project:workflows:manage`, and `project-admin` is granted *that*
- the permission `org:skills:manage` — it exists in no environment at all
- the `skill` resource type, or `skill:view` / `skill:run` / `skill:manage`

The project tier reads its grants from WorkOS at request time and has no
implication to fall back on, so **`project:skills:manage` is currently held by
nobody**. Every skill-schedule gate — create, edit, delete, run — therefore
answers 404 for a project admin who is not also an org admin. Org admins are
unaffected, because the org-wide project bypass skips FGA entirely, which is
exactly why the gap has been invisible: the people who would notice cannot
reproduce it.

`org:skills:manage` was the softer half: the org tier's bounded implication
granted it to any admin session, so the org skills toolbox worked only *because
of* the back-compat rule (see §5).

**Reconciled.** In both environments: the `skill` resource type created with
parent `project`; `org:skills:manage`, `project:skills:manage`, `skill:view`,
`skill:run` and `skill:manage` created; `admin` given `org:skills:manage`; and
`project-admin`'s `project:workflows:manage` replaced with
`project:skills:manage`. FGA grants follow the role, so every existing
project-admin assignment conferred the new permission immediately — Agent Skills
went from unreachable to reachable without touching a single role assignment.

### W2 — Retired Workflow objects are still provisioned — LEFT IN PLACE

The `workflow` resource type, `workflow:view` / `workflow:run` /
`workflow:manage`, `project:workflows:manage`, and the `workflow-viewer` /
`workflow-operator` / `workflow-admin` roles all still exist in both
environments. Nothing in the app references any of them. The provisioning script
deliberately reports them (`UNKNOWN … in WorkOS, absent from the catalog`) rather
than deleting them, and its comment says exactly why the `workflow:` prefix is
still in that check.

### W3 — The two permissions this audit adds — NOW PROVISIONED

`org:projects:administer` (the project bypass, §F3) and `platform:settings:view`
(the read half of the platform settings gate, §F2) are new in the catalog. Both
now exist in both environments; `admin` holds the first, and both platform-org
roles hold the second. Before that landed the fallbacks below applied, and they
remain the reason the deploy order does not matter:

- **`org:projects:administer`** is covered by the org-tier implication, so
  existing admins keep every project with no re-login. Nothing breaks. A CUSTOM
  admin role cannot hold it yet, which is the point of the fix, so that half
  waits on provisioning.
- **`platform:settings:view`** is covered by the platform-tier implication added
  in the same change (`permissionsForPlatformRole`), so Platform Owner and
  Platform Support both keep reading every platform screen. Support gains its
  documented read-only posture immediately, because the deny half needs no
  provisioning at all.

### W4 — The drift job cannot see production, and staging drift is not being read

`.github/workflows/workos-drift.yml` runs `provision:authz` in check mode weekly
against **staging only**, by design (the comment explains: production's key would
sit in CI for a job that reads nothing but configuration). Given W1 and W2, that
job should currently be failing on staging. Either it is failing unread, or
`WORKOS_API_KEY_STAGING` is unset and it is failing fast for a different reason.
Worth one look — a drift gate nobody reads is the same as no drift gate, and W1
is precisely the class of thing it exists to catch.

### What was applied, and what it did not touch

Applied to Staging (`environment_01KEF0YG238CSMNF731TEG010E`) and Production
(`environment_01KEF0YGNYDFAFAS77EZEFQ839`) on 2026-08-25, and verified by
re-reading every role afterwards:

| | Staging | Production |
|---|---|---|
| `skill` resource type (parent `project`) | created | created |
| `org:skills:manage`, `project:skills:manage`, `skill:view/run/manage` | created | created |
| `org:projects:administer`, `platform:settings:view` | created | created |
| `admin` += `org:skills:manage`, `org:projects:administer` | applied | applied |
| `project-admin`: `project:workflows:manage` → `project:skills:manage` | applied | applied |
| `project-editor`, `project-admin` descriptions (still said "workflows") | applied | applied |
| `org-platform-owner`, `org-platform-support` += `platform:settings:view` | applied | applied |

**Not touched, deliberately:** every existing role ASSIGNMENT, every user, every
organization, and the Workflow leftovers (W2). No member gained or lost a role;
what changed is what the roles they already hold confer.

Two things learned doing it, both now guarded in the catalog spec:

1. **The `skill` resource type is not reachable from the provisioning script.**
   The Node SDK exposes no CRUD for resource types (ADR-0038, "Consequences"), so
   `provision:authz --apply` could not have fixed W1 on its own — it would have
   failed to create `skill:*` against a type that does not exist. It was created
   through the WorkOS API directly.
2. **WorkOS caps permission descriptions at 150 characters**, not just resource
   type descriptions. `org:projects:administer` shipped at 208 and was rejected.
   `catalog.spec.ts` now asserts the cap for permissions too, so the next one
   fails in CI rather than half-way through a provisioning run.

## 7. What is left

The nine code findings are fixed and covered by tests (`lib/authz/*.spec.ts`,
including a first-ever spec for `decide.ts`), and W1–W3 are reconciled in both
WorkOS environments. What remains:

1. **Read the drift job** (W4). It runs weekly in check mode against staging
   only, and given W1 and W2 it should have been failing. Either nobody reads it
   or its secret is unset — and a drift gate nobody reads is the same as no drift
   gate. This is the one item that would have caught W1 a month earlier.
2. **Consider a production drift check.** The workflow's comment explains why
   production was left out, and that reasoning was sound when a drift meant a
   stale description. It cost a whole feature this time.
3. **Then** narrow — or retire — the bounded role implication (§5). It is safe to
   do now that both environments agree with the catalog, and it is what finally
   makes a restricted admin constructible by editing the Admin role.
4. **Delete the Workflow leftovers** (W2) once nothing anywhere holds them.
   Optional; they are inert, and the provisioner reports them every run.

Not attempted here, and unchanged from the original audit: a purge worker for the
`deletion_queue` does not exist anywhere in the repo, so the FGA resources of a
purged project still have nowhere to be cleaned up (F8's second half). The
compensating half — a failed creation no longer strands a project — did land.
