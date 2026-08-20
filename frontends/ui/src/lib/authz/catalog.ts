/**
 * The authorization catalog — ONE source of truth for every resource type,
 * permission and role GRID's access model defines (ADR-0038).
 *
 * This file is deliberately pure data with no imports: it is consumed by
 *
 *   - the app, which derives its permission types and the bounded role
 *     implication table from it (`./permissions`), and
 *   - `scripts/provision-workos-authz.ts`, which applies it to a WorkOS
 *     environment (`--apply`) or fails CI on drift (`--check`).
 *
 * Because both read the SAME structure, "the code says X but WorkOS says Y"
 * stops being possible to ship. That drift was a real finding: `org:audit:view`
 * and `org:archiv:manage` lived in the app's registry and in the runbook for
 * three weeks while existing in no WorkOS environment, so no custom role could
 * ever hold them and only the legacy `admin` implication made them work.
 *
 * ## Tiers
 *
 * A permission's tier is the WorkOS resource type it attaches to, which decides
 * HOW it is checked — not merely how it is named:
 *
 * | Tier       | Attaches to  | Checked via                                  |
 * |------------|--------------|----------------------------------------------|
 * | `org`      | Organization | AuthKit JWT `permissions` claim (no I/O)     |
 * | `platform` | Organization | platform-org membership (`./platform`)       |
 * | `project`  | Project      | WorkOS FGA `authorization.check` per project |
 *
 * `platform` shares the Organization resource type because WorkOS has no tier
 * above it — verified against the live API, which rejects a parentless resource
 * type with "At least one parent type is required". Exclusivity is therefore
 * enforced by `./platform` (membership of the platform org is required), NOT by
 * the resource topology. See ADR-0016 and ADR-0038.
 */

/** WorkOS resource type a permission or role attaches to. */
export type PermissionTier = 'org' | 'platform' | 'project' | 'skill'

/** Where a role may be assigned. */
export type RoleScope =
  /** Assignable in any organization (a WorkOS environment-wide role). */
  | 'environment'
  /**
   * Created inside the GRID Platform organization only. WorkOS refuses to
   * assign an org-scoped role anywhere else, which is what makes platform
   * access structurally unavailable to tenant admins.
   */
  | 'platform-org'

export interface PermissionSpec {
  readonly slug: string
  /** Human label shown in the WorkOS dashboard. */
  readonly name: string
  readonly description: string
  readonly tier: PermissionTier
  /**
   * WorkOS-owned permission (every `widgets:*`). Roles may reference it; the
   * provisioning script must never try to create or modify it.
   */
  readonly system?: true
  /**
   * Retained so existing grants keep working, but no new check should use it.
   * The replacement is named in the description.
   */
  readonly deprecated?: true
}

export interface RoleSpec {
  readonly slug: string
  readonly name: string
  readonly description: string
  /** Resource type the role attaches to. */
  readonly tier: PermissionTier
  readonly scope: RoleScope
  readonly permissions: readonly string[]
}

export interface ResourceTypeSpec {
  readonly slug: string
  readonly name: string
  /** WorkOS caps this at 150 characters. */
  readonly description: string
  /** Parent type slug; `null` only for the system Organization root. */
  readonly parent: string | null
}

/**
 * The resource topology: Organization → Project → Skill schedule.
 *
 * `document` was deliberately REMOVED (it existed with zero roles and zero
 * permissions, so nothing ever checked it). Document access is pure inheritance
 * from the parent project and is enforced in `lib/documents/service.ts`; giving
 * every uploaded file its own FGA resource would mean a WorkOS write per upload,
 * a delete per delete, a backfill and a reconciliation job — an unbounded
 * distributed-consistency problem bought for no access-control gain. If
 * per-document sharing ever ships, the ADR-0032 grant model already expresses it
 * transactionally in Postgres. See ADR-0038.
 */
