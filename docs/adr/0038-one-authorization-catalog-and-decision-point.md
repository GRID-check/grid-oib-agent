# ADR-0038: One authorization catalog, one decision point, and a coverage gate

- **Status**: Accepted
- **Date**: 2026-07-30
- **Deciders**: Grid Agent team (RBAC overhaul commissioned by the platform owner)
- **Related**: ADR-0016 (platform tier + permission registry), ADR-0004 (tenancy), ADR-0017 (BFF repository/service architecture), ADR-0023 (scheduled workflows), ADR-0024 (org Archiv), ADR-0032 (shareable resource model), `docs/deployment/workos-provisioning.md`

## Context

ADR-0016 established a permission-driven model and it was the right call. Three
weeks of feature work later, an end-to-end audit of the access model found the
design intact but the *system around it* unable to keep itself honest. Six
findings, in the order they matter:

**F1 — the project listing ignored per-project authorization.** `GET /api/projects`
returned every non-deleted project in the organization. `getProject` gated on
per-project FGA; the list that fed it did not. Any member enumerated every
project name and id in the tenant — exactly the distinction the
`project-viewer`/`project-editor`/`project-admin` roles exist to draw. A live
information leak, not a theoretical one.

**F2 — the code registry and WorkOS had silently diverged.** `org:audit:view` and
`org:archiv:manage` were in `lib/authz/permissions.ts`, were documented in the
provisioning runbook (each carrying a ⚠️ "create this in Staging" note from
2026-07-08), and existed in **no WorkOS environment**. No role could hold them,
so ADR-0016's headline promise — "create a role with a subset of permissions and
it works with no code change" — was false for those two. Only the legacy `admin`
implication made them appear to work. Nothing detected this.

**F3 — the admin back-compat rule was an unbounded superuser.** `hasPermission`
granted any `org:*` permission to `role === 'admin'` by prefix match. Every new
permission was therefore pre-granted to every admin the moment it was defined,
and a restricted admin was impossible to construct.

**F4 — three authorization engines, no shared front door.** WorkOS JWT claims,
WorkOS FGA, and the ADR-0032 Postgres grant model each had their own vocabulary,
their own admin-bypass rule and their own denial shape. Plus a dead fourth: a
`document` FGA resource type with zero roles and zero permissions that nothing
ever checked.

**F5 — enforcement was not provable.** 117 route files, four enforcement styles:
factory-checked (`apiRoute` + `permission`), service-checked, hand-rolled (the
eighteen `platform/*` routes each repeated the same twelve lines of session
resolution and error translation), and — the failure mode — simply absent. No
test, lint rule or type would fail when a route shipped ungated.

**F6 — no CI gate on any of it.** F1 through F5 were all discoverable by reading.
None was discoverable by running anything.

F5 is the finding that matters. F1–F4 are bugs; F5 is why there would be more.

## Decision

We will make the authorization model **derivable from one artifact, decidable at
one entry point, and provable by CI.**

### 1. One catalog

`frontends/ui/src/lib/authz/catalog.ts` becomes the single source of truth for
every resource type, permission and role. It is pure data with no imports, read
by both the app (which derives its permission types and role-implication table
from it) and `scripts/provision-workos-authz.ts`. Because both read the same
structure, F2 stops being expressible.

### 2. A resource topology that earns its keep

`Organization → Project → Workflow`. Three properties of WorkOS's FGA model were
verified against the live API rather than assumed, because each one rules out a
design that looks attractive on paper:

| Probe | Result | Consequence |
|---|---|---|
| Create a resource type with no parent | `"At least one parent type is required"` | Nothing can sit above Organization |
| Rename / re-parent the `organization` type | `"Cannot update organization resource type"` | The root is immutable — you cannot relabel it as "Platform" and insert a tenant type beneath it |
| Give an `organization`-typed role a `project:view` permission | **Accepted** | Permissions are NOT constrained to roles of their own resource type |

The first two mean the platform tier cannot be modelled as a level above the
tenant, so ADR-0016's platform-org approach stands. The third is the load-bearing
one: it means moving `platform:*` onto a dedicated resource type would buy tidier
grouping and **no security guarantee** — a tenant role could still be given those
permissions. The guarantee therefore has to be ours, and it is: `lib/authz/platform.ts`
requires GRID Platform membership before any platform surface answers, and
`catalog.spec.ts` asserts no environment-scoped role holds a `platform:*`
permission. That test is not belt-and-braces; it is the only enforcement.

- **`workflow` is added.** A scheduled research run spends budget unattended and
  is a genuinely distinct access question from the project hosting it — an
  operator may need to run one without being able to edit the project.
  Cardinality is tens per org, so an FGA resource per workflow is cheap. Roles:
  `workflow-viewer`, `workflow-operator`, `workflow-admin`.
- **`document` is deleted.** It existed with no roles and no permissions;
  nothing checked it. Document access is pure inheritance from the parent
  project, already enforced in `lib/documents/service.ts`. Giving every uploaded
  file its own FGA resource buys a WorkOS write per upload, a delete per delete,
  a backfill and a reconciliation job — an unbounded distributed-consistency
  problem for no access-control gain. If per-document sharing ever ships, the
  ADR-0032 grant model already expresses it transactionally in Postgres.
- **Conversations stay on the ADR-0032 grant model.** Visibility tiers plus
  additive grants plus audited self-escalation is strictly more expressive than
  FGA roles, and it is transactional with the data. Moving it would be a
  downgrade.

