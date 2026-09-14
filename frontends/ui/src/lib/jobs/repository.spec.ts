/**
 * @vitest-environment node
 */
/**
 * Characterization of the jobs repository BEFORE the task_definitions /
 * task_runs collapse moves it (slice 01 of the task-model follow-up, PR #659).
 *
 * Asserted as the SQL Postgres receives rather than as chain spies: org
 * scoping, list bounds and the backend-id lookup only exist in the statement.
 * These must pass unchanged through the additive slices — an edit here means a
 * storage behaviour changed without being declared.
 *
 * The DB is a drizzle `pg-proxy` instance, the same harness as
 * `lib/inbox/repository.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pg-proxy'

interface CapturedQuery {
  sql: string
  params: unknown[]
}

const captured: CapturedQuery[] = []
let driverRows: unknown[] = []

const proxyDb = drizzle(async (sql, params) => {
  captured.push({ sql, params })
  return { rows: driverRows }
})

vi.mock('@/lib/db', () => ({ getDb: () => proxyDb }))

import {
  deleteJob,
  findJob,
  findJobById,
  findJobRunByBackendJobId,
  insertJobRun,
  listJobRuns,
  listJobsInProject,
  touchJobLastRun,
  updateJob,
} from './repository'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const JOB = '22222222-2222-4222-8222-222222222222'
const ORG = 'org_1'

function onlyQuery(): CapturedQuery {
  expect(captured).toHaveLength(1)
  return captured[0]
}

/** The predicate Postgres applies, without the projection or the modifiers. */
function where(sql: string): string {
  const match = / where (.+?)(?: order by| limit| offset| returning|$)/.exec(sql)
  expect(match, sql).not.toBeNull()
  return match![1]
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB,
    projectId: PROJECT,
    organizationId: ORG,
    name: 'Wochencheck',
    prompt: 'Prüf das',
    skillName: null,
    skillSnapshot: null,
    output: 'chat',
    dataSources: null,
    enabled: true,
    scheduleCron: '0 8 * * 1',
    scheduleTimezone: 'Europe/Vienna',
    nextRunAt: new Date('2026-09-21T06:00:00.000Z'),
    lastRunAt: null,
    createdBy: 'user_1',
    createdByEmail: 'p@grid.test',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  }
}

beforeEach(() => {
  captured.length = 0
  driverRows = []
})

describe('jobs repository — tenant scoping', () => {
  it('scopes the project list to the project AND the organization, newest first, capped', async () => {
    driverRows = [jobRow()]
    const rows = await listJobsInProject(PROJECT, ORG)

    const { sql, params } = onlyQuery()
    expect(sql).toContain('from "jobs"')
    const predicate = where(sql)
    expect(predicate).toContain('"jobs"."project_id" =')
    expect(predicate).toContain('"jobs"."organization_id" =')
    expect(sql).toContain('order by "jobs"."created_at" desc')
    expect(params).toEqual([PROJECT, ORG, 100])
    expect(rows).toHaveLength(1)
  })

  it('scopes a single job lookup to the organization', async () => {
    driverRows = [jobRow()]
    await findJob(JOB, ORG)

    const { sql, params } = onlyQuery()
    const predicate = where(sql)
    expect(predicate).toContain('"jobs"."id" =')
    expect(predicate).toContain('"jobs"."organization_id" =')
    expect(params).toContain(JOB)
    expect(params).toContain(ORG)
  })

  it('loads by id WITHOUT a tenant filter for the scheduler fire path', async () => {
    driverRows = [jobRow()]
    await findJobById(JOB)

    const { sql, params } = onlyQuery()
    expect(where(sql)).toBe('"jobs"."id" = $1')
    expect(params[0]).toBe(JOB)
    expect(params.slice(1, -1)).toEqual([])
  })

  it('scopes updates and deletes to the organization', async () => {
    driverRows = [jobRow()]
    await updateJob(JOB, ORG, { enabled: false })

    const { sql, params } = onlyQuery()
    expect(sql).toContain('update "jobs"')
    const predicate = where(sql)
    expect(predicate).toContain('"jobs"."id" =')
    expect(predicate).toContain('"jobs"."organization_id" =')
    expect(params).toContain(false)
    expect(params).toContain(JOB)
    expect(params).toContain(ORG)

    captured.length = 0
    driverRows = [{ id: JOB }]
    expect(await deleteJob(JOB, ORG)).toBe(true)
    const deleted = onlyQuery()
    expect(deleted.sql).toContain('delete from "jobs"')
    expect(where(deleted.sql)).toContain('"jobs"."organization_id" =')
    expect(deleted.params).toEqual([JOB, ORG])
  })

  it('reports a missing row for a scoped update rather than throwing', async () => {
    await expect(updateJob(JOB, ORG, { enabled: false })).resolves.toBeNull()
  })

  it('advances last_run_at by id, with no tenant filter (the caller holds the row)', async () => {
    await touchJobLastRun(JOB, new Date('2026-09-14T08:00:00.000Z'))

    const { sql, params } = onlyQuery()
    expect(sql).toContain('update "jobs"')
    expect(sql).toContain('"last_run_at"')
    expect(where(sql)).toContain('"jobs"."id" =')
    expect(params).toContain(JOB)
  })
})