export const RESOURCE_TYPES: readonly ResourceTypeSpec[] = [
  {
    slug: 'organization',
    name: 'Organization',
    description: 'System resource type representing the organization level',
    parent: null,
  },
  {
    slug: 'project',
    name: 'Project',
    description:
      'A tenant workspace: shared documents, memory and conversations for the research agent.',
    parent: 'organization',
  },
]

/** Organization-tier permissions — delivered in the AuthKit JWT. */
export const ORG_PERMISSION_SPECS: readonly PermissionSpec[] = [
  {
    slug: 'org:settings:manage',
    name: 'Manage organization settings',
    description: 'Manage organization settings (name, locale, defaults).',
    tier: 'org',
  },
  {
    slug: 'org:models:manage',
    name: 'Manage AI models',
    description: 'Manage runtime AI model configuration per agent group (ADR-0014).',
    tier: 'org',
  },
  {
    slug: 'org:budgets:manage',
    name: 'Manage LLM budgets',
    description: 'Manage LLM budgets and view org-wide usage (ADR-0015).',
    tier: 'org',
  },
  {
    slug: 'org:compliance:manage',
    name: 'Manage compliance',
    description: 'Manage legal holds and the deletion queue.',
    tier: 'org',
  },
  {
    slug: 'org:audit:view',
    name: 'View audit trail',
    description: "Open the organization's native WorkOS audit-log viewer and exports.",
    tier: 'org',
  },
  {
    slug: 'org:archiv:manage',
    name: 'Manage document Archiv',
    description:
      'Upload, delete, re-ingest and retag documents in the org-wide Archiv (ADR-0024). Reads stay open to every member.',
    tier: 'org',
  },
  {
    slug: 'org:skills:manage',
    name: 'Manage organization skills',
    description:
      'Author, edit, clone and delete skills in the organization toolbox (Agent Skills). Reads stay open to every member.',
    tier: 'org',
  },
  {
    slug: 'org:projects:create',
    name: 'Create projects',
    description:
      'Create new projects in the organization. Held by the default Member role; withhold it to make project creation an admin-only act.',
    tier: 'org',
  },
  {
    slug: 'org:members:manage',
    name: 'Manage people and roles',
    description:
      'Open the Access tab: see every member and the role they hold, and invite, re-role or remove people.',
    tier: 'org',
  },
]

/**
 * Platform-tier permissions. Only ever attached to `platform-org` roles.
 *
 * **This separation is enforced by US, not by WorkOS.** Verified against the
 * live API on 2026-07-31: a role whose resource type is `organization` was
 * created holding `project:view`, a Project-tier permission, and WorkOS accepted
 * it — permissions are NOT constrained to roles of their own resource type.
 * Moving `platform:*` onto a dedicated resource type would therefore buy tidier
 * grouping and no security guarantee at all.
 *
 * What actually holds the line is two things, both ours:
 *   1. `./platform` requires membership of the GRID Platform organization
 *      before any platform surface answers — a claim alone is never enough.
 *   2. `catalog.spec.ts` asserts no environment-scoped role holds a
 *      `platform:*` permission, which is the ONLY check standing between a
 *      careless provisioning edit and a tenant role carrying platform access.
 */
export const PLATFORM_PERMISSION_SPECS: readonly PermissionSpec[] = [
  {
    slug: 'platform:organizations:view',
    name: 'View all organizations',
    description:
      'Platform tier: see every organization on the platform (directory, members, activity).',
    tier: 'platform',
  },
  {
    slug: 'platform:organizations:manage',
    name: 'Manage any organization',
    description: 'Platform tier: administer any organization (settings, limits, lifecycle).',
    tier: 'platform',
  },
  {
    slug: 'platform:usage:view',
    name: 'View cross-org usage',
    description: 'Platform tier: cross-organization LLM usage, spend, and budget posture.',
    tier: 'platform',
  },
  {
    slug: 'platform:settings:manage',
    name: 'Manage platform settings',
    description: 'Platform tier: manage platform-wide settings and defaults.',
    tier: 'platform',
  },
]