### 3. Finer-grained project permissions

`project:edit` was one permission covering documents, memory, profile, folders
and workflows. It is now **deprecated but retained** and joined by
`project:documents:write`, `project:memory:write`, `project:members:manage` and
`project:workflows:manage`. Creating a workflow is `project:workflows:manage`;
operating an existing one is workflow-tier — the same service-level-create /
resource-level-operate split AWS IAM uses.

Splitting a permission is a back-compat hazard: a custom role provisioned before
the split holds only the umbrella and would lose access the day the narrow
permission ships. `requireProjectAccess` therefore accepts an **any-of** list
whose first entry is canonical — call sites pass
`['project:documents:write', 'project:edit']`, so a legacy grant keeps working
while new roles can be given just the narrow permission. The built-in editor and
admin roles hold both, so nothing changes for them.

### 4. Fine-grained roles that prove the extensibility contract

Four org personas ship in the catalog, each holding a strict subset of Admin:
`org-auditor`, `org-billing-admin`, `org-compliance-officer`,
`org-knowledge-manager`. Plus `project-contributor` (chat and read, no corpus
writes) and `org-platform-support` (read-only platform staff). They exist
because a contract that is never exercised is a contract that quietly breaks —
which is precisely what F2 was.

### 5. The admin implication becomes bounded

`hasPermission` no longer prefix-matches. A role slug implies exactly the
permissions the **catalog** says that role holds, and the implication table is
built only from environment-scoped org-tier roles, so `platform:*` can never be
reached by implication. Existing admins are unaffected (the catalog's Admin role
holds every `org:*`), but a new permission is no longer silently pre-granted,
and a restricted admin is now constructible.

### 6. One decision point

`lib/authz/decide.ts` exposes `decide()` / `can()` / `authorize()` across all
four tiers. It dispatches to the existing engines rather than replacing them —
claims for org/platform, `requireProjectAccess` for project, FGA plus an explicit
parent fallback for workflow — so adoption is incremental and the most
security-critical code is not rewritten. Every decision carries a **named rule**
(`jwt-permission`, `org-admin-bypass`, `platform-membership`, `resource-role`,
`project-inherited`, `tenancy-mismatch`, …), so bypasses are visible instead of
implicit. Denials keep each tier's existing shape: 403 for claims tiers, 404 for
resource tiers (no existence oracle).

The single FGA round-trip, its instrumentation and its optional cache move to
`lib/authz/resource-check.ts`, shared by both resource tiers, and **fail closed**
— a check that cannot complete is a denial, where the project path previously let
the error propagate as a 500.

### 7. Authorization becomes a required argument

`apiRoute` will not compile without an `authz` declaration:

- `{ permission }` — the factory checks a claims-tier permission before the
  handler runs.
- `{ enforcedBy }` — the service authorizes because the decision needs the
  resource; names the function that does it.
- `{ sessionOnly, why }` — authentication is the whole requirement, with the
  reasoning recorded.

`publicApiRoute` requires a `why`. A new `platformApiRoute` absorbs the eighteen
hand-rolled platform routes, deleting their bespoke error translation; it lives in
its own module so that AuthKit stays out of the module every route imports.

`{ enforcedBy }` and `{ sessionOnly }` are not loopholes — they are real,
common postures. The requirement is that the choice is written down next to the
route by someone who had to think about it.

### 8. A coverage gate

`src/app/api/authz-coverage.spec.ts` walks every `app/api/**/route.ts` and fails
when a handler is neither factory-declared nor listed in a `HAND_ROLLED` map with
the gate it applies recorded. That list holds seven entries today (two proxies,
the OAuth callback, the WebSocket scope endpoint, three platform routes with
bespoke shapes) and the gate asserts it does not grow.

## Consequences

**Good.** An ungated route is a compile error, then a test failure. The endpoint
inventory is greppable and reviewable — the artifact an enterprise security
review actually asks for. Catalog/WorkOS drift is detectable in CI
(`npm run provision:authz`, read-only by default). The admin bypass and
break-glass are named rules rather than anonymous conditionals. Restricted
admins, auditors, billing admins and read-only platform staff are now
constructible without code changes.

**Costs, accepted.**

- `apiRoute`'s signature changed at ~109 call sites. Mechanical, `tsc`-verified,
  no behavioural change for routes declaring `{ enforcedBy }`.
- `GET /api/projects` now issues one FGA check per project (concurrent, and
  skipped entirely for org admins). Fixing F1 costs a round of parallel network
  calls on that page; `GRID_AUTHZ_CACHE_TTL_MS` shortens it where a ≤TTL
  revocation lag is acceptable.
- The FGA cache key gained a resource-type segment, so a project and a workflow
  sharing an external id cannot collide. Existing cache entries are invalidated
  once; the cache is a short-TTL optimisation, so this is a non-event.
- `decide.ts` is additive. Existing service-layer calls still go direct, so two
  routes to the same answer exist until adoption completes. The alternative —
  rewriting every gate at once — would have put the most security-critical code
  in the app through one unreviewed change.
- Resource types remain a dashboard step: the Node SDK exposes no CRUD for them.
  The provisioning script verifies them indirectly, since a permission cannot be
  created against a type that does not exist.

**Not addressed here.** The three engines are unified behind one entry point, not
merged. Conversations remain on Postgres grants and projects on FGA, which we
believe is correct — but "one decision point" is not yet "one engine", and this
ADR should not be read as claiming otherwise.
