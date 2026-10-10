/**
 * Migration 0128 against a real Postgres (ADR-0097): who is on a folder's own
 * list moves to WorkOS, and the one part of a list that names no person stays
 * with the folder as `everyone_reads`. What the SQL carries over from the
 * role-based grants of 0111:
 *
 *   - a `*` entry that reads: `everyone_reads`, and the folder stays custom;
 *   - a `*` entry that writes: everyone reads and writes, which is what a
 *     folder that inherits gives, so the folder goes back to `inherit`;
 *   - a list naming roles only: custom, `everyone_reads` false, until the
 *     conversion script gives its people folder roles (narrow until then);
 *
 * and that the 1–20 grant trigger is gone, the grants stay for the script, a
 * re-run changes nothing, and the down migration drops only the column.
 *
 * Opt-in. It needs a database migrated up to, and not including, 0128, as its
 * owner, because the rows under test need the trigger 0128 drops:
 *
 *   GRID_TEST_MIGRATION_0128_DATABASE_URL=postgres://grid_app_owner@host:port/grid_folder_roles \
 *     npx vitest run src/lib/projects/folder-access-in-workos.migration.spec.ts
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.GRID_TEST_MIGRATION_0128_DATABASE_URL

const ORG = 'org_0128'
const USER = 'user_0128'

const migration = (name: string): string => readFileSync(path.join(process.cwd(), 'drizzle', name), 'utf-8')

type Grant = [role: string, level: 'read' | 'write']

/** The folders under test, by what their 0111 list said. */
const LISTS: Record<string, Grant[] | null> = {
  everyoneReads: [
    ['*', 'read'],
    ['org-gf', 'write'],
  ],
  everyoneReadsOnly: [['*', 'read']],
  everyoneWrites: [['*', 'write']],
  everyoneWritesAndRole: [
    ['*', 'write'],
    ['org-gf', 'read'],
  ],
  rolesOnly: [
    ['org-gf', 'write'],
    ['org-bh', 'read'],
  ],
  inherits: null,
}