/** Project-tier permissions — checked per project via WorkOS FGA. */
export const PROJECT_PERMISSION_SPECS: readonly PermissionSpec[] = [
  {
    slug: 'project:view',
    name: 'View project',
    description: 'Read and search a project, its documents and its conversations.',
    tier: 'project',
  },
  {
    slug: 'project:chat',
    name: 'Chat in project',
    description: 'Start and continue conversations scoped to this project.',
    tier: 'project',
  },
  {
    slug: 'project:edit',
    name: 'Edit project content',
    description:
      'Legacy umbrella write permission. Retained so existing grants keep working; new checks use project:documents:write or project:memory:write.',
    tier: 'project',
    deprecated: true,
  },
  {
    slug: 'project:documents:write',
    name: 'Write project documents',
    description: 'Upload, delete, re-ingest and retag documents inside a project.',
    tier: 'project',
  },
  {
    /**
     * Machine authorship, as a capability of its own.
     *
     * `project:documents:write` gates the ORDINARY upload — a person choosing a
     * file off their disk — and it is the same permission behind delete and a
     * whole-project re-index (`lib/documents/service.ts`). An organization that
     * wanted Piloti to answer but not to write into its file system therefore
     * had exactly one lever, and pulling it also stopped its own architects
     * uploading plans. That is not a choice, and a deploy runbook that offered
     * it as a kill switch was wrong
     * (`docs/deployment/agent-authored-documents-rollout.md` §4).
     *
     * This permission is required **in addition to** the write permission at
     * every generated-document seam, never instead of it — the argument is at
     * the seam itself, `lib/documents/generated.ts`.
     *
     * It is deliberately NOT joined by the `project:edit` umbrella in any
     * any-of list. The umbrella exists to keep grants that predate ADR-0038 §3's
     * SPLIT working; this is not a split of anything, it is a new capability,
     * and a permission every legacy role already implicitly holds is exactly the
     * un-withholdable lever this one exists to replace.
     */
    slug: 'project:documents:generate',
    name: 'File agent-authored documents',
    description:
      'Let the agent file documents it wrote — reports, diagrams — into a project. Required IN ADDITION to project:documents:write, never instead of it.',
    tier: 'project',
  },
  {
    slug: 'project:memory:write',
    name: 'Write project memory',
    description: "Add, edit and remove items in a project's long-term memory.",
    tier: 'project',
  },
  {
    slug: 'project:manage',
    name: 'Manage project',
    description: 'Rename, archive or delete the project itself.',
    tier: 'project',
  },
  {
    slug: 'project:members:manage',
    name: 'Manage project members',
    description: 'Grant and revoke project roles for other members of the organization.',
    tier: 'project',
  },
  {
    slug: 'project:skills:manage',
    name: 'Manage project skill schedules',
    description:
      'Create, edit, delete and run skill schedules in a project (Agent Skills Phase A). Reads stay open to every project viewer.',
    tier: 'project',
  },
]

/**
 * Skill-tier permissions — checked per skill schedule via WorkOS FGA. Mirrors
 * CREATING a schedule is `project:skills:manage` (no
 * schedule exists yet to check against); operating an existing one is checked
 * here, with the project-tier fallback in `./decide` keeping project admins
 * working without provisioning per-skill roles.
 */
export const SKILL_PERMISSION_SPECS: readonly PermissionSpec[] = [
  {
    slug: 'skill:view',
    name: 'View skill schedule',
    description: "See a skill schedule's definition, schedule and run history.",
    tier: 'skill',
  },
  {
    slug: 'skill:run',
    name: 'Run skill schedule',
    description: 'Trigger a skill schedule manually, outside its schedule. Spends LLM budget.',
    tier: 'skill',
  },
  {
    slug: 'skill:manage',
    name: 'Manage skill schedule',
    description: "Edit a skill schedule's definition and schedule, or delete it.",
    tier: 'skill',
  },
]

