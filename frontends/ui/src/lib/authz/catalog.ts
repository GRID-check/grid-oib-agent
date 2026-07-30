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
 * | `workflow` | Workflow     | WorkOS FGA `authorization.check` per workflow|
 *
 * `platform` shares the Organization resource type because WorkOS has no tier
 * above it — verified against the live API, which rejects a parentless resource
 * type with "At least one parent type is required". Exclusivity is therefore
 * enforced by `./platform` (membership of the platform org is required), NOT by
 * the resource topology. See ADR-0016 and ADR-0038.
 */

/** WorkOS resource type a permission or role attaches to. */
export type PermissionTier = 'org' | 'platform' | 'project' | 'workflow'

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
 * The resource topology: Organization → Project → Workflow.
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
  {
    slug: 'workflow',
    name: 'Workflow',
    description:
      'A scheduled deep-research workflow inside a project (ADR-0023). Separate type so an operator can run one without editing the project.',
    parent: 'project',
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
    slug: 'org:projects:create',
    name: 'Create projects',
    description:
      'Create new projects in the organization. Held by the default Member role; withhold it to make project creation an admin-only act.',
    tier: 'org',
  },
]

/**
 * Platform-tier permissions. Only ever attached to `platform-org` roles, so no
 * tenant admin can grant them. Note this is a provisioning convention plus the
 * membership check in `./platform` — WorkOS itself cannot express "attachable
 * only to roles of one organization".
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
    slug: 'project:workflows:manage',
    name: 'Manage project workflows',
    description: 'Create, edit and delete scheduled workflows in a project (ADR-0023).',
    tier: 'project',
  },
]

/**
 * Workflow-tier permissions — checked per workflow via WorkOS FGA.
 *
 * CREATING a workflow is `project:workflows:manage` (there is no workflow yet to
 * check against); operating an existing one is checked here. Same split as
 * service-level create vs. resource-level operate in AWS IAM.
 */
export const WORKFLOW_PERMISSION_SPECS: readonly PermissionSpec[] = [
  {
    slug: 'workflow:view',
    name: 'View workflow',
    description: "See a scheduled workflow's definition, schedule and run history.",
    tier: 'workflow',
  },
  {
    slug: 'workflow:run',
    name: 'Run workflow',
    description: 'Trigger a scheduled workflow manually, outside its schedule. Spends LLM budget.',
    tier: 'workflow',
  },
  {
    slug: 'workflow:manage',
    name: 'Manage workflow',
    description: "Edit a scheduled workflow's definition and schedule, or delete it.",
    tier: 'workflow',
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
  ...WORKFLOW_PERMISSION_SPECS,
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
      'Full working access to one project: chat, documents and memory. Cannot rename or delete the project, manage its members, or create workflows.',
    tier: 'project',
    scope: 'environment',
    permissions: [
      'project:view',
      'project:chat',
      'project:edit',
      'project:documents:write',
      'project:memory:write',
    ],
  },
  {
    slug: 'project-admin',
    name: 'Project Admin',
    description:
      'Administers one project: everything an editor can do, plus renaming/deleting it, managing its members, and creating workflows.',
    tier: 'project',
    scope: 'environment',
    permissions: [
      'project:view',
      'project:chat',
      'project:edit',
      'project:documents:write',
      'project:memory:write',
      'project:manage',
      'project:members:manage',
      'project:workflows:manage',
    ],
  },

  // ---- Workflow tier -----------------------------------------------------
  {
    slug: 'workflow-viewer',
    name: 'Workflow Viewer',
    description: 'Read-only on one scheduled workflow: its definition, schedule and run history.',
    tier: 'workflow',
    scope: 'environment',
    permissions: ['workflow:view'],
  },
  {
    slug: 'workflow-operator',
    name: 'Workflow Operator',
    description:
      'May trigger one scheduled workflow manually and read its run history, without being able to edit its definition or schedule.',
    tier: 'workflow',
    scope: 'environment',
    permissions: ['workflow:view', 'workflow:run'],
  },
  {
    slug: 'workflow-admin',
    name: 'Workflow Admin',
    description:
      'Full control of one scheduled workflow: edit its definition and schedule, run it, delete it.',
    tier: 'workflow',
    scope: 'environment',
    permissions: ['workflow:view', 'workflow:run', 'workflow:manage'],
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
