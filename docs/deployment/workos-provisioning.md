# WorkOS Provisioning Runbook

> What must exist in a WorkOS environment for GRID's authorization model
> (ADR-0016) to work, what is already provisioned where, and how to replay
> it (e.g. into Production). The app degrades gracefully when pieces are
> missing (legacy `admin` back-compat, break-glass env allowlist), but this
> is the intended steady state.

## Provisioned state (Staging — done 2026-07-08)

The Staging environment (`environment_01KEF0YG238CSMNF731TEG010E`) is the
one the deployed app uses (its orgs include "GRID Test"). Everything below
already exists there. **Production is empty and needs the same replay
before go-live.**

### 1. Organization-tier permissions (resource type: Organization)

| Slug | Meaning |
|---|---|
| `org:settings:manage` | Org settings (name, locale, defaults); org page shell |
| `org:models:manage` | Runtime AI model configuration (ADR-0014) |
| `org:budgets:manage` | LLM budgets + org-wide usage (ADR-0015) |
| `org:compliance:manage` | Legal holds + deletion queue |
| `org:audit:view` | Open the org's native audit-log viewer (Admin Portal). ⚠️ Added after the 2026-07-08 provisioning run — create it in Staging + attach to Admin (until then, legacy-`admin` back-compat covers admins). |

Attached to the environment **Admin** role (which keeps its six
`widgets:*` permissions). The **Member** role has none — members rely on
project-level FGA roles.

### 2. Platform-tier permissions (resource type: Organization)

| Slug | Meaning |
|---|---|
| `platform:organizations:view` | See every org: directory, members, activity |
| `platform:organizations:manage` | Administer any org (reserved, unused in v1) |
| `platform:usage:view` | Cross-org LLM usage/spend |
| `platform:settings:manage` | Platform-wide settings (reserved) |

They live on the Organization resource type because WorkOS permissions
attach to resource types and **Organization is the immutable topology
root** — a type above it is rejected by the API (see ADR-0016). They are
only ever attached to platform-org roles, never to tenant roles.

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

- CORS web origins: `https://grid-dev.bigls.net`, `https://grid.bigls.net`
  (required for WorkOS widgets) — pre-existing, verified.
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
Actions emitted (registry: `AUDIT_ACTIONS` in that file): `org.created`,
`org.settings.updated`, `budget.policy.set`, `budget.policy.cleared`,
`model_config.version.activated`, `compliance.hold.created`,
`compliance.hold.released`, `platform.access.break_glass` (lands in the GRID
Platform org's trail, throttled to once per actor per hour),
`project.created`, `project.deleted`, `project.restored`,
`project.role.assigned`, `project.role.removed` (FGA access-control
changes), `document.uploaded` (data provenance). Deliberately NOT audited:
high-frequency content activity (memory items, profile edits, conversation
messages, renames, user preferences) — it would drown the admin trail.

- **Provision the event schemas** (validates incoming events; also creates
  the actions): `WORKOS_API_KEY=sk_… npm run provision:audit-schemas`
  (from `frontends/ui`; idempotent — rerunning adds identical versions).
  ⚠️ Not yet run against Staging — run it once before expecting events.
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

Rollout order (per environment): 1) create the flags in the WorkOS
dashboard (Feature Flags — flag create/update events are covered by
WorkOS's own event log), 2) target the organizations that should have them
(dashboard, or `workos.featureFlags.addFlagTarget({ slug, targetId:
'org_…' })`), 3) set `GRID_ENFORCE_FEATURE_FLAGS=true` in the deployment.
While the env flag is `false` (default) nothing is gated, so existing
deployments are unaffected. Once enforced, tokens minted before the rollout
carry no `feature_flags` claim and fail closed — users pick the flags up at
next sign-in. ⚠️ Not yet created in Staging.

## Replay into a fresh environment (e.g. Production)

Via the WorkOS dashboard (or the management API):

1. Create the ten permissions from tables 1 + 2 (resource type
   Organization, same slugs).
2. Edit the **Admin** role: add the five `org:*` permissions (keep the
   `widgets:*` ones).
3. Create organization **GRID Platform** with external id `grid-platform`.
4. Inside that organization, create the **org-scoped** role
   `org-platform-owner` with the four `platform:*` + five `widgets:*`
   permissions.
5. Add the owner's user to GRID Platform with that role.
6. Add the production web origin to AuthKit CORS and redirect URIs.
7. Provision the Audit Log schemas: `WORKOS_API_KEY=<prod key> npm run
   provision:audit-schemas` (from `frontends/ui`).
8. Create the feature flags (§6), target the intended orgs, then set
   `GRID_ENFORCE_FEATURE_FLAGS=true`.
9. BYOK (ADR-0022): WorkOS Vault needs no per-environment setup — objects
   are created lazily under each org's key context. Enterprise tenants
   wanting customer-managed KEKs (Vault BYOK: AWS KMS / Azure Key Vault /
   GCP KMS) enable it per organization with WorkOS support; no Grid change
   is required.

Bootstrap alternative: set `GRID_PLATFORM_OWNER_EMAILS=<owner email>` until
steps 3–5 are done, then clear it.

## How the app consumes this

- JWT claims (`role`, `permissions`) per active org → permission registry
  (`frontends/ui/src/lib/authz/permissions.ts`); legacy `admin` implies all
  `org:*` (never `platform:*`).
- Platform owner: `lib/authz/platform.ts` — platform-org membership with
  `org-platform-owner` (cached lookup) or the break-glass allowlist.
- Custom roles: create any role in WorkOS with a subset of `org:*` /
  `widgets:*` permissions and it works immediately — code never checks role
  names except the documented `admin` back-compat.

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
