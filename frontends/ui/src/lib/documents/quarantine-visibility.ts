/**
 * Which quarantined rows a listing's reader may see (ADR-0083), asked of rows
 * already in memory. Its own module because it is pure: the listings that need
 * it mock the repository whole, and a predicate is not a database read.
 */

/**
 * `visibleQuarantineFor` (`./repository`) in memory, for the rows a listing
 * has already read and then reconciled. The query can only drop a row that IS
 * quarantined; the first read after a file's verdict still finds it `pending`,
 * and the reconcile that follows turns it `quarantined` and would hand it, name
 * and all, to everyone. Every listing that reconciles applies this after it.
 */
export function keepVisibleQuarantine<T extends { status: string; createdBy: string }>(
  rows: T[],
  quarantineReader: string | undefined,
): T[] {
  if (!quarantineReader) return rows
  return rows.filter((row) => row.status !== 'quarantined' || row.createdBy === quarantineReader)
}
