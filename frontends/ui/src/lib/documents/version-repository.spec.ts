/**
 * @vitest-environment node
 */
/**
 * `findPreviousVersion` — the diff base for a review round.
 *
 * The predecessor is found by a statement, not by scanning a page in memory:
 * past 200 versions a page no longer contains the predecessor, and a scan would
 * name the highest row inside the window as the diff base. These tests pin the
 * statement: a direct `version_number < $n ORDER BY version_number DESC LIMIT 1`
 * inside the tenant boundary, so Postgres answers the predecessor no matter how
 * long the history is.
 *
 * Same pg-proxy harness as `lib/inbox/repository.spec.ts`: a real query
 * builder over a callback driver that records the SQL instead of connecting.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pg-proxy'

interface CapturedQuery {
  sql: string
  params: unknown[]
}

const captured: CapturedQuery[] = []
/** Row pages the proxy answers with, in order (pg-proxy rows are value arrays). */
const pages: unknown[][][] = []

const proxyDb = drizzle(async (sql, params) => {
  captured.push({ sql, params })
  return { rows: pages.shift() ?? [] }
})

/**
 * The handle `getDb()` returns. The pg-proxy driver refuses transactions, so a
 * test about one swaps in a drizzle-SHAPED fake (below) for its duration.
 */
let currentDb: unknown = proxyDb
vi.mock('@/lib/db', () => ({ getDb: () => currentDb }))

import { TransactionRollbackError, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  findPreviousVersion,
  listDocumentVersionObjects,
  swapVersionContent,
  insertDocumentVersion,
  insertPublishedVersion,
  promoteVersionToPublished,
} from './version-repository'

function onlyQuery(): CapturedQuery {
  expect(captured).toHaveLength(1)
  return captured[0]
}

beforeEach(() => {
  captured.length = 0
  pages.length = 0
  currentDb = proxyDb
})

/**
 * A transaction handle that behaves the way drizzle 0.45 on postgres-js does
 * where it matters: `db.transaction` re-throws whatever its callback throws,
 * and `tx.rollback()` THROWS `TransactionRollbackError` rather than returning.
 * Each `update(...).returning()` answers the next queued row list.
 */
