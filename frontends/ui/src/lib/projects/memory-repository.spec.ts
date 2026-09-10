/**
 * @vitest-environment node
 *
 * The scope rule of the memory store, asserted where it is written.
 *
 * ADR-0055 gave that rule a second caller (`search_memory` beside the digest),
 * and a scope rule with two implementations is a scope rule that leaks in one
 * of them. These cases pin the condition itself: with a project the read
 * reaches that project plus the organization, without one it reaches
 * organization-scoped notes ONLY, and the project branch is always pinned to
 * the organization when the caller knows it — so a project id from another
 * tenant matches nothing rather than matching its own row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))

// Plain descriptor objects instead of drizzle operators, so a case can assert
// on the exact condition tree the repository builds without a database.
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  or: (...conditions: unknown[]) => ({ op: 'or', conditions }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  inArray: (col: unknown, values: unknown) => ({ op: 'inArray', col, values }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      op: 'sql',
      strings: Array.from(strings),
      values,
    }),
    {}
  ),
}))

vi.mock('@/lib/db/schema', () => ({
  projectMemory: {
    id: 'pm.id',
    scope: 'pm.scope',
    projectId: 'pm.projectId',
    organizationId: 'pm.organizationId',
    kind: 'pm.kind',
    content: 'pm.content',
    status: 'pm.status',
    confidence: 'pm.confidence',
    verification: 'pm.verification',
    pinned: 'pm.pinned',
    salience: 'pm.salience',
    lastReferencedAt: 'pm.lastReferencedAt',
    recallCount: 'pm.recallCount',
    supersedesId: 'pm.supersedesId',
    updatedAt: 'pm.updatedAt',
    embedding: 'pm.embedding',
    embeddingModel: 'pm.embeddingModel',
  },
}))

import { getDb } from '@/lib/db'
import { asDb } from '@/test-utils/db-fixtures'
import {
  RECALL_CANDIDATE_LIMIT,
  memoryScopeCondition,
  selectRecallCandidates,
  selectSupersessionLinks,
} from './memory-repository'

const eq = (col: unknown, val: unknown) => ({ op: 'eq', col, val })
const and = (...conditions: unknown[]) => ({ op: 'and', conditions })
const or = (...conditions: unknown[]) => ({ op: 'or', conditions })
const isNull = (col: unknown) => ({ op: 'isNull', col })

const projectBranch = (projectId: string, organizationId?: string) =>
  organizationId
    ? and(eq('pm.projectId', projectId), eq('pm.organizationId', organizationId))
    : eq('pm.projectId', projectId)

const orgBranch = (organizationId: string) =>
  and(
    eq('pm.scope', 'organization'),
    eq('pm.organizationId', organizationId),
    isNull('pm.projectId')
  )

const mockSelectChain = (rows: unknown[]) => {
  const limit = vi.fn().mockResolvedValue(rows)
  const orderBy = vi.fn().mockReturnValue({ limit })
  const where = vi.fn().mockReturnValue({ orderBy, limit })
  const from = vi.fn().mockReturnValue({ where })
  vi.mocked(getDb).mockReturnValue(asDb({ select: vi.fn().mockReturnValue({ from }) }))
  return { where, orderBy, limit }
}

beforeEach(() => {
  vi.mocked(getDb).mockReset()
})

describe('memoryScopeCondition — the rule both readers share', () => {
  it('reaches the project AND the organization when a project is named', () => {
    expect(memoryScopeCondition({ projectId: 'proj-1', organizationId: 'org-1' })).toEqual(
      or(projectBranch('proj-1', 'org-1'), orgBranch('org-1'))
    )
  })

  it('reaches ORGANIZATION-scoped notes only when no project is named', () => {
    const condition = memoryScopeCondition({ organizationId: 'org-1' })

    expect(condition).toEqual(orgBranch('org-1'))
    // The whole point, stated as an assertion rather than as a shape: the only
    // thing this condition says about `project_id` is that it must be NULL, so
    // no row belonging to any project can match it.
    expect(JSON.stringify(condition)).toContain('{"op":"isNull","col":"pm.projectId"}')
    expect(JSON.stringify(condition)).not.toContain('"col":"pm.projectId","val"')
  })

  it('pins the project branch to the organization, so a foreign project matches nothing', () => {
    const condition = memoryScopeCondition({ projectId: 'proj-of-another-tenant' })

    // Anonymous mode (no organization known) is the only case where the project
    // branch stands alone — every tenant-aware caller supplies the org, and the
    // branch is then an AND of both.
    expect(condition).toEqual(eq('pm.projectId', 'proj-of-another-tenant'))
    expect(memoryScopeCondition({ projectId: 'proj-1', organizationId: 'org-1' })).toEqual(
      or(and(eq('pm.projectId', 'proj-1'), eq('pm.organizationId', 'org-1')), orgBranch('org-1'))
    )
  })

  it('is undefined when the caller named neither — an unbounded read, not a scope', () => {
    expect(memoryScopeCondition({})).toBeUndefined()
  })
})

describe('selectRecallCandidates', () => {
  it('reads nothing at all without a scope', async () => {
    const result = await selectRecallCandidates({})

    expect(result).toEqual({ rows: [], total: 0 })
    expect(getDb).not.toHaveBeenCalled()
  })

  it('filters to active notes in scope and bounds the candidate window', async () => {
    const { where, limit } = mockSelectChain([])

    await selectRecallCandidates({ projectId: 'proj-1', organizationId: 'org-1' })

    expect(where).toHaveBeenCalledWith(
      and(or(projectBranch('proj-1', 'org-1'), orgBranch('org-1')), eq('pm.status', 'active'))
    )
    expect(limit).toHaveBeenCalledWith(RECALL_CANDIDATE_LIMIT)
  })

  it('reports the in-scope count the window function returned, not the page size', async () => {
    mockSelectChain([
      {
        id: 'a',
        scope: 'project',
        kind: 'decision',
        content: 'x',
        confidence: 'medium',
        verification: 'unverified',
        pinned: false,
        salience: 0.5,
        lastReferencedAt: null,
        recallCount: 0,
        updatedAt: new Date('2026-09-01T00:00:00Z'),
        relevance: null,
        embeddingModel: null,
        total: 412,
      },
    ])

    const { rows, total } = await selectRecallCandidates({ organizationId: 'org-1' })

    expect(rows).toHaveLength(1)
    expect(total).toBe(412)
  })

  it('ignores a vector written by a different embedder', async () => {
    mockSelectChain([
      {
        id: 'a',
        scope: 'organization',
        kind: 'preference',
        content: 'x',
        confidence: 'medium',
        verification: 'unverified',
        pinned: false,
        salience: 0.5,
        lastReferencedAt: null,
        recallCount: 0,
        updatedAt: new Date('2026-09-01T00:00:00Z'),
        relevance: 0.99,
        embeddingModel: 'some-older-model',
        total: 1,
      },
    ])

    const { rows } = await selectRecallCandidates(
      { organizationId: 'org-1' },
      { queryVector: [0.1, 0.2], fingerprint: 'current-model' }
    )

    // A same-size vector from another embedder is noise wearing the right
    // shape — the row falls back to the lexical channel rather than scoring 0.99.
    expect(rows[0].relevance).toBeNull()
    expect(rows[0].embeddedByCurrentModel).toBe(false)
  })
})

describe('selectSupersessionLinks', () => {
  it('asks nothing when there are no rows', async () => {
    const links = await selectSupersessionLinks([])

    expect(links.targets.size).toBe(0)
    expect(links.replacements.size).toBe(0)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('reports only ACTIVE replacements, so a restored note is not shown as retired', async () => {
    // The replacement lookup filters on status in SQL; this asserts the
    // condition, which is what makes a restore reversible: after one, the
    // replacement is itself retired and its supersedes_id is history.
    const { where } = mockSelectChain([])

    await selectSupersessionLinks([{ id: 'a', supersedesId: null }])

    expect(where).toHaveBeenCalledWith(
      and({ op: 'inArray', col: 'pm.supersedesId', values: ['a'] }, eq('pm.status', 'active'))
    )
  })
})
