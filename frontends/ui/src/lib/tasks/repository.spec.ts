/**
 * @vitest-environment node
 */
/**
 * Characterization of the tasks repository BEFORE the task_definitions /
 * task_runs collapse moves it (slice 01 of the task-model follow-up, PR #659).
 *
 * The shipped statements, not chain spies: tenant scoping, the backend-id
 * lookup the worker reports through, and the bounded rejection history the
 * next run reads. These must pass unchanged through the additive slices.
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
  findTaskByBackendJobId,
  findTaskInProject,
  insertTask,
  listRejectedReviewsForJob,
  listTasksInProject,
  updateTask,
} from './repository'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const JOB = '22222222-2222-4222-8222-222222222222'
const TASK = '33333333-3333-4333-8333-333333333333'
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

beforeEach(() => {
  captured.length = 0
  driverRows = []
})

describe('tasks repository — tenant scoping', () => {
  it('inserts a task with its tenant, project and kind and returns the row', async () => {
    driverRows = [{ id: TASK, status: 'running' }]
    await insertTask({
      organizationId: ORG,
      projectId: PROJECT,
      kind: 'document',
      title: 'Dokument: Aktenvermerk',
      plan: { prompt: 'x', skill: {} as import('@/lib/skills/types').SkillSnapshot, dataSources: null },
      requesterUserId: 'user_1',
      status: 'queued',
    })

    const { sql, params } = onlyQuery()
    expect(sql).toContain('insert into "tasks"')
    expect(sql).toContain('returning')
    expect(params).toContain(ORG)
    expect(params).toContain(PROJECT)
    expect(params).toContain('document')
  })

  it('scopes a single task to id, project AND organization', async () => {
    await findTaskInProject(TASK, PROJECT, ORG)

    const { sql, params } = onlyQuery()
    expect(sql).toContain('from "tasks"')
    const predicate = where(sql)
    expect(predicate).toContain('"tasks"."id" =')
    expect(predicate).toContain('"tasks"."project_id" =')
    expect(predicate).toContain('"tasks"."organization_id" =')
    expect(params).toContain(TASK)
    expect(params).toContain(PROJECT)
    expect(params).toContain(ORG)
  })

  it('lists a project newest-first under the project AND org, capped at 100', async () => {
    await listTasksInProject(PROJECT, ORG)

    const { sql, params } = onlyQuery()
    expect(sql).toContain('from "tasks"')
    const predicate = where(sql)
    expect(predicate).toContain('"tasks"."project_id" =')
    expect(predicate).toContain('"tasks"."organization_id" =')
    expect(sql).toContain('order by "tasks"."created_at" desc')
    expect(params).toEqual([PROJECT, ORG, 100])
  })

  it('scopes updates to the organization and stamps updated_at', async () => {
    await updateTask(TASK, ORG, { status: 'succeeded' })

    const { sql, params } = onlyQuery()
    expect(sql).toContain('update "tasks"')
    expect(sql).toContain('"status"')
    expect(sql).toContain('"updated_at"')
    const predicate = where(sql)
    expect(predicate).toContain('"tasks"."id" =')
    expect(predicate).toContain('"tasks"."organization_id" =')
    expect(params).toContain('succeeded')
    expect(params).toContain(TASK)
    expect(params).toContain(ORG)
  })
})

describe('tasks repository — the worker lookup', () => {
  it('finds the task by backend job id with no tenant filter in the predicate', async () => {
    driverRows = [{ id: TASK }]
    await findTaskByBackendJobId('backend-9')

    const { sql, params } = onlyQuery()
    expect(sql).toContain('from "tasks"')
    expect(where(sql)).toBe('"tasks"."backend_job_id" = $1')
    expect(params[0]).toBe('backend-9')
  })
})

describe('tasks repository — rejection history for the next fire', () => {
  it('reads only rejected, reasoned reviews of the same job, newest first, three at most', async () => {
    await listRejectedReviewsForJob(JOB, ORG)

    const { sql, params } = onlyQuery()
    expect(sql).toContain('from "tasks"')
    const predicate = where(sql)
    expect(predicate).toContain('"tasks"."job_id" =')
    expect(predicate).toContain('"tasks"."organization_id" =')
    expect(predicate).toContain('"tasks"."review" =')
    expect(predicate).toContain('"tasks"."review_reason" is not null')
    expect(sql).toContain('order by "tasks"."reviewed_at" desc')
    expect(params).toContain(JOB)
    expect(params).toContain(ORG)
    expect(params).toContain('rejected')
    expect(params).toContain(3)
  })
})
