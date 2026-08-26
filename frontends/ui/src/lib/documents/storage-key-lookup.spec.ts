/**
 * @vitest-environment node
 */
/**
 * The second path by which a document's bytes reach the agent tier.
 *
 * `dispatchDocument` closes the chunk path: a machine-authored row is never
 * indexed, so retrieval cannot surface it. That is only half of what the design
 * claims. `findStorageKeyByCollectionAndFilename` resolves any
 * `(collection, filename)` pair for the service-token internal route, and
 * `view_knowledge_image` in the knowledge layer calls that route with a file
 * name and collection the MODEL supplies — then renders the object with pdfium
 * and hands it back as "the actual page the retrieved chunk describes".
 *
 * Filing the report as a PDF is what made it reachable: a `.docx` was excluded
 * by extension and unrenderable by pdfium. And `generatedFilename` is
 * deterministic from the report's H1, which the writer agent wrote — so the
 * model does not guess the name of its own report, it derives it.
 *
 * These tests exist so that stays shut. The first asserts the predicate is in
 * the QUERY: filtering after the fact still resolves the row, and the point is
 * that a machine-authored row never becomes a storage key at all.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const whereArg = vi.fn()

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          whereArg(condition)
          return { orderBy: () => ({ limit: () => Promise.resolve([]) }) }
        },
      }),
    }),
  }),
}))

vi.mock('@/lib/db/tenant-context', () => ({
  withOptionalTenant: (_org: string | undefined, _why: string, fn: () => unknown) => fn(),
  withTenant: (_scope: unknown, fn: () => unknown) => fn(),
}))

import { findStorageKeyByCollectionAndFilename } from './repository'

/**
 * Column names named by a drizzle condition tree.
 *
 * `JSON.stringify` cannot be used: a `PgColumn` holds a reference back to its
 * `PgTable`, so the condition is circular. This walks it with a seen-set and
 * collects the `name` of anything that carries one, which is enough to answer
 * the only question these tests ask — which columns the WHERE mentions.
 */
const columnsIn = (node: unknown, seen = new Set<unknown>()): string[] => {
  if (node === null || typeof node !== 'object' || seen.has(node)) return []
  seen.add(node)
  const here = 'name' in node && typeof (node as { name: unknown }).name === 'string'
    ? [(node as { name: string }).name]
    : []
  return [...here, ...Object.values(node).flatMap((child) => columnsIn(child, seen))]
}

describe('findStorageKeyByCollectionAndFilename', () => {
  beforeEach(() => whereArg.mockReset())

  it('puts the authorship predicate in the query, not in a later filter', async () => {
    await findStorageKeyByCollectionAndFilename('proj_abc', 'brandschutz-2026-08-20.pdf')

    expect(whereArg).toHaveBeenCalledTimes(1)
    const columns = columnsIn(whereArg.mock.calls[0][0])
    expect(columns).toContain('authored_by')
    // Alongside the predicates that were always there, so this test fails if the
    // where clause is rebuilt and the new one is quietly dropped.
    expect(columns).toContain('collection_name')
    expect(columns).toContain('deleted_at')
  })

  it('still narrows by organization when the caller can supply one', async () => {
    await findStorageKeyByCollectionAndFilename('archiv_org-1', 'plan.pdf', 'org-1')

    const columns = columnsIn(whereArg.mock.calls[0][0])
    expect(columns).toContain('organization_id')
    expect(columns).toContain('authored_by')
  })

  it("names 'user' rather than excluding one producer by name", () => {
    // An allow-list, not a deny-list. `authored_by <> 'agent'` would admit every
    // author kind added to the tuple after it — `system`, `import` — which is
    // the failure mode the schema's own CHECK constraint was written to avoid.
    const source = readFileSync(
      new URL('./repository.ts', import.meta.url),
      'utf8',
    )
    const fn = source.slice(source.indexOf('export async function findStorageKeyByCollectionAndFilename'))
    // Comments stripped first: this file argues about `authored_by` at length
    // in prose, and a test that cannot tell a statement from a sentence would
    // pass on the documentation alone.
    const body = fn
      .slice(0, fn.indexOf('\n}'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(body).toMatch(/eq\(documents\.authoredBy,\s*'user'\)/)
    expect(body).not.toMatch(/ne\(documents\.authoredBy/)
  })
})