describe('job_runs repository — the attempt record', () => {
  it('inserts a run with the backend id, trigger, status and snapshot', async () => {
    driverRows = [
      {
        id: 'run_1',
        scheduleId: JOB,
        projectId: PROJECT,
        organizationId: ORG,
        jobId: 'backend-1',
        trigger: 'schedule',
        status: 'submitted',
        detail: null,
        conversationId: 's_conv_1',
        skillSnapshot: {},
        triggeredBy: 'scheduler',
        createdAt: new Date('2026-09-14T06:00:00.000Z'),
      },
    ]
    await insertJobRun({
      scheduleId: JOB,
      projectId: PROJECT,
      organizationId: ORG,
      jobId: 'backend-1',
      trigger: 'schedule',
      status: 'submitted',
      detail: null,
      conversationId: 's_conv_1',
      skillSnapshot: {} as import('@/lib/skills/types').SkillSnapshot,
      triggeredBy: 'scheduler',
    })

    const { sql, params } = onlyQuery()
    expect(sql).toContain('insert into "job_runs"')
    expect(sql).toContain('"job_id"')
    expect(sql).toContain('returning')
    expect(params).toContain('backend-1')
    expect(params).toContain('schedule')
    expect(params).toContain('submitted')
  })

  it('finds the run a backend job id belongs to, with no tenant filter', async () => {
    driverRows = [{ id: 'run_1', jobId: 'backend-1' }]
    await findJobRunByBackendJobId('backend-1')

    const { sql, params } = onlyQuery()
    expect(sql).toContain('from "job_runs"')
    expect(where(sql)).toBe('"job_runs"."job_id" = $1')
    expect(params[0]).toBe('backend-1')
  })

  it('pages run history under the parent AND org, newest first, hard cap 200', async () => {
    await listJobRuns(JOB, ORG, { limit: 9_999, offset: 7 })

    const { sql, params } = onlyQuery()
    expect(sql).toContain('from "job_runs"')
    const predicate = where(sql)
    expect(predicate).toContain('"job_runs"."schedule_id" =')
    expect(predicate).toContain('"job_runs"."organization_id" =')
    expect(sql).toContain('order by "job_runs"."created_at" desc')
    expect(sql).toContain('offset')
    expect(params).toContain(JOB)
    expect(params).toContain(ORG)
    expect(params).toContain(200)
    expect(params).toContain(7)
  })

  it('defaults the run-history page to fifty', async () => {
    await listJobRuns(JOB, ORG)
    expect(onlyQuery().params).toEqual([JOB, ORG, 50])
  })
})
