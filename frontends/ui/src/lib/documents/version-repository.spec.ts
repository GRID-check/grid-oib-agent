/**
 * @vitest-environment node
 */
/**
 * `findPreviousVersion` — the diff base for a review round.
 *
 * The predecessor used to be found by scanning the asc-limited-200 page in
 * memory. Past 200 versions that page no longer contains the predecessor at
 * all, and the scan then named the wrong row (the highest inside the window)
 * as the diff base. These tests pin the statement instead: a direct
 * `version_number < $n ORDER BY version_number DESC LIMIT 1` inside the tenant
 * boundary, so Postgres answers the predecessor no matter how long the history
 * is.
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

const proxyDb = drizzle(async (sql, params) => {
  captured.push({ sql, params })
  return { rows: [] }
})

/**
 * The handle `getDb()` returns. The pg-proxy driver refuses transactions, so a
 * test about one swaps in a drizzle-SHAPED fake (below) for its duration.
 */
let currentDb: unknown = proxyDb
vi.mock('@/lib/db', () => ({ getDb: () => currentDb }))

import { TransactionRollbackError } from 'drizzle-orm'
import {
  findPreviousVersion,
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
 * The version number, allocated inside the inserting transaction (migration
 * 0092). `max + 1` read in one statement and inserted in another let two
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
