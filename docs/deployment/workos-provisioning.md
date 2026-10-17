# WorkOS Provisioning Runbook

> What must exist in a WorkOS environment for Piloti's authorization model
> (ADR-0016, ADR-0038) to work, what is already provisioned where, and how to
> replay it (e.g. into Production). The app degrades gracefully when pieces are
> missing (bounded `admin` back-compat, break-glass env allowlist), but this
> is the intended steady state.

## The catalog is the source of truth

Since ADR-0038 the tables below are **generated from, and verified against**,
`frontends/ui/src/lib/authz/catalog.ts`. That file is what the app derives its
permission types from AND what the provisioning script applies, so this runbook
documents the catalog rather than competing with it.

```bash
cd frontends/ui
WORKOS_API_KEY=sk_… npm run provision:authz            # read-only drift check
WORKOS_API_KEY=sk_… npm run provision:authz -- --apply # reconcile
```

**Every deploy runs `--apply`.** The Kubernetes Job `grid-app-authz-catalog`
(`deploy/pulumi/src/app/workos-authz-jobs.ts`) and the compose service
`grid-workos-authz` run it against the environment the stack's
`WORKOS_API_KEY` belongs to, so a permission or role added to the catalog
exists in WorkOS once the release that checks it is deployed. It creates what
is missing, sets a catalog role's permissions to the catalog's (a permission
added to such a role in the dashboard is taken off again), and deletes no
permission and no role. Custom roles are not in the catalog and are left alone. A tier whose resource type is missing fails
the Job, and the stack update with it, naming the type. Running `--apply` by
hand is for an environment no stack deploys against.

The check is read-only and exits non-zero on drift — run it in CI. It exists
because the two ⚠️ rows this runbook used to carry (`org:audit:view`,
`org:archiv:manage`, both "create this in Staging", both still absent three
weeks later) were invisible to everything except a human re-reading the file.

