/**
 * Apply GRID's authorization catalog to a WorkOS environment — or fail on drift.
 *
 * The catalog (`src/lib/authz/catalog.ts`) is the single source of truth the app
 * derives its permission types from. This script makes WorkOS agree with it, and
 * `--check` makes CI fail when it stops agreeing.
 *
 * That gap was real and it shipped: `org:audit:view` and `org:archiv:manage`
 * lived in the app's registry and in the runbook for three weeks while existing
 * in no WorkOS environment. No custom role could hold them, so the documented
 * "create a role with a subset of permissions" contract silently did not work
 * for those two — and nothing anywhere reported it.
 *
 *   Usage:
 *     WORKOS_API_KEY=sk_… npm run provision:authz          # check (read-only)
 *     WORKOS_API_KEY=sk_… npm run provision:authz -- --apply
 *
 * `--check` is the default and never writes. Run it in CI.
 *
 * ## What this script does NOT do
 *
 * Resource types (Organization → Project → Workflow) are not exposed by the
 * Node SDK, so they are a dashboard step — documented in
 * `docs/deployment/workos-provisioning.md`. The script still VERIFIES them
 * indirectly: a permission cannot be created against a resource type that does
 * not exist, so a missing type surfaces as a create failure naming the type.
 */

import { WorkOS, type Role } from '@workos-inc/node'
import {
  ALL_PERMISSION_SPECS,
  RESOURCE_TYPES,
  ROLES,
  type RoleSpec,
} from '../src/lib/authz/catalog'

const PLATFORM_ORG_EXTERNAL_ID = process.env.GRID_PLATFORM_ORG_EXTERNAL_ID ?? 'grid-platform'

const apply = process.argv.includes('--apply')
const apiKey = process.env.WORKOS_API_KEY
if (!apiKey) {
  console.error('WORKOS_API_KEY is required.')
  process.exit(2)
}

const workos = new WorkOS(apiKey)
const drift: string[] = []
const applied: string[] = []

const note = (message: string) => console.log(`  ${message}`)

/** Permissions we own. `widgets:*` are WorkOS system permissions — never ours. */
const OWNED_PERMISSIONS = ALL_PERMISSION_SPECS.filter((permission) => !permission.system)

async function listAll<T>(
  page: (after?: string) => Promise<{ data: T[]; listMetadata?: { after?: string | null } }>
): Promise<T[]> {
  const all: T[] = []
  let after: string | undefined
  do {
    const result = await page(after)
    all.push(...result.data)
    after = result.listMetadata?.after ?? undefined
  } while (after)
  return all
}

