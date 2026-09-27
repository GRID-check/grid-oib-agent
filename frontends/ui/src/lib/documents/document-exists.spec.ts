/**
 * @vitest-environment node
 */
/**
 * `documentExistsInCollection` answers the ingest pipeline's one question:
 * is the document this ingest was dispatched for still there? A "no" makes the
 * pipeline discard what it just indexed, so the predicate must not be narrower
 * than the set of rows that are really indexed. The presign lookup beside it
 * filters on `authored_by = 'user'`; this one must not, because a published
 * machine-authored version is ingested too (ADR-0054).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Which columns the WHERE compares, recorded at `eq` itself: a drizzle
// condition tree reaches every column of the table through each column's
// back-reference, so walking it cannot show that a predicate is absent.
const compared = vi.hoisted(() => [] as string[])
let rows: unknown[] = []

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>()
  return {
    ...actual,
    eq: (column: { name: string }, value: unknown) => {
      compared.push(column.name)
      return actual.eq(column as never, value)
    },
  }
})

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(rows) }),
      }),
    }),
  }),
}))

vi.mock('@/lib/db/tenant-context', () => ({
  withOptionalTenant: (_org: string | undefined, _why: string, fn: () => unknown) => fn(),
  withTenant: (_scope: unknown, fn: () => unknown) => fn(),
}))

import { documentExistsInCollection } from './repository'

const DOC_ID = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'

describe('documentExistsInCollection', () => {
  beforeEach(() => {
    compared.length = 0
    rows = []
  })

  it('answers from whether a row matched', async () => {
    expect(await documentExistsInCollection(DOC_ID, 'proj_1')).toBe(false)
    rows = [{ id: DOC_ID }]
    expect(await documentExistsInCollection(DOC_ID, 'proj_1')).toBe(true)
  })

  it('addresses the row by id and collection, and by nothing about its author', async () => {
    await documentExistsInCollection(DOC_ID, 'proj_1')
    expect(compared).toEqual(['id', 'collection_name'])
  })

  it('narrows by organization when the caller supplies one', async () => {
    await documentExistsInCollection(DOC_ID, 'archiv_org-1', 'org-1')
    expect(compared).toEqual(['id', 'collection_name', 'organization_id'])
  })
})