**The catalog's wording follows the „Büroablage" rename on the next provisioning.**
The product renamed the org-wide shelf from „Archiv" to „Büroablage" („Office
filing" in English) on 6 Oct 2026. `org:archiv:manage` keeps its slug. Its
label is NOT taken from the dictionary: Organisation → Zugriff
(`frontends/ui/src/features/organization/components/permission-reference.tsx`) shows the `name` and `description` from
`frontends/ui/src/lib/authz/catalog.ts`, so it still reads „Manage document Archiv" there until
the next provisioning changes them. Changing them rewrites the permission's
name and description in WorkOS, a provisioning step that waits for the
product owner's go. Change the
`name` and `description` in `catalog.ts` and run `--apply` together, never one
without the other: the drift check would fail in between.

**Resource types are the one manual step**: the Node SDK exposes no CRUD for
them, so create them in the dashboard. The script still catches a missing one —
a permission cannot be created against a resource type that does not exist, and
the failure names the type.

## The environment around the catalog

`provision:authz` covers permissions and roles; `provision:workos-env` covers
the environment identity AROUND them that used to be dashboard steps — same
conventions: read-only check by default, `--apply` reconciles, non-zero exit
on drift.

```bash
cd frontends/ui
WORKOS_API_KEY=sk_… npm run provision:workos-env            # read-only drift check
WORKOS_API_KEY=sk_… npm run provision:workos-env -- --apply # reconcile
```

Each section is driven by its own desired-state variable and is skipped
cleanly when unset, so a partial run only verifies what it knows:

| Section | Desired state via | Reconciles |
|---|---|---|
| Platform organization | `GRID_PLATFORM_ORG_EXTERNAL_ID` (default `grid-platform`) | creates "GRID Platform" with that external id when missing |
| Owner membership | `GRID_PLATFORM_OWNER_EMAIL` | seats the user in the platform org and assigns `org-platform-owner` (the invite itself stays manual) |
| AuthKit redirect URIs / CORS origins | `WORKOS_DESIRED_REDIRECT_URIS`, `WORKOS_DESIRED_CORS_ORIGINS` (comma-separated) | adds missing entries; extras are REPORTED, never deleted without `--apply --prune` |
| Observability Connect app | `WORKOS_CONNECT_APP_NAME` (default `GRID Observability`), `WORKOS_CONNECT_REDIRECT_URIS` | matches by name; creates a confidential OAuth app and prints client id + secret ONCE; updates redirect URIs on an existing app. The Scopes permission assignment stays manual |
| Feature-flag targeting | `WORKOS_FLAG_TARGETS_JSON` (`{"<slug>": ["org_…", …]}`) | ADDITIVE only — adds missing targets per org, never removes one; flags missing from WorkOS are reported as MANUAL because creation has no SDK binding |

The check always lists registry flags missing from WorkOS and ends with the
remaining MANUAL steps: resource types, the allow-sign-ups toggle,
`multipleRolesEnabled`, flag creation — everything below still says so where
it applies. `.github/workflows/workos-drift.yml` runs the authz + audit-schema
checks weekly against Staging (`WORKOS_API_KEY_STAGING` secret).

## Provisioned state (Staging + Production — catalog applied 2026-07-30/31)

Everything below exists in **both** environments:

| Environment | ID | Applied |
|---|---|---|
| Staging | `environment_01KEF0YG238CSMNF731TEG010E` | 2026-07-30 — the environment the deployed app uses (its orgs include "GRID Test") |
| Production | `environment_01KEF0YGNYDFAFAS77EZEFQ839` | 2026-07-31 — full replay into a previously empty environment |

Both carry the same three resource types, the same 24 GRID permissions and the
same 13 roles, verified role-by-role against the catalog after each run.

The **folder tier** (ADR-0097, 2026-10-09) came later and is not in either count
yet: the `folder` resource type exists in Staging (created 2026-10-09) and in
Production (created 2026-10-10, `authz_resource_type_01M4KGD04HGQMPAZR09R15538W`).
In Production `folder:read`, `folder:write`, `folder-reader` and `folder-editor`
were also created by hand on 2026-10-10, with the catalog's names, descriptions
and permission sets, so the deploy's catalog Job finds them already in place. In
Staging the next deploy creates them. A read-only comparison of Production on
2026-10-10 found that `--apply` there also adds `platform:observability:view` and
the `org-platform-observability-analyst` role, adds that permission to
`org-platform-owner` and `org-platform-support`, and removes nothing.
[Rolling out folder roles](#rolling-out-folder-roles-adr-0097) has the order.

Two Production-specific notes:

- **No users exist yet**, so the GRID Platform organization has no
  `org-platform-owner` membership. Until the first owner signs in, platform
  access comes from the `GRID_PLATFORM_OWNER_EMAILS` break-glass allowlist —
  which is exactly the first-run case it exists for. Clear it once the
  membership is assigned.
- **`multipleRolesEnabled` is `false` in Production and `true` in Staging.**
  This is a WorkOS role-config setting, not part of the catalog, so the
  provisioning script neither reads nor changes it. It matters for the
  fine-grained personas: with it off, a membership holds exactly one role, so
  Auditor and Billing Admin cannot be combined on the same person. Turn it on
  in Production if you want additive personas there too.

### 0. Resource topology

`Organization → Project → Skill`, and `Organization → Project → Folder`.
Organization is the immutable root:
creating a parentless resource type is rejected by the live API with
*"At least one parent type is required"* (verified 2026-07-30), which is why the
platform tier is modelled as an org-scoped role rather than a tier above
Organization.

| Type | Parent | Purpose |
|---|---|---|
| `organization` | — | System root. Carries org-tier and platform-tier permissions. |
| `project` | `organization` | Tenant workspace: documents, memory, conversations. |
| `skill` | `project` | A scheduled agent-skill job attached to a project (Agent Skills). |
| `folder` | `project` | A project folder with its own access list (ADR-0097). Who may read or change it is a folder role (§2a) assigned on it to a person. |

**Only a folder with its own list is a resource**, and it sits directly under
its project whatever its depth in the folder tree. A folder that inherits is not
registered. WorkOS shapes this, verified against Staging on 2026-10-09: a
`folder` cannot be the parent of a `folder` (*"Adding this parent type would
create a cycle"*), a hierarchy is five levels deep at most, a resource cannot
move to another parent, and roles only add down a tree. So moving a folder
inside its project never touches WorkOS, and the narrowing over the folder's
ancestors stays in Grid's code (`effectiveFolderLevel`). The app registers the
folder when someone gives it its own list and deletes the resource when it goes
back to inheriting; a deleted folder keeps its resource, as its row is kept.
About 5,000 resources of one type per organization is WorkOS's soft limit.

> `document` was **deleted** (2026-07-30). It existed with zero roles and zero
> permissions and nothing ever checked it; document access is inheritance from
> the parent project, enforced in `lib/documents/service.ts`. See ADR-0038.
>
> The `workflow` resource type and its three permissions/roles met the same
> fate when Agent Skills replaced Workflows: the catalog now defines the
> `skill` type instead. Environments the old feature reached still carry the
> `workflow:*` leftovers — the provisioning script reports them as
> `UNKNOWN … absent from the catalog`, which is how they stay visible until an
> operator deletes them in the dashboard.

### 1. Organization-tier permissions (resource type: Organization)

| Slug | Meaning |
|---|---|
| `org:settings:manage` | Org settings (name, locale, defaults); org page shell |
| `org:models:manage` | Runtime AI model configuration (ADR-0014) |
| `org:budgets:manage` | LLM budgets + org-wide usage (ADR-0015) |
| `org:compliance:manage` | Legal holds + deletion queue |
| `org:audit:view` | Open the org's native audit-log viewer (Admin Portal) |
| `org:downloads:view` | Read the download log: who took which document out, and who opened one under a folder with its own access list (ADR-0088). **New 2026-10-06: run `bun run provision:authz --apply` against every environment** before a custom role can hold it; `admin` holds it through the catalog. Reading the log is audited (`download_log.viewed`, needs `npm run provision:audit-schemas -- --apply`). |
| `org:archiv:manage` | Upload/delete/reingest/retag in the org-wide document Archiv (ADR-0024). Reads are open to any member, so only mutations need it. |
| `org:skills:manage` | Author, edit, clone and delete skills in the organization toolbox (Agent Skills). Reads are open to any member. |
| `org:projects:create` | Create projects. Held by **Member** by default; withhold it to make project creation admin-only. |
| `org:members:manage` | Open the **Access** section: the member directory, the role catalog and the WorkOS Users widget that invites, re-roles and removes people. |

All nine are attached to the environment **Admin** role, which keeps its six
`widgets:*` permissions. **Member** holds `org:projects:create` only — all other
project access comes from project-scoped roles.

### 1a. Project-tier permissions (resource type: Project)

| Slug | Meaning |
|---|---|
| `project:view` | Read and search a project, its documents and conversations |
| `project:chat` | Start and continue conversations in the project |
| `project:edit` | **Deprecated** umbrella write, retained so existing grants keep working |
| `project:documents:write` | Upload/delete/re-ingest/retag project documents |
| `project:documents:generate` | Let the agent file documents it wrote (a Recherchebericht, a diagram) into the project. Required **in addition to** `project:documents:write`, never instead of it, and deliberately NOT satisfied by the `project:edit` umbrella — a permission every legacy role already implicitly holds could not be withheld, which is the whole point of this one. Withhold it on a custom project role to let Piloti answer without writing into the file system |
| `project:memory:write` | Add/edit/remove project memory items |
| `project:manage` | Rename, archive or delete the project |
| `project:members:manage` | Grant and revoke project roles |
| `project:skills:manage` | Create, edit, delete and run skill schedules in a project (Agent Skills Phase A) |

### 1b. Skill-tier permissions (resource type: Skill)

| Slug | Meaning |
|---|---|
| `skill:view` | See a skill schedule's definition, schedule and run history |
| `skill:run` | Trigger it manually, outside its schedule (spends budget) |
| `skill:manage` | Edit its definition/schedule, or delete it |

Creating a skill schedule is `project:skills:manage` (there is no schedule yet
to check against); operating an existing one is skill-tier, with the
project-tier fallback in `lib/authz/decide.ts` keeping project admins working
without provisioning per-skill roles.

### 1c. Folder-tier permissions (resource type: Folder)

| Slug | Meaning |
|---|---|
| `folder:read` | See, open, download and search a folder with its own access list, and use it in answers |
| `folder:write` | Change such a folder and what is filed in it. The project role still caps it: a project viewer holding it only reads |

**No project role holds a `folder:*` permission**, and none may: being in the
project grants nothing on a registered folder, which is how a folder is
narrower than its project without the exclusions WorkOS does not have. Only the
two folder roles in §2a hold them. Organization admins write every folder
through `org:projects:administer`, not through this tier.

### 2. Platform-tier permissions (resource type: Organization)

| Slug | Meaning |
|---|---|
| `platform:organizations:view` | See every org: directory, members, activity |
| `platform:organizations:manage` | Administer any org (reserved, unused in v1) |
| `platform:usage:view` | Cross-org LLM usage/spend |
| `platform:settings:manage` | Platform-wide settings (reserved) |

They live on the Organization resource type because WorkOS permissions attach to
resource types and Organization is the immutable topology root (§0). They are
only ever attached to platform-org roles, never to tenant roles — a provisioning
convention plus the membership check in `lib/authz/platform.ts`. WorkOS itself
cannot express "attachable only to one organization's roles", so the binding
guarantee is that check, not the topology. `catalog.spec.ts` asserts no
environment-scoped role holds a `platform:*` permission.

### 2a. Roles

| Slug | Scope | Holds |
|---|---|---|
| `member` | environment | `org:projects:create` |
| `admin` | environment | every `org:*` (including `org:projects:administer`, the org-wide project bypass) + six `widgets:*` |
| `org-auditor` | environment | `org:audit:view` |
| `org-billing-admin` | environment | `org:budgets:manage` |
| `org-compliance-officer` | environment | `org:compliance:manage`, `org:audit:view` |
| `org-knowledge-manager` | environment | `org:archiv:manage` |
| `org-user-admin` | environment | `org:members:manage`, `widgets:users-table:manage` |
| `project-viewer` | environment (Project) | `project:view` |
| `project-contributor` | environment (Project) | `project:view`, `project:chat` |
| `project-editor` | environment (Project) | + `project:edit`, `project:documents:write`, `project:documents:generate`, `project:memory:write` |
| `project-admin` | environment (Project) | + `project:manage`, `project:members:manage`, `project:skills:manage` |
| `folder-reader` | environment (Folder) | `folder:read` |
| `folder-editor` | environment (Folder) | `folder:read`, `folder:write` |
| `org-platform-owner` | **GRID Platform org only** | all `platform:*` + five `widgets:*` |
| `org-platform-support` | **GRID Platform org only** | `platform:organizations:view`, `platform:usage:view`, `platform:settings:view`, `platform:observability:view` — every read, no `*:manage`. `platformApiRoute` requires the specific permission per route, which is what makes "read-only" true rather than described. |
| `org-platform-observability-analyst` | **GRID Platform org only** | `platform:observability:view` only: opens Langfuse at the edge for business analysts and the Fachbereich, and no platform surface in the app (ADR-0089). The scope must be assigned to the Connect application before the stack that checks it is deployed, or every Langfuse login fails with `invalid_scope` |

The two folder roles are assigned on one folder resource to one organization
membership, by the folder's access dialog in a project's Files
(`setFolderAccess`), never on the **Personen** tab: a person's organization role
says nothing about which folders they reach.

The five fine-grained org personas exist to keep ADR-0016's extensibility
contract honest: each holds a strict subset of Admin and works with no code
change, which is the property that silently broke for `org:audit:view` and
`org:archiv:manage`.

**Reaching PROJECTS needs `org:projects:administer`.** The org-wide bypass used
to key off the role slug `admin`, so a custom administrator role reached no
project at all however many `org:*` permissions it held. It is a permission now —
grant it to any role that should administer every project in its organization.
Existing `admin` sessions keep it through the bounded catalog implication in
`lib/authz/permissions.ts`, so nobody re-logs-in; a custom role needs it
provisioned before it can hold it.

**A catalog change is not live until `--apply` has run against the environment.**
The project tier reads its grants from WorkOS at request time and has no
fallback, so a project-tier permission that exists only in the catalog is held by
nobody. The current gap in both environments, and what it costs users, is in
[`docs/architecture/authorization-audit-2026-08.md`](../architecture/authorization-audit-2026-08.md) §6.

### 3. The platform organization + exclusive role

- Organization **"GRID Platform"**, external id **`grid-platform`**
  (Staging id: `org_01KX06QQJN3KA25R9G2PNFBGXV`). The app resolves it by
  external id (`GRID_PLATFORM_ORG_EXTERNAL_ID`).
- **Org-scoped role** `org-platform-owner` ("Platform Owner") **created
  inside that org only** — WorkOS org-scoped roles cannot be assigned in
  any other organization, which is the exclusivity guarantee. Permissions:
  the four `platform:*` + all five admin widget scopes (so platform-org
  widgets work on the platform dashboard).
- The owner (`biglmatthias@gmail.com`, `user_01KEF12GR7XHBQXA5M42R9VC48`)
  holds a GRID Platform membership with that role.

### 4. AuthKit / environment settings

- CORS web origins: `https://app.dev.piloti.at` (required for WorkOS widgets).
  Keep in sync with `grid-oib:baseDomain` in `deploy/pulumi/Pulumi.*.yaml` —
  the app origin is always `https://app.<baseDomain>`. Reconciled by
  `provision:workos-env` (`WORKOS_DESIRED_CORS_ORIGINS`, and
  `WORKOS_DESIRED_REDIRECT_URIS` for redirect URIs); extras are report-only
  unless `--apply --prune`.
- Auth methods: password + Google + GitHub + Microsoft + Apple; email
  verification required; MFA off.
- **JWT template** (AuthKit → Sessions → JWT template; set 2026-10-15 in
  Staging and Production). It adds three claims and keeps every default one
  (`org_id`, `role`, `roles`, `permissions`, `feature_flags`, checked with a
  preview against a real membership before saving):

  ```json
  {"name": "{{ user.first_name }} {{ user.last_name }}", "email": {{ user.email }}, "organization_name": {{ organization.name }}}
  ```

  The agent reads them off the verified token as the person's name, email and
  office in the system prompt (`aiq_api.auth.jwt_validator`,
  `aiq_agent.turn.context.user_info_from_principal`); without the template
  the prompt has no name. A null `organization.name` drops its key, and an
  unknown name renders as an empty string, which the agent reads as no name.
  WorkOS has no public API for the template, so `provision:workos-env` cannot
  check it: it lists it as a manual step. A turn with no signed-in person (a
  scheduled task, a woken thread reply) has no token; it is named from the
  signed request-context envelope's `requester` instead, which the BFF resolves
  from WorkOS for the pinned session (`lib/auth/person.ts`).
- **Sign-up: decided posture is INVITE-ONLY EVERYTHING** (platform owner
  decision, 2026-07-08). Two switches, one per layer:
  1. **WorkOS-native**: AuthKit → Authentication → *Allow sign-ups* **OFF**.
     Accounts are then created only via invitations (users-table widget) or
     verified-domain auto-join. ⚠️ Not yet applied — flip it in the
     dashboard (or via the management API `updateAuthkitSettings`,
     `allowSignUp: false`) for Staging, and again when Production is
     provisioned.
  2. **App-side**: `GRID_DISABLE_SELF_SERVE_ORGS=true` in the deploy
     environment (Coolify) — org creation becomes platform-team-only and
     onboarding shows the invite-only notice up front.

### 5. Audit Logs (native WorkOS product)

The app emits every privileged admin action as a **WorkOS Audit Log event**
(`frontends/ui/src/lib/audit/service.ts`) — no app-side audit table.

**The registry is `frontends/ui/src/lib/audit/schemas.mjs`**, and it is not a
list of action names: each action is stored WITH the schema WorkOS validates
its events against, and `AUDIT_ACTIONS` is derived from those keys. That is
deliberate. The two used to be separate lists — actions in `service.ts`,
schemas in the provisioning script — and they drifted by nine actions (the
whole `resource.*` sharing family, `model_config.zdr.updated`,
`platform.model_defaults.updated`, `platform.norm_registry.updated`,
`document.deleted`). WorkOS rejects an event whose action has no schema
(`Invalid Audit Log event: event 'resource.shared', version '1' has not been
configured in this environment`), the emitter never throws, and the only trace
was an ERROR log per privileged mutation — issues #255/#256. Now `tsc` refuses
to compile a `recordAuditEvent` call whose action has no schema, and
`src/lib/audit/schemas.spec.ts` is the offline CI gate.

Broadly the trail covers: org creation/settings, budgets, model configuration
(org versions, ZDR, fleet defaults), BYOK credentials, legal holds,
break-glass platform access (lands in the GRID Platform org's trail, throttled
to once per actor per hour), project lifecycle and role grants, document and
Archiv uploads/deletes, the sharing/ownership changes from ADR-0032, and what
Piloti did in the office (below).
Deliberately NOT audited: high-frequency content activity (memory items,
profile edits, conversation messages, renames, user preferences) — it would
drown the admin trail. A person's own edits of Anmerkungen are content
activity; Piloti's are not, because a machine acting in a person's name is
what an admin has to be able to account for, and neither is a person taking
over or dismissing a mark Piloti proposed: that is a decision on Piloti's
work (`piloti.mark.decided`).

- **What Piloti did** (`piloti.*`, added 2026-10-14). Piloti acts in a
  person's session as that person (ADR-0105, ADR-0108), so the trail names the
  person and the action family names Piloti:

  | Action | When | Actor | Targets | Metadata |
  |---|---|---|---|---|
  | `piloti.change.applied` | Piloti set, changed or deleted a mark, or answered in its thread, in the asker's name: one per `piloti_changes` row (`lib/changes/service.ts`) | the person the turn acted for | mark, document, project, conversation | `op` (create, update, delete, reply), `markNumber`, `markKind`, `status`, `fields` (names of the fields that moved), `messageId`, `changeId` |
  | `piloti.change.undone` | a person undid one (`POST /api/piloti-changes/[id]/undo`) | who undid it | mark, document, conversation | `op`, `inverse`, `markNumber`, `onBehalfOf`, `messageId`, `changeId` |
  | `piloti.proposal.created` | Piloti filed a proposed change, once per card (`lib/proposals/service.ts`) | the person Piloti acted for | proposal, project, conversation | `kind`, `operation`, `items`, `memoryScope`, `messageId` |
  | `piloti.proposal.decided` | a person applied or dismissed it | the decider | proposal, project, conversation | `kind`, `decision` (applied, partially_applied, failed, dismissed), `operation`, `items`, `appliedItems`, `memoryScope`, `onBehalfOf`, `messageId` |
  | `piloti.mark.decided` | a person took over (`open`) or dismissed a mark Piloti proposed, on the canvas: the per-mark buttons and the live card's batch send the same PATCH, so one per mark that left `proposed` (`lib/annotations/service.ts`); a colleague's earlier move (409) records nothing | the person who decided | mark, document, project | `decision` (taken_over, dismissed), `markNumber`, `markKind`, `onBehalfOf` (the person Piloti proposed it for) |
  | `piloti.wake.started` | a wake's turn started (`lib/annotations/wake-job.ts`) | the person whose act woke Piloti | mark, document, project, their thread | `trigger`, `wakeId`, `markNumber`, `waits` |
  | `piloti.wake.ended` | the wake ended, once: its turn ended (`lib/turns/outcome.ts`), or the wake job refused it or gave up before a turn answered (`lib/annotations/wake-job.ts`) | the same person | the same | `trigger`, `wakeId`, `outcome` (answered, stopped, failed; refused for the job's refusal), `turnOutcome` (what the socket reported; absent when the job ended it), `reason` (the stored reason, cut at 200), `reasonKind` (budget, busy, access, error: the class the person's inbox notice is worded by, `lib/annotations/wake-end-reason.ts`), `handedBack`, `markNumber` |
  | `piloti.wake.stopped` | a person took the mark back, or deleted it, and that stopped a queued or running wake (`lib/annotations/take-back.ts`) | who took it back | the same | `trigger`, `wakeId`, `wakeStatus`, `wokenBy`, `by` (person, or piloti when Piloti closed the mark) |
  | `piloti.wake.suppressed` | a wake was held before Piloti was asked: a cap, the switch off, the person's right to write gone, the mark or reply gone, the delegation taken back. Until 2026-10-14 a failed turn (`stage: 'turn'`) and a wake the job ended `refused` or `failed` were recorded here too; they are now `piloti.wake.ended` | the person whose act woke Piloti | mark | `documentId`, `trigger`, `status` (suppressed), `reason`, `stage` (enqueue, claim) |

  *The actor model.* The actor is always a person, never Piloti: the actor is
  the authorization principal (`AuditActorType` in `lib/audit/service.ts`, the
  decision `document.generated` already took), and it is the field the viewer
  and the export filter by. An agent actor would hide on whose behalf Piloti
  acted in the one place an admin searches. So an admin finds everything Piloti
  did with the action filter on `piloti.*`, and everything it did for one
  person with that person's actor filter added. A wake's row keeps the
  person's id and not their email, so the wake events look the email up in
  the organization's directory before they go out (best effort: the id alone
  when the directory does not know the person). The turn is the
  `conversation` target and `messageId`, the answer whose Langfuse trace and
  change card carry the same id. A `via: 'piloti'` key would only repeat the
  action family.

  *No content.* Ids, numbers, kinds, field names and counts only: never a word
  of a mark, a reply, a note, a proposal or a document name, so none of these
  actions needs `filedIn`. `schemas.spec.ts` refuses a `piloti.*` metadata key
  that could carry text.

  *Once per act.* Each is emitted after the write it records committed, by the
  call whose compare-and-swap won (`recordAuditEventAfterCommit`, fire and
  forget: a lost line is logged, the act is never failed or rolled back). A
  repeated proposal card, an already-undone undo, a wake the job or the outcome
  settled twice, a decision a colleague made first, and a change that moved
  nothing emit nothing. Undoing a mark Piloti proposed dismisses it, so it is
  both `piloti.change.undone` and `piloti.mark.decided`. A background run
  (ADR-0108) reaches the same internal routes, so what Piloti changes in one
  is recorded the same way; `task.*` records the run itself.

  The deploy's schema Job registers the new actions; no new environment
  variable. An environment reconciled by hand needs
  `npm run provision:audit-schemas -- --apply` before this release, or WorkOS
  rejects these events (and the trail silently lacks them).

- **Schemas are reconciled on every deploy, on all three deployment paths.**
  Each runs `node scripts/provision-workos-audit-schemas.mjs --apply` from the
  frontend image against the deployment's own `WORKOS_API_KEY`. It reads first
  and writes only what is missing or actually changed, so an unchanged registry
  writes nothing (schema versions are append-only in WorkOS — an unconditional
  re-create would mint a new version of all ~30 schemas per rollout).

  | Path | How | Does the app wait? |
  |---|---|---|
  | Kubernetes (Pulumi) | Job `grid-app-audit-schemas` (`deploy/pulumi/src/app/audit-schemas-job.ts`), created when `requireAuth` is on | **No** — the frontend Deployment does not depend on it |
  | Docker Compose | one-shot service `grid-audit-schemas` | **Yes** — `frontend` waits on `service_completed_successfully` |
  | Coolify | the same one-shot service in `docker-compose.coolify.yaml` | **Yes** |

  On the compose paths the container exits 0 without doing anything when
  `WORKOS_API_KEY` is unset, so an anonymous stack still boots.

- **One action is on a request path, which is why the compose stacks block.**
  `document.generated` (agent-authored documents) is emitted with
  `recordAuditEventOrThrow`. A rejected event there does not thin the trail — the
  document it was about is unfiled, row and object both, and the user is shown a
  report with no file. WorkOS rejects an event whose action has no schema **and**
  one whose registered schema has the wrong targets or metadata keys, so this
  bites after a registry change as much as on a fresh environment: migration 0066
  added `answer_artifact` to that action's targets, and an environment still
  holding the two-target version rejects every emit until it is reconciled.
  Kubernetes deliberately does not gate the rollout on it — the failure window is
  one deploy long, loud, and self-healing, while gating would put every release
  behind a third party; the reasoning is in the Job file's own header.
- **Manual escape hatch** (a fresh environment, or a key the cluster does not
  hold — from `frontends/ui`):

  ```bash
  WORKOS_API_KEY=sk_… npm run provision:audit-schemas            # read-only drift check
  WORKOS_API_KEY=sk_… npm run provision:audit-schemas -- --apply # reconcile
  ```

  Same convention as `provision:authz`: check is the default, exits non-zero on
  drift, and names every action whose schema is missing or different.
- **Viewing** is native: the org page's "View audit logs" opens the WorkOS
  Admin Portal audit-logs viewer (`adminPortal.generateLink`,
  `intent: 'audit_logs'`); exports (CSV) and SIEM **streaming** (Datadog,
  Splunk, S3, …) are configured via the existing audit-log-streaming widget
  (`widgets:audit-log-streaming:manage` on the Admin role).
- **What a viewer reads.** `org:audit:view` opens the viewer, and roles that
  are not organization admins hold it (`org-auditor`, `org-compliance-officer`,
  any custom role given it). So an event emitted about a document filed, at
  that moment, under a folder not every project member may read leaves its name
  out (ADR-0087): for the actions in `DOCUMENT_NAME_ACTIONS`
  (`lib/audit/document-names.ts`) the emitter drops `filename`, `previousName`
  and `displayName`, and the screening `terms` (the name-gate words that
  matched a piece of the name on an override, the office's words the content
  check found in the text on a quarantine release; the release's `reasons` keep
  only the kinds), and sets `nameWithheld: true`; the
  target id still says
  which document, and someone cleared for the folder opens it in Piloti. Folder
  events carry the folder id, never its name. A folder rule that cannot be read
  withholds the name too.
- **What it does not cover.** The decision is taken once, when the event is
  emitted, and WorkOS events cannot be changed afterwards. A viewer still reads
  the name in: events emitted before this release; events emitted while the
  folder was open (an upload or rename), after which the folder got its own list
  (`project.folder.access_changed` removes nothing); and the earlier events of a
  document moved into a restricted folder (a move emits no audit event). If such
  names must not be read, limit `org:audit:view` to people cleared for those
  folders. `nameWithheld` is
  registered on those actions (and `terms` on `document.quarantine_released`);
  the deploy's schema job reconciles them, and an
  environment reconciled by hand needs `npm run provision:audit-schemas -- --apply`
  before this release, or WorkOS rejects the event.

### 6. Feature Flags (native WorkOS product)

Every feature switch is a **WorkOS Feature Flag**, per organization,
delivered in the AuthKit JWT `feature_flags` claim (registry:
`frontends/ui/src/lib/authz/feature-flags.ts`). There is one semantic: a flag is
on exactly when WorkOS says so for the organization, and anything short of a
yes — a stale token, a slug missing from WorkOS, a failed lookup, no
organization — is off. There are no env switches and no enforcement toggle.

The one exception is a deployment that signs nobody in (`REQUIRE_AUTH` not
`true`: local dev, an anonymous compose stack). It has no claim to read, so
each flag answers by its **kind** (`FLAG_KINDS` in the registry): a
**rollout** — shipped to everybody, kept as a kill switch — is ON, an
**entitlement** — granted per organization because it costs money or widens
who reads what — is OFF. To exercise an entitlement locally, sign in against
the Staging WorkOS environment.

| Flag slug | Kind | Gates |
|---|---|---|
| `runtime-model-config` | entitlement | Runtime AI model configuration (org page card + all 4 API routes) |
| `deep-research` | entitlement | Deep-research runs, on all three paths that reach one: job submission (`POST /api/jobs/async/submit`), the commissioned run (`POST /api/internal/tasks`, op `research`), and — since the agent reads it per turn — whether a run is OFFERED at all, so the escalation and its plan-approval card never appear for a tenant without it. **OFF for all organizations in Production since 2026-09-18**; ON in Staging |
| `byok-llm` | entitlement | BYOK LLM credentials (ADR-0022): org page card, all `/api/organization/llm-credentials` routes, and the internal resolution endpoint |
| `web-search` | rollout | Platform-layer web-search gate (ADR-0022). Evaluated live per org at the WS upgrade (like `memory-reflection`), combined with the tenant's own `settings.webSearchEnabled` toggle |
| `image-upload` | rollout | Standalone PNG/JPG upload via VLM captioning (FB-15a). Availability = this flag **AND** a derived VLM capability (`vlm_available` on `GET /v1/data_sources`, computed from the VLM key). Server-computed in the root layout, prop-drilled into `AppConfig.fileUpload.acceptedTypes` (client accept-list includes image types only when flag AND capability hold); the BFF upload route (`uploadDocument`) independently re-applies the same flag∧capability rule via a short-TTL-cached backend probe and rejects image extensions with a 400 (fail-closed when the capability can't be confirmed). **Prerequisite (in addition to this flag):** a configured VLM (`AIQ_VLM_*`). No `FILE_UPLOAD_ACCEPTED_TYPES` image opt-in is needed — images are derived from the capability, not the env list (env-listed images without a VLM stay excluded) |
| `wizard-conflict-check` | rollout | End-of-wizard intake conflict check (FB-13). Server-computed in the intake page, prop-drilled to `ProjectIntakeWizard`. On Save: structured answers are checked deterministically on the client (instant), free-text answers by the LLM (`POST /api/projects/[id]/consistency-check` → backend `/v1/consistency-check`, skipped when there is no substantive free text); findings hold the save for "Trotzdem speichern" / "Überarbeiten". Off → the wizard saves exactly as before |
| `skills` | entitlement | Agent Skills and the project Jobs that attach them (ADR-0046): the project **Automation** section (its Tasks / Zeitplan / Skills tabs, its rail entry, its ⌘K entries and the `g j` jump), every `/api/skills` and `/api/projects/[id]/jobs` route, and every scheduled fire (`fireScheduledJob` asks per organization and records a `skipped` run when it is off; the `skill-scheduler` itself has no gate). Created 2026-09-18, **OFF for all organizations in both environments** |
| `task-automation` | entitlement | Delegated TASKS and their schedules (ADR-0051/0054, `task_definitions` + `task_runs`): work a chat turn hands over instead of answering, plus the recurring `cadence` form the scheduler fires. Gates the agent's `create_task` tool — told to the model in its per-turn prompt block and refused at `POST /api/internal/tasks`, so a turn neither offers one nor creates one — and the session-bearing `/api/projects/[id]/tasks`. **Deliberately separate from `skills`**, which shipped with it and is not the same feature: a skill is an instruction the agent may follow inside a turn, a task is work that outlives the turn, costs the requester's budget and runs under their permissions. It is also the second door into `deep-research`, since a task's agent type may be `researcher` or `deep_researcher`. Created 2026-09-18, **OFF for all organizations in both environments** |
| `collaboration` | entitlement | Shared chats, `@`-mentions with the agent hand-off, and the inbox (ADR-0032…0035): the inbox nav entry + page, the share surfaces, the mention picker, and every `/api/inbox/*`, `/api/sharing/*` and `/api/stream` route. An entitlement because the feature changes who can READ a conversation. The flag hides the surfaces, it does not revoke grants: a thread shared while it was on stays shared in the database after it goes off |
| `piloti-wakes` | entitlement | Events on Piloti's work wake a turn (ADR-0106): a reply that addresses Piloti in an Anmerkung's thread, a reply on Piloti's own open question, and a mark delegated to Piloti are answered by the server (the `piloti_wake` job) as the person who acted, with nobody's browser open. Read from the person's session when the reply or delegation is written, and from their pinned session when the job runs. Off: an @Piloti reply is asked by the browser that wrote it, as before, and „An Piloti delegieren" is not offered. An entitlement because a wake is a model call nobody typed. **Not created yet in either environment**: create it OFF, then switch it on per organization |
| `piloti-acts` | entitlement | Piloti acts when asked (ADR-0105): sets a mark born open, changes one (resolve, reopen, dismiss, take over, assign, date, reword) or deletes one the person set, in the asker's name, through `POST /api/internal/document-annotations` (ops `create`, `update`, `delete`). Read from the asker's pinned session on that route (`isPilotiActsEnabled`, `lib/authz/feature-flags.ts`). Off: those ops are refused with a 403, code `PILOTI_ACTS_OFF`, `details.reason` `piloti-acts-off`, and Piloti proposes the mark instead or tells the person to make the change themselves; reads, the room, pointing, highlighting, thread replies and proposals are unaffected. An entitlement so an office starts with Piloti proposing only and switches acting on once it trusts it. **Not created yet in either environment**: create it OFF, then switch it on per organization; an organization that already relies on acting needs it targeted in the same release |
| `mail-import` | entitlement | The Outlook archive import into a project's Dateien (ADR-0085): the **Outlook-Archiv importieren** action and the routes that start and complete an import (`isMailImportEnabled`, `lib/authz/feature-flags.ts`). **Not created yet in either environment**, so the import is off for everybody until it is: create it OFF, then switch it on per organization once its Art. 28 notice covers imported correspondence |
| `project-mail-inbox` | entitlement | The project email address (`lib/inbound-mail`, ADR-0075): the address card and `/api/projects/[id]/inbound-address`, the inbound-mail webhook (a permanent refusal when off) and the filing job. The webhook and the job have no session and read `isProjectMailInboxEnabledForOrg` (`lib/workos/feature-flags.ts`), which answers a WorkOS failure with a retry rather than "off", because "off" bounces the sender's mail. An entitlement because mail from outside reaches a tenant's file system. Created 2026-10-01, **OFF for all organizations in both environments**; target an organization only after it has been told |
| `ifc-models` | rollout | IFC/BIM models (ADR-0045): the `.ifc` entry in the upload accept-list (client **and** the server-side allow-list), the model surfaces, every `/api/**/bim/*` route, and the agent's `ifc_query` tool via the internal service route. Worth knowing before enabling it for a customer: the feature renders OIB compliance verdicts, and `docs/roadmap/ifc-review-findings.md` lists the rules that still overstate |
| `agent-authored-documents` | rollout | The ONE filing seam for documents Piloti writes — a finished Recherchebericht, a drawn diagram — into a project as `documents` rows (`lib/documents/generated.ts`, ADR-0047). Deliberately alongside the `project:documents:generate` permission, not instead of it: the permission is the TENANT's (per project, per role, set by the org's own admin), this flag is the OPERATOR's — the lever that stops filing for every producer and every tenant at once without editing a built-in role (which would then fail `provision:authz --check` in CI) |
| `project-knowledge-page` | rollout | The project-level knowledge-base transparency page (`/knowledge` route plus its ⌘K entry), showing the shared OIB corpus and the project's documents with their live index state. The platform owner's base-knowledge manager is NOT gated by this. OFF for all organizations in both environments |
| `memory-reflection` | rollout | The post-answer memory-reflection stage, read per TURN by the agent tier (`GET /api/internal/stages`). ON for all organizations in both environments |
| `post-answer-follow-ups` | rollout | The post-answer follow-up-questions stage, read the same way. ON for all organizations in both environments, and the only source of follow-up questions since the in-answer card was retired |

**Retired flags (delete them from WorkOS in both environments).** Eight slugs
exist in WorkOS and nothing in the code reads them any more: the seven finished
UX rollouts `answer-feedback`, `chat-confidence-chip`, `files-metadata-panel`,
`research-in-chat-history`, `keyboard-shortcuts`, `organization-archiv` and
`ifc-preview-first` (ON for all organizations for about three months, so their
features are simply on now: the Archiv for every member of an organization, the
keyboard shortcuts for every session with one, the rest for everybody), and
`source-origin-badges`, whose only reader went with the research side panel. A
flag left in the dashboard after its code is gone reads like a switch and
switches nothing.

Rollout order (per environment): 1) create the flag in the WorkOS dashboard
(Feature Flags — flag create/update events are covered by WorkOS's own event
log), in BOTH environments and in the same change that adds the slug to the
registry, 2) target the organizations that should have it (dashboard, or
`workos.featureFlags.addFlagTarget({ slug, targetId: 'org_…' })`). `task
fe:provision:flags` lists every registry slug missing from an environment
(read-only, `WORKOS_API_KEY` of that environment). Tokens minted before a change carry the old claim — users pick it up at their
next sign-in. ✅ All four flags exist in Staging AND Production
(2026-07-13): `runtime-model-config` and `web-search` enabled for ALL
organizations in both; `byok-llm` enabled for ALL in Staging, OFF in
Production (target per enterprise deal). **`deep-research` was switched OFF
for ALL organizations in Production on 2026-09-18** (`flagEnabled: false`,
`accessType: NONE`), so that tier offers the shallow researcher only; it
stays ON for all organizations in Staging. Users signed in
before a flag change pick it up at their next sign-in. ✅ The three
cycle-6 UI flags exist in Staging AND Production (2026-07-14):
`source-origin-badges` and `files-metadata-panel` enabled for ALL
organizations in both; **`chat-confidence-chip` is enabled in Staging but
intentionally OFF in Production** until the live confidence-marker
smoke test passes (the answering LLM must emit the `[CONFIDENCE:…]` control
marker reliably; see FB-6 / backlog.md RUNTIME-SMOKE) — flip it on in
Production once that check is green. The `image-upload` flag (FB-15a) exists in
Staging AND Production (2026-07-14); enabled for all orgs in Staging,
**intentionally OFF in Production** pending a live image-ingestion smoke test
(a real PNG/JPG must round-trip through the VLM caption → summary/tags →
retrieval, and the deployment must have `AIQ_VLM_*` configured) — flip it on in
Production once that check is green. The `research-in-chat-history` flag (FB-10)
exists in Staging AND Production (2026-07-14); enabled for all orgs in Staging,
**intentionally OFF in Production** pending a review of the merged navigation
(the Research tab disappears and its runs move into the chat-history panel) —
flip it on in Production once the IA change is signed off. The
`wizard-conflict-check` flag (FB-13) exists in Staging AND Production
(2026-07-14); enabled for all orgs in Staging, **intentionally dark in
Production** pending a review of the end-of-wizard conflict check (deterministic
structured-answer rules plus a free-text LLM check, with a "Trotzdem speichern"
override) — flip it on in Production once the review is signed off and the
free-text check has been smoke-tested against a configured LLM.

