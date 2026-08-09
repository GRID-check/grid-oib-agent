/**
 * The SQL a property filter actually compiles to.
 *
 * The integration suite proves the predicate returns the right ELEMENTS. It
 * cannot prove the predicate is fast, and the two are separable in a way that
 * bit once already: `search_keys IS NULL OR search_keys @> …` returns exactly
 * the right rows and is the slowest form there is, because `IS NULL` is not
 * GIN-indexable and the disjunction takes the index out of play. Measured on a
 * seeded 200 000-element model, a filter matching one element:
 *
 *   no pre-filter          6 474 ms
 *   `IS NULL OR @>`        2 934 ms   (same plan as no pre-filter)
 *   `@>` alone                 4 ms   (Bitmap Index Scan on the GIN index)
 *
 * Nothing in a green test suite distinguishes those three, so the shape is
 * pinned here.
 */

import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { buildBimPredicate } = await import('./query')

const dialect = new PgDialect()

function compile(
  filter: Parameters<typeof buildBimPredicate>[0],
  options?: Parameters<typeof buildBimPredicate>[1]
): { sql: string; params: unknown[] } {
  const predicate = buildBimPredicate(filter, options)
  if (!predicate) throw new Error('expected a predicate')
  const query = dialect.sqlToQuery(predicate)
  return { sql: query.sql, params: query.params }
}

const INDEXED = { searchKeysIndexed: true }

describe('the property-filter pre-filter', () => {
  it('never puts an unindexable IS NULL beside the containment', () => {
    const { sql } = compile(
      { properties: [{ name: 'FireRating', operator: 'eq', value: 'REI 90', source: 'property' }] },
      INDEXED
    )

    expect(sql).toContain('"search_keys" @>')
    expect(sql).not.toContain('"search_keys" is null')
    expect(sql).not.toContain('"search_keys" IS NULL')
  })

  it('looks up an exact string match by VALUE, lowercased, not just by key', () => {
    // The difference between "every element carrying a FireRating" and "every
    // element whose FireRating is this one" — on a model where a quarter of
    // the elements carry the property, that is the whole optimisation.
    const { params } = compile(
      { properties: [{ set: 'Pset_WallCommon', name: 'FireRating', operator: 'eq', value: 'REI 90', source: 'property' }] },
      INDEXED
    )

    expect(params).toContain('{"p:pset_wallcommon.firerating":["rei 90"]}')
  })

  it('falls back to key existence when the value is not an exact string', () => {
    // `gt` / `contains` cannot be answered by containment, but "carries this
    // property at all" is still a necessary condition and still indexable.
    const { sql, params } = compile(
      { properties: [{ name: 'ThermalTransmittance', operator: 'lte', value: 0.2, source: 'property' }] },
      INDEXED
    )

    expect(sql).toContain('"search_keys" ?')
    expect(params).toContain('p:thermaltransmittance')
  })

  it('prefixes quantities separately from properties', () => {
    const { params } = compile(
      { properties: [{ name: 'Width', operator: 'exists', source: 'quantity' }] },
      INDEXED
    )

    expect(params).toContain('q:width')
  })

  it('leaves `missing` and `neq` alone', () => {
    // Both are SATISFIED by an element that does not carry the property, so a
    // pre-filter requiring the key would drop exactly the rows being looked
    // for. Speed is not worth an answer that omits its subject.
    for (const operator of ['missing', 'neq'] as const) {
      const { sql } = compile(
        { properties: [{ name: 'FireRating', operator, value: 'REI 90', source: 'property' }] },
        INDEXED
      )
      expect(sql, operator).not.toContain('search_keys')
    }
  })

  it('emits no pre-filter at all for a model that is not indexed', () => {
    // The rolling-deploy case. An older image writes elements with no
    // `search_keys` and leaves `bim_models.search_keys_indexed` false; reading
    // the column anyway would answer every property filter with nothing.
    const { sql } = compile(
      { properties: [{ name: 'FireRating', operator: 'eq', value: 'REI 90', source: 'property' }] },
      { searchKeysIndexed: false }
    )

    expect(sql).not.toContain('search_keys')
    expect(sql).toContain('jsonb_each')
  })

  it('defaults to no pre-filter when the caller does not say', () => {
    // Slow-and-right is the only safe default for a caller that has not
    // established the model is indexed.
    const { sql } = compile({
      properties: [{ name: 'FireRating', operator: 'eq', value: 'REI 90', source: 'property' }],
    })

    expect(sql).not.toContain('search_keys')
  })
})
