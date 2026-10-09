/**
 * Carry each folder's role grants over to WorkOS folder roles (ADR-0096) — or
 * show what it would do.
 *
 * Before ADR-0096 a folder with its own access list named organization ROLES
 * (`project_folder_grants`). Now the folder is a WorkOS `folder` resource and
 * the PEOPLE on its list hold a folder role on it. Migration 0128 carried the
 * `*` entries over in SQL; the role entries need WorkOS, so they are this
 * script: for every folder with its own list, every active member of the
 * organization who holds one of the roles it names gets the folder role for
 * the best level those roles granted.
 *
 * What changes for the office: a role grant followed the role, so someone given
 * the role later reached the folder. A folder role is given to a person, so
 * after this runs, the list is the people who held the role today.
 *
 *   Usage (from frontends/ui):
 *     WORKOS_API_KEY=sk_… GRID_APP_MIGRATION_DATABASE_URL=postgres://… \
 *       bun run migrate:folder-grants             # show the plan, change nothing
 *     … bun run migrate:folder-grants -- --apply  # register the folders and assign the roles
 *
 * Order: `provision:authz -- --apply` first (the `folder` resource type, the
 * `folder:*` permissions and the folder roles must exist), then this, then the
 * deploy that reads folder roles. Until it has run, a folder with its own list
 * is readable only by organization admins and, when everyone reads it, by every
 * project member: the narrow direction, not a leak.
 *
 * It converts only folders that are not yet registered in WorkOS. Once a folder
 * is registered, its list is WorkOS's: someone may have edited it in the new
 * dialog, and `project_folder_grants` is no longer written, so carrying the old
 * roles over again would put back people who were taken off. A registered
 * folder is therefore skipped, and running the script twice changes nothing.
 * A folder a failed run registered but did not finish is named on the command
 * line to finish it: `-- --apply --finish=<folder id>` (repeatable). It never
 * removes a folder role.
 *
 * It reads `project_folder_grants` across every organization, so it needs the
 * schema owner's connection (`GRID_APP_MIGRATION_DATABASE_URL`); the runtime
 * role is subject to row-level security and would see nothing.
 */

import postgres from 'postgres'
import { WorkOS } from '@workos-inc/node'

type Level = 'read' | 'write'

const FOLDER_ROLE: Readonly<Record<Level, string>> = { read: 'folder-reader', write: 'folder-editor' }
const RESOURCE_TYPE = 'folder'

const apply = process.argv.includes('--apply')
const finish = new Set(process.argv.filter((arg) => arg.startsWith('--finish=')).map((arg) => arg.slice('--finish='.length)))
const apiKey = process.env.WORKOS_API_KEY
const databaseUrl = process.env.GRID_APP_MIGRATION_DATABASE_URL ?? process.env.GRID_APP_DATABASE_URL
if (!apiKey || !databaseUrl) {
  console.error('WORKOS_API_KEY and GRID_APP_MIGRATION_DATABASE_URL (or GRID_APP_DATABASE_URL) are required.')
  process.exit(2)
}

const workos = new WorkOS(apiKey)
const sql = postgres(databaseUrl, { max: 2 })

interface GrantRow {
  organization_id: string
  project_id: string
  folder_id: string
  folder_name: string
  role_slug: string
  level: Level
}

interface FolderPlan {
  organizationId: string
  projectId: string
  folderId: string
  folderName: string
  grants: Map<string, Level>
}

const better = (a: Level | undefined, b: Level): Level => (a === 'write' || b === 'write' ? 'write' : 'read')

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404
}

async function loadPlans(): Promise<FolderPlan[]> {
  const rows = await sql<GrantRow[]>`
    SELECT p.organization_id, f.project_id, f.id AS folder_id, f.name AS folder_name, g.role_slug, g.level
    FROM project_folders f
    JOIN projects p ON p.id = f.project_id
    JOIN project_folder_grants g ON g.folder_id = f.id
    WHERE f.access_mode = 'custom' AND g.role_slug <> '*'
    ORDER BY p.organization_id, f.project_id, f.id`
  const plans = new Map<string, FolderPlan>()
  for (const row of rows) {
    const plan = plans.get(row.folder_id) ?? {
      organizationId: row.organization_id,
      projectId: row.project_id,
      folderId: row.folder_id,
      folderName: row.folder_name,
      grants: new Map<string, Level>(),
    }
    plan.grants.set(row.role_slug, better(plan.grants.get(row.role_slug), row.level))
    plans.set(row.folder_id, plan)
  }
  return [...plans.values()]
}