#### Flags are always enforced (since 2026-10)

`GRID_ENFORCE_FEATURE_FLAGS` was switched on in both stacks on 2026-09-18 and
then deleted, together with every env fallback that only mattered while it was
off (`GRID_SKILLS_ENABLED`, `GRID_COLLABORATION_ENABLED`,
`GRID_MAIL_IMPORT_ENABLED`, `GRID_IFC_MODELS_ENABLED`,
`GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED`, `GRID_PROJECT_KNOWLEDGE_PAGE_ENABLED`,
`GRID_MEMORY_REFLECTION_ENABLED`, `GRID_STAGE_FOLLOW_UPS_ENABLED`). With it on,
every one of those was dead config in both stacks, and compose and local dev,
which ran it off, rehearsed a different code path from the one that shipped.
WorkOS is the control plane for features: per organization, per flag, no
redeploy.

**A registry flag absent from WorkOS is off for everybody.** The registry is
TypeScript and the flags are remote state, so `task verify` cannot see across
the gap. `task fe:provision:flags` can: it lists the environment's flags
read-only, fails on any registry slug missing there, and reports (without
failing) flags no code reads. The weekly **WorkOS drift** workflow runs it
against Staging; Production has no key in CI, so run it there by hand with the
Production key. **Create the flag in both environments in the same change.**

