/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { databaseUnavailableCode, isUniqueViolation, UNIQUE_VIOLATION } from './errors'

/** What drizzle throws: a `Failed query` wrapper with no code, the driver's error on `cause`. */
function drizzleFailure(code: string, constraintName?: string): Error {
  return new Error('Failed query: insert into "documents" …\nparams: …', {
    cause: Object.assign(new Error('duplicate key value violates unique constraint'), {
      code,
      ...(constraintName === undefined ? {} : { constraint_name: constraintName }),
    }),
  })
}

describe('isUniqueViolation', () => {
  it('finds the SQLSTATE on the cause, where drizzle puts it', () => {
    const error = drizzleFailure(UNIQUE_VIOLATION, 'uniq_documents_live_name_per_collection')
    // The regression: the wrapper itself carries no code, so `error.code` was
    // never '23505' and every race backstop that read it was dead.
    expect((error as { code?: unknown }).code).toBeUndefined()
    expect(isUniqueViolation(error)).toBe(true)
  })

  it('matches a named constraint only when the violation names it', () => {
    const error = drizzleFailure(UNIQUE_VIOLATION, 'uniq_documents_live_name_per_collection')
    expect(isUniqueViolation(error, 'uniq_documents_live_name_per_collection')).toBe(true)
    expect(isUniqueViolation(error, 'uniq_document_versions_open_per_document')).toBe(false)
  })

  it('refuses a named match when the driver did not say which constraint', () => {
    expect(isUniqueViolation(drizzleFailure(UNIQUE_VIOLATION), 'any_index')).toBe(false)
    expect(isUniqueViolation(drizzleFailure(UNIQUE_VIOLATION))).toBe(true)
  })

  it('still reads a code on the error itself', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: UNIQUE_VIOLATION }))).toBe(true)
  })

  it('is false for every other failure', () => {
    expect(isUniqueViolation(drizzleFailure('23503', 'some_fkey'))).toBe(false)
    expect(isUniqueViolation(new Error('boom'))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation('23505')).toBe(false)
  })

  it('does not treat a unique violation as the database being unavailable', () => {
    expect(databaseUnavailableCode(drizzleFailure(UNIQUE_VIOLATION, 'x'))).toBeUndefined()
  })
})