/**
 * WorkOS-owned widget permissions. Listed so roles can reference them and so the
 * provisioning script can verify a role's attachment set exactly, but never
 * created or modified by us — WorkOS ships them with `system: true`.
 */
export const WIDGET_PERMISSION_SPECS: readonly PermissionSpec[] = [
  {
    slug: 'widgets:users-table:manage',
    name: 'Manage users',
    description: 'View and edit access for the users table widget.',
    tier: 'org',
    system: true,
  },
  {
    slug: 'widgets:sso:manage',
    name: 'Manage Single Sign-On connections',
    description: 'View and manage access for the Single Sign-On (SSO) widget.',
    tier: 'org',
    system: true,
  },
  {
    slug: 'widgets:dsync:manage',
    name: 'Manage Directory Sync',
    description: 'View and manage access for the Directory Sync widget.',
    tier: 'org',
    system: true,
  },
  {
    slug: 'widgets:domain-verification:manage',
    name: 'Manage domains',
    description: 'View and manage access for the domain verification widget.',
    tier: 'org',
    system: true,
  },
  {
    slug: 'widgets:audit-log-streaming:manage',
    name: 'Manage audit log streaming',
    description: 'View and manage access for the audit log streaming widget.',
    tier: 'org',
    system: true,
  },
  {
    slug: 'widgets:pipes:manage',
    name: 'Manage Pipes',
    description: 'View and manage access for the Pipes integrations widget.',
    tier: 'org',
    system: true,
  },
]

/** Every permission GRID defines or references, in one list. */
export const ALL_PERMISSION_SPECS: readonly PermissionSpec[] = [
  ...ORG_PERMISSION_SPECS,
  ...PLATFORM_PERMISSION_SPECS,
  ...PROJECT_PERMISSION_SPECS,
  ...SKILL_PERMISSION_SPECS,
  ...WIDGET_PERMISSION_SPECS,
]

const ORG_WIDGET_SLUGS = WIDGET_PERMISSION_SPECS.map((permission) => permission.slug)

/**
 * Every role GRID provisions.
 *
 * The fine-grained org roles below (`org-auditor`, `org-billing-admin`,
 * `org-compliance-officer`, `org-knowledge-manager`) are the personas enterprise
 * buyers actually ask for, and they exist to make the extensibility contract
 * TRUE rather than merely claimed: each one holds a strict subset of `org:*` and
 * works with no code change, because every gate checks a permission and never a
 * role name.
 */