##### What the flip changed, and what it deliberately did not

Before the flip, ten features were live in Production only *because*
enforcement was off — seven riding fail-open, three (`answer-feedback`,
`ifc-preview-first`, `agent-authored-documents`) not present in WorkOS at all
and therefore about to fail closed. Enforcing without fixing that would have
withdrawn all ten in one deploy.

So the WorkOS state was made **behaviour-preserving first**: every registry flag
was created or targeted to match what Production was already serving, and only
the two the change was actually for were switched off.

| Registry flag | Production now | Note |
|---|---|---|
| `deep-research` | **OFF, all orgs** | The intended change: the tier offers the shallow researcher only |
| `skills` | **OFF, all orgs** | The intended change: no Automation section. Created 2026-09-18 — it had never existed |
| `task-automation` | **OFF, all orgs** | The intended change: no work handed over from a chat turn. Created 2026-09-18 — it had never existed, and `skills` alone could not express it |
| `project-knowledge-page` | OFF, all orgs | Unchanged; it was already dark via its env opt-in |
| `answer-feedback` | ON, all orgs | Created 2026-09-18 to preserve behaviour — was fail-open before |
| `ifc-preview-first` | ON, all orgs | Created 2026-09-18 to preserve behaviour — was env-default-ON before |
| `agent-authored-documents` | ON, all orgs | Created 2026-09-18 to preserve behaviour — was env-default-ON before |
| `byok-llm`, `chat-confidence-chip`, `research-in-chat-history`, `wizard-conflict-check`, `organization-archiv`, `collaboration`, `ifc-models` | ON, all orgs | Switched from OFF to ON on 2026-09-18. They read OFF in WorkOS while Production served them anyway; the flip would have withdrawn them |
| `runtime-model-config`, `web-search`, `keyboard-shortcuts`, `source-origin-badges`, `files-metadata-panel`, `image-upload` | ON, all orgs | Unchanged |

