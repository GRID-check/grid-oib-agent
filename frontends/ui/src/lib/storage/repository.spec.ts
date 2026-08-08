import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * A drizzle-shaped transaction handle that records what it was asked to do.
 *
 * The point of these tests is the ORDER and the SCOPE of the statements — the
 * lock has to be taken before the sum is read, and the insert has to happen
 * inside the same transaction — because that ordering is the entire guarantee.
 * A mock that only checked "an insert happened" would pass on a version of this
 * function with no lock at all, which is the version that was already shipped.
 */
function fakeDb(usedBytes: number) {
  const statements: string[] = []
  const inserted: unknown[] = []

  const tx = {
    execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
      statements.push(JSON.stringify(query.queryChunks ?? query))
      return []
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => {
          statements.push('SELECT sum')
          return [{ bytes: String(usedBytes) }]
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (values: unknown) => {
        statements.push('INSERT')
        inserted.push(values)
        return []
      }),
    })),
  }

  return {
    statements,
    inserted,
    tx,
    db: { transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)) },
  }
}

const getDb = vi.fn()
vi.mock('@/lib/db', () => ({ getDb: () => getDb() }))
vi.mock('@/lib/db/tenant-context', () => ({
  withPlatformAccess: (_reason: string, fn: () => unknown) => fn(),
}))

import { insertDocumentWithinQuota } from './repository'
import type { NewDocument } from '@/lib/db/schema'

const row = (fileSize: number): NewDocument =>
  ({ id: 'doc-1', organizationId: 'org-1', fileSize }) as unknown as NewDocument

describe('insertDocumentWithinQuota', () => {
  beforeEach(() => vi.clearAllMocks())

  it('takes the per-organization lock BEFORE reading the sum', async () => {
    const fake = fakeDb(0)
    getDb.mockReturnValue(fake.db)

    await insertDocumentWithinQuota(row(1_000), 10_000)

    // Lock, then sum, then insert. Reading the sum first would be the same
    // check-then-act this function exists to replace: two transactions could
    // both read the pre-state and both admit.
    expect(fake.statements).toHaveLength(3)
    expect(fake.statements[0]).toContain('pg_advisory_xact_lock')
    expect(fake.statements[1]).toBe('SELECT sum')
    expect(fake.statements[2]).toBe('INSERT')
  })

  it('keys the lock on the organization, so tenants do not queue behind each other', async () => {
    const fake = fakeDb(0)
    getDb.mockReturnValue(fake.db)
    await insertDocumentWithinQuota(row(1), 10)
    expect(fake.statements[0]).toContain('storage_quota:org-1')
  })

  it('inserts inside the transaction, not outside it', async () => {
    const fake = fakeDb(0)
    getDb.mockReturnValue(fake.db)
    await insertDocumentWithinQuota(row(1), 10)
    // An insert on `db` rather than `tx` would commit independently of the lock,
    // which puts the admission back where it started.
    expect(fake.tx.insert).toHaveBeenCalled()
    expect(fake.db.transaction).toHaveBeenCalledTimes(1)
  })

  it('admits an upload that exactly fills the quota', async () => {
    const fake = fakeDb(9_000)
    getDb.mockReturnValue(fake.db)
    await expect(insertDocumentWithinQuota(row(1_000), 10_000)).resolves.toEqual({ ok: true })
    expect(fake.inserted).toHaveLength(1)
  })

  it('refuses the upload that would cross it, and inserts nothing', async () => {
    const fake = fakeDb(9_000)
    getDb.mockReturnValue(fake.db)

    await expect(insertDocumentWithinQuota(row(1_001), 10_000)).resolves.toEqual({
      ok: false,
      usedBytes: 9_000,
    })
    // Reported, not thrown: the caller has an object to clean up and a refusal
    // is an expected outcome, not an error condition.
    expect(fake.inserted).toHaveLength(0)
  })

  it('skips the sum entirely when the organization is unlimited', async () => {
    const fake = fakeDb(999_999)
    getDb.mockReturnValue(fake.db)

    await expect(insertDocumentWithinQuota(row(1_000), null)).resolves.toEqual({ ok: true })
    // Still locked — the lock is what makes the sequence serializable for the
    // organizations that DO have a quota, and taking it unconditionally keeps
    // this function's behaviour independent of the caller's configuration.
    expect(fake.statements).toEqual([
      expect.stringContaining('pg_advisory_xact_lock'),
      'INSERT',
    ])
  })

  it('treats a row with no recorded size as zero rather than NaN', async () => {
    const fake = fakeDb(10_000)
    getDb.mockReturnValue(fake.db)
    // `file_size` is nullable in the schema. `null + 10_000 > 10_000` is false
    // in JS only by accident; reading it as 0 is the deliberate version.
    const nullSize = { id: 'doc-1', organizationId: 'org-1' } as unknown as NewDocument
    await expect(insertDocumentWithinQuota(nullSize, 10_000)).resolves.toEqual({ ok: true })
  })
})
