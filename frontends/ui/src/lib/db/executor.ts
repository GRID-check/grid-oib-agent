import type { getDb } from './index'

/** The handle a `db.transaction` callback receives. */
export type DbTransaction = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

/**
 * Where a repository function runs its statement: the tenant-scoped handle, or
 * the transaction a caller already holds. A function that may run inside a
 * caller's transaction takes one of these rather than calling `getDb()`, which
 * would ask for a second pool slot while the first is held
 * (`transaction-shape.spec.ts`).
 */
export type DbExecutor = ReturnType<typeof getDb> | DbTransaction
