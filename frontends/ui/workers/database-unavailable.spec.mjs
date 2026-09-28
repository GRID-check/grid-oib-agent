/**
 * @vitest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  UNAVAILABLE_DRIVER_CODES,
  UNAVAILABLE_ERRNOS,
  databaseUnavailableCode,
  isDatabaseUnavailableCode,
} from './database-unavailable.js'
import { databaseUnavailableCode as appDatabaseUnavailableCode } from '../src/lib/db/errors'
import { classifyConsoleRecord } from '../observability/otel-logs.js'

const UI_ROOT = path.resolve(__dirname, '..')

/** One code from every family: class 08, the shutdown SQLSTATEs, errnos, driver codes. */
const EVERY_CODE = ['08000', '08006', '08P01', '57P01', '57P02', '57P03', ...UNAVAILABLE_ERRNOS, ...UNAVAILABLE_DRIVER_CODES]

/** Codes that mean a query was wrong, not that the database was gone. */
const NOT_AN_OUTAGE = ['23505', '23503', '22P02', '42P01', '40001', '57014', 'P0001', 'ERR_INVALID_ARG_TYPE']

describe('databaseUnavailableCode', () => {
  it('knows every code family', () => {
    for (const code of EVERY_CODE) expect(isDatabaseUnavailableCode(code), code).toBe(true)
    for (const code of NOT_AN_OUTAGE) expect(isDatabaseUnavailableCode(code), code).toBe(false)
  })

  it('finds the code where Drizzle hangs it, on the cause', () => {
    const socket = Object.assign(new Error('connect EHOSTUNREACH 10.111.223.83:5432'), { code: 'EHOSTUNREACH' })
    const drizzle = new Error('Failed query: select 1', { cause: socket })
    expect(databaseUnavailableCode(drizzle)).toBe('EHOSTUNREACH')
  })

  it('finds it on a worker’s bare postgres.js error', () => {
    const shutdown = Object.assign(new Error('the database system is starting up'), { code: '57P03' })
    expect(databaseUnavailableCode(shutdown)).toBe('57P03')
  })

  it('is undefined for a bad query and for anything that is not an error', () => {
    const dup = new Error('Failed query', { cause: Object.assign(new Error('duplicate'), { code: '23505' }) })
    expect(databaseUnavailableCode(dup)).toBeUndefined()
    expect(databaseUnavailableCode(null)).toBeUndefined()
    expect(databaseUnavailableCode('ECONNREFUSED')).toBeUndefined()
  })

  it('is the very function the app imports from @/lib/db/errors', () => {
    expect(appDatabaseUnavailableCode).toBe(databaseUnavailableCode)
  })
})

describe('the log bridge reads the same code set', () => {
  /** Next's `⨯` record for a page render whose query met an unreachable database. */
  const renderFailure = (code) =>
    [
      '⨯ Error: Failed query: select "id" from "projects" where "projects"."id" = $1',
      'params: 38d1bb85-5d06-40a5-b88d-1b74043b11a4',
      `  [cause]: Error: the database said ${code}`,
      `    code: '${code}',`,
    ].join('\n')

  it.each(EVERY_CODE)('reclassifies a render that failed with %s to WARN', (code) => {
    expect(classifyConsoleRecord('error', renderFailure(code))).toEqual({
      severityNumber: 13,
      severityText: 'WARN',
      attributes: { 'grid.severity.reclassified': 'database-unavailable-render' },
    })
  })

  it.each(NOT_AN_OUTAGE)('keeps a render that failed with %s at ERROR', (code) => {
    expect(classifyConsoleRecord('error', renderFailure(code)).severityNumber).toBe(17)
  })
})

describe('the code set is spelled once', () => {
  // Three copies of this set existed (lib/db/errors.ts, the log bridge's
  // regex, and the workers had none), and the regex had already lost EPIPE.
  // A fourth copy fails here, by file name, rather than in a review.
  // What a copy looks like: a quoted shutdown SQLSTATE, the regex form of it
  // or of class 08, or a driver code no prose would mention. A log line that
  // merely names a code, `database unavailable (57P03)`, is not a copy.
  const SPELLED = /CONNECTION_DESTROYED|['"`]57P0[0-9]['"`]|57P0\[|08\[0-9A-Z\]/
  const ROOTS = ['src', 'scheduler', 'purger', 'workers', 'observability', 'server.js']
  const HOME = path.join('workers', 'database-unavailable.js')

  function sourceFiles(entry) {
    const full = path.join(UI_ROOT, entry)
    if (statSync(full).isFile()) return [entry]
    return readdirSync(full).flatMap((name) =>
      name === 'node_modules' ? [] : sourceFiles(path.join(entry, name)),
    )
  }

  it('appears in no other source file', () => {
    const copies = ROOTS.flatMap(sourceFiles)
      .filter((file) => /\.(c?js|mjs|ts|tsx)$/.test(file) && !/\.(spec|test)\.|\.d\.ts$/.test(file))
      .filter((file) => file !== HOME)
      .filter((file) => SPELLED.test(readFileSync(path.join(UI_ROOT, file), 'utf8')))
    expect(copies).toEqual([])
  })
})
