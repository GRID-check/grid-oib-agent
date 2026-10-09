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
import {
  countFeedbackVotes,
  getFeedbackExportTotals,
  getFeedbackFacets,
  getProjectNames,
  listFeedbackExportRows,
} from './export-repository'
import { NO_RATINGS_FILTERS, type FeedbackQuery, type RatingsFilters } from './filters'

const all: FeedbackQuery = {
  scope: { from: '2026-09-10', to: '2026-10-09', organizationIds: [], projectIds: [] },
  ratings: NO_RATINGS_FILTERS,
}
const PROJECT = '0b6f2a1e-5c3d-4e8f-9a7b-1c2d3e4f5a61'
const withRatings = (ratings: Partial<RatingsFilters>): FeedbackQuery => ({
  ...all,
  ratings: { ...NO_RATINGS_FILTERS, ...ratings },
})

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
    await listFeedbackExportRows(withRatings({ verdict: 'up' }), 10)

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
    const totals = await getFeedbackExportTotals({
      scope: { ...all.scope, organizationIds: ['org_9'] },
      ratings: { ...NO_RATINGS_FILTERS, topics: ['statik'] },
    })
    const { sql, params } = queryOf(execute)

    expect(totals).toEqual({ votes: 6, up: 3, down: 3, voters: 5, organizations: 2 })
    expect(params).toEqual(expect.arrayContaining(['org_9', 'statik']))
    // The question lateral's `limit 1` is per vote; the set itself has no bound.
    expect(sql).not.toMatch(/limit \$\d+/i)
  })
})

/**
 * Every filter is a WHERE clause in the one bounded statement, never a second
 * query per value and never a `.filter()` after the cap. One fragment
 * (`vote-scope.ts`) for the export, the page and the count, so these hold for
 * all of them.
 */
describe('the shared vote scope, per filter', () => {
  const sqlOf = async (query: FeedbackQuery) => {
    const execute = capture()
    await listFeedbackExportRows(query, 10)
    expect(execute).toHaveBeenCalledOnce()
    return queryOf(execute)
  }

  it('bounds the range as [from, to + 1 day), UTC', async () => {
    const { sql, params } = await sqlOf(all)
    expect(sql).toMatch(/f\.created_at >= \$\d+::timestamptz/)
    expect(sql).toMatch(/f\.created_at < \$\d+::timestamptz/)
    expect(params).toEqual(expect.arrayContaining(['2026-09-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z']))
  })

  it('narrows to organizations and projects as IN lists', async () => {
    const { sql, params } = await sqlOf({
      ...all,
      scope: { ...all.scope, organizationIds: ['org_a', 'org_b'], projectIds: [PROJECT] },
    })
    expect(sql).toMatch(/f\.organization_id in \(\$\d+, \$\d+\)/)
    expect(sql).toMatch(/coalesce\(f\.project_id, c\.project_id\) in \(\$\d+\)/)
    expect(params).toEqual(expect.arrayContaining(['org_a', 'org_b', PROJECT]))
  })

  it.each<[string, Partial<RatingsFilters>, RegExp, unknown[]]>([
    ['verdict', { verdict: 'up' }, /f\.verdict = \$\d+/, ['up']],
    [
      'reasons, which imply down-votes and count a chip-less one as other',
      { reasons: ['inaccurate', 'other'] },
      /f\.verdict = 'down' and coalesce\(f\.reason, 'other'\) in \(\$\d+, \$\d+\)/,
      ['inaccurate', 'other'],
    ],
    ['topics, any of them', { topics: ['brandschutz', 'statik'] }, /c\.tags && array\[\$\d+, \$\d+\]::text\[\]/, ['brandschutz', 'statik']],
    ['answer modes, report from the job id', { modes: ['report', 'deep'] }, /then 'report' else m\.metadata->'provenance'->>'routingDecision' end\) in \(/, ['deep', 'report']],
    ['confidence', { confidences: ['low'] }, /m\.metadata->'provenance'->>'answerConfidence'\) in \(\$\d+\)/, ['low']],
    ['a comment', { hasComment: true }, /nullif\(btrim\(f\.comment\), ''\) is not null/, []],
    ['an expected answer', { hasExpectedAnswer: true }, /nullif\(btrim\(f\.expected_answer\), ''\) is not null/, []],
  ])('%s', async (_name, ratings, pattern, values) => {
    const unfiltered = await sqlOf(all)
    const { sql, params } = await sqlOf(withRatings(ratings))
    expect(unfiltered.sql).not.toMatch(pattern)
    expect(sql).toMatch(pattern)
    expect(params).toEqual(expect.arrayContaining(values))
  })

  /** `100%` must find the text "100%", not everything starting with 100. */
  it('searches question and answer with LIKE metacharacters escaped', async () => {
    const { sql, params } = await sqlOf(withRatings({ query: 'WC_1 100%' }))
    expect(sql).toMatch(/m\.content ilike \$\d+ or q\.content ilike \$\d+/)
    expect(params).toContain('%WC\\_1 100\\%%')
  })
})

