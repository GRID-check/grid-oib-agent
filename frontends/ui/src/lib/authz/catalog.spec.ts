/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import {
  ALL_PERMISSION_SPECS,
  ORG_PERMISSION_SPECS,
  PLATFORM_PERMISSION_SPECS,
  PROJECT_PERMISSION_SPECS,
  RESOURCE_TYPES,
  ROLES,
  SKILL_PERMISSION_SPECS,
  findPermissionSpec,
  findRoleSpec,
  type PermissionTier,
} from './catalog'
import {
  ORG_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  PROJECT_PERMISSIONS,
  SKILL_PERMISSIONS,
} from './permissions'

/**
 * The catalog is provisioned into WorkOS by `scripts/provision-workos-authz.ts`
 * and is what the app derives its permission types from. An internally
 * inconsistent catalog therefore produces an internally inconsistent WorkOS
 * environment — these are the invariants that must hold before it is applied.
 */
describe('authorization catalog', () => {
  it('has no duplicate permission slugs', () => {
    const slugs = ALL_PERMISSION_SPECS.map((permission) => permission.slug)
    expect(slugs).toEqual([...new Set(slugs)])
  })

  it('has no duplicate role slugs', () => {
    const slugs = ROLES.map((role) => role.slug)
    expect(slugs).toEqual([...new Set(slugs)])
  })

  it('every permission a role grants exists in the catalog', () => {
    const known = new Set(ALL_PERMISSION_SPECS.map((permission) => permission.slug))
    const dangling = ROLES.flatMap((role) =>
      role.permissions.filter((slug) => !known.has(slug)).map((slug) => `${role.slug} -> ${slug}`)
    )
    // A role referencing an unknown slug would be created in WorkOS with a
    // permission that can never be granted, which reads as "the role is broken".
    expect(dangling).toEqual([])
  })

  it("every permission's slug prefix matches its tier", () => {
    const mismatched = ALL_PERMISSION_SPECS.filter((permission) => {
      if (permission.system) return false // widgets:* are WorkOS-owned
      const prefix = permission.slug.split(':')[0]
      return prefix !== permission.tier
    }).map((permission) => `${permission.slug} is ${permission.tier}-tier`)
    expect(mismatched).toEqual([])
  })

  it('NO tenant-assignable role may hold a platform permission', () => {
    // The whole platform tier rests on this, and this assertion is the ONLY
    // thing enforcing it. Verified against the live WorkOS API on 2026-07-31:
    // a role on the `organization` resource type was created holding
    // `project:view` (a Project-tier permission) and WorkOS accepted it, so the
    // provider does not constrain permissions to roles of their own type.
    // A `platform:*` permission on an environment-scoped role would be
    // assignable inside any tenant org, and nothing upstream would object.
    const platformSlugs = new Set(PLATFORM_PERMISSION_SPECS.map((p) => p.slug))
    const leaked = ROLES.filter((role) => role.scope === 'environment').flatMap((role) =>
      role.permissions
        .filter((slug) => platformSlugs.has(slug))
        .map((slug) => `${role.slug} -> ${slug}`)
    )
    expect(leaked).toEqual([])
  })

  it('platform-org roles hold no org: permission (tiers stay separate)', () => {
    const orgSlugs = new Set(ORG_PERMISSION_SPECS.map((p) => p.slug))
    const mixed = ROLES.filter((role) => role.scope === 'platform-org').flatMap((role) =>
      role.permissions.filter((slug) => orgSlugs.has(slug)).map((slug) => `${role.slug} -> ${slug}`)
    )
    expect(mixed).toEqual([])
  })

  it('the resource topology is a tree rooted at organization', () => {
    const bySlug = new Map(RESOURCE_TYPES.map((type) => [type.slug, type]))
    const roots = RESOURCE_TYPES.filter((type) => type.parent === null)
    expect(roots.map((type) => type.slug)).toEqual(['organization'])
    for (const type of RESOURCE_TYPES) {
      if (type.parent === null) continue
      expect(bySlug.has(type.parent), `${type.slug} parent ${type.parent}`).toBe(true)
    }
  })

  it('WorkOS caps descriptions at 150 characters — resource types AND permissions', () => {
    // Both learned the same way: the API rejects a longer one at provisioning
    // time, which turns a catalog edit into a half-applied environment. The
    // permission half was missing from this check until `org:projects:administer`
    // shipped at 208 characters and `createPermission` refused it.
    for (const type of RESOURCE_TYPES) {
      expect(type.description.length, `${type.slug} description`).toBeLessThanOrEqual(150)
    }
    for (const permission of ALL_PERMISSION_SPECS) {
      if (permission.system) continue // WorkOS owns the widgets:* copy
      expect(
        permission.description.length,
        `${permission.slug} description`
      ).toBeLessThanOrEqual(150)
    }
  })

  it('every permission/role tier maps to a declared resource type', () => {
    // The provisioner attaches permissions and roles via `resourceTypeSlugFor`
    // (platform → organization, otherwise the tier itself). A tier without a
    // RESOURCE_TYPES entry still compiles — it just silently prints a topology
    // that omits where its permissions live. The skill type went missing
    // exactly this way: skills had permissions and roles while the printed
    // topology stopped at Project.
    const typeSlugs = new Set(RESOURCE_TYPES.map((type) => type.slug))
    const resourceTypeFor = (tier: PermissionTier): string =>
      tier === 'platform' || tier === 'org' ? 'organization' : tier
    const unattached = [
      ...new Set([
        ...ALL_PERMISSION_SPECS.map((permission) => resourceTypeFor(permission.tier)),
        ...ROLES.map((role) => resourceTypeFor(role.tier)),
      ]),
    ].filter((slug) => !typeSlugs.has(slug))
    expect(unattached).toEqual([])
  })

  it('the registry constants and the catalog agree on every slug', () => {
    // All FOUR tiers. The skill tier used to be omitted from both halves of this
    // check, so `skill:*` was the one part of the catalog that could drift from
    // the registry — and from WorkOS — without anything failing.
    const registrySlugs: string[] = [
      ...Object.values(ORG_PERMISSIONS),
      ...Object.values(PLATFORM_PERMISSIONS),
      ...Object.values(PROJECT_PERMISSIONS),
      ...Object.values(SKILL_PERMISSIONS),
    ]
    for (const slug of registrySlugs) {
      expect(findPermissionSpec(slug), `${slug} must exist in the catalog`).toBeDefined()
    }
    // …and the other direction, so a catalog addition cannot be forgotten in the
    // registry the app actually checks against.
    const registry = new Set(registrySlugs)
    const unexposed = [
      ...ORG_PERMISSION_SPECS,
      ...PLATFORM_PERMISSION_SPECS,
      ...PROJECT_PERMISSION_SPECS,
      ...SKILL_PERMISSION_SPECS,
    ]
      .filter((permission) => !registry.has(permission.slug))
      .map((permission) => permission.slug)
    expect(unexposed).toEqual([])
  })

  it('Admin holds the org-wide project bypass, so existing admins keep every project', () => {
    // The bypass moved from the role slug `admin` to the permission
    // `org:projects:administer`. `hasPermission`'s bounded implication reads
    // THIS list, so if Admin ever stopped holding it every org admin would
    // silently lose access to every project they do not have a project role on.
    expect(findRoleSpec('admin')?.permissions).toContain('org:projects:administer')
  })

  it('no role below Admin holds the project bypass', () => {
    const holders = ROLES.filter(
      (role) => role.tier === 'org' && role.permissions.includes('org:projects:administer')
    ).map((role) => role.slug)
    expect(holders).toEqual(['admin'])
  })

  it('read-only platform staff hold no platform write permission', () => {
    // The catalog half of the fix for a role that was documented as changing
    // nothing and could PUT the platform model defaults. The enforcement half is
    // `requirePlatformPermission`; this keeps the grant honest.
    const support = findRoleSpec('org-platform-support')
    expect(support).toBeDefined()
    expect(support!.permissions.filter((slug) => slug.endsWith(':manage'))).toEqual([])
  })

  it('every project role is assignable through the members API', () => {
    // A role in the catalog that the API refuses is a role that exists only on
    // paper — which is what `project-contributor` was.
    const assignable = ['project-viewer', 'project-contributor', 'project-editor', 'project-admin']
    const projectRoles = ROLES.filter((role) => role.tier === 'project').map((role) => role.slug)
    expect(projectRoles.sort()).toEqual([...assignable].sort())
  })

  /**
   * `project:documents:generate` is required IN ADDITION to
   * `project:documents:write` at the generated-document seam
   * (`lib/documents/generated.ts`). Two things follow for the catalog, and
   * neither is enforced anywhere else.
   */
  describe('machine authorship is separable and never standalone', () => {
    it('no role grants generate without the write permission it rides on', () => {
      // A role holding only `generate` could put bytes into a project's file
      // system that it cannot put there by uploading, and cannot delete
      // afterwards — a principal that writes more than it can undo. The seam
      // refuses such a session, so a role like that is not a hole; it is a role
      // whose grant does nothing, which is worse to debug than one that is
      // simply absent.
      const broken = ROLES.filter(
        (role) =>
          role.permissions.includes('project:documents:generate') &&
          !role.permissions.includes('project:documents:write')
      ).map((role) => role.slug)
      expect(broken).toEqual([])
    })

    it('the built-in editor and admin hold it; the read-only personas do not', () => {
      // Held, so the shipped feature works once the catalog is provisioned. An
      // organization that does not want machine authorship withholds it on a
      // CUSTOM project role — which is the ADR-0038 §4 extensibility contract
      // and leaves this catalog (and therefore `provision:authz --check`) alone.
      for (const slug of ['project-editor', 'project-admin']) {
        expect(findRoleSpec(slug)?.permissions, slug).toContain('project:documents:generate')
      }
      // A contributor may run the research agent and may not change the corpus,
      // so it gets the answer and not the file. A viewer writes nothing at all.
      for (const slug of ['project-viewer', 'project-contributor']) {
        expect(findRoleSpec(slug)?.permissions, slug).not.toContain('project:documents:generate')
      }
    })
  })

  it('the fine-grained org personas each hold a strict subset of Admin', () => {
    // This is the extensibility contract made testable: if a persona could hold
    // something Admin does not, "Admin can do everything in the org" is false.
    const admin = new Set(findRoleSpec('admin')?.permissions ?? [])
    for (const slug of [
      'org-auditor',
      'org-billing-admin',
      'org-compliance-officer',
      'org-knowledge-manager',
    ]) {
      const role = findRoleSpec(slug)
      expect(role, slug).toBeDefined()
      const outside = role!.permissions.filter((permission) => !admin.has(permission))
      expect(outside, `${slug} holds permissions Admin does not`).toEqual([])
      expect(role!.permissions.length).toBeLessThan(admin.size)
    }
  })
})
