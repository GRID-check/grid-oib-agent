/**
 * The deadlock shape, made into a build failure.
 *
 * Since ADR-0041 every statement runs inside its own `BEGIN … COMMIT`, so it
 * holds a pool slot for the whole round trip. A `getDb()` call made INSIDE an
 * open `db.transaction()` body therefore asks for a SECOND slot while still
 * holding the first — and postgres-js has no acquisition timeout, so on a
 * saturated pool the caller does not fail, it queues forever behind a slot only
 * it could release.
 *
 * The fix at every call site is the same and costs nothing: use the `tx` handle
 * the transaction callback already hands you. This spec exists because the bug
 * is invisible until the pool is full, which is to say: in production, under
 * load, at the worst moment.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Every first-party source file that could contain a transaction. */
function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)) found.push(path)
    }
  }
  walk(join(process.cwd(), 'src'))
  return found
}

/**
 * The body of each `.transaction(` call in `source`, found by matching
 * parentheses from the opening one. Brace-counting would miss a callback that
 * uses a concise arrow body; paren-counting bounds the whole call expression,
 * which is what we want to search.
 */
function transactionBodies(source: string): string[] {
  const bodies: string[] = []
  const opener = /\.transaction\s*\(/g
  let match: RegExpExecArray | null

  while ((match = opener.exec(source))) {
    let depth = 0
    let index = match.index + match[0].length - 1
    for (; index < source.length; index += 1) {
      if (source[index] === '(') depth += 1
      else if (source[index] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    bodies.push(source.slice(match.index, index + 1))
  }
  return bodies
}

describe('no getDb() inside a transaction body', () => {
  it('finds no call site that would need a second pool slot to finish its first', () => {
    const offenders: string[] = []

    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8')
      if (!source.includes('.transaction(')) continue
      for (const body of transactionBodies(source)) {
        if (/\bgetDb\s*\(/.test(body)) {
          offenders.push(file.replace(`${process.cwd()}/`, ''))
          break
        }
      }
    }

    expect(
      offenders,
      'These call getDb() inside a db.transaction() body. That needs a second ' +
        'pool slot while holding the first, and postgres-js has no acquisition ' +
        'timeout — on a saturated pool it deadlocks rather than erroring. Use the ' +
        '`tx` handle the callback receives.'
    ).toEqual([])
  })

  it('actually detects the shape it is looking for', () => {
    // Otherwise a refactor that broke the matcher would report a clean sweep.
    const planted = `
      await db.transaction(async (tx) => {
        const other = getDb()
        await other.select()
      })
    `
    expect(transactionBodies(planted)).toHaveLength(1)
    expect(/\bgetDb\s*\(/.test(transactionBodies(planted)[0])).toBe(true)
  })
})
