import { describe, expect, it } from 'vitest'

import {
  ALL_PERMISSION_SPECS,
  ORG_PERMISSION_SPECS,
  PLATFORM_PERMISSION_SPECS,
  PROJECT_PERMISSION_SPECS,
  RESOURCE_TYPES,
  ROLES,
  WORKFLOW_PERMISSION_SPECS,
  findPermissionSpec,
  findRoleSpec,
} from './catalog'
import { ORG_PERMISSIONS, PLATFORM_PERMISSIONS, PROJECT_PERMISSIONS } from './permissions'

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

  it('WorkOS caps resource-type descriptions at 150 characters', () => {
    // Learned from the API rejecting a longer one during provisioning.
    for (const type of RESOURCE_TYPES) {
      expect(type.description.length, `${type.slug} description`).toBeLessThanOrEqual(150)
    }
  })

  it('the registry constants and the catalog agree on every slug', () => {
    const registrySlugs: string[] = [
      ...Object.values(ORG_PERMISSIONS),
      ...Object.values(PLATFORM_PERMISSIONS),
      ...Object.values(PROJECT_PERMISSIONS),
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
    ]
      .filter((permission) => !registry.has(permission.slug))
      .map((permission) => permission.slug)
    expect(unexposed).toEqual([])
  })

  it('exposes the workflow tier the Workflow resource type was created for', () => {
    expect(WORKFLOW_PERMISSION_SPECS.map((permission) => permission.slug)).toEqual([
      'workflow:view',
      'workflow:run',
      'workflow:manage',
    ])
    expect(findRoleSpec('workflow-operator')?.permissions).toEqual([
      'workflow:view',
      'workflow:run',
    ])
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
