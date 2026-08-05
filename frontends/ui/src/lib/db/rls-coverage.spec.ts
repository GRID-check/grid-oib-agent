/**
 * The guard that keeps the tenant boundary complete (ADR-0041).
 *
 * Row-level security protects the tables it was switched on for. The failure
 * mode nobody notices is the NEXT table: a migration adds one, a repository
 * queries it, and it sits outside the boundary reading across every tenant
 * because switching RLS on is a separate line somebody had to remember.
 *
 * So the drizzle schema — which is where a new table actually gets declared —
 * is the checklist, and this spec fails until the table also appears in
 * `0030_row_level_security.sql`. Same shape as `authz-coverage.spec.ts` and the
 * exhaustive `CARD_INTERACTIVITY` map: the reminder is a failing build, not a
 * review comment.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Table, getTableName, is } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import * as schema from './schema'
import { ORGANIZATION_SETTING, PLATFORM_ROLE, USER_SETTING } from './tenant-context'

const MIGRATION = readFileSync(
  join(process.cwd(), 'drizzle', '0030_row_level_security.sql'),
  'utf8'
)

/** Every table the application declares, from the schema barrel. */
function declaredTables(): string[] {
  // The barrel also exports enum tuples and row types alongside the tables, so
  // the values are widened to `unknown` and narrowed back by drizzle's own
  // runtime check rather than by a structural guess.
  return (Object.values(schema) as unknown[])
    .filter((value): value is Table => is(value, Table))
    .map((table) => getTableName(table))
    .sort()
}

/** Tables the migration puts inside the boundary, by how they are secured. */
function securedTables(): { tenant: string[]; platform: string[] } {
  const collect = (fn: string) =>
    [...MIGRATION.matchAll(new RegExp(`${fn}\\(\\s*'([a-z_]+)'`, 'g'))].map((m) => m[1]).sort()
  return { tenant: collect('grid_secure_table'), platform: collect('grid_secure_platform_table') }
}

describe('row-level security coverage', () => {
  it('secures every table the drizzle schema declares', () => {
    const { tenant, platform } = securedTables()
    const secured = new Set([...tenant, ...platform])
    const unsecured = declaredTables().filter((table) => !secured.has(table))

    expect(
      unsecured,
      `These tables are outside the tenant boundary. Add a grid_secure_table() ` +
        `line for each one to a migration — see docs/database/row-level-security.md.`
    ).toEqual([])
  })

  it('secures no table that no longer exists', () => {
    const declared = new Set(declaredTables())
    const { tenant, platform } = securedTables()
    const orphaned = [...tenant, ...platform].filter((table) => !declared.has(table))

    expect(orphaned, 'Secured tables that are not in the schema — stale migration entry.').toEqual(
      []
    )
  })

  it('secures each table exactly once', () => {
    const { tenant, platform } = securedTables()
    const all = [...tenant, ...platform]
    const duplicated = all.filter((table, index) => all.indexOf(table) !== index)

    // Two permissive policies OR together, so a second entry for a table would
    // silently widen the first rather than tighten it.
    expect(duplicated, 'Tables secured twice — the policies would OR together.').toEqual([])
  })

  it('keeps platform configuration out of the tenant-predicate set', () => {
    const { tenant, platform } = securedTables()

    // Platform tables hold no tenant data and are writable only by the platform
    // role; securing one with an organization predicate would silently make it
    // unreadable for every tenant instead.
    expect(platform).toEqual([
      'platform_model_defaults',
      'platform_retrieval_settings',
      'platform_workflow_templates',
    ])
    expect(tenant.filter((table) => table.startsWith('platform_'))).toEqual([])
  })
})

describe('settings parity between the app and the policies', () => {
  it('uses the setting names the policies read', () => {
    // The policies read these through grid_current_org() / grid_current_user_id().
    // If either name drifts, every policy silently matches nothing.
    expect(MIGRATION).toContain(`current_setting('${ORGANIZATION_SETTING}', true)`)
    expect(MIGRATION).toContain(`current_setting('${USER_SETTING}', true)`)
  })

  it('names the same bypass role the migration requires', () => {
    // The migration no longer CREATES roles — creating a BYPASSRLS role needs
    // the creator to hold BYPASSRLS, which no migration credential should. It
    // asserts them instead, and the name it asserts must be the one the app
    // steps up to.
    expect(MIGRATION).toContain(`'${PLATFORM_ROLE}'`)
    expect(MIGRATION).not.toContain(`CREATE ROLE ${PLATFORM_ROLE}`)
  })

  it('is provisioned by every deployment that has to run the migration', () => {
    // Roles moved out of the migration, so "who creates them" became a thing
    // that can be forgotten per deployment — and forgetting it fails the whole
    // deploy at migration time. Each place that migrates must also provision.
    const provisioners = [
      'deploy/compose/init-db.sql',
      'scripts/rls-test-db.sh',
      'deploy/pulumi/src/data/postgres.ts',
    ]
    for (const file of provisioners) {
      const source = readFileSync(join(process.cwd(), '..', '..', file), 'utf8')
      for (const role of ['grid_app_owner', 'grid_app_rw', PLATFORM_ROLE]) {
        expect(source, `${file} must provision ${role}`).toContain(role)
      }
    }
  })

  it('grants the runtime role no write access to platform configuration', () => {
    // Defence in depth behind the read-only policy: the grant itself withholds
    // writes, so a bug cannot rewrite platform-wide config even in its own
    // transaction.
    expect(MIGRATION).toContain('GRANT SELECT ON %I TO grid_app_rw')
    expect(MIGRATION).not.toMatch(/GRANT[^;]*INSERT[^;]*TO grid_app_rw[^,]*;/)
  })
})