describe('the 0128 migration suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_MIGRATION_0128_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('migration 0128: folder access in WorkOS, against live Postgres', () => {
  let db: postgres.Sql
  let projectId = ''
  const folderIds: Record<string, string> = {}
  let tombstone = ''

  /** A folder and its whole 0111 list in one transaction: the deferred trigger checks at commit. */
  async function insertFolder(name: string, list: Grant[] | null, deleted = false): Promise<string> {
    return db.begin(async (tx) => {
      const [folder] = await tx<{ id: string }[]>`
        insert into project_folders
          (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at, deleted_at, deleted_by)
        values (${ORG}, ${projectId}::uuid, ${name}, ${name}, ${list ? 'custom' : 'inherit'},
                ${list ? USER : null}, ${list ? new Date() : null}, ${deleted ? new Date() : null}, ${deleted ? USER : null})
        returning id`
      for (const [role, level] of list ?? []) {
        await tx`
          insert into project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
          values (${ORG}, ${projectId}::uuid, ${folder.id}::uuid, ${role}, ${level})`
      }
      return folder.id
    })
  }

  /** `access_mode` and `everyone_reads` of each folder under test. */
  async function state(): Promise<Record<string, [string, boolean]>> {
    const rows = await db<{ id: string; access_mode: string; everyone_reads: boolean }[]>`
      select id, access_mode, everyone_reads from project_folders where project_id = ${projectId}::uuid`
    const byId = new Map(rows.map((row) => [row.id, [row.access_mode, row.everyone_reads] as [string, boolean]]))
    return Object.fromEntries(Object.entries(folderIds).map(([name, id]) => [name, byId.get(id) ?? ['missing', false]]))
  }

  const grantCount = async () =>
    Number((await db<{ n: number }[]>`select count(*)::int as n from project_folder_grants where organization_id = ${ORG}`)[0].n)

  const AFTER: Record<string, [string, boolean]> = {
    everyoneReads: ['custom', true],
    everyoneReadsOnly: ['custom', true],
    everyoneWrites: ['inherit', false],
    everyoneWritesAndRole: ['inherit', false],
    rolesOnly: ['custom', false],
    inherits: ['inherit', false],
  }

  beforeAll(async () => {
    db = postgres(url as string, { prepare: false, max: 1, onnotice: () => {} })
    const [project] = await db<{ id: string }[]>`
      insert into projects (organization_id, name, created_by, collection_name)
      values (${ORG}, 'Ordnerrechte 0128', ${USER}, 'proj_0128') returning id`
    projectId = project.id
    for (const [name, list] of Object.entries(LISTS)) folderIds[name] = await insertFolder(name, list)
    // A folder in the Papierkorb keeps its list, and the setting with it.
    tombstone = await insertFolder('Archiv', [['*', 'read']], true)

    await db.unsafe(migration('0128_folder_access_in_workos.sql'))
  })

  afterAll(async () => {
    await db?.end()
  })

  it('carries `*` read over as everyone_reads, turns `*` write back to inherit, and leaves a role-only list custom', async () => {
    expect(await state()).toEqual(AFTER)
  })

  it('carries the setting of a folder in the Papierkorb too', async () => {
    const [row] = await db<{ access_mode: string; everyone_reads: boolean }[]>`
      select access_mode, everyone_reads from project_folders where id = ${tombstone}::uuid`
    expect(row).toEqual({ access_mode: 'custom', everyone_reads: true })
  })

  it('keeps every grant row for the conversion script', async () => {
    expect(await grantCount()).toBe(9)
  })

  it('drops the 1–20 trigger: a custom folder with no grant row commits, and a grant row may go', async () => {
    const triggers = await db<{ n: number }[]>`
      select count(*)::int as n from pg_trigger
      where tgname in ('project_folders_access_list', 'project_folder_grants_access_list')`
    expect(triggers[0].n).toBe(0)
    const functions = await db<{ n: number }[]>`
      select count(*)::int as n from pg_proc
      where proname in ('grid_folder_access_list_on_folder', 'grid_folder_access_list_on_grant', 'grid_folder_access_list_check')`
    expect(functions[0].n).toBe(0)

    const lone = await insertFolder('Ohne Einträge', null)
    await db`update project_folders set access_mode = 'custom', access_changed_by = ${USER}, access_changed_at = now()
             where id = ${lone}::uuid`
    await db`delete from project_folder_grants where folder_id = ${folderIds.rolesOnly}::uuid and role_slug = 'org-bh'`
    const [row] = await db<{ access_mode: string }[]>`select access_mode from project_folders where id = ${lone}::uuid`
    expect(row.access_mode).toBe('custom')
    // Restore the row the next test counts.
    await db`insert into project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
             values (${ORG}, ${projectId}::uuid, ${folderIds.rolesOnly}::uuid, 'org-bh', 'read')`
    await db`delete from project_folders where id = ${lone}::uuid`
  })

  it('changes nothing when it runs again', async () => {
    await db.unsafe(migration('0128_folder_access_in_workos.sql'))
    expect(await state()).toEqual(AFTER)
    expect(await grantCount()).toBe(9)
  })

  it('down drops only the column, keeps the folders as 0128 left them, and 0128 carries `*` read over again', async () => {
    await db.unsafe(migration('0128_folder_access_in_workos.down.sql'))
    const columns = await db<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
      where table_name = 'project_folders' and column_name = 'everyone_reads'`
    expect(columns[0].n).toBe(0)
    const modes = await db<{ id: string; access_mode: string }[]>`
      select id, access_mode from project_folders where project_id = ${projectId}::uuid`
    const modeOf = new Map(modes.map((row) => [row.id, row.access_mode]))
    // Lossy by design: a folder turned back to inherit stays inherit, which grants the same.
    expect(modeOf.get(folderIds.everyoneWrites)).toBe('inherit')
    expect(modeOf.get(folderIds.everyoneReads)).toBe('custom')

    await db.unsafe(migration('0128_folder_access_in_workos.sql'))
    expect(await state()).toEqual(AFTER)
  })
})
