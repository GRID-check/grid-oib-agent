/**
 * @vitest-environment node
 *
 * The SQL's shape only; what Postgres does with it is proven in
 * `repository.integration.spec.ts`.
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))

import { getDb } from '@/lib/db'
import { FEEDBACK_EXPORT_ROW_CAP } from './repository'
import { getFeedbackExportTotals, listFeedbackExportRows, type FeedbackExportFilters } from './export-repository'

const all: FeedbackExportFilters = {
  windowDays: 30,
  verdict: null,
  reason: null,
  organizationId: null,
  topic: null,
  query: null,
}

const capture = (rows: unknown[] = []) => {
  const execute = vi.fn().mockResolvedValue(rows)
  vi.mocked(getDb).mockReturnValue({ execute } as never)
  return execute
}
const queryOf = (execute: ReturnType<typeof capture>, call = 0) =>
  new PgDialect().sqlToQuery(execute.mock.calls[call][0])

beforeEach(() => vi.clearAllMocks())

describe('listFeedbackExportRows', () => {
  it('never reads more than one row past the export cap', async () => {
    const execute = capture()
    await listFeedbackExportRows(all, 1_000_000)
    expect(queryOf(execute).params).toContain(FEEDBACK_EXPORT_ROW_CAP + 1)
  })

  it('reads both verdicts unless a selection names one', async () => {
    const execute = capture()
    await listFeedbackExportRows(all, 10)
    await listFeedbackExportRows({ ...all, verdict: 'up' }, 10)

    expect(queryOf(execute, 0).sql).not.toContain('f.verdict = $')
    expect(queryOf(execute, 1).sql).toContain('f.verdict = $')
    expect(queryOf(execute, 1).params).toContain('up')
  })

  /** The voter is a pseudonym computed in SQL: the user id never reaches the application. */
  it('hashes the voter in SQL and never selects the user id itself', async () => {
    const execute = capture()
    await listFeedbackExportRows(all, 10)
    const { sql } = queryOf(execute)

    expect(sql).toContain("sha256(convert_to(f.organization_id || ':' || f.user_id, 'UTF8'))")
    expect(sql.replace(/sha256\([^)]*\)/, '')).not.toMatch(/f\.user_id/)
  })

  it('pins every join to the voter’s organization', async () => {
    const execute = capture()
    await listFeedbackExportRows(all, 10)
    const { sql } = queryOf(execute)

    expect(sql).toContain('m.organization_id = f.organization_id')
    expect(sql).toContain('c.organization_id = f.organization_id')
    expect(sql).toContain('p.organization_id = sel.organization_id')
    expect(sql).toContain('tr.organization_id = m.organization_id')
    expect(sql).toMatch(/u\.organization_id = s\.organization_id[\s\S]*u\.organization_id = s\.organization_id/)
  })

  it('aggregates cost over the selected set, not per row', async () => {
    const execute = capture()
    await listFeedbackExportRows(all, 10)
    const { sql } = queryOf(execute)

    expect(sql).toContain('union all')
    expect(sql).toContain('group by id')
  })

  it('coerces the raw row — `sql` results are not runtime-validated', async () => {
    capture([
      {
        id: 'fb_1',
        organization_id: 'org_1',
        message_id: 'm_1',
        verdict: 'down',
        reason: null,
        comment: '  ',
        expected_answer: null,
        created_at: '2026-10-06T08:15:00.000Z',
        updated_at: '2026-10-06T08:17:30.000Z',
        lessons_holdout: null,
        voter_key: 'a1b2c3d4e5f6',
        conversation_id: 's_1',
        conversation_found: true,
        conversation_title: 'T',
        topics: ['brandschutz', 'not_a_tag'],
        project_id: null,
        answer: 'A',
        answered_at: '2026-10-06T08:14:10.000Z',
        question: 'Q',
        trace_id: 'not-a-trace',
        provenance: { routingDecision: 'shallow', answerConfidence: 'bogus', skillsActivated: ['s'] },
        sources_cited: '3',
        job_id: null,
        project_name: null,
        bundesland: null,
        llm_calls: '0',
        models: null,
        tokens_total: null,
        cost_usd: null,
        lesson_id: null,
        lesson_outcome: 'skipped',
        lesson_status: null,
      },
    ])
    const [row] = await listFeedbackExportRows(all, 10)

    expect(row).toMatchObject({
      reason: 'other',
      comment: null,
      topics: ['brandschutz'],
      answerMode: 'shallow',
      answerConfidence: null,
      sourcesCited: 3,
      traceId: null,
      llmCalls: null,
      costUsd: null,
      lessonStatus: 'skipped',
      skills: ['s'],
    })
    expect(row.firstVotedAt).toBeInstanceOf(Date)
    expect(row.answeredAt).toBeInstanceOf(Date)
  })
})

describe('getFeedbackExportTotals', () => {
  it('counts over the same scope as the rows, uncapped', async () => {
    const execute = capture([{ votes: '6', up: '3', down: '3', voters: '5', organizations: '2' }])
    const totals = await getFeedbackExportTotals({ ...all, organizationId: 'org_9', topic: 'statik' })
    const { sql, params } = queryOf(execute)

    expect(totals).toEqual({ votes: 6, up: 3, down: 3, voters: 5, organizations: 2 })
    expect(params).toEqual(expect.arrayContaining(['org_9', 'statik']))
    // The question lateral's `limit 1` is per vote; the set itself has no bound.
    expect(sql).not.toMatch(/limit \$\d+/i)
  })
})