That last-but-one row is the one to read twice. Several of those flags are
described **above** as "intentionally OFF in Production" pending a smoke test or
a sign-off. That intent was never in force: with enforcement off, a flag reading
OFF in the dashboard still served the feature to every organization, so those
notes described a state Production did not have. Turning them ON records what
Production has actually been serving for two months rather than silently
withdrawing seven features under cover of an unrelated change. **Each is now one
dashboard toggle away** — if the sign-off those notes wait on has still not
happened, switch the flag off deliberately and say so in a release note.

`flagsForOrganization` is the authoritative answer to what an organization
actually gets; prefer it over reading `flagEnabled` per flag.

##### Withdrawing a feature from here

One WorkOS toggle, per organization or for all, effective at the reader's next
sign-in (the claim rides the AuthKit JWT). No deploy. That is the point of
enforcing.

There is no stack key to change alongside: the `skill-scheduler` always runs
and the BFF skips a schedule whose organization lacks `skills`, so re-enabling
Automation for one organization is the same single toggle.

##### How a withdrawn capability reaches the agent

`deep-research` and `task-automation` are not gates the job queue applies after
the fact. Both are resolved PER TURN by the agent tier, on
`GET /api/internal/stages` (`features.deepResearch`, `features.tasks`), and read
in two places: the prompt tells the model the capability is absent, and the
conversation graph refuses the escalation even when the model asks anyway. So a
tenant without deep research is never shown a plan, and one without tasks is
never told an Auftrag was created.

