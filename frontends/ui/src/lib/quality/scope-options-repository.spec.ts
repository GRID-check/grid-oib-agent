/**
 * @vitest-environment node
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))

import { getDb } from '@/lib/db'
import {
  listActiveOrganizationIds,
  listScopeProjects,
  SCOPE_ORGANIZATION_LIMIT,
  SCOPE_PROJECT_LIMIT,
} from './scope-options-repository'

const capture = (...results: unknown[][]) => {
  const execute = vi.fn()
  for (const rows of results) execute.mockResolvedValueOnce(rows)
  vi.mocked(getDb).mockReturnValue({ execute } as never)
  return execute
}
const queryOf = (execute: ReturnType<typeof capture>, call = 0) =>
  new PgDialect().sqlToQuery(execute.mock.calls[call][0])

const START = new Date('2026-10-01T00:00:00.000Z')
const END = new Date('2026-10-08T00:00:00.000Z')

beforeEach(() => vi.clearAllMocks())

describe('listActiveOrganizationIds', () => {
  it('unions the three quality tables in the range, bounded, busiest first', async () => {
    const execute = capture([{ organization_id: 'org_a' }, { organization_id: 'org_b' }])
    const result = await listActiveOrganizationIds(START, END)
    const { sql, params } = queryOf(execute)

    for (const table of ['answer_feedback', 'citation_events', 'agent_profiler_spans']) expect(sql).toContain(`from ${table}`)
    expect(sql).toContain('order by activity desc')
    expect(params).toEqual(expect.arrayContaining([START.toISOString(), END.toISOString(), SCOPE_ORGANIZATION_LIMIT + 1]))
    expect(result).toEqual({ ids: ['org_a', 'org_b'], truncated: false })
  })

  it('says when the list was cut', async () => {
    capture([{ organization_id: 'a' }, { organization_id: 'b' }, { organization_id: 'c' }])
    expect(await listActiveOrganizationIds(START, END, 2)).toEqual({ ids: ['a', 'b'], truncated: true })
  })
})

describe('listScopeProjects', () => {
  it('lists nothing and reads nothing without an organization or a project', async () => {
    const execute = capture()
    expect(await listScopeProjects([], [])).toEqual({ projects: [], truncated: false })
    expect(execute).not.toHaveBeenCalled()
  })

  it('lists the chosen organizations’ live projects, bounded, and names a chosen project once', async () => {
    const execute = capture(
      [{ id: 'p1', name: 'Stadthaus', organization_id: 'org_a' }],
      [
        { id: 'p1', name: 'Stadthaus', organization_id: 'org_a' },
        { id: 'p9', name: 'Gelöscht', organization_id: 'org_a' },
      ]
    )
    const result = await listScopeProjects(['org_a'], ['p1', 'p9'])
    const listed = queryOf(execute, 0)

    expect(listed.sql).toContain('deleted_at is null')
    expect(listed.params).toEqual(['org_a', SCOPE_PROJECT_LIMIT + 1])
    expect(result.projects.map((project) => project.id)).toEqual(['p1', 'p9'])
  })
})
