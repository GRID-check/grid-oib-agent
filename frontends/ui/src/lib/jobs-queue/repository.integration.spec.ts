/**
 * @vitest-environment node
 *
 * The BFF's side of `bff_job_queue`, against a REAL Postgres, through the
 * restricted runtime role: a request enqueues into its own lane, a second
 * click finds the open job by its payload, and the internal route reads back
 * only the row a worker holds. The claim itself is `queue.integration.spec.ts`.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/jobs-queue/repository.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG_A = `org_jobrepo_a_${STAMP}`
const ORG_B = `org_jobrepo_b_${STAMP}`

describe.skipIf(!url)('bff_job_queue reads and writes from the BFF', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let context: typeof import('@/lib/db/tenant-context')
  let repo: typeof import('./repository')

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    context = await import('@/lib/db/tenant-context')
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
  }, 60_000)

  afterAll(async () => {
    if (!db) return
    await context.withPlatformAccess('test teardown', async () => {
      await db.execute(sql`DELETE FROM bff_job_queue WHERE lane IN (${ORG_A}, ${ORG_B})`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  const enqueueAs = (organizationId: string, projectId: string, kind = 'reindex_project') =>
    context.withTenant({ organizationId }, () =>
      repo.insertJob({ kind, organizationId, priority: 1, payload: { projectId, cursor: null } }),
    )

  it('enqueues into the active organization’s lane, queued and unclaimed', async () => {
    const jobId = await enqueueAs(ORG_A, 'p-1')

    const rows = await context.withPlatformAccess('test: read the row', () =>
      db.execute<Record<string, unknown>>(sql`SELECT * FROM bff_job_queue WHERE job_id = ${jobId}::uuid`),
    )
    expect(Array.from(rows)[0]).toMatchObject({
      lane: ORG_A,
      kind: 'reindex_project',
      priority: 1,
      status: 'queued',
      attempts: 0,
      claimed_by: null,
      payload: { projectId: 'p-1', cursor: null },
    })
  })

  it('refuses a lane that is not the active organization', async () => {
    const forged = context.withTenant({ organizationId: ORG_A }, () =>
      repo.insertJob({ kind: 'reindex_project', organizationId: ORG_B, priority: 1, payload: {} }),
    )

    await expect(forged).rejects.toThrow()
  })

  it('finds the open job of a kind by what its payload contains, in the caller’s lane only', async () => {
    const jobId = await enqueueAs(ORG_A, 'p-open')
    await enqueueAs(ORG_B, 'p-open')

    const inA = await context.withTenant({ organizationId: ORG_A }, () =>
      repo.findOpenJobId({ kind: 'reindex_project', organizationId: ORG_A, matching: { projectId: 'p-open' } }),
    )
    const otherProject = await context.withTenant({ organizationId: ORG_A }, () =>
      repo.findOpenJobId({ kind: 'reindex_project', organizationId: ORG_A, matching: { projectId: 'p-none' } }),
    )
    const otherKind = await context.withTenant({ organizationId: ORG_A }, () =>
      repo.findOpenJobId({ kind: 'reingest_failed', organizationId: ORG_A, matching: { projectId: 'p-open' } }),
    )
    const anyOfKind = await context.withTenant({ organizationId: ORG_A }, () =>
      repo.findOpenJobId({ kind: 'reindex_project', organizationId: ORG_A, matching: {} }),
    )

    expect(inA).toBe(jobId)
    expect(otherProject).toBeNull()
    expect(otherKind).toBeNull()
    expect(anyOfKind).not.toBeNull()
  })

  it('does not call a dead job open', async () => {
    const jobId = await enqueueAs(ORG_A, 'p-dead')
    await context.withPlatformAccess('test: kill the job', () =>
      db.execute(sql`UPDATE bff_job_queue SET status = 'dead', last_error = 'x' WHERE job_id = ${jobId}::uuid`),
    )

    const open = await context.withTenant({ organizationId: ORG_A }, () =>
      repo.findOpenJobId({ kind: 'reindex_project', organizationId: ORG_A, matching: { projectId: 'p-dead' } }),
    )

    expect(open).toBeNull()
  })

  it('reads back a job only for the worker that holds it', async () => {
    const jobId = await enqueueAs(ORG_A, 'p-claimed')
    await context.withPlatformAccess('test: claim the job', () =>
      db.execute(sql`
        UPDATE bff_job_queue
        SET status = 'claimed', claimed_by = 'w-0', claimed_at = now(), heartbeat_at = now(), attempts = 1
        WHERE job_id = ${jobId}::uuid
      `),
    )

    const read = (worker: string) =>
      context.withPlatformAccess('test: the run route reads the row', () => repo.findClaimedJob(jobId, worker))

    expect((await read('w-0'))?.lane).toBe(ORG_A)
    expect(await read('w-1')).toBeNull()
  })
})