/** Every active membership of the organization, with the role slugs it holds. */
async function membersByRole(organizationId: string): Promise<Array<{ membershipId: string; roles: Set<string> }>> {
  const page = await workos.userManagement.listOrganizationMemberships({ organizationId, statuses: ['active'] })
  const memberships = await page.autoPagination()
  return memberships.map((membership) => ({
    membershipId: membership.id,
    roles: new Set([membership.role?.slug, ...(membership.roles ?? []).map((role) => role.slug)].filter(Boolean) as string[]),
  }))
}

async function isRegistered(plan: FolderPlan): Promise<boolean> {
  try {
    await workos.authorization.getResourceByExternalId({
      organizationId: plan.organizationId,
      resourceTypeSlug: RESOURCE_TYPE,
      externalId: plan.folderId,
    })
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

async function register(plan: FolderPlan): Promise<void> {
  await workos.authorization.createResource({
    resourceTypeSlug: RESOURCE_TYPE,
    externalId: plan.folderId,
    organizationId: plan.organizationId,
    name: plan.folderName,
    parentResourceTypeSlug: 'project',
    parentResourceExternalId: plan.projectId,
  })
}

/** Role slugs already assigned on the folder, per membership. Empty when it is not registered. */
async function assignedOn(plan: FolderPlan): Promise<Map<string, Set<string>>> {
  const held = new Map<string, Set<string>>()
  try {
    const page = await workos.authorization.listResourceRoleAssignments({
      organizationId: plan.organizationId,
      resourceTypeSlug: RESOURCE_TYPE,
      externalId: plan.folderId,
    })
    for (const assignment of await page.autoPagination()) {
      const roles = held.get(assignment.organizationMembershipId) ?? new Set<string>()
      roles.add(assignment.role.slug)
      held.set(assignment.organizationMembershipId, roles)
    }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  return held
}

async function main(): Promise<void> {
  console.log(`Folder grants → WorkOS folder roles (${apply ? 'APPLY' : 'plan only; add -- --apply to write'})`)
  const plans = await loadPlans()
  if (plans.length === 0) {
    console.log('No folder names a role. Nothing to carry over.')
    return
  }
  const members = new Map<string, Awaited<ReturnType<typeof membersByRole>>>()
  let assigned = 0
  let unmatched = 0
  let skipped = 0
  for (const plan of plans) {
    if (!members.has(plan.organizationId)) members.set(plan.organizationId, await membersByRole(plan.organizationId))
    const roster = members.get(plan.organizationId) ?? []
    const wanted = new Map<string, Level>()
    for (const member of roster) {
      for (const [role, level] of plan.grants) {
        if (member.roles.has(role)) wanted.set(member.membershipId, better(wanted.get(member.membershipId), level))
      }
    }
    const rolesWithoutHolder = [...plan.grants.keys()].filter((role) => !roster.some((member) => member.roles.has(role)))
    unmatched += rolesWithoutHolder.length
    const label = `${plan.organizationId} / project ${plan.projectId} / folder ${plan.folderId}`
    console.log(`\n${label}`)
    console.log(`  roles:  ${[...plan.grants].map(([role, level]) => `${role}:${level}`).join(', ')}`)
    console.log(`  people: ${wanted.size} (${[...wanted.values()].filter((level) => level === 'write').length} write)`)
    if (rolesWithoutHolder.length > 0) console.log(`  no active member holds: ${rolesWithoutHolder.join(', ')}`)
    const registered = await isRegistered(plan)
    if (registered && !finish.has(plan.folderId)) {
      // Already WorkOS's: converted before, or edited in the new dialog.
      skipped += 1
      console.log('  already registered in WorkOS: skipped (its list is WorkOS\'s now)')
      continue
    }
    if (!apply || wanted.size === 0) continue

    if (!registered) await register(plan)
    console.log(`  resource ${registered ? 'finishing' : 'created'}`)
    const held = await assignedOn(plan)
    for (const [membershipId, level] of wanted) {
      const roleSlug = FOLDER_ROLE[level]
      if (held.get(membershipId)?.has(roleSlug)) continue
      await workos.authorization.assignRole({
        organizationMembershipId: membershipId,
        roleSlug,
        resourceExternalId: plan.folderId,
        resourceTypeSlug: RESOURCE_TYPE,
      })
      assigned += 1
    }
  }
  console.log(
    `\n${plans.length} folder(s), ${skipped} already registered and skipped; ${apply ? `${assigned} folder role(s) assigned` : 'nothing written'}; ${unmatched} role entr${unmatched === 1 ? 'y' : 'ies'} no active member holds.`
  )
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => sql.end())
