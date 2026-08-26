/**
 * @vitest-environment node
 */
/**
 * The project overview must ask for project documents.
 *
 * Both of its document queries filtered on `project_id` and `organization_id`
 * alone, which reads as "documents of this project" only because of an accident
 * of the data: the other two shelves — the org-wide Archiv and, since ADR-0047
 * Phase 2, a chat attachment — both carry a NULL `project_id`, and NULL never
 * satisfies an equality. So nothing leaks today, and this spec is not about a
 * leak. It is about which question the query asks: `listProjectDocuments` and
 * `countDocumentsByProject` state `scope = 'project'` (lib/documents/repository),
 * and the overview must state it too, or the page's count and the page's list
 * agree with the document list only by coincidence.
 *
 * A coincidence is what ends silently. One row that ever carries both a project
 * and a non-project scope — a backfill, an import, a "promote this attachment"
 * feature — and the overview starts counting private chat attachments into a
 * project's totals without anything failing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))

import { getDb } from '@/lib/db'
import { getProjectOverviewData } from './overview-query'

const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const ORG_ID = 'org_1'

const projectRow = {
  id: PROJECT_ID,
  name: 'Haus am See',
  collectionName: `proj_${PROJECT_ID}`,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  profile: null,
  profileDisplay: null,
}

/** Every `where(...)` the function built, in the order it built them. */
let predicates: SQL[] = []

/**
 * A drizzle stand-in that records predicates and answers each awaited query
 * with the next prepared result set.
 *
 * Recording the predicate rather than stubbing rows is deliberate: a fake that
 * returned rows would pass for a query with no scope filter at all, since the
 * fake is the one deciding what comes back. The WHERE clause is the whole
 * assertion.
 */
function recordingDb(results: unknown[][]) {
  let next = 0
  const chain: Record<string, unknown> = {
    select: () => chain,
    from: () => chain,
    where: (condition: SQL) => {
      predicates.push(condition)
      return chain
    },
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(results[next++] ?? []).then(resolve, reject),
  }
  return chain as unknown as ReturnType<typeof getDb>
}

const dialect = new PgDialect()

function compile(predicate: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(predicate)
  return { sql: query.sql, params: query.params }
}

describe('getProjectOverviewData', () => {
  beforeEach(() => {
    predicates = []
    vi.mocked(getDb).mockReturnValue(
      recordingDb([[projectRow], [{ count: 0, totalSize: '0' }], []])
    )
  })

  it('counts only documents on the project shelf', async () => {
    await getProjectOverviewData(PROJECT_ID, ORG_ID)

    // [0] is the projects lookup; [1] is the document count.
    const stats = compile(predicates[1])
    expect(stats.sql).toContain('"scope"')
    expect(stats.params).toEqual([PROJECT_ID, ORG_ID, 'project'])
  })

  it('lists only documents on the project shelf', async () => {
    await getProjectOverviewData(PROJECT_ID, ORG_ID)

    const recent = compile(predicates[2])
    expect(recent.sql).toContain('"scope"')
    expect(recent.params).toEqual([PROJECT_ID, ORG_ID, 'project'])
  })

  it('asks the count and the list the same question', async () => {
    // A page whose "3 documents" and whose list of documents could disagree is
    // worse than either being wrong on its own.
    await getProjectOverviewData(PROJECT_ID, ORG_ID)

    expect(compile(predicates[1])).toEqual(compile(predicates[2]))
  })

  it('still scopes both queries to the project and the organization', async () => {
    // The shelf predicate is an ADDITION. A version of this that replaced the
    // tenant check with it would be a cross-tenant read.
    await getProjectOverviewData(PROJECT_ID, ORG_ID)

    for (const predicate of [predicates[1], predicates[2]]) {
      const { sql, params } = compile(predicate)
      expect(sql).toContain('"project_id"')
      expect(sql).toContain('"organization_id"')
      expect(params).toContain(ORG_ID)
    }
  })
})
