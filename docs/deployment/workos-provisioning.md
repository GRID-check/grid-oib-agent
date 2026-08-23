# WorkOS Provisioning Runbook

> What must exist in a WorkOS environment for GRID's authorization model
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

The check is read-only and exits non-zero on drift — run it in CI. It exists
because the two ⚠️ rows this runbook used to carry (`org:audit:view`,
`org:archiv:manage`, both "create this in Staging", both still absent three
weeks later) were invisible to everything except a human re-reading the file.

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

`Organization → Project → Skill`. Organization is the immutable root:
creating a parentless resource type is rejected by the live API with
*"At least one parent type is required"* (verified 2026-07-30), which is why the
platform tier is modelled as an org-scoped role rather than a tier above
Organization.

| Type | Parent | Purpose |
|---|---|---|
| `organization` | — | System root. Carries org-tier and platform-tier permissions. |
| `project` | `organization` | Tenant workspace: documents, memory, conversations. |
| `skill` | `project` | A scheduled agent-skill job attached to a project (Agent Skills). |

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
| `admin` | environment | every `org:*` + six `widgets:*` |
| `org-auditor` | environment | `org:audit:view` |
| `org-billing-admin` | environment | `org:budgets:manage` |
| `org-compliance-officer` | environment | `org:compliance:manage`, `org:audit:view` |
| `org-knowledge-manager` | environment | `org:archiv:manage` |
| `org-user-admin` | environment | `org:members:manage`, `widgets:users-table:manage` |
| `project-viewer` | environment (Project) | `project:view` |
| `project-contributor` | environment (Project) | `project:view`, `project:chat` |
| `project-editor` | environment (Project) | + `project:edit`, `project:documents:write`, `project:memory:write` |
| `project-admin` | environment (Project) | + `project:manage`, `project:members:manage`, `project:skills:manage` |
| `org-platform-owner` | **GRID Platform org only** | all `platform:*` + five `widgets:*` |
| `org-platform-support` | **GRID Platform org only** | `platform:organizations:view`, `platform:usage:view` |

The five fine-grained org personas exist to keep ADR-0016's extensibility
contract honest: each holds a strict subset of Admin and works with no code
change, which is the property that silently broke for `org:audit:view` and
`org:archiv:manage`.

### 3. The platform organization + exclusive role

- Organization **"GRID Platform"**, external id **`grid-platform`**
  (Staging id: `org_01KX06QQJN3KA25R9G2PNFBGXV`). The app resolves it by
  external id (`GRID_PLATFORM_ORG_EXTERNAL_ID`).
- **Org-scoped role** `org-platform-owner` ("Platform Owner") **created
  inside that org only** — WorkOS org-scoped roles cannot be assigned in
  any other organization, which is the exclusivity guarantee. Permissions:
  the four `platform:*` + all five admin widget scopes (so platform-org
  widgets work on the platform dashboard).
- The owner (biglmatthias@gmail.com, `user_01KEF12GR7XHBQXA5M42R9VC48`)
  holds a GRID Platform membership with that role.

### 4. AuthKit / environment settings

- CORS web origins: `https://app.dev.piloti.at` (required for WorkOS widgets).
  Keep in sync with `grid-oib:baseDomain` in `deploy/pulumi/Pulumi.*.yaml` —
  the app origin is always `https://app.<baseDomain>`. Reconciled by
  `provision:workos-env` (`WORKOS_DESIRED_CORS_ORIGINS`, and
  `WORKOS_DESIRED_REDIRECT_URIS` for redirect URIs); extras are report-only
  unless `--apply --prune`.
- Auth methods: password + Google + GitHub + Microsoft + Apple; email
  verification required; MFA off. No JWT template (default claims carry
  role/permissions per active org — exactly what the app reads).
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
Archiv uploads/deletes, and the sharing/ownership changes from ADR-0032.
Deliberately NOT audited: high-frequency content activity (memory items,
profile edits, conversation messages, renames, user preferences) — it would
drown the admin trail.

- **Schemas are reconciled on every deploy.** The Kubernetes Job
  `grid-app-audit-schemas` (`deploy/pulumi/src/app/audit-schemas-job.ts`) runs
  `node scripts/provision-workos-audit-schemas.mjs --apply` from the frontend
  image, against the deployment's own `WORKOS_API_KEY`. It reads first and
  writes only what is missing or actually changed, so an unchanged registry
  writes nothing (schema versions are append-only in WorkOS — an
  unconditional re-create would mint a new version of all ~30 schemas per
  rollout). Nothing depends on the Job: a WorkOS outage must not hold back a
  release, so a failure shows up as a failed Job, not a failed deploy.
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

### 6. Feature Flags (native WorkOS product)

Premium/expensive features are gated behind **WorkOS Feature Flags**,
delivered in the AuthKit JWT `feature_flags` claim (registry:
`frontends/ui/src/lib/authz/feature-flags.ts`):

