# ADR-0016: Platform tier and the permission-driven authorization model

- **Status**: Accepted
- **Date**: 2026-07-08
- **Deciders**: Grid Agent team (platform model chosen by the platform owner)
- **Related**: ADR-0002 (WorkOS identity), ADR-0004 (tenancy), ADR-0007 (no local identity sync), `docs/deployment/workos-provisioning.md`, `docs/architecture/multitenancy-and-auth-spec.md`

## Context

Authorization was role-slug driven (`session.role === 'admin'`) with three
routes even bypassing the shared helper, WorkOS FGA covered only the
`project` resource type, and nothing existed above the organization: no way
for the app owner to see all tenants, cross-org usage, or platform health.
Sign-up let any fresh user self-provision an org and become its admin with
no platform-level control.

Hard constraint discovered while provisioning (verified via the WorkOS API):
**Organization is the immutable root of WorkOS's FGA topology.** Creating a
parentless resource type is rejected ("At least one parent type is
required") and the Organization system type cannot be re-parented ("Cannot
update organization resource type"). A resource type *above* organizations
is therefore not expressible; a `platform` FGA type would forever render as
a child of Organization — semantically upside down — and was rejected.

## Decision

1. **Permission-driven checks (extensible roles).** The app checks
   PERMISSIONS, never role names: a registry
   (`frontends/ui/src/lib/authz/permissions.ts`) defines `org:*` and
   `platform:*` slugs, provisioned in WorkOS and delivered via the AuthKit
   JWT `permissions` claim. Roles are permission bundles managed in the
   WorkOS dashboard — a new role (e.g. a billing admin holding only
   `org:budgets:manage`) works with zero code changes. Granular helpers
   (`canManageModels/Budgets/Compliance`, `isOrgAdmin`) wrap the registry;
   the legacy `admin` role implies all `org:*` permissions (JWT-refresh
   back-compat), never `platform:*`.
2. **Platform tier = dedicated WorkOS organization + org-scoped role.** A
   "GRID Platform" organization (external id `grid-platform`) with the
   ORG-SCOPED role `org-platform-owner` holding the four `platform:*`
   permissions plus all admin widget scopes. Org-scoped roles exist only
   inside their organization, so WorkOS itself makes the role unassignable
   by tenant admins — that is the exclusivity guarantee for the owner.
3. **Platform-owner resolution** (`lib/authz/platform.ts`): active-org fast
   path via JWT claims when acting inside the platform org; otherwise a
   cached (60s) WorkOS membership lookup; plus a break-glass env allowlist
   (`GRID_PLATFORM_OWNER_EMAILS`) for first-run bootstrap. Fail closed.
4. **Platform dashboard** (`/app/platform`, `GET /api/platform/overview`):
   cross-org directory (WorkOS) joined with Grid data (project counts, LLM
   spend per org from the usage ledger), headline stat tiles, and the WorkOS
   Users Management widget scoped to the platform org (platform team) — the
   widget token route mints platform-org tokens for platform owners only.
5. **Sign-up hardening**: org-creation API returns stable error codes (never
   raw provider messages), and `GRID_DISABLE_SELF_SERVE_ORGS=true` turns the
   platform invite-only. Onboarding explains the invited-member path.

## Consequences

### Positive

- Roles become configuration, not code: WorkOS dashboard changes suffice.
- The owner gets a real top tier — visible, auditable, and exclusively
  assignable in WorkOS — with dashboards fed by both WorkOS and the ledger.
- The three inconsistent `session.role !== 'admin'` checks (legal holds,
  deletions) now honor the same permission model as everything else.
- Platform widgets work natively (the owner has a real platform-org
  membership context).

### Negative

- Cross-org owner detection costs one cached WorkOS call when browsing a
  tenant org (same order as the existing per-request membership resolution).
- The platform org appears in the org directory (flagged with a badge);
  tenant lists must exclude it where that matters in future features.
- Permissions live in WorkOS per environment — Production must be
  provisioned before first use (runbook: `docs/deployment/workos-provisioning.md`).

### Risks

- The break-glass allowlist bypasses WorkOS; it is documented as
  bootstrap-only and empty in steady state.
- If the platform org is deleted in WorkOS, platform access degrades to the
  allowlist (fail-closed otherwise).

## Alternatives Considered

- **FGA `platform` resource type + singleton resource**: rejected — WorkOS
  renders it below Organization (verified constraint above), every check is
  an extra API call, and role assignments ride on org memberships anyway.
- **Environment-level role claims / JWT template**: WorkOS roles always
  attach to org memberships; a template cannot conjure a cross-org role.
- **App-database role table**: contradicts ADR-0007 (no local identity
  sync) and loses WorkOS auditability.

## Open Questions / Follow-ups

- Remove the `admin`-implies-all-`org:*` back-compat once every environment
  (Production included) is permission-provisioned and sessions have cycled —
  until then a permission removed from the Admin role in WorkOS is not
  actually revoked for bare-`admin` sessions.

- Org switcher UI (the owner currently flips orgs via AuthKit's default
  behavior; a first-class switcher is the natural next step).
- Platform-level org lifecycle actions (suspend, limits) on the dashboard —
  `platform:organizations:manage` is provisioned but unused in v1.
- App-side audit log for role/permission changes (WorkOS audit logs cover
  the identity side).

## References

- `docs/deployment/workos-provisioning.md` — exactly what exists in WorkOS and how to replay it.
