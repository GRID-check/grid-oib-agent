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

const { buildBimPredicate, bimFilterSchema, bimQuerySchema } = await import('./query')

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

/**
 * What the schema refuses, and why refusing beats stripping.
 *
 * Zod's default is to drop unknown keys, which for a FILTER is the worst
 * possible failure: the query still runs, over a wider set than the caller
 * asked for, and nothing downstream can tell that a criterion was discarded.
 * The agent then reports a filtered count that was never filtered.
 */
describe('the query schema', () => {
  const filter = (value: unknown) => bimFilterSchema.safeParse(value)

  it('rejects a filter key it does not know instead of dropping it', () => {
    // Singular `storey` is a very natural slip; the real key is `storeys`.
    // Stripped, this became "every wall in the building" and came back as
    // "412 Bauteile erfüllen die Abfrage".
    const result = filter({ ifcTypes: ['IfcWall'], storey: 'Erdgeschoss' })
    expect(result.success).toBe(false)
  })

  it('names the key it did not recognise, so the caller can correct it', () => {
    const result = filter({ ifcType: 'IfcWall' })
    expect(JSON.stringify(result.error?.issues)).toContain('ifcType')
  })

  it('still accepts every key it does know', () => {
    expect(
      filter({
        ifcTypes: ['IfcWall'],
        storeys: ['Erdgeschoss'],
        nameContains: 'Aussen',
        material: 'Beton',
        classification: 'Ifc',
        globalIds: ['abc'],
        properties: [{ set: 'Pset_WallCommon', name: 'FireRating', operator: 'exists' }],
      }).success
    ).toBe(true)
  })

  it('rejects a property filter with an invented field', () => {
    expect(filter({ properties: [{ property: 'FireRating', operator: 'exists' }] }).success).toBe(
      false
    )
  })

  it('refuses to group by a property without saying which', () => {
    // It used to run UNGROUPED and then render the grand total as one group
    // called "(ohne Angabe)" — so "wie verteilen sich die
    // Feuerwiderstandsklassen?" answered that 412 walls have none.
    const result = bimQuerySchema.safeParse({ op: 'aggregate', metric: 'count', groupBy: 'property' })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('groupProperty')
  })

  it('accepts the same grouping once the property is named', () => {
    expect(
      bimQuerySchema.safeParse({
        op: 'aggregate',
        metric: 'count',
        groupBy: 'property',
        groupProperty: { set: 'Pset_WallCommon', name: 'FireRating' },
      }).success
    ).toBe(true)
  })

  it('rejects an invented key at the TOP level too, not only inside the filter', () => {
    // `filters` — plural, and the name of the agent's own tool parameter —
    // was stripped, `filter` defaulted to `{}`, and the aggregate ran over
    // the whole model. An unfiltered number reported as a filtered one, which
    // is the failure the strictness one level down was added to prevent.
    const result = bimQuerySchema.safeParse({
      op: 'aggregate',
      metric: 'count',
      filters: { ifcTypes: ['IfcWall'] },
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('filters')
  })

  it.each(['overview', 'health', 'schedule', 'types', 'profile'] as const)(
    'rejects a filter handed to %s, which reads the whole model',
    (op) => {
      expect(bimQuerySchema.safeParse({ op, filter: { ifcTypes: ['IfcWall'] } }).success).toBe(false)
    }
  )

  it('lets the viewer page past the extraction cap', () => {
    // The walk advances six pages of 1 000 per round while pages come back
    // full. A ceiling of 100 000 — half the 200 000-element extraction cap —
    // made one round 400, `Promise.all` reject, and the WHOLE element index
    // fail rather than return a partial one, for every model between the two
    // numbers. Selection, storey isolation and highlights die with it.
    expect(bimQuerySchema.safeParse({ op: 'elements', offset: 150_000 }).success).toBe(true)
    // Still bounded: an unbounded OFFSET is a slow sequential scan on demand.
    expect(bimQuerySchema.safeParse({ op: 'elements', offset: 10_000_000 }).success).toBe(false)
  })
})

describe('what a property predicate compiles to', () => {
  it('escapes the ILIKE wildcards in a `contains` value', () => {
    // `%` and `_` are wildcards. `WC_1` also matched `WC-1` and `WCx1`, and a
    // value of `%` matched every element carrying the property at all — an
    // inflated count reported as a fact. Three sibling predicates already
    // route through `likeContains`; this one did not.
    const { params } = compile({ properties: [{ name: 'Raumnummer', operator: 'contains', value: 'WC_1', source: 'property' }] })
    expect(params).toContain('%WC\\_1%')
  })

  it('compares a numeric equality numerically, not as rendered text', () => {
    // `#>> '{}'` against `String(value)` made the two sides disagree on
    // rendering: JavaScript writes `1e-7` where Postgres stores `0.0000001`,
    // and a stored `2.50` never equals the string `2.5`. Nothing matched, and
    // the answer was "Kein Bauteil erfüllt die Abfrage" — a fact about number
    // formatting, reported as a fact about the building.
    const { sql: text, params } = compile({
      properties: [{ name: 'Dicke', operator: 'eq', value: 0.0000001, source: 'property' }],
    })
    expect(text).toContain('::numeric')
    expect(params).toContain(0.0000001)
    expect(params).not.toContain('1e-7')
  })

  it('keeps a STRING equality case-insensitive and textual', () => {
    // "REI 90", "rei 90" and "Rei 90" all occur in the wild, and a filter that
    // returns zero rows over capitalisation is indistinguishable from a
    // building with no fire-rated walls.
    const { sql: text } = compile({
      properties: [{ name: 'FireRating', operator: 'eq', value: 'REI 90', source: 'property' }],
    })
    expect(text).toContain('lower(')
  })

  it('counts an element that does not carry the property as "not 2.5"', () => {
    // A bare `<>` inside the numeric CASE reports `false` for a non-numeric
    // value and for a missing property, so both would be excluded from a
    // filter they in fact satisfy.
    const { sql: text } = compile({
      properties: [{ name: 'Dicke', operator: 'neq', value: 2.5, source: 'property' }],
    })
    expect(text).toContain('NOT (CASE WHEN')
  })
})