function fakeTransactionalDb(updateResults: unknown[][], highest: number | string | null = null) {
  const statements: string[] = []
  const inserted: Array<Record<string, unknown>> = []
  const tx = {
    rollback: () => {
      throw new TransactionRollbackError()
    },
    execute: async (query: { queryChunks?: unknown[] }) => {
      statements.push(`EXECUTE ${JSON.stringify(query.queryChunks ?? query)}`)
      return []
    },
    select: () => ({
      from: () => ({
        where: async () => {
          statements.push('SELECT max')
          return [{ highest }]
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          statements.push('INSERT')
          inserted.push(values)
          return [{ id: 'ver_new', ...values }]
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => {
          const result = updateResults.shift() ?? []
          statements.push('UPDATE')
          const settled = Promise.resolve(result)
          return Object.assign(settled, { returning: async () => result })
        },
      }),
    }),
  }
  return {
    statements,
    inserted,
    db: { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
  }
}

const NEW_VERSION = {
  organizationId: 'org_1',
  documentId: 'doc_1',
  projectId: 'proj_1',
  state: 'published' as const,
  storageKey: 'org/org_1/project/proj_1/doc/doc_1/v3/a1b2c3d4e5f6/plan.pdf',
  createdBy: 'user_1',
  approvedBy: 'user_1',
  approvedAt: new Date(),
}

/**
 * The version number, allocated inside the inserting transaction. `max + 1`
 * read in one statement and inserted in another let two
 * overlapping re-uploads both record „Version N"; the per-document lock makes
 * the read and the insert one step for every writer of that document.
 */
describe('the version number is allocated under a per-document lock', () => {
  it('locks, reads the highest number, then inserts — in one transaction (plain insert)', async () => {
    const fake = fakeTransactionalDb([], '2')
    currentDb = fake.db

    await insertDocumentVersion({ ...NEW_VERSION, state: 'draft' })

    expect(fake.statements).toHaveLength(3)
    expect(fake.statements[0]).toContain('pg_advisory_xact_lock')
    expect(fake.statements[0]).toContain('document_versions:doc_1')
    expect(fake.statements[1]).toBe('SELECT max')
    expect(fake.statements[2]).toBe('INSERT')
    // Coerced: the driver may answer `max()` as a string, and '2' + 1 is '21'.
    expect(fake.inserted[0].versionNumber).toBe(3)
  })

  it('takes the lock BEFORE the supersede on a born-published insert', async () => {
    // supersede → the old published row; pointer move → nothing to return.
    const fake = fakeTransactionalDb([[{ id: 'ver_old' }], []], 4)
    currentDb = fake.db

    const outcome = await insertPublishedVersion(NEW_VERSION)

    expect(fake.statements[0]).toContain('pg_advisory_xact_lock')
    expect(fake.statements[1]).toBe('SELECT max')
    expect(fake.statements.slice(2)).toEqual(['UPDATE', 'INSERT', 'UPDATE'])
    expect(outcome.version.versionNumber).toBe(5)
    expect(outcome.superseded).toEqual([{ id: 'ver_old' }])
  })

  it('numbers the first version of a document 1', async () => {
    const fake = fakeTransactionalDb([], null)
    currentDb = fake.db
    await insertDocumentVersion({ ...NEW_VERSION, state: 'draft' })
    expect(fake.inserted[0].versionNumber).toBe(1)
  })

  it('does not share its lock key with the storage quota', async () => {
    const fake = fakeTransactionalDb([], null)
    currentDb = fake.db
    await insertDocumentVersion({ ...NEW_VERSION, state: 'draft' })
    expect(fake.statements[0]).not.toContain('storage_quota:')
  })
})

describe('promoteVersionToPublished — the loser of a publish race', () => {
  it('reports a lost compare-and-swap as null (the 409), not as a thrown rollback (a 500)', async () => {
    // supersede → one row; the swap → nothing matched.
    const fake = fakeTransactionalDb([[{ id: 'ver_old' }], []])
    currentDb = fake.db

    await expect(
      promoteVersionToPublished('ver_new', 'doc_1', 'org_1', 'approved', {}),
    ).resolves.toBeNull()
    // The pointer move never ran: the transaction was abandoned at the swap.
    expect(fake.statements).toEqual(['UPDATE', 'UPDATE'])
  })

  it('still returns the published version and the superseded one when it wins', async () => {
    const fake = fakeTransactionalDb([[{ id: 'ver_old' }], [{ id: 'ver_new' }], []])
    currentDb = fake.db

    await expect(
      promoteVersionToPublished('ver_new', 'doc_1', 'org_1', 'approved', {}),
    ).resolves.toEqual({ version: { id: 'ver_new' }, superseded: [{ id: 'ver_old' }] })
    expect(fake.statements).toEqual(['UPDATE', 'UPDATE', 'UPDATE'])
  })

  it('lets a real database failure through rather than calling it a lost race', async () => {
    currentDb = {
      transaction: async () => {
        throw new Error('connection reset')
      },
    }
    await expect(
      promoteVersionToPublished('ver_new', 'doc_1', 'org_1', 'approved', {}),
    ).rejects.toThrow('connection reset')
  })
})

describe('findPreviousVersion — the diff base', () => {
  it('asks for the highest version below the given number, newest first, one row', async () => {
    const result = await findPreviousVersion('doc_1', 'org_1', 201)

    expect(result).toBeNull()
    const { sql, params } = onlyQuery()
    expect(sql).toMatch(/"version_number" </)
    expect(sql.toLowerCase()).toContain('order by')
    expect(sql.toLowerCase()).toContain('desc')
    expect(sql.toLowerCase()).toContain('limit')
    // Tenant boundary travels with the query.
    expect(params).toContain('doc_1')
    expect(params).toContain('org_1')
    expect(params).toContain(201)
  })
})

/**
 * The content swap's predicate (the two-writers-one-If-Match defect).
 *
 * `update` goes draft → draft, so `WHERE state = 'draft'` alone let two writers
 * holding the same digest both win. The WHERE clause has to carry the hash and
 * the key that were read. Rendered through drizzle's own dialect, so this is
 * the SQL Postgres would receive; `document-versions.integration.spec.ts` runs
 * the race itself against a real database under `task db:test:rls`.
 */
describe('swapVersionContent — the swap asserts what was read', () => {
  const dialect = new PgDialect()

  /**
   * A drizzle-shaped transaction for the content swap. `usage` answers the
   * ledger reads in order (before the swap, after it); each is split into the
   * live half and the version-overhead half, the way `readStorageUsage` reads.
   */
  function fakeSwapDb(opts: { swapped: unknown[]; named: boolean; usage?: number[] }) {
    const wheres: Array<{ sql: string; params: unknown[] }> = []
    const statements: string[] = []
    const usage = [...(opts.usage ?? [])]
    let updates = 0
    const tx = {
      update: () => ({
        set: () => ({
          where: (condition: SQL) => {
            const rendered = dialect.sqlToQuery(condition)
            wheres.push({ sql: rendered.sql, params: rendered.params })
            statements.push('UPDATE')
            updates += 1
            const result = updates === 1 ? opts.swapped : []
            return Object.assign(Promise.resolve(result), { returning: async () => result })
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: async () => {
            statements.push('USAGE')
            return [{ bytes: String(usage.shift() ?? 0), versionBytes: '0' }]
          },
        }),
      }),
      execute: async (query: { queryChunks?: unknown[] }) => {
        const text = JSON.stringify(query.queryChunks ?? query)
        if (text.includes('pg_advisory_xact_lock')) {
          statements.push(`LOCK ${text.includes('storage_quota:org_1') ? 'storage_quota:org_1' : text}`)
          return []
        }
        statements.push('ORPHAN CHECK')
        return [{ named: opts.named }]
      },
    }
    return {
      wheres,
      statements,
      db: { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
    }
  }

  const input = {
    versionId: 'ver_1',
    documentId: 'doc_1',
    organizationId: 'org_1',
    expected: { state: 'draft' as const, storageKey: 'k/old', contentHash: 'sha256:alt' },
    patch: {
      state: 'draft' as const,
      storageKey: 'k/new',
      storageBucket: 'b',
      contentType: 'text/markdown',
      fileSize: 5,
      contentHash: 'sha256:neu',
    },
    mirrorsItem: false,
    quotaBytes: null,
  }

  it('matches on state, storage key AND content hash', async () => {
    const fake = fakeSwapDb({ swapped: [{ id: 'ver_1' }], named: false })
    currentDb = fake.db

    await swapVersionContent(input)

    const [where] = fake.wheres
    expect(where.sql).toMatch(/"state" = \$\d/)
    expect(where.sql).toMatch(/"storage_key" = \$\d/)
    expect(where.sql).toMatch(/"content_hash" = \$\d/)
    expect(where.params).toEqual(
      expect.arrayContaining(['ver_1', 'doc_1', 'org_1', 'draft', 'k/old', 'sha256:alt']),
    )
  })

  it('matches a row with no stored digest as IS NULL, never as = NULL', async () => {
    const fake = fakeSwapDb({ swapped: [{ id: 'ver_1' }], named: false })
    currentDb = fake.db

    await swapVersionContent({ ...input, expected: { ...input.expected, contentHash: null } })

    expect(fake.wheres[0].sql).toMatch(/"content_hash" is null/i)
  })

  it('reports the loser as a conflict and writes nothing else', async () => {
    const fake = fakeSwapDb({ swapped: [], named: false })
    currentDb = fake.db

    await expect(swapVersionContent({ ...input, mirrorsItem: true })).resolves.toEqual({
      ok: false,
      reason: 'conflict',
    })
    // No item mirror, no orphan check: the transaction was abandoned at the swap.
    expect(fake.statements).toEqual(['LOCK storage_quota:org_1', 'UPDATE'])
  })

  it('mirrors the item in the same transaction when the version is the item’s bytes', async () => {
    const fake = fakeSwapDb({ swapped: [{ id: 'ver_1', storageKey: 'k/new' }], named: false })
    currentDb = fake.db

    await swapVersionContent({ ...input, mirrorsItem: true })

    expect(fake.statements).toEqual([
      'LOCK storage_quota:org_1',
      'UPDATE',
      'UPDATE',
      'ORPHAN CHECK',
    ])
  })

  it('says whether the previous key is still named by anything', async () => {
    currentDb = fakeSwapDb({ swapped: [{ id: 'ver_1' }], named: true }).db
    await expect(swapVersionContent(input)).resolves.toMatchObject({ previousKeyOrphaned: false })

    currentDb = fakeSwapDb({ swapped: [{ id: 'ver_1' }], named: false }).db
    await expect(swapVersionContent(input)).resolves.toMatchObject({ previousKeyOrphaned: true })
  })
})

/**
 * The draft rewrite on the LOCKED admission path (the undercharge defect).
 *
 * The rewrite is admitted under the quota lock, not outside it as
 * `incoming − fileSize`: for a draft freshly forked from the published version
 * that is the published file's size, so ≈ 0, and fork, write, reject, fork again
 * would grow the bucket without a check. The usage is read under the lock before
 * and after the swap, inside one transaction, and a crossing after-state rolls
 * it back.
 */
describe('swapVersionContent — the quota is measured on the state it commits', () => {
  const dialect = new PgDialect()

  function fakeQuotaDb(usage: [number, number]) {
    const statements: string[] = []
    const reads = [...usage]
    let updates = 0
    const tx = {
      update: () => ({
        set: () => ({
          where: (condition: SQL) => {
            dialect.sqlToQuery(condition)
            statements.push('UPDATE')
            updates += 1
            const result = updates === 1 ? [{ id: 'ver_1' }] : []
            return Object.assign(Promise.resolve(result), { returning: async () => result })
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: async () => {
            statements.push('USAGE')
            return [{ bytes: String(reads.shift() ?? 0), versionBytes: '0' }]
          },
        }),
      }),
      execute: async (query: { queryChunks?: unknown[] }) => {
        const text = JSON.stringify(query.queryChunks ?? query)
        statements.push(text.includes('pg_advisory_xact_lock') ? 'LOCK' : 'ORPHAN CHECK')
        return [{ named: true }]
      },
    }
    return { statements, db: { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } }
  }

  const base = {
    versionId: 'ver_1',
    documentId: 'doc_1',
    organizationId: 'org_1',
    expected: { state: 'draft' as const, storageKey: 'k/published', contentHash: 'sha256:alt' },
    patch: {
      storageKey: 'k/new',
      storageBucket: 'b',
      contentType: 'text/markdown',
      fileSize: 4_000,
      contentHash: 'sha256:neu',
    },
    mirrorsItem: false,
  }

  it('takes the storage lock, reads the usage, swaps, and reads it again — in that order', async () => {
    const fake = fakeQuotaDb([5_000, 9_000])
    currentDb = fake.db
    await swapVersionContent({ ...base, quotaBytes: 10_000 })
    expect(fake.statements).toEqual(['LOCK', 'USAGE', 'UPDATE', 'USAGE', 'ORPHAN CHECK'])
  })

  it('refuses a forked draft’s rewrite at its FULL size, because the published bytes stay', async () => {
    // Before: 8_000 (the published file, shared by the fresh fork). After the
    // swap the draft owns 4_000 more of its own: 12_000 > 10_000. The delta
    // (4_000 − the published file's 4_000 = 0) would admit this without a check.
    currentDb = fakeQuotaDb([8_000, 12_000]).db
    await expect(swapVersionContent({ ...base, quotaBytes: 10_000 })).resolves.toEqual({
      ok: false,
      reason: 'quota',
      usedBytes: 8_000,
    })
  })

  it('admits a rewrite that fits, and one that shrinks even over a lowered quota', async () => {
    currentDb = fakeQuotaDb([5_000, 9_000]).db
    await expect(swapVersionContent({ ...base, quotaBytes: 10_000 })).resolves.toMatchObject({
      ok: true,
    })

    currentDb = fakeQuotaDb([12_000, 11_000]).db
    await expect(swapVersionContent({ ...base, quotaBytes: 10_000 })).resolves.toMatchObject({
      ok: true,
    })
  })

  it('still serializes on the lock, and reads nothing, when the organization is unlimited', async () => {
    const fake = fakeQuotaDb([0, 0])
    currentDb = fake.db
    await swapVersionContent({ ...base, quotaBytes: null })
    expect(fake.statements).toEqual(['LOCK', 'UPDATE', 'ORPHAN CHECK'])
  })
})

/**
 * The delete cascade's object list reads EVERY version, not the first page.
 *
 * It must not stop at `DOCUMENT_VERSION_LIST_LIMIT` (500): a document with a
 * longer history would leave every later version's object in the bucket —
 * invisible, still charged, still presignable.
 */
describe('listDocumentVersionObjects — past the first page', () => {
  it('pages by version number until a short page, and returns a shared object once', async () => {
    const full = Array.from({ length: 500 }, (_, index) => [
      index + 1,
      `k/v${index + 1}`,
      'grid-org-1',
    ])
    // A fork shares the published version's key: two rows, one object.
    full[499] = [500, 'k/v499', 'grid-org-1']
    pages.push(full, [
      [501, 'k/v501', 'grid-org-1'],
      [502, 'k/v502', 'grid-org-1'],
    ])

    const objects = await listDocumentVersionObjects('doc_1', 'org_1')

    expect(captured).toHaveLength(2)
    // The second page starts after the last number the first one returned.
    expect(captured[1].sql).toMatch(/"version_number" > \$\d/)
    expect(captured[1].params).toContain(500)
    expect(
      captured.every(({ sql }) => /order by "document_versions"."version_number" asc/i.test(sql)),
    ).toBe(true)
    expect(objects).toHaveLength(501)
    expect(objects.map((object) => object.storageKey)).toContain('k/v502')
  })

  it('asks once when the history fits one page', async () => {
    pages.push([[1, 'k/v1', null]])
    await expect(listDocumentVersionObjects('doc_1', 'org_1')).resolves.toEqual([
      { storageKey: 'k/v1', storageBucket: null },
    ])
    expect(captured).toHaveLength(1)
  })
})