describe('countFeedbackVotes', () => {
  it('stops counting one past the cap, under the same scope', async () => {
    const execute = capture([{ votes: '5001' }])
    const counted = await countFeedbackVotes(withRatings({ topics: ['statik'] }), 5000)
    const { sql, params } = queryOf(execute)

    expect(counted).toBe(5001)
    expect(sql).toMatch(/select count\(\*\) as votes from \(\s*select 1/)
    expect(sql).toContain('c.tags && array[')
    expect(params).toContain(FEEDBACK_EXPORT_ROW_CAP + 1)
  })
})

describe('getFeedbackFacets', () => {
  it('counts every value over the scope only, zero-filled, in one statement', async () => {
    const execute = capture([
      { facet: 'verdict', key: 'up', votes: '12' },
      { facet: 'verdict', key: 'down', votes: '3' },
      { facet: 'reason', key: 'inaccurate', votes: '2' },
      { facet: 'topic', key: 'brandschutz', votes: '7' },
      { facet: 'topic', key: 'not_a_tag', votes: '1' },
      { facet: 'mode', key: 'deep', votes: '4' },
      { facet: 'confidence', key: 'high', votes: '9' },
      { facet: 'flag', key: 'has_comment', votes: '2' },
      { facet: 'flag', key: 'has_expected', votes: '1' },
    ])
    const facets = await getFeedbackFacets({
      scope: { ...all.scope, organizationIds: ['org_a'] },
      ratings: { ...NO_RATINGS_FILTERS, reasons: ['other'], hasComment: true },
    })
    const { sql, params } = queryOf(execute)

    expect(execute).toHaveBeenCalledOnce()
    // The scope narrows the counts; the ratings filters do not.
    expect(params).toContain('org_a')
    expect(sql).not.toContain("coalesce(f.reason, 'other') in")
    // Selected once as a column; never applied as a condition.
    expect(sql.match(/btrim\(f\.comment\)/g)).toHaveLength(1)
    expect(sql.match(/union all/g)?.length).toBe(6)
    expect(facets.verdicts).toEqual({ up: 12, down: 3 })
    expect(facets.reasons).toEqual([
      { key: 'inaccurate', votes: 2 },
      { key: 'wrong_source', votes: 0 },
      { key: 'too_slow', votes: 0 },
      { key: 'other', votes: 0 },
    ])
    expect(facets.topics).toEqual([{ key: 'brandschutz', votes: 7 }])
    expect(facets.modes.find((entry) => entry.key === 'deep')?.votes).toBe(4)
    expect(facets.confidences.find((entry) => entry.key === 'high')?.votes).toBe(9)
    expect(facets).toMatchObject({ withComment: 2, withExpectedAnswer: 1 })
  })
})

describe('getProjectNames', () => {
  it('reads only the ids it is given, and nothing for none', async () => {
    const execute = capture([{ id: PROJECT, name: 'Stadthaus' }])
    expect(await getProjectNames([])).toEqual(new Map())
    expect(execute).not.toHaveBeenCalled()

    const names = await getProjectNames([PROJECT])
    expect(names.get(PROJECT)).toBe('Stadthaus')
    expect(queryOf(execute).params).toEqual([PROJECT, 1])
  })
})