The same answer carries a closed project (ADR-0090): the turn sends its
`projectId`, and a closed project answers `deepResearch: false` and
`tasks: false` whatever the flags say, because both file into the project.

That is what the flags did NOT do before. Each was read at exactly one route —
`POST /api/jobs/async/submit` for deep research, nothing at all for tasks — so
the agent went on escalating into a queue that would refuse it, and the reader
met the refusal only after approving a plan for it. A flag that closes a queue
is not a flag that withdraws a feature.

Three things follow, and each has cost somebody an afternoon:

- **The routes still check.** `POST /api/internal/tasks` refuses both ops and
  `submit` re-checks with the reader's own session. The agent-side read is what
  stops the OFFER; it is not the authority, and a capability withdrawn
  mid-conversation is caught there.
- **A refused commission is never retried in process.** `CommissionRefused`
  with reason `forbidden` answers with the unavailability note. The inline
  fallback exists for a deployment with no worker, and running it on a
  capability refusal would do the very thing the route just refused.
- **Every failure path leaves the capability ALLOWED** — an unreachable BFF, a
  timeout, an older BFF that sends no `features`. Withdrawal is a decision
  somebody made in WorkOS; it is never the shape of a blip. The route behind it
  is what fails closed. A turn with no organization is not a failure: the BFF
  answers it, and its answer is OFF (both are entitlements), the same verdict
  the submit and task routes reach.

