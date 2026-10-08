/**
 * @vitest-environment node
 */
/**
 * Cross-language contract for the shelf, on the hop where it is emitted.
 *
 * `X-Grid-Collection-Scope` is written here and read by
 * `src/aiq_agent/knowledge/scoping.py`. Nothing in either runtime imports the
 * other's enum — ADR-0047 keeps each side's three constants local on purpose —
 * so the ONLY thing holding the two in agreement is this shared fixture.
 *
 * Both sides assert against `tests/fixtures/collection_scope/scope_header.json`:
 * this spec proves the BFF still emits it, and
 * `tests/aiq_agent/knowledge/test_scope_header_contract.py` proves the agent
 * still reads it. Change the payload on one end and exactly one of the two
 * fails, which is the point. Each side's suite can pass while the seam between
 * them is broken, which is the case this fixture exists for.
 *
 * A seam is not covered by testing each side of it.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { encodeCollectionScopeHeader } from './collection-scope-request'
import type { ScopedCollection } from './collection-scope'

// frontends/ui/src/lib → repo root is five levels up.
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(HERE, '../../../../tests/fixtures/collection_scope/scope_header.json')

interface ScopeCase {
  name: string
  /** False for legacy shapes the agent must still read but the BFF does not write. */
  emittedByBff: boolean
  entries: Array<ScopedCollection | string>
  parsed: Array<{ collection: string; shelf: string | null }>
  header: string
}

const contract = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as {
  header_name: string
  cases: ScopeCase[]
}

describe('X-Grid-Collection-Scope — the shape the agent decodes', () => {
  const emitted = contract.cases.filter((entry) => entry.emittedByBff)

  test.each(emitted)('the BFF still encodes "$name" byte-for-byte', (scopeCase) => {
    const encoded = encodeCollectionScopeHeader(scopeCase.entries as ScopedCollection[])

    expect(encoded).toBe(scopeCase.header)
  })

  test.each(contract.cases)('"$name" round-trips back to its entries', (scopeCase) => {
    const decoded: unknown = JSON.parse(Buffer.from(scopeCase.header, 'base64url').toString('utf-8'))

    expect(decoded).toEqual(scopeCase.entries)
  })

  test('an unattributable collection omits the shelf rather than defaulting it', () => {
    // The key must be ABSENT, not null and not "base". `scoping.py` reads a
    // missing shelf as unknown and renders unattributed; a default here would
    // reinstate the fail-open ADR-0047 removed, where anything unrecognised
    // claimed to be authoritative base law.
    const encoded = encodeCollectionScopeHeader([{ collection: 'some_custom_corpus' }])
    const [entry] = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8')) as Array<
      Record<string, unknown>
    >

    expect(Object.keys(entry)).toEqual(['collection'])
  })

  test('a session collection is its own shelf, not project', () => {
    // Without the shelf on the wire, a guess such as `('s_', 'projekt')` is the
    // only option, and a file attached privately to a chat would be cited as
    // "Projektwissen".
    const encoded = encodeCollectionScopeHeader([{ collection: 's_conv_abc', shelf: 'session' }])
    const [entry] = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8')) as Array<
      Record<string, unknown>
    >

    expect(entry.shelf).toBe('session')
  })

  test('the fixture covers every shelf, so a new one cannot be added silently', () => {
    const shelves = new Set(
      contract.cases
        .flatMap((scopeCase) => scopeCase.parsed)
        .map((entry) => entry.shelf)
        .filter((shelf): shelf is string => shelf !== null)
    )

    expect([...shelves].sort()).toEqual(['archiv', 'base', 'project', 'session'])
  })
})
