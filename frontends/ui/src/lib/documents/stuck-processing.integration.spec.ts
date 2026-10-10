/**
 * @vitest-environment node
 *
 * The SQL behind the background-work sweeps (ADR-0079), against a REAL Postgres
 * through the restricted runtime role:
 *
 *   - which documents at `processing` the sweep is handed: those with no job,
 *     and those whose job is dead, and NOT those whose job is still waiting or
 *     running, however many there are, nor those in a folder in the
 *     Papierkorb (ADR-0088);
 *   - that the job id a row remembers leaves with the status;
 *   - which report filings are still `queued` after the window (migration 0105,
 *     its CHECK and its partial index).
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/documents/stuck-processing.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptySkillSnapshot } from '@/lib/jobs/types'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_stuck_${STAMP}`
const OTHER_ORG = `org_stuck_other_${STAMP}`
const USER = `user_stuck_${STAMP}`
const PROJECT = '0d0d0d0d-0000-4000-8000-000000000001'
const OTHER_PROJECT = '0d0d0d0d-0000-4000-8000-000000000002'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

describe.skipIf(!url)('background-work sweeps against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let context: typeof import('@/lib/db/tenant-context')
  let documents: typeof import('./repository')
  let tasks: typeof import('@/lib/tasks/repository')
  let queue: typeof import('@/lib/jobs-queue/repository')

  const docs: Record<string, string> = {}
  const nameOf = (id: string) => Object.entries(docs).find(([, value]) => value === id)?.[0]

  async function seedJob(organizationId: string, status: 'queued' | 'claimed' | 'dead', lastError?: string) {
    const jobId = await context.withTenant({ organizationId }, () =>
      queue.insertJob({ kind: 'bim_extract', organizationId, priority: 1, payload: { documentId: 'x' } }),
    )
    await context.withPlatformAccess('test seed: put the job in its state', () =>
      db.execute(sql`
        UPDATE bff_job_queue
        SET status = ${status}, last_error = ${lastError ?? null}, dead_at = ${status === 'dead' ? sql`now()` : null},
            claimed_by = ${status === 'claimed' ? 'w-0' : null},
            heartbeat_at = ${status === 'claimed' ? sql`now()` : null}
        WHERE job_id = ${jobId}::uuid
      `),
    )
    return jobId
  }

  async function seedDocument(
    name: string,
    fields: {
      organizationId?: string
      projectId?: string
      status?: string
      ageMinutes: number
      jobId?: string
      folderId?: string
    },
  ) {
    const organizationId = fields.organizationId ?? ORG
    const projectId = fields.projectId ?? PROJECT
    const metadata = fields.jobId ? JSON.stringify({ bffJobId: fields.jobId }) : null
    const rows = await context.withTenant({ organizationId }, () =>
      db.execute<{ id: string }>(sql`
        INSERT INTO documents
          (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id, metadata, updated_at)
        VALUES
          (${organizationId}, ${USER}, ${name + '.ifc'}, ${'k/' + name}, 'coll_stuck', ${fields.status ?? 'processing'},
           'project', ${projectId}::uuid, ${fields.folderId ?? null}::uuid, ${metadata}::jsonb,
           ${minutesAgo(fields.ageMinutes).toISOString()}::timestamptz)
        RETURNING id
      `),
    )
    docs[name] = String(Array.from(rows)[0].id)
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    context = await import('@/lib/db/tenant-context')
    documents = await import('./repository')
    tasks = await import('@/lib/tasks/repository')
    queue = await import('@/lib/jobs-queue/repository')
    db = (await import('@/lib/db')).getDb()

    await context.withPlatformAccess('test seed: organizations', async () => {
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
      await context.withTenant({ organizationId: org }, () =>
        db.execute(sql`
          insert into projects (id, organization_id, name, created_by, collection_name)
          values (${project}, ${org}, 'Stuck', ${USER}, ${'proj_' + project})
        `),
      )
    }

    const waiting = await seedJob(ORG, 'queued')
    const running = await seedJob(ORG, 'claimed')
    const dead = await seedJob(ORG, 'dead', 'object store down')
    await seedDocument('no-job', { ageMinutes: 30 })
    await seedDocument('dead-job', { ageMinutes: 40, jobId: dead })
    await seedDocument('waiting-job', { ageMinutes: 90, jobId: waiting })
    await seedDocument('running-job', { ageMinutes: 90, jobId: running })
    await seedDocument('fresh', { ageMinutes: 2 })
    await seedDocument('finished', { ageMinutes: 60, status: 'completed' })
    // Filed while the folder lived (nothing is filed into a deleted one), then
    // the folder went to the Papierkorb.
    const [binned] = Array.from(
      await context.withTenant({ organizationId: ORG }, () =>
        db.execute<{ id: string }>(sql`
          INSERT INTO project_folders (organization_id, project_id, name, path)
          VALUES (${ORG}, ${PROJECT}::uuid, 'Papierkorb', '/Papierkorb')
          RETURNING id
        `),
      ),
    )
    await seedDocument('in-the-bin', { ageMinutes: 50, folderId: String(binned.id) })
    await context.withTenant({ organizationId: ORG }, () =>
      db.execute(sql`
        UPDATE project_folders SET deleted_at = now(), deleted_by = ${USER}, bin_root_id = id
        WHERE id = ${String(binned.id)}::uuid
      `),
    )
    await seedDocument('elsewhere', {
      organizationId: OTHER_ORG,
      projectId: OTHER_PROJECT,
      ageMinutes: 20,
    })
  }, 60_000)

  afterAll(async () => {
    if (!db) return
    await context.withPlatformAccess('test teardown', async () => {
      await db.execute(sql`DELETE FROM task_runs WHERE organization_id IN (${ORG}, ${OTHER_ORG})`)
      await db.execute(sql`DELETE FROM documents WHERE organization_id IN (${ORG}, ${OTHER_ORG})`)
      await db.execute(sql`DELETE FROM bff_job_queue WHERE lane IN (${ORG}, ${OTHER_ORG})`)
      await db.execute(sql`DELETE FROM project_folders WHERE organization_id IN (${ORG}, ${OTHER_ORG})`)
      await db.execute(sql`DELETE FROM projects WHERE organization_id IN (${ORG}, ${OTHER_ORG})`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('hands the sweep rows with no job or a dead one, across organizations, oldest first', async () => {
    const stuck = await documents.listStuckProcessingDocuments(minutesAgo(15), 100)
    const mine = stuck.filter((row) => nameOf(row.id))

    // The longest-stranded first: 40, 30 and 20 minutes.
    expect(mine.map((row) => nameOf(row.id))).toEqual(['dead-job', 'no-job', 'elsewhere'])
    expect(mine.find((row) => row.id === docs['dead-job'])).toMatchObject({
      organizationId: ORG,
      jobStatus: 'dead',
      lastError: 'object store down',
    })
    expect(mine.find((row) => row.id === docs['no-job'])).toMatchObject({ jobStatus: null, lastError: null })
    expect(mine.find((row) => row.id === docs.elsewhere)?.organizationId).toBe(OTHER_ORG)
  })

  it('leaves out rows whose job is waiting or running, however old, and rows that are not processing', async () => {
    const stuck = await documents.listStuckProcessingDocuments(minutesAgo(15), 100)
    const names = stuck.map((row) => nameOf(row.id))

    expect(names).not.toContain('waiting-job')
    expect(names).not.toContain('running-job')
    expect(names).not.toContain('fresh')
    expect(names).not.toContain('finished')
  })

  it('leaves out a row in a folder in the Papierkorb: restoring the folder dispatches it again', async () => {
    const stuck = await documents.listStuckProcessingDocuments(minutesAgo(15), 100)

    expect(stuck.map((row) => nameOf(row.id))).not.toContain('in-the-bin')
  })

  it('bounds the batch', async () => {
    const stuck = await documents.listStuckProcessingDocuments(minutesAgo(15), 1)

    expect(stuck).toHaveLength(1)
  })

  it('remembers the job on a row that is processing, and only then', async () => {
    const jobId = await seedJob(ORG, 'queued')
    const read = (name: string) =>
      context.withTenant({ organizationId: ORG }, () => documents.findDocumentInOrg(docs[name], ORG))

    await context.withTenant({ organizationId: ORG }, () => documents.setDocumentBackgroundJob(docs['no-job'], ORG, jobId))
    await context.withTenant({ organizationId: ORG }, () => documents.setDocumentBackgroundJob(docs.finished, ORG, jobId))

    expect((await read('no-job'))?.metadata).toMatchObject({ bffJobId: jobId })
    expect((await read('finished'))?.metadata ?? {}).not.toHaveProperty('bffJobId')

    // The row is now waiting on a live job, so the sweep leaves it alone.
    const stuck = await documents.listStuckProcessingDocuments(minutesAgo(15), 100)
    expect(stuck.map((row) => row.id)).not.toContain(docs['no-job'])

    // The next round forgets the old job: it was that round's.
    await context.withTenant({ organizationId: ORG }, () => documents.markDocumentProcessing(docs['no-job'], ORG))
    expect((await read('no-job'))?.metadata ?? {}).not.toHaveProperty('bffJobId')
  })

  it('lists the report filings still queued after the window, oldest first, and no others', async () => {
    const seedRun = async (name: string, filingStatus: 'queued' | 'filed' | null, finishedMinutesAgo: number) => {
      await context.withTenant({ organizationId: ORG }, async () => {
        const run = await tasks.insertRun({
          organizationId: ORG,
          projectId: PROJECT,
          kind: 'deep-research',
          title: name,
          plan: { prompt: name, skill: emptySkillSnapshot(), dataSources: null, goal: name, subject: null },
          requesterUserId: USER,
          trigger: 'delegated',
          status: 'succeeded',
          skillSnapshot: emptySkillSnapshot(),
          backendJobId: `job_${name}_${STAMP}`,
          finishedAt: minutesAgo(finishedMinutesAgo),
        })
        await tasks.updateRun(run.id, ORG, { filingStatus })
      })
    }
    await seedRun('queued-old', 'queued', 120)
    await seedRun('queued-recent', 'queued', 2)
    await seedRun('already-filed', 'filed', 120)
    await seedRun('never-filed', null, 120)

    const stale = await context.withPlatformAccess('test: the sweep’s read', () =>
      tasks.listRunsWithStaleQueuedFiling(minutesAgo(15), 100),
    )
    const mine = stale.filter((run) => run.organizationId === ORG)

    expect(mine.map((run) => run.title)).toEqual(['queued-old'])
    expect(mine[0]).toMatchObject({ filingStatus: 'queued', organizationId: ORG })
  })

  it('leaves out a filing whose job is alive, so a backlog of live ones cannot starve a dead one', async () => {
    const seed = async (name: string, finishedMinutesAgo: number) => {
      const backendJobId = `job_${name}_${STAMP}`
      await context.withTenant({ organizationId: ORG }, async () => {
        const run = await tasks.insertRun({
          organizationId: ORG,
          projectId: PROJECT,
          kind: 'deep-research',
          title: name,
          plan: { prompt: name, skill: emptySkillSnapshot(), dataSources: null, goal: name, subject: null },
          requesterUserId: USER,
          trigger: 'delegated',
          status: 'succeeded',
          skillSnapshot: emptySkillSnapshot(),
          backendJobId,
          finishedAt: minutesAgo(finishedMinutesAgo),
        })
        await tasks.updateRun(run.id, ORG, { filingStatus: 'queued' })
      })
      return backendJobId
    }
    const job = (runId: string, status: 'queued' | 'claimed' | 'dead') =>
      context.withTenant({ organizationId: ORG }, () =>
        queue.insertJob({ kind: 'file_research_report', organizationId: ORG, priority: 0, payload: { runId } }),
      ).then((jobId) =>
        context.withPlatformAccess('test seed: put the filing job in its state', () =>
          db.execute(sql`
            UPDATE bff_job_queue
            SET status = ${status}, dead_at = ${status === 'dead' ? sql`now()` : null},
                claimed_by = ${status === 'claimed' ? 'w-0' : null}, heartbeat_at = ${status === 'claimed' ? sql`now()` : null}
            WHERE job_id = ${jobId}::uuid
          `),
        ),
      )
    // The oldest are alive; the one a sweep has to reach is younger, with a dead job.
    await job(await seed('alive-queued', 300), 'queued')
    await job(await seed('alive-claimed', 290), 'claimed')
    await job(await seed('dead-job', 120), 'dead')
    await seed('no-job', 100)

    const stale = await context.withPlatformAccess('test: the sweep’s read', () =>
      tasks.listRunsWithStaleQueuedFiling(minutesAgo(15), 100),
    )
    const titles = stale.filter((run) => run.organizationId === ORG).map((run) => run.title)

    expect(titles).toContain('dead-job')
    expect(titles).toContain('no-job')
    expect(titles).not.toContain('alive-queued')
    expect(titles).not.toContain('alive-claimed')
  })

  it('settles a filing only while it is still queued', async () => {
    const run = await context.withTenant({ organizationId: ORG }, async () => {
      const row = await tasks.insertRun({
        organizationId: ORG,
        projectId: PROJECT,
        kind: 'deep-research',
        title: 'settle-me',
        plan: { prompt: 'x', skill: emptySkillSnapshot(), dataSources: null, goal: 'x', subject: null },
        requesterUserId: USER,
        trigger: 'delegated',
        status: 'succeeded',
        skillSnapshot: emptySkillSnapshot(),
        backendJobId: `job_settle_${STAMP}`,
      })
      await tasks.updateRun(row.id, ORG, { filingStatus: 'queued' })
      return row
    })
    const verdict = (filingStatus: 'filed' | 'failed') => ({ filingStatus, filingDetail: null, filedDocumentId: null })

    const first = await context.withTenant({ organizationId: ORG }, () => tasks.settleQueuedFiling(run.id, ORG, verdict('filed')))
    const second = await context.withTenant({ organizationId: ORG }, () => tasks.settleQueuedFiling(run.id, ORG, verdict('failed')))
    const read = await context.withTenant({ organizationId: ORG }, () => tasks.findRunById(run.id))

    expect(first?.filingStatus).toBe('filed')
    expect(second).toBeNull()
    expect(read?.filingStatus).toBe('filed') // the later opinion did not overwrite the first
  })

  it('refuses a filing status the vocabulary does not have', async () => {
    const bad = context.withPlatformAccess('test: a status the CHECK refuses', () =>
      db.execute(sql`UPDATE task_runs SET filing_status = 'someday' WHERE organization_id = ${ORG}`),
    )

    await expect(bad).rejects.toThrow()
  })
})