## Replay into a fresh environment

> Steps 1–5 were run against **Production on 2026-07-31** via the WorkOS
> management API and verified role-by-role.
>
> **Re-verified in BOTH environments on 2026-09-18**, against
> `lib/authz/catalog.ts` rather than by eye: all 3 catalog resource types, all
> 33 permissions, and all 13 roles exist in each, and every role's permission
> set matches the catalog exactly — including the two GRID Platform
> organization-scoped roles, which the environment-wide role listing does not
> return and which therefore have to be asked for per organization.
> Nothing had to be created. Step 6 (feature flags) is now done in both; §6
> carries its state.
>
> The diff also surfaced drift in the other direction — things WorkOS held that
> the catalog does not — and it was cleaned out the same day, so both
> environments now match the catalog exactly, with nothing extra:
>
> - **The legacy `workflow` tier is gone.** ADR-0023's resource type, its
>   `workflow:view|run|manage` and `project:workflows:manage` permissions, and
>   its three `workflow-*` roles were deleted from both environments. It was
>   superseded by Agent Skills, no code has read any of it since, and every one
>   of the six roles had a membership count of zero — all four facts checked
>   before anything was deleted, because `provision:authz` does not delete and
>   therefore nothing else would have caught a mistake here. The legacy
>   `workflows` FEATURE FLAG, which was likewise in no registry, went with it.
> - **`multipleRolesEnabled` is `false` in both.** Staging was `true`. The
>   session model carries ONE `role` plus a `permissions` array and authorizes
>   on the permissions, so a second role would have unioned its permissions in
>   while leaving `role` ambiguous — and the catalog's organization roles are
>   written as exclusive personas („…and nothing else"). Staging was brought to
>   Production's setting rather than the reverse, for the same reason
>   enforcement was: Staging rehearses Production, so a capability Production
>   does not have is not one Staging should be testing with.
>
> What a clean environment looked like then: 3 resource types (`organization` →
> `project` → `skill`), 33 permissions (27 custom plus 6 WorkOS-managed widget
> ones), 13 roles, and no others.
>
> Since then the catalog gained `org:downloads:view` (2026-10-06) and the folder
> tier (ADR-0097, 2026-10-09). What the next diff should find: 4 resource types
> (`folder` beside `skill` under `project`), 36 permissions (30 custom plus 6
> widget ones), 15 roles.

1. **Dashboard** (still manual — the SDK cannot create resource types): create
   the resource types from §0 — `project` (parent `organization`), then
   `skill` and `folder` (each parent `project`). Descriptions are capped at 150
   characters.
2. **Script**: `WORKOS_API_KEY=<key> npm run provision:workos-env -- --apply`
   from `frontends/ui` creates organization **GRID Platform** with external id
   `grid-platform` (the app resolves it by external id, so the name may differ
   but the external id may not). Was dashboard-only before.
3. **Script**: `WORKOS_API_KEY=<key> npm run provision:authz -- --apply`.
   This creates every permission from §1/§1a/§1b/§1c/§2 and every role from §2a,
   including the two platform-org roles, and is idempotent. Nothing to do if
   the environment is the one a stack deploys against: the
   `grid-app-authz-catalog` Job runs it on the next rollout.
4. **Script**: re-run both without `--apply` and confirm
   "WorkOS matches the catalog." / "WorkOS matches the desired environment."
5. **Script**: re-run `provision:workos-env --apply` with
   `GRID_PLATFORM_OWNER_EMAIL=<owner email>` set — it seats the user in GRID
   Platform (the account itself must already exist; the script reports a
   missing one as MANUAL) and assigns `org-platform-owner`. The membership +
   role pair used to be a dashboard/API action.
6. **Script**: re-run `provision:workos-env --apply` with
   `WORKOS_DESIRED_REDIRECT_URIS` / `WORKOS_DESIRED_CORS_ORIGINS` set to add
   the production web origins, and `WORKOS_CONNECT_APP_NAME` /
   `WORKOS_CONNECT_REDIRECT_URIS` set to create the observability Connect
   application. On first creation the script prints the client id and client
   secret ONCE — store them immediately (`pulumi config set --secret …`, see
   the Pulumi stack-file header); the Scopes permission assignment stays a
   dashboard step.
7. Audit Log schemas (§5): nothing to do if the environment is the one the
   cluster deploys against — the `grid-app-audit-schemas` Job reconciles them
   on the next rollout. Otherwise run it by hand:
   `WORKOS_API_KEY=<prod key> npm run provision:audit-schemas -- --apply`
   (from `frontends/ui`), then re-run without `--apply` to confirm it reports
   "WorkOS matches the audit registry."
8. Feature flags (§6): CREATION stays a dashboard step —
   `provision:workos-env` lists every registry flag missing from WorkOS as
   MANUAL rather than attempting it. Create them, target the intended orgs
   (`WORKOS_FLAG_TARGETS_JSON` + `--apply` reconciles targeting, ADDITIVELY).
   `task fe:provision:flags` then confirms every registry slug exists.
9. BYOK (ADR-0022): WorkOS Vault needs no per-environment setup — objects
   are created lazily under each org's key context. Enterprise tenants
   wanting customer-managed KEKs (Vault BYOK: AWS KMS / Azure Key Vault /
   GCP KMS) enable it per organization with WorkOS support; no Piloti change
   is required.

Still manual in every environment, summarized by every `provision:workos-env`
run: resource types, AuthKit's *Allow sign-ups* toggle, the
`multipleRolesEnabled` role setting, flag creation, and Vault CMK via support.

Bootstrap alternative: set `GRID_PLATFORM_OWNER_EMAILS=<owner email>` until
steps 3–5 are done, then clear it.

## Rolling out folder roles (ADR-0097)

Before ADR-0097 a folder with its own access list named organization roles, in
`project_folder_grants`. Now the folder is a `folder` resource and the people on
its list hold a folder role on it. Migration `0128` carries over what needs no
WorkOS (the reserved `*` entry becomes `project_folders.everyone_reads`, or the
folder goes back to inheriting when everyone wrote it). The role entries become
folder roles of the people who hold those roles, which only WorkOS knows, so a
script does that. **The deploy runs all of it**, after one dashboard step per
environment:

1. **Dashboard, once**: create the `folder` resource type, parent `project` (§0).
   Staging and Production have it (Production since 2026-10-10). Neither the SDK nor the public API
   can create a resource type, so this is the one step no deploy can take.
   Without it the catalog Job fails on the folder permissions and roles, the
   stack update reports it, and the carry-over does not run.
2. **Deploy.** In order, with nothing to run by hand:
   - `grid-app-authz-catalog` creates `folder:read`, `folder:write`,
     `folder-reader` and `folder-editor` (`provision:authz --apply`).
   - `grid-app-migrate` applies migration `0128`.
   - The frontend that reads folder roles rolls out. From here until the
     carry-over has run, a folder whose list named roles is readable only by
     organization admins and, when everyone reads it, by every project member:
     narrower than before, never wider.
   - `grid-app-folder-grants` carries the role grants over
     (`migrate:folder-grants --apply`). It waits on the frontend rollout, the
     migrations and the catalog Job. Compose runs both scripts in
     `grid-workos-authz`, once the frontend is healthy.

For every folder with its own list, every active member of the organization who
holds a role the list names gets the folder role for the best level those roles
granted. The Job's log prints, per folder, the roles, how many people that is,
and any role no active member holds. It reads `project_folder_grants` across
every organization, so it runs with the schema owner's connection; the runtime
role is subject to row-level security and sees nothing. It converts only folders
not yet registered in WorkOS and never removes a folder role, and saving a list
in the new dialog deletes that folder's old grant rows, so a list someone
changed is never carried over again and every later deploy's run is a no-op.

By hand, for an environment no stack deploys against, from `frontends/ui`:

```bash
WORKOS_API_KEY=sk_… GRID_APP_MIGRATION_DATABASE_URL=postgres://… \
  bun run migrate:folder-grants             # the plan, changes nothing
WORKOS_API_KEY=sk_… GRID_APP_MIGRATION_DATABASE_URL=postgres://… \
  bun run migrate:folder-grants -- --apply  # register the folders, assign the roles
```

A folder a failed run registered but did not finish is finished with
`-- --apply --finish=<folder id>`.

**Why the carry-over waits for the frontend.** Run before the new frontend, the
script would carry a list over as it stood then, and a list narrowed in the old
dialog afterwards would come back wider, because a later run skips a folder an
earlier one registered. Run after it, the old dialog is gone and the gap is
only narrower.

**What changes for the office.** A role grant followed the role: someone given
the role later reached the folder. A folder role is given to a person, so after
the carry-over a list is the people who held the role on the day it ran, and
someone given the role afterwards is added to the folder by hand. The other
way round too: someone who loses the role later keeps the folder role until
someone takes them off the list.

`project_folder_grants` stays until the carry-over has run in every
environment; the migration that drops it also deletes the
`grid-app-folder-grants` Job and the second half of `grid-workos-authz`.

## How the app consumes this

- **Catalog** (`lib/authz/catalog.ts`) — the source of truth this runbook
  documents, read by the app and by `provision:authz`.
- **Decision point** (`lib/authz/decide.ts`) — one `decide()`/`authorize()`
  across all four tiers, each answer carrying the named rule that produced it
  (ADR-0038). Claims tiers deny with 403, resource tiers with 404.
- **Claims** (`role`, `permissions`) per active org → `lib/authz/permissions.ts`.
  A role slug implies exactly the permissions the **catalog** says that role
  holds — a bounded back-compat bridge for sessions minted before a permission
  was provisioned, not the old `org:*` prefix wildcard. `platform:*` is never
  implied.
- **Platform owner**: `lib/authz/platform.ts` — platform-org membership with
  `org-platform-owner`/`org-platform-support` (cached lookup) or the break-glass
  allowlist.
- **Per-resource**: `lib/authz/resource-check.ts` is the single FGA round-trip
  for both the project and skill tiers, and fails closed.
- **Folders** (ADR-0097): `lib/authz/folder-roles.ts` holds every WorkOS call of
  the folder tier. A person's levels in a project are two
  `listResourcesForMembership` calls (`folder:read`, `folder:write`) scoped to
  the project, cached for `GRID_AUTHZ_CACHE_TTL_MS` like every FGA answer, and
  never made for a project with no folder of its own (one indexed probe). A
  lookup that fails clears nothing and is not cached. Changing a list registers
  the folder, then removes the folder roles it no longer wants before assigning
  the new ones, and drops the cached levels of everyone it changed.
  `lib/authz/folder-access.ts` stays the one decision point: it walks the
  folder's ancestors (`effectiveFolderLevel`, the minimum over the path), caps
  writing at the project role, and lets organization admins write everywhere.
- **Route postures**: every `app/api` handler declares how it is authorized
  (`{ permission }` / `{ enforcedBy }` / `{ sessionOnly, why }`); `tsc` rejects a
  route that does not, and `src/app/api/authz-coverage.spec.ts` fails when a
  handler escapes the factories entirely.
- **Custom roles**: add a role to the catalog (or create one in WorkOS with a
  subset of `org:*` / `widgets:*`) and it works immediately — code never checks
  role names except the bounded `admin` back-compat above. The four shipped
  personas in §2a exercise this path so it cannot rot unnoticed.

## Sign-up policy — what is native WorkOS vs. app-side

| Control | Where | How |
|---|---|---|
| Who can create an ACCOUNT | **WorkOS (native)** | AuthKit → `allowSignUp` off = invite-only accounts; or enable the **waitlist** (approve/deny each entry). Auth methods (password/Google/GitHub/Microsoft/Apple), email verification, MFA, password policy are all native settings. |
| Joining an existing org | **WorkOS (native)** | Invitations (users-table widget) and **domain auto-join** (verify the org's email domain; users signing up with that domain land in the org via JIT provisioning instead of the onboarding screen). |
| Who can create an ORGANIZATION | **App-side** (`GRID_DISABLE_SELF_SERVE_ORGS`) | WorkOS has no org-creation gate — orgs are created by our API. `true` = only the platform team creates orgs; onboarding shows the invite-only notice up front. |
| Platform tier / cross-org access | **App-side on WorkOS primitives** | The GRID Platform org + org-scoped role (this runbook); resolution logic in `lib/authz/platform.ts`. |

Decided posture (see §4): invite-only everything — `allowSignUp` off,
`GRID_DISABLE_SELF_SERVE_ORGS=true`. Verified-domain auto-join stays
available for known customer domains; the waitlist remains an option if
public interest should queue rather than bounce.