export const ROLES: readonly RoleSpec[] = [
  // ---- Organization tier -------------------------------------------------
  {
    slug: 'member',
    name: 'Member',
    description:
      'The default user role. May create projects; all other project access comes from project-scoped roles.',
    tier: 'org',
    scope: 'environment',
    permissions: ['org:projects:create'],
  },
  {
    slug: 'admin',
    name: 'Admin',
    description:
      'Full administration of one organization. Holds every org: permission; never any platform: permission.',
    tier: 'org',
    scope: 'environment',
    permissions: [
      ...ORG_PERMISSION_SPECS.map((permission) => permission.slug),
      ...ORG_WIDGET_SLUGS,
    ],
  },
  {
    slug: 'org-auditor',
    name: 'Auditor',
    description:
      'Read-only compliance persona: opens the organization’s audit trail and nothing else. Cannot change settings, budgets, models or data.',
    tier: 'org',
    scope: 'environment',
    permissions: ['org:audit:view'],
  },
  {
    slug: 'org-billing-admin',
    name: 'Billing Admin',
    description:
      'FinOps persona: sets LLM budget policies and sees org-wide spend. No access to settings, models, data or the audit trail.',
    tier: 'org',
    scope: 'environment',
    permissions: ['org:budgets:manage'],
  },
  {
    slug: 'org-compliance-officer',
    name: 'Compliance Officer',
    description:
      'Legal/DPO persona: places and releases legal holds, drives the deletion queue, and reads the audit trail. No settings, budgets or model access.',
    tier: 'org',
    scope: 'environment',
    permissions: ['org:compliance:manage', 'org:audit:view'],
  },
  {
    slug: 'org-knowledge-manager',
    name: 'Knowledge Manager',
    description:
      'Curates the org-wide document Archiv: upload, delete, re-ingest, retag. No other administrative access.',
    tier: 'org',
    scope: 'environment',
    permissions: ['org:archiv:manage'],
  },
  {
    slug: 'org-user-admin',
    name: 'User Admin',
    description:
      'IT-helpdesk persona: manages who is in the organization and what role they hold, without seeing budgets, models, compliance or settings.',
    tier: 'org',
    scope: 'environment',
    permissions: ['org:members:manage', 'widgets:users-table:manage'],
  },

  // ---- Platform tier (GRID Platform organization only) -------------------
  {
    slug: 'org-platform-owner',
    name: 'Platform Owner',
    description:
      'Exclusive to the GRID Platform organization: full cross-organization oversight of the platform. Not assignable in tenant organizations.',
    tier: 'platform',
    scope: 'platform-org',
    permissions: [
      ...PLATFORM_PERMISSION_SPECS.map((permission) => permission.slug),
      'widgets:users-table:manage',
      'widgets:sso:manage',
      'widgets:dsync:manage',
      'widgets:domain-verification:manage',
      'widgets:audit-log-streaming:manage',
    ],
  },
  {
    slug: 'org-platform-support',
    name: 'Platform Support',
    description:
      'Read-only platform staff: sees every organization and cross-org usage, changes nothing. Exclusive to the GRID Platform organization.',
    tier: 'platform',
    scope: 'platform-org',
    permissions: ['platform:organizations:view', 'platform:usage:view'],
  },

  // ---- Project tier ------------------------------------------------------
  {
    slug: 'project-viewer',
    name: 'Project Viewer',
    description: 'Read-only on one project: its documents, memory and conversations.',
    tier: 'project',
    scope: 'environment',
    permissions: ['project:view'],
  },
  {
    slug: 'project-contributor',
    name: 'Project Contributor',
    description:
      'May use the research agent in one project but not change its corpus: chat and read, no document or memory writes.',
    tier: 'project',
    scope: 'environment',
    permissions: ['project:view', 'project:chat'],
  },
  {
    slug: 'project-editor',
    name: 'Project Editor',
    description:
      'Full working access to one project: chat, documents and memory. Cannot rename or delete the project, manage its members, or create skill schedules.',
    tier: 'project',
    scope: 'environment',
    permissions: [
      'project:view',
      'project:chat',
      'project:edit',
      'project:documents:write',
      // Held by the built-in editor so the shipped product works out of the box.
      // An organization that does not want machine authorship withholds it the
      // way ADR-0038 §4 says every capability is withheld — by putting people on
      // a custom project role that omits it, which is drift-free because custom
      // roles are not in this catalog. Editing THIS role in WorkOS instead would
      // fail `provision:authz --check` in CI, which is why an operator-side kill
      // switch has to be a flag and not a permission.
      'project:documents:generate',
      'project:memory:write',
    ],
  },
  {
    slug: 'project-admin',
    name: 'Project Admin',
    description:
      'Administers one project: everything an editor can do, plus renaming/deleting it, managing its members, and creating skill schedules.',
    tier: 'project',
    scope: 'environment',
    permissions: [
      'project:view',
      'project:chat',
      'project:edit',
      'project:documents:write',
      'project:documents:generate',
      'project:memory:write',
      'project:manage',
      'project:members:manage',
      'project:skills:manage',
    ],
  },

]

/** Look up a permission spec by slug. */
export function findPermissionSpec(slug: string): PermissionSpec | undefined {
  return ALL_PERMISSION_SPECS.find((permission) => permission.slug === slug)
}

/** Look up a role spec by slug. */
export function findRoleSpec(slug: string): RoleSpec | undefined {
  return ROLES.find((role) => role.slug === slug)
}
