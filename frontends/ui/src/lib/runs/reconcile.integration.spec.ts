/**
 * Opt-in integration test: the run reconciler's two statements against a REAL
 * Postgres with every migration applied (0096 included), as the restricted
 * runtime role.
 *
 * The unit suite doubles the repository and pins the decisions. Only this can
 * prove the SQL: that the claim picks exactly the active runs nobody has
 * checked within the window, stamps them in the same statement so a second
 * sweep — or a second replica sweeping at the same moment — never takes one
 * run twice, and that the conditional close lets exactly one closer win.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/runs/reconcile.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptySkillSnapshot } from '@/lib/jobs/types'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL

const STAMP = Date.now()
const ORG = `org_reconcile_${STAMP}`
const OTHER_ORG = `org_reconcile_other_${STAMP}`
const USER = `user_reconcile_${STAMP}`
const PROJECT = '0c0c0c0c-0000-4000-8000-000000000001'
const OTHER_PROJECT = '0c0c0c0c-0000-4000-8000-000000000002'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

describe.skipIf(!url)('run reconciler SQL against live Postgres (migration 0096)', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repository: typeof import('@/lib/tasks/repository')

  const ids: Record<string, string> = {}
  const ours = <T extends { id: string }>(rows: T[]): T[] => {
    const mine = new Set(Object.values(ids))
    return rows.filter((row) => mine.has(row.id))
  }
  const nameOf = (id: string) => Object.entries(ids).find(([, value]) => value === id)?.[0]

  async function seedRun(
    name: string,
    organizationId: string,
    projectId: string,
    fields: { status: 'queued' | 'running' | 'succeeded'; startedAt: Date | null; createdAt: Date },
  ) {
    const run = await withTenant({ organizationId }, () =>
      repository.insertRun({
        organizationId,
        projectId,
        kind: 'deep-research',
        title: name,
        plan: { prompt: name, skill: emptySkillSnapshot(), dataSources: null, goal: name, subject: null },
        requesterUserId: USER,
        trigger: 'delegated',
        status: fields.status,
        skillSnapshot: emptySkillSnapshot(),
        backendJobId: `job_${name}_${STAMP}`,
        startedAt: fields.startedAt,
        createdAt: fields.createdAt,
      }),
    )
    ids[name] = run.id
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    repository = await import('@/lib/tasks/repository')
    db = (await import('@/lib/db')).getDb()

    await withPlatformAccess('test seed: organizations', async () => {
      for (const org of [ORG, OTHER_ORG]) {
        await db.execute(
          sql`insert into organizations (workos_organization_id, display_name) values (${org}, ${org}) on conflict do nothing`,
        )
      }
    })
    for (const [org, project] of [
      [ORG, PROJECT],
      [OTHER_ORG, OTHER_PROJECT],
    ] as const) {
      await withTenant({ organizationId: org }, () =>
        db.execute(sql`
          insert into projects (id, organization_id, name, created_by, collection_name)
          values (${project}, ${org}, 'Reconcile', ${USER}, ${'proj_' + project})
        `),
      )
    }

    await seedRun('stale', ORG, PROJECT, { status: 'running', startedAt: minutesAgo(30), createdAt: minutesAgo(31) })
    await seedRun('fresh', ORG, PROJECT, { status: 'running', startedAt: minutesAgo(2), createdAt: minutesAgo(2) })
    await seedRun('done', ORG, PROJECT, { status: 'succeeded', startedAt: minutesAgo(60), createdAt: minutesAgo(60) })
    // Never started: judged by when it was created.
    await seedRun('queued', ORG, PROJECT, { status: 'queued', startedAt: null, createdAt: minutesAgo(45) })
    await seedRun('elsewhere', OTHER_ORG, OTHER_PROJECT, {
      status: 'running',
      startedAt: minutesAgo(20),
      createdAt: minutesAgo(20),
    })
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from projects where organization_id in (${ORG}, ${OTHER_ORG})`)
      await db.execute(
        sql`delete from organizations where workos_organization_id in (${ORG}, ${OTHER_ORG})`,
      )
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('claims only active runs older than the window, across organizations, oldest first', async () => {
    const claimed = await withPlatformAccess('test: claim', () =>
      repository.claimRunsToReconcile(minutesAgo(10), 500),
    )
    const mine = ours(claimed)
    expect(mine.map((row) => nameOf(row.id)).sort()).toEqual(['elsewhere', 'queued', 'stale'])
    for (const row of mine) {
      expect(row.reconcileCheckedAt).toBeInstanceOf(Date)
      expect(Date.now() - (row.reconcileCheckedAt as Date).getTime()).toBeLessThan(60_000)
    }
  })

  it('does not take a run again until the window has passed since its last check', async () => {
    const again = await withPlatformAccess('test: claim again', () =>
      repository.claimRunsToReconcile(minutesAgo(10), 500),
    )
    expect(ours(again)).toEqual([])

    // A cutoff in the future stands in for the window having passed.
    const later = await withPlatformAccess('test: claim later', () =>
      repository.claimRunsToReconcile(new Date(Date.now() + 60_000), 500),
    )
    expect(ours(later).map((row) => nameOf(row.id)).sort()).toEqual(['elsewhere', 'fresh', 'queued', 'stale'])
  })

  it('two sweeps at the same moment never take the same run', async () => {
    // Due again, as they would be once the window has passed — and a cutoff in
    // the PAST, as a real sweep uses, so a run one sweep has just stamped is out
    // of the other's window whether it saw the lock or the committed stamp.
    await withPlatformAccess('test: make due again', () =>
      db.execute(sql`update task_runs set reconcile_checked_at = null where organization_id in (${ORG}, ${OTHER_ORG})`),
    )
    const cutoff = minutesAgo(1)
    const [a, b] = await Promise.all([
      withPlatformAccess('test: replica a', () => repository.claimRunsToReconcile(cutoff, 500)),
      withPlatformAccess('test: replica b', () => repository.claimRunsToReconcile(cutoff, 500)),
    ])
    const taken = [...ours(a), ...ours(b)].map((row) => row.id)
    expect(new Set(taken).size).toBe(taken.length)
    expect(taken.length).toBe(4)
  })

  it('bounds a sweep by its batch', async () => {
    const future = new Date(Date.now() + 20 * 60_000)
    const one = await withPlatformAccess('test: batch', () => repository.claimRunsToReconcile(future, 1))
    expect(one.length).toBe(1)
  })

  it('closes a run once: the second closer, and another organization, get nothing', async () => {
    const patch = { status: 'failed' as const, error: 'reconciled', finishedAt: new Date() }

    const foreign = await withTenant({ organizationId: OTHER_ORG }, () =>
      repository.closeActiveRun(ids.stale, OTHER_ORG, patch),
    )
    expect(foreign).toBeNull()

    const first = await withTenant({ organizationId: ORG }, () => repository.closeActiveRun(ids.stale, ORG, patch))
    expect(first?.status).toBe('failed')

    const second = await withTenant({ organizationId: ORG }, () => repository.closeActiveRun(ids.stale, ORG, patch))
    expect(second).toBeNull()

    const finished = await withTenant({ organizationId: ORG }, () =>
      repository.closeActiveRun(ids.done, ORG, patch),
    )
    expect(finished).toBeNull()

    // And a closed run leaves the sweep for good.
    const after = await withPlatformAccess('test: claim after close', () =>
      repository.claimRunsToReconcile(new Date(Date.now() + 60 * 60_000), 500),
    )
    expect(ours(after).map((row) => nameOf(row.id))).not.toContain('stale')
  })
})
