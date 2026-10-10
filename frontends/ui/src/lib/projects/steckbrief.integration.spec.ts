/**
 * @vitest-environment node
 *
 * The Steckbrief's tables (ADR-0091, migration 0117) against a REAL Postgres,
 * through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/projects/steckbrief.integration.spec.ts
 *
 * Tenancy of `project_people` (row-level security and the composite foreign
 * key), the month CHECKs, the closed-project guard on a new person, erasure,
 * the cascade with the project, and closing filling the Abschluss.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_steckbrief_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = 'user_pl'

describe.skipIf(!url)('the Steckbrief against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let repo: typeof import('./steckbrief-repository')
  let projectsRepo: typeof import('./repository')
  let projectId: string

  const inTenant = <T>(run: () => Promise<T>, organizationId = ORG): Promise<T> =>
    withTenant({ organizationId, userId: USER }, run)
  const person = (overrides: Partial<import('./steckbrief-repository').ProjectPersonValues> = {}) => ({
    name: 'DI Maria Huber',
    function: 'Statik',
    company: 'Huber ZT GmbH',
    startedOn: '2023-03-01',
    endedOn: '2025-11-01',
    userId: null,
    ...overrides,
  })

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    repo = await import('./steckbrief-repository')
    projectsRepo = await import('./repository')
    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Seestadt D12', ${USER}, ${`proj_steckbrief_${STAMP}`}) RETURNING id
      `)
    )
    projectId = String(Array.from(rows)[0]?.id)
  })

  afterAll(async () => {
    await inTenant(() => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
  })

  it('keeps a person inside the tenant: another organization neither reads nor files one', async () => {
    const added = await repo.insertProjectPerson(projectId, ORG, USER, person())
    expect(await repo.listProjectPeople(projectId, ORG)).toHaveLength(1)

    const seenByOther = await inTenant(
      () => db.execute(sql`SELECT id FROM project_people WHERE id = ${added.id}::uuid`),
      OTHER_ORG
    )
    expect(Array.from(seenByOther)).toHaveLength(0)
    // Naming this project under another organization breaks the composite key (and the policy).
    await expect(repo.insertProjectPerson(projectId, OTHER_ORG, USER, person())).rejects.toThrow()

    expect(await repo.deleteProjectPersonRow(projectId, ORG, added.id)).toBe(true)
    expect(await repo.listProjectPeople(projectId, ORG)).toHaveLength(0)
  })

  it('refuses a day-precise month, a backwards period, and an empty name', async () => {
    await expect(repo.insertProjectPerson(projectId, ORG, USER, person({ startedOn: '2023-03-15' }))).rejects.toThrow()
    await expect(
      repo.insertProjectPerson(projectId, ORG, USER, person({ startedOn: '2025-03-01', endedOn: '2023-03-01' }))
    ).rejects.toThrow()
    await expect(repo.insertProjectPerson(projectId, ORG, USER, person({ name: '   ' }))).rejects.toThrow()
    await expect(repo.updateProjectPeriod(projectId, ORG, { startedOn: '2025-03-01', endedOn: '2023-03-01' })).rejects.toThrow()
  })

  it('closing fills the Abschluss with the month of the close, keeps one set by hand, and adds nobody after', async () => {
    await repo.updateProjectPeriod(projectId, ORG, { startedOn: '2023-03-01', endedOn: null })
    const kept = await repo.insertProjectPerson(projectId, ORG, USER, person())
    await projectsRepo.setProjectStatusInOrg(projectId, ORG, {
      status: 'closed',
      closedBy: USER,
      at: new Date('2026-10-06T18:00:00Z'),
    })
    expect(await repo.findProjectPeriod(projectId, ORG)).toEqual({ startedOn: '2023-03-01', endedOn: '2026-10-01' })

    // The 0115 guard covers the Steckbrief's people too; erasing one is still possible.
    await expect(repo.insertProjectPerson(projectId, ORG, USER, person({ name: 'Später' }))).rejects.toThrow()
    expect(await repo.deleteProjectPersonRow(projectId, ORG, kept.id)).toBe(true)

    await projectsRepo.setProjectStatusInOrg(projectId, ORG, { status: 'active' })
    await repo.updateProjectPeriod(projectId, ORG, { startedOn: '2023-03-01', endedOn: '2025-06-01' })
    await projectsRepo.setProjectStatusInOrg(projectId, ORG, { status: 'closed', closedBy: USER, at: new Date('2026-10-06T18:00:00Z') })
    expect((await repo.findProjectPeriod(projectId, ORG))?.endedOn).toBe('2025-06-01')
    await projectsRepo.setProjectStatusInOrg(projectId, ORG, { status: 'active' })
  })

  it('goes with its project', async () => {
    await repo.insertProjectPerson(projectId, ORG, USER, person())
    const other = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Wegwerf', ${USER}, ${`proj_steckbrief_x_${STAMP}`}) RETURNING id
      `)
    )
    const otherId = String(Array.from(other)[0]?.id)
    await repo.insertProjectPerson(otherId, ORG, USER, person())
    await inTenant(() => db.execute(sql`DELETE FROM projects WHERE id = ${otherId}::uuid`))
    const left = await inTenant(() => db.execute(sql`SELECT id FROM project_people WHERE project_id = ${otherId}::uuid`))
    expect(Array.from(left)).toHaveLength(0)
  })
})