async function reconcilePermissions(): Promise<void> {
  console.log('\nPermissions')
  const existing = await listAll((after) =>
    workos.authorization.listPermissions({ after, limit: 100 })
  )
  const bySlug = new Map(existing.map((permission) => [permission.slug, permission]))

  for (const spec of OWNED_PERMISSIONS) {
    const found = bySlug.get(spec.slug)
    if (found) {
      note(`ok       ${spec.slug}`)
      continue
    }
    if (!apply) {
      drift.push(`permission missing in WorkOS: ${spec.slug} (${spec.tier} tier)`)
      note(`MISSING  ${spec.slug}`)
      continue
    }
    try {
      await workos.authorization.createPermission({
        name: spec.name,
        slug: spec.slug,
        description: spec.description,
      })
      applied.push(`created permission ${spec.slug}`)
      note(`created  ${spec.slug}`)
    } catch (error) {
      // A create that fails because the resource type is absent is the signal
      // that the dashboard step has not been done for this environment.
      drift.push(`could not create ${spec.slug} (${spec.tier} tier): ${String(error)}`)
      note(`FAILED   ${spec.slug} — ${String(error)}`)
    }
  }

  // Permissions in WorkOS that the catalog does not know about. Not an error —
  // WorkOS ships its own, and an operator may be mid-rollout — but worth saying,
  // because an unknown org:*/platform:* slug is usually a half-removed feature.
  const ours = new Set(ALL_PERMISSION_SPECS.map((permission) => permission.slug))
  for (const permission of existing) {
    if (ours.has(permission.slug)) continue
    if (/^(org|platform|project|workflow):/.test(permission.slug)) {
      note(`UNKNOWN  ${permission.slug} — in WorkOS, absent from the catalog`)
      drift.push(`permission in WorkOS but not in the catalog: ${permission.slug}`)
    }
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((value, index) => value === right[index])
}

async function reconcileRoles(): Promise<void> {
  console.log('\nRoles')

  // Both list endpoints return the full set in one response (no pagination).
  const envRoles = (await workos.authorization.listEnvironmentRoles()).data

  let platformOrgId: string | null = null
  try {
    platformOrgId = (
      await workos.organizations.getOrganizationByExternalId(PLATFORM_ORG_EXTERNAL_ID)
    ).id
  } catch {
    platformOrgId = null
  }

  let orgRoles: Role[] = []
  if (platformOrgId) {
    orgRoles = (await workos.authorization.listOrganizationRoles(platformOrgId)).data
  } else {
    drift.push(
      `platform organization "${PLATFORM_ORG_EXTERNAL_ID}" not found — platform roles cannot be verified`
    )
    note(`MISSING  organization ${PLATFORM_ORG_EXTERNAL_ID}`)
  }

  const envBySlug = new Map(envRoles.map((role) => [role.slug, role]))
  const orgBySlug = new Map(orgRoles.map((role) => [role.slug, role]))

  for (const spec of ROLES) {
    const isPlatform = spec.scope === 'platform-org'
    if (isPlatform && !platformOrgId) continue

    const found = isPlatform ? orgBySlug.get(spec.slug) : envBySlug.get(spec.slug)
    if (!found) {
      if (!apply) {
        drift.push(`role missing in WorkOS: ${spec.slug} (${spec.scope})`)
        note(`MISSING  ${spec.slug}`)
        continue
      }
      await createRole(spec, platformOrgId)
      continue
    }

    if (sameSet(found.permissions, spec.permissions)) {
      note(`ok       ${spec.slug}`)
      continue
    }

    const missing = spec.permissions.filter((slug) => !found.permissions.includes(slug))
    const extra = found.permissions.filter((slug) => !spec.permissions.includes(slug))
    const detail = [
      missing.length ? `missing ${missing.join(', ')}` : '',
      extra.length ? `extra ${extra.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ')

    if (!apply) {
      drift.push(`role ${spec.slug} permissions differ — ${detail}`)
      note(`DRIFT    ${spec.slug} — ${detail}`)
      continue
    }

    await setPermissions(spec, platformOrgId)
    applied.push(`updated role ${spec.slug} (${detail})`)
    note(`updated  ${spec.slug} — ${detail}`)
  }
}

/** Roles attach to the resource type their tier names; org/platform tiers to Organization. */
function resourceTypeSlugFor(spec: RoleSpec): string {
  return spec.tier === 'platform' ? 'organization' : spec.tier
}

/** Permissions are set separately from creation — the create endpoints take no list. */
async function setPermissions(spec: RoleSpec, platformOrgId: string | null): Promise<void> {
  const permissions = [...spec.permissions]
  if (spec.scope === 'platform-org') {
    if (!platformOrgId) return
    await workos.authorization.setOrganizationRolePermissions(platformOrgId, spec.slug, {
      permissions,
    })
    return
  }
  await workos.authorization.setEnvironmentRolePermissions(spec.slug, { permissions })
}

async function createRole(spec: RoleSpec, platformOrgId: string | null): Promise<void> {
  try {
    if (spec.scope === 'platform-org') {
      if (!platformOrgId) return
      await workos.authorization.createOrganizationRole(platformOrgId, {
        name: spec.name,
        slug: spec.slug,
        description: spec.description,
        resourceTypeSlug: resourceTypeSlugFor(spec),
      })
    } else {
      await workos.authorization.createEnvironmentRole({
        name: spec.name,
        slug: spec.slug,
        description: spec.description,
        resourceTypeSlug: resourceTypeSlugFor(spec),
      })
    }
    await setPermissions(spec, platformOrgId)
    applied.push(`created role ${spec.slug}`)
    note(`created  ${spec.slug}`)
  } catch (error) {
    drift.push(`could not create role ${spec.slug}: ${String(error)}`)
    note(`FAILED   ${spec.slug} — ${String(error)}`)
  }
}

async function main(): Promise<void> {
  console.log(`GRID authorization catalog → WorkOS (${apply ? 'APPLY' : 'CHECK — read-only'})`)
  console.log(
    `\nExpected resource topology (dashboard-managed, not creatable via the SDK):\n  ` +
      RESOURCE_TYPES.map(
        (type) => `${type.slug}${type.parent ? ` → parent ${type.parent}` : ' (root)'}`
      ).join('\n  ')
  )

  await reconcilePermissions()
  await reconcileRoles()

  if (apply) {
    console.log(`\nApplied ${applied.length} change(s).`)
    for (const change of applied) console.log(`  - ${change}`)
  }

  if (drift.length === 0) {
    console.log('\nWorkOS matches the catalog.')
    return
  }

  console.error(`\n${drift.length} drift finding(s):`)
  for (const finding of drift) console.error(`  - ${finding}`)
  console.error(
    apply
      ? '\nSome changes could not be applied — see above.'
      : '\nRun with --apply to reconcile (resource types must be created in the dashboard first).'
  )
  process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