| Flag slug | Gates |
|---|---|
| `runtime-model-config` | Runtime AI model configuration (org page card + all 4 API routes) |
| `deep-research` | Deep-research job submission (`POST /api/jobs/async/submit`) |
| `byok-llm` | BYOK LLM credentials (ADR-0022): org page card, all `/api/organization/llm-credentials` routes, and the internal resolution endpoint (under enforcement) |
| `web-search` | Platform-layer web-search gate (ADR-0022). Evaluated live per org at the WS upgrade (like `memory-reflection`), combined with the tenant's own `settings.webSearchEnabled` toggle |
| `source-origin-badges` | [KB]/[RIS]/[Web] origin badges in report source lists (FB-2). Server-computed in the chat route, prop-drilled to ReportTab; off → plain token-stripped source text |
| `chat-confidence-chip` | Self-assessed confidence chip on shallow chat answers (FB-6). Server-computed in the chat route, prop-drilled to AgentResponse; off → no chip |
| `files-metadata-panel` | Files preview ingestion-metadata block: summary/pages/passages/contents rows (FB-8). Server-computed in the files page, prop-drilled to FilePreviewPane; status/type/size rows are never gated |
| `image-upload` | Standalone PNG/JPG upload via VLM captioning (FB-15a). Availability = this flag **AND** a derived VLM capability (`vlm_available` on `GET /v1/data_sources`, computed from the VLM key). Server-computed in the root layout, prop-drilled into `AppConfig.fileUpload.acceptedTypes` (client accept-list includes image types only when flag AND capability hold); the BFF upload route (`uploadDocument`) independently re-applies the same flag∧capability rule via a short-TTL-cached backend probe and rejects image extensions with a 400 (fail-closed when the capability can't be confirmed). **Prerequisite (in addition to this flag):** a configured VLM (`AIQ_VLM_*`). No `FILE_UPLOAD_ACCEPTED_TYPES` image opt-in is needed — images are derived from the capability, not the env list (env-listed images without a VLM stay excluded) |
| `research-in-chat-history` | Fold the Research runs tab into the chat-history panel as a "Deep Research" section (FB-10). Server-computed in the project layout (hide the `research` nav item) and the chat route (SessionsPanel section + `?job=` deep links); the `/research` route redirects to chat when on. Off → legacy Research tab + `ResearchRunsList` page remain |
| `wizard-conflict-check` | End-of-wizard intake conflict check (FB-13). Server-computed in the intake page, prop-drilled to `ProjectIntakeWizard`. On Save: structured answers are checked deterministically on the client (instant), free-text answers by the LLM (`POST /api/projects/[id]/consistency-check` → backend `/v1/consistency-check`, skipped when there is no substantive free text); findings hold the save for "Trotzdem speichern" / "Überarbeiten". Off → the wizard saves exactly as before |
| `organization-archiv` | Org-wide document Archiv (ADR-0024): `/app/archiv` page + user-menu entry, `/api/archiv/*` routes, and injection of the `archiv_<orgId>` collection into every project's retrieval scope. A standard flag — while `GRID_ENFORCE_FEATURE_FLAGS` is off it is available to all orgs (fail-open, like every flag); once enforcement is on, target the specific orgs that should have it. Uploads/deletes additionally require the `org:archiv:manage` permission (table §1) |
| `answer-feedback` | Per-answer thumbs feedback (WS-7 of the click-dummy overhaul spec): the "War das hilfreich?" row under assistant answers (up / down → reason chips) and the `/api/feedback/answers` routes (`lib/feedback/*`, `answer_feedback` table). Server-computed in the chat route, prop-drilled to AgentResponse (same path as `chat-confidence-chip`). A standard flag — fail-open while enforcement is off; **create it default-off** in WorkOS and target the orgs that should collect feedback. Not yet provisioned in Staging/Production |

Rollout order (per environment): 1) create the flags in the WorkOS
dashboard (Feature Flags — flag create/update events are covered by
WorkOS's own event log), 2) target the organizations that should have them
(dashboard, or `workos.featureFlags.addFlagTarget({ slug, targetId:
'org_…' })`), 3) set `GRID_ENFORCE_FEATURE_FLAGS=true` in the deployment.
While the env flag is `false` (default) nothing is gated, so existing
deployments are unaffected. Once enforced, tokens minted before the rollout
carry no `feature_flags` claim and fail closed — users pick the flags up at
next sign-in. ✅ All four flags exist in Staging AND Production
(2026-07-13): `runtime-model-config`, `deep-research`, and `web-search`
enabled for ALL organizations in both; `byok-llm` enabled for ALL in
Staging, OFF in Production (target per enterprise deal). Users signed in
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

## Replay into a fresh environment

> Steps 1–5 were run against **Production on 2026-07-31** via the WorkOS
> management API and verified role-by-role. Steps 6–9 remain open there.

1. **Dashboard** (still manual — the SDK cannot create resource types): create
   the resource types from §0 — `project` (parent `organization`), then
   `skill` (parent `project`). Descriptions are capped at 150 characters.
2. **Script**: `WORKOS_API_KEY=<key> npm run provision:workos-env -- --apply`
   from `frontends/ui` creates organization **GRID Platform** with external id
   `grid-platform` (the app resolves it by external id, so the name may differ
   but the external id may not). Was dashboard-only before.
3. **Script**: `WORKOS_API_KEY=<key> npm run provision:authz -- --apply`.
   This creates every permission from §1/§1a/§1b/§2 and every role from §2a,
   including the two platform-org roles, and is idempotent.
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
   (`WORKOS_FLAG_TARGETS_JSON` + `--apply` reconciles targeting, ADDITIVELY),
   then set `GRID_ENFORCE_FEATURE_FLAGS=true`.
9. BYOK (ADR-0022): WorkOS Vault needs no per-environment setup — objects
   are created lazily under each org's key context. Enterprise tenants
   wanting customer-managed KEKs (Vault BYOK: AWS KMS / Azure Key Vault /
   GCP KMS) enable it per organization with WorkOS support; no Grid change
   is required.

Still manual in every environment, summarized by every `provision:workos-env`
run: resource types, AuthKit's *Allow sign-ups* toggle, the
`multipleRolesEnabled` role setting, flag creation, and Vault CMK via support.

Bootstrap alternative: set `GRID_PLATFORM_OWNER_EMAILS=<owner email>` until
steps 3–5 are done, then clear it.

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
