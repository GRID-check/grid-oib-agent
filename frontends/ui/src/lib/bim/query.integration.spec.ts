/**
 * The BIM query layer against a REAL Postgres, with the real migration chain
 * and the real fixture model (ADR-0041's harness — `task db:test:rls`).
 *
 * This suite is not optional polish. Every claim the query layer makes is a
 * claim about SQL: that a jsonb property filter matches the elements it should,
 * that `missing` and `neq` are different questions, that an aggregate groups by
 * the column it says it does, and that none of it crosses a tenant boundary.
 * None of that is observable from a mock — a mocked drizzle handle returns
 * whatever the fixture author expected, which is exactly the thing under test.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/bim/query.integration.spec.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { extractIfcModel } from './extract'
import type { BimModelIndex } from './types'
import { readZipEntries } from '@/test-utils/read-zip'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_bim_${Date.now()}`
const OTHER_ORG = `org_bim_other_${Date.now()}`

describe('the BIM query suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(
      url,
      'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set, so the ' +
        'BIM query suite skipped and nothing verified the SQL. Check `task db:test:rls`.'
    ).toBeTruthy()
  })
})

describe.skipIf(!url)('BIM queries against live Postgres', () => {
  let modelId: string
  let otherModelId: string
  let revisionModelId: string
  /** A model past both the count ceiling and the property-catalog scan limit. */
  let bigModelId: string
  let FIXTURE_PROJECT: string
  let index: BimModelIndex
  let runBimQuery: typeof import('./query').runBimQuery
  let bimQuerySchema: typeof import('./query').bimQuerySchema
  let BimModelNotReadyError: typeof import('./query').BimModelNotReadyError
  let closeDb: typeof import('@/lib/db').closeDb
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess

  /** Rows in {@link bigModelId} — over `COUNT_CEILING` and over the scan limit. */
  const BIG_MODEL_ELEMENTS = 10_100

  /**
   * The backfill half of `0038_bim_element_search_keys.sql`, read from the
   * migration itself rather than restated here — the whole point of the tests
   * below is that the SQL and the TypeScript agree, and a copy of the SQL in
   * the spec would agree with itself no matter what shipped.
   *
   * Only the UPDATEs: the `ALTER`/`CREATE INDEX` are already applied by the
   * migration chain, and `COMMENT ON COLUMN` needs table ownership the test
   * role does not have.
   */
  const runSearchKeyBackfill = async (): Promise<void> => {
    const source = readFileSync(
      join(process.cwd(), 'drizzle', '0038_bim_element_search_keys.sql'),
      'utf8'
    ).replace(/^\s*--.*$/gm, '')
    const statements = source
      .split(/;\s*(?:\n|$)/)
      .filter((statement) => /^\s*(WITH|UPDATE)\b/i.test(statement))
    // The two element backfills and the `search_keys_indexed` flip.
    expect(statements).toHaveLength(3)
    for (const statement of statements) {
      await withPlatformAccess('re-run the search-key backfill', () =>
        db.execute(sql.raw(statement))
      )
    }
  }

  /** `global_id -> search_keys`, with the value arrays put in a stable order. */
  const readSearchKeys = async (): Promise<Record<string, Record<string, string[]>>> => {
    const rows = await withPlatformAccess('read the search keys', () =>
      db.execute<{ global_id: string; search_keys: Record<string, string[]> | null }>(sql`
        SELECT global_id, search_keys FROM bim_elements WHERE model_id = ${modelId}::uuid
      `)
    )
    return Object.fromEntries(
      Array.from(rows).map((row) => [
        row.global_id,
        Object.fromEntries(
          // `jsonb_agg(DISTINCT …)` and a JS `Set` do not agree on order, and
          // nothing reads these in order — `@>` and `?` are set operations.
          Object.entries(row.search_keys ?? {}).map(([key, values]) => [key, [...values].sort()])
        ),
      ])
    )
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const { getDb, closeDb: close } = await import('@/lib/db')
    const tenantContext = await import('@/lib/db/tenant-context')
    withPlatformAccess = tenantContext.withPlatformAccess
    const repository = await import('./repository')
    const query = await import('./query')
    runBimQuery = query.runBimQuery
    bimQuerySchema = query.bimQuerySchema
    BimModelNotReadyError = query.BimModelNotReadyError
    closeDb = close

    const buffer = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'ifc', 'sample-building.ifc'))
    index = await extractIfcModel(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
      'sample-building.ifc'
    )

    db = getDb()
    // `documents.organization_id` is a plain column with no foreign key to
    // `organizations` (WorkOS owns org identity), so a document row is all the
    // fixture needs — and it is written through the platform role because a
    // tenant-scoped insert cannot seed two tenants.
    const seedDocument = async (organizationId: string, filename: string): Promise<string> => {
      const rows = await withPlatformAccess('seed a BIM fixture document', () =>
        db.execute<{ id: string }>(sql`
          INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status)
          VALUES (${organizationId}, 'seed', ${filename}, ${`seed/${filename}`}, 'seed', 'completed')
          RETURNING id
        `)
      )
      return Array.from(rows)[0].id
    }

    const { elements: extracted, ...summary } = index
    // A null-valued property, which the two `search_keys` writers used to
    // disagree about: SQL emitted `[null]`, TypeScript omitted the key, and a
    // `{operator: 'exists'}` filter therefore matched or did not depending on
    // which one had written the row.
    const elements = extracted.map((element, position) =>
      position === 0
        ? {
            ...element,
            properties: {
              ...element.properties,
              Pset_WallCommon: { ...element.properties.Pset_WallCommon, AcousticRating: null },
            },
          }
        : element
    )
    const documentId = await seedDocument(ORG, 'sample-building.ifc')
    modelId = await repository.startBimModel({
      organizationId: ORG,
      projectId: null,
      documentId,
    })
    await repository.completeBimModel({
      modelId,
      organizationId: ORG,
      summary,
      elements,
      indexStorageKey: null,
      indexStorageBucket: null,
    })

    // A second revision of the SAME building: one wall downgraded, one wall
    // removed, one door added. Everything else keeps its GlobalId, which is
    // what the comparison is built on.
    const revisionElements = elements
      .filter((element) => element.name !== 'Innenwand OG')
      .map((element) =>
        element.name === 'Aussenwand Nord'
          ? {
              ...element,
              properties: {
                ...element.properties,
                Pset_WallCommon: { ...element.properties.Pset_WallCommon, FireRating: 'REI 30' },
              },
            }
          : element
      )
      .concat([
        {
          ...elements[0],
          globalId: '0GridFixture00Door0009',
          expressId: 9001,
          ifcType: 'IfcDoor',
          name: 'Fluchttuer OG',
          storeyName: 'Obergeschoss',
          storeyGlobalId: '0GridFixture00StoreyOG',
          properties: {},
          quantities: {},
          materials: [],
          classifications: [],
          typeName: null,
          predefinedType: null,
          tag: null,
        },
      ])
    const revisionDocumentId = await seedDocument(ORG, 'sample-building-v2.ifc')
    revisionModelId = await repository.startBimModel({
      organizationId: ORG,
      projectId: null,
      documentId: revisionDocumentId,
    })
    await repository.completeBimModel({
      modelId: revisionModelId,
      organizationId: ORG,
      summary,
      elements: revisionElements,
      indexStorageKey: null,
      indexStorageBucket: null,
    })

    // `bim_check_confirmations.project_id` is a real foreign key, so the
    // fixture needs a project row rather than a made-up uuid.
    const projectRows = await withPlatformAccess('seed a BIM fixture project', () =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'BIM fixture', 'seed', 'seed')
        RETURNING id
      `)
    )
    FIXTURE_PROJECT = Array.from(projectRows)[0].id

    const otherDocumentId = await seedDocument(OTHER_ORG, 'other.ifc')
    otherModelId = await repository.startBimModel({
      organizationId: OTHER_ORG,
      projectId: null,
      documentId: otherDocumentId,
    })
    await repository.completeBimModel({
      modelId: otherModelId,
      organizationId: OTHER_ORG,
      summary,
      elements,
      indexStorageKey: null,
      indexStorageBucket: null,
    })

    // A model big enough for the two bounds to engage: past `COUNT_CEILING`
    // so the element count stops early, and past the property-catalog scan
    // limit so the catalog samples. Written in one INSERT rather than through
    // `completeBimModel`, because ten thousand round trips through the ORM
    // would dominate the suite's runtime and none of it is what is under test.
    //
    // The three types are deliberately spread across the alphabet and given
    // DIFFERENT property sets: rows come back from
    // `bim_elements_model_type_express_idx` in type order, so a catalog that
    // took a flat `LIMIT` off the top would report `Pset_DoorCommon`, part of
    // `Pset_WallCommon`, and never see `Pset_WindowCommon` at all.
    const bigDocumentId = await seedDocument(ORG, 'big-building.ifc')
    bigModelId = await repository.startBimModel({
      organizationId: ORG,
      projectId: null,
      documentId: bigDocumentId,
    })
    await repository.completeBimModel({
      modelId: bigModelId,
      organizationId: ORG,
      summary,
      elements: [],
      indexStorageKey: null,
      indexStorageBucket: null,
    })
    await withPlatformAccess('seed a large BIM fixture', () =>
      db.execute(sql`
        INSERT INTO bim_elements
          (model_id, global_id, express_id, ifc_type, name, storey_name, properties, quantities)
        SELECT
          ${bigModelId}::uuid,
          'BIG' || lpad(i::text, 19, '0'),
          i,
          kind.ifc_type,
          'Bauteil ' || i,
          'Erdgeschoss',
          jsonb_build_object(
            kind.pset,
            jsonb_build_object(
              'FireRating', (ARRAY['REI 90', 'EI 30'])[1 + (i % 2)],
              'Reference', 'R' || i
            )
          ),
          '{}'::jsonb
        FROM generate_series(1, ${BIG_MODEL_ELEMENTS}) AS i
        CROSS JOIN LATERAL (
          SELECT
            (ARRAY['IfcDoor', 'IfcWall', 'IfcWindow'])[1 + (i % 3)] AS ifc_type,
            (ARRAY['Pset_DoorCommon', 'Pset_WallCommon', 'Pset_WindowCommon'])[1 + (i % 3)] AS pset
        ) kind
      `)
    )
    await withPlatformAccess('record the large fixture element count', () =>
      db.execute(sql`
        UPDATE bim_models SET element_count = ${BIG_MODEL_ELEMENTS} WHERE id = ${bigModelId}::uuid
      `)
    )
    // `completeBimModel` ran with an empty element list, so it stored a
    // rule-input projection describing ZERO elements, and the raw insert above
    // did not update it. A `compliance` query would take the fast path and
    // report a catalogue run over nothing as complete and untruncated. No test
    // does that today; clearing the column means none can start to.
    await withPlatformAccess('drop the empty rule-input projection', () =>
      db.execute(sql`UPDATE bim_models SET rule_inputs = NULL WHERE id = ${bigModelId}::uuid`)
    )
    // Those rows went in raw, so they carry no `search_keys` yet. Running the
    // migration's own backfill over them puts the fixture in the state a real
    // deployment is in after 0038, rather than a state only a test produces.
    await runSearchKeyBackfill()
  })

  afterAll(async () => {
    await closeDb?.()
  })

  const run = (request: Parameters<typeof runBimQuery>[0]) =>
    runBimQuery(request, { modelId, organizationId: ORG })

  it('serves the overview from the stored summary', async () => {
    const result = await run({ op: 'overview' })
    expect(result.overview?.projectName).toBe('Wohnhaus Beispielgasse')
    expect(result.overview?.totals.elements).toBe(19)
    expect(result.summary).toContain('19 Bauteile')
    expect(result.summary).toContain('Netto-Grundfläche 69 m²')
  })

  it('counts the element types from the rows, not from the summary', async () => {
    const result = await run({ op: 'types' })
    expect(result.types).toEqual(
      expect.arrayContaining([
        { ifcType: 'IfcWall', elements: 5 },
        { ifcType: 'IfcSpace', elements: 4 },
        { ifcType: 'IfcWindow', elements: 3 },
      ])
    )
  })

  it('filters by IFC type and storey together', async () => {
    const result = await run({
      op: 'elements',
      filter: { ifcTypes: ['IfcWall'], storeys: ['Erdgeschoss'] },
      limit: 25,
      offset: 0,
    })
    expect(result.total).toBe(3)
    expect(result.elements?.map((element) => element.name).sort()).toEqual([
      'Aussenwand Nord',
      'Aussenwand Sued',
      'Innenwand EG',
    ])
  })

  it('addresses a storey by GlobalId as readily as by name', async () => {
    const byId = await run({
      op: 'elements',
      filter: { ifcTypes: ['IfcWall'], storeys: ['0GridFixture00StoreyEG'] },
      limit: 25,
      offset: 0,
    })
    expect(byId.total).toBe(3)
  })

  it('matches IFC type names case-insensitively', async () => {
    const result = await run({ op: 'elements', filter: { ifcTypes: ['ifcwall'] }, limit: 25, offset: 0 })
    expect(result.total).toBe(5)
  })

  it('filters on a property value inside jsonb', async () => {
    const external = await run({
      op: 'elements',
      filter: {
        ifcTypes: ['IfcWall'],
        properties: [{ set: 'Pset_WallCommon', name: 'IsExternal', operator: 'eq', value: true, source: 'property' }],
      },
      limit: 25,
      offset: 0,
    })
    expect(external.total).toBe(3)

    const internal = await run({
      op: 'elements',
      filter: {
        ifcTypes: ['IfcWall'],
        properties: [{ name: 'IsExternal', operator: 'eq', value: false, source: 'property' }],
      },
      limit: 25,
      offset: 0,
    })
    expect(internal.total).toBe(2)
  })

  it('compares string property values case-insensitively', async () => {
    const result = await run({
      op: 'elements',
      filter: { properties: [{ name: 'FireRating', operator: 'eq', value: 'rei 90', source: 'property' }] },
      limit: 25,
      offset: 0,
    })
    // Three walls carry REI 90; a case-sensitive comparison would return none
    // and the answer would read as "no fire-rated walls".
    expect(result.total).toBe(3)
  })

  it('keeps `missing` and `neq` as different questions', async () => {
    const notRei90 = await run({
      op: 'elements',
      filter: { properties: [{ name: 'FireRating', operator: 'neq', value: 'REI 90', source: 'property' }] },
      limit: 200,
      offset: 0,
    })
    // Only the two EI 30 walls HAVE a FireRating that is not REI 90.
    expect(notRei90.total).toBe(2)

    const noRating = await run({
      op: 'elements',
      filter: { properties: [{ name: 'FireRating', operator: 'missing', source: 'property' }] },
      limit: 200,
      offset: 0,
    })
    // Everything else in the model carries no FireRating at all.
    expect(noRating.total).toBe(19 - 5)
  })

  it('compares numbers numerically, not as text', async () => {
    const result = await run({
      op: 'elements',
      filter: {
        properties: [
          { name: 'ThermalTransmittance', operator: 'lte', value: 0.2, source: 'property' },
        ],
      },
      limit: 25,
      offset: 0,
    })
    // The three external walls are at 0.18; the windows at 1.1 must not match,
    // and a text comparison would have ordered "1.1" before "0.18".
    expect(result.total).toBe(3)
    expect(result.elements?.every((element) => element.ifcType === 'IfcWall')).toBe(true)
  })

  it('filters by material and by classification', async () => {
    const insulated = await run({
      op: 'elements',
      filter: { material: 'Waermedaemmung' },
      limit: 25,
      offset: 0,
    })
    expect(insulated.total).toBe(3)

    const classified = await run({
      op: 'elements',
      filter: { classification: 'B.1.3' },
      limit: 25,
      offset: 0,
    })
    expect(classified.total).toBe(2)
  })

  it('extracts the same search keys the migration backfills', async () => {
    // `buildSearchKeys` in TypeScript and the `jsonb_each` backfill in SQL are
    // two implementations of one lookup map. If they drift, a freshly
    // extracted model and a backfilled one answer the same filter differently
    // — and the difference is invisible, because the pre-filter only ever
    // REMOVES candidates the exact predicate would have matched.
    const fromExtractor = await readSearchKeys()
    expect(
      Object.values(fromExtractor).filter((keys) => Object.keys(keys).length > 0).length
    ).toBeGreaterThan(0)

    await withPlatformAccess('clear the search keys', () =>
      db.execute(sql`UPDATE bim_elements SET search_keys = NULL WHERE model_id = ${modelId}::uuid`)
    )
    await runSearchKeyBackfill()

    expect(await readSearchKeys()).toEqual(fromExtractor)
  })

  it('answers every property filter identically with and without the pre-filter', async () => {
    // The pre-filter is an index-servable NECESSARY condition AND-ed into the
    // predicate. A key it fails to emit — a case, a prefix, a set-qualified
    // form — does not slow the query down, it deletes matching elements from
    // the answer. `search_keys_indexed` switches the pre-filter off entirely,
    // so the two runs below are the same question asked with and without it.
    const requests = [
      { properties: [{ name: 'FireRating', operator: 'eq', value: 'rei 90', source: 'property' }] },
      { properties: [{ set: 'Pset_WallCommon', name: 'FireRating', operator: 'eq', value: 'REI 90', source: 'property' }] },
      { properties: [{ name: 'FireRating', operator: 'exists', source: 'property' }] },
      { properties: [{ name: 'FireRating', operator: 'missing', source: 'property' }] },
      { properties: [{ name: 'FireRating', operator: 'neq', value: 'REI 90', source: 'property' }] },
      { properties: [{ name: 'FireRating', operator: 'contains', value: 'rei', source: 'property' }] },
      { properties: [{ name: 'IsExternal', operator: 'eq', value: true, source: 'property' }] },
      { properties: [{ name: 'ThermalTransmittance', operator: 'lte', value: 0.2, source: 'property' }] },
      { properties: [{ name: 'NetFloorArea', operator: 'gt', value: 10, source: 'quantity' }] },
      { properties: [{ set: 'Qto_WallBaseQuantities', name: 'NetSideArea', operator: 'exists', source: 'quantity' }] },
      // The null-valued property. `exists` asks only about the NAME, so this
      // has to match the wall carrying `AcousticRating: null` — and it is the
      // filter the two `search_keys` writers used to answer differently.
      { properties: [{ name: 'AcousticRating', operator: 'exists', source: 'property' }] },
      { storeys: ['Erdgeschoss'] },
      { storeys: ['ERDGESCHOSS'], properties: [{ name: 'FireRating', operator: 'exists', source: 'property' }] },
    ]
    const answers = async () =>
      Promise.all(
        requests.map(async (filter) => {
          const result = await run(
            bimQuerySchema.parse({ op: 'elements', filter, limit: 200, offset: 0 })
          )
          return {
            filter: JSON.stringify(filter),
            total: result.total ?? 0,
            globalIds: (result.elements ?? []).map((element) => element.globalId).sort(),
          }
        })
      )

    const withPrefilter = await answers()
    // Not vacuous: every filter has to actually match something, or "identical"
    // would be ten empty answers agreeing with ten empty answers.
    expect(withPrefilter.filter((answer) => answer.total > 0).length).toBe(requests.length)

    await withPlatformAccess('mark the model unindexed', () =>
      db.execute(sql`UPDATE bim_models SET search_keys_indexed = false WHERE id = ${modelId}::uuid`)
    )
    try {
      expect(await answers()).toEqual(withPrefilter)
    } finally {
      await runSearchKeyBackfill()
    }
  })

  it('answers correctly for a model whose elements were never indexed', async () => {
    // The rolling-deploy case: a pod on the previous image extracts a model
    // after 0038 has run, writing elements with no `search_keys` and leaving
    // `search_keys_indexed` at its default. If the query layer trusted the
    // column anyway, every property filter against that model would return
    // nothing — a building reported as having no fire-rated walls at all.
    await withPlatformAccess('simulate an older image writing this model', () =>
      db.execute(sql`
        UPDATE bim_elements SET search_keys = NULL WHERE model_id = ${modelId}::uuid
      `)
    )
    await withPlatformAccess('leave the flag at its default', () =>
      db.execute(sql`UPDATE bim_models SET search_keys_indexed = false WHERE id = ${modelId}::uuid`)
    )

    try {
      const result = await run({
        op: 'elements',
        filter: { properties: [{ name: 'FireRating', operator: 'eq', value: 'REI 90', source: 'property' }] },
        limit: 25,
        offset: 0,
      })
      expect(result.total).toBe(3)
    } finally {
      await runSearchKeyBackfill()
    }
  })

  it('reads one element in full by GlobalId', async () => {
    const result = await run({ op: 'element', globalId: '0GridFixture00Wall0001' })
    expect(result.element?.name).toBe('Aussenwand Nord')
    expect(result.element?.properties['Pset_WallCommon']).toMatchObject({ FireRating: 'REI 90' })
    expect(result.element?.quantities['Qto_WallBaseQuantities']).toMatchObject({ NetSideArea: 24.5 })
    expect(result.element?.materials).toEqual(['Stahlbeton', 'Waermedaemmung EPS', 'Aussenputz'])
  })

  it('publishes the property catalog with real values and counts', async () => {
    const result = await run({ op: 'properties', maxValues: 10 })
    const fireRating = result.properties?.find((entry) => entry.name === 'FireRating')
    expect(fireRating?.set).toBe('Pset_WallCommon')
    expect(fireRating?.source).toBe('property')
    expect(fireRating?.values).toEqual([
      { value: 'REI 90', elements: 3 },
      { value: 'EI 30', elements: 2 },
    ])

    const netFloorArea = result.properties?.find((entry) => entry.name === 'NetFloorArea')
    expect(netFloorArea?.source).toBe('quantity')
    expect(netFloorArea?.elements).toBe(4)
  })

  it('narrows the property catalog to one element type', async () => {
    const result = await run({ op: 'properties', ifcType: 'IfcWindow', maxValues: 10 })
    expect(result.properties?.map((entry) => entry.name).sort()).toEqual([
      'IsExternal',
      'ThermalTransmittance',
    ])
  })

  it('reports the property catalog of a small model as complete', async () => {
    const result = await run({ op: 'properties', maxValues: 10 })
    expect(result.propertyScan).toEqual({ scanned: 19, total: 19, complete: true })
    expect(result.summary).toBe(`${result.properties?.length} Merkmale im Modell.`)
  })

  it('samples the property catalog of a large model, and says it sampled', async () => {
    // The old query unnested every element: 11.6 M rows on a 400 000-element
    // model, two sorts over a 4 MB `work_mem`, past the 30 s statement timeout
    // and out as HTTP 500. This is the bound that replaced it.
    const result = await runBimQuery(
      { op: 'properties', maxValues: 10 },
      { modelId: bigModelId, organizationId: ORG }
    )

    expect(result.propertyScan?.total).toBe(BIG_MODEL_ELEMENTS)
    expect(result.propertyScan?.complete).toBe(false)
    // 200 per type, three types — the per-type cap, not a slice off the top.
    expect(result.propertyScan?.scanned).toBe(600)

    // The point of stratifying: `IfcWindow` sorts last and would never be
    // reached by a flat LIMIT, so its property set appearing here is the
    // assertion that the sample covers the model rather than its first rows.
    expect(result.properties?.map((entry) => entry.set).sort()).toEqual([
      'Pset_DoorCommon',
      'Pset_DoorCommon',
      'Pset_WallCommon',
      'Pset_WallCommon',
      'Pset_WindowCommon',
      'Pset_WindowCommon',
    ])

    // And the counts are labelled as the sample's, so an agent quoting the
    // summary cannot present 200 walls as the model's wall count.
    expect(result.summary).toContain('Stichprobe von 600 der 10100 Bauteile')
    expect(result.summary).toContain('NUR auf die Stichprobe')
  })

  it('stops counting elements at the ceiling and says the total is a floor', async () => {
    // An exact `count(*)` over a filtered 400 000-element model was measured at
    // 15.8 s warm / 21.9 s cold, holding a second pool slot beside the page
    // query for the whole time. Nothing in the product needs the exact figure.
    const { COUNT_CEILING } = await import('./repository')
    const result = await runBimQuery(
      { op: 'elements', filter: {}, limit: 25, offset: 0 },
      { modelId: bigModelId, organizationId: ORG }
    )

    expect(result.total).toBe(COUNT_CEILING)
    expect(result.totalIsLowerBound).toBe(true)
    // `truncated` must not be computed from `offset + rows < total` alone: on
    // the last page inside the cap that is false while 90 000 rows remain.
    expect(result.truncated).toBe(true)
    expect(result.summary).toContain(`Mindestens ${COUNT_CEILING} Bauteile`)
    expect(result.summary).not.toMatch(/^10000 Bauteile/)
  })

  it('returns the same elements whichever plan serves the page', async () => {
    // The two plans are a thousandfold apart in speed and must be identical in
    // result — the pre-filter is a necessary condition, never part of the
    // answer, so removing it can only change the plan. If it ever changes the
    // rows, one of the two is silently wrong and no user could tell which.
    const repository = await import('./repository')
    const { buildBimElementPlan } = await import('./query')

    const plan = buildBimElementPlan(
      { properties: [{ name: 'FireRating', operator: 'eq', value: 'REI 90', source: 'property' }] },
      { searchKeysIndexed: true }
    )
    const page = (over: Partial<Parameters<typeof repository.listBimElements>[0]>) =>
      repository.listBimElements({
        modelId: bigModelId,
        organizationId: ORG,
        plan,
        elementCount: BIG_MODEL_ELEMENTS,
        limit: 25,
        offset: 50,
        ...over,
      })

    // Half of the 10 100 elements carry `REI 90`, so the pre-filter admits far
    // more than the budget while the walk reaches the end of the page in ~150
    // rows: exactly the regime the walk exists for.
    const walked = await page({})
    expect(walked.walked).toBe(true)

    // `candidates: null` is how a caller says "there is nothing to weigh", so
    // it pins the same request to the pre-filter plan.
    const assisted = await page({ plan: { ...plan, candidates: null } })
    expect(assisted.walked).toBe(false)

    expect(walked.rows).toEqual(assisted.rows)
    expect(walked.rows).toHaveLength(25)
    expect(walked.total).toBe(assisted.total)
  })

  it('does not walk for a filter the pre-filter already answers narrowly', async () => {
    // One element out of 10 100. Walking would read the whole model to find
    // it; the GIN index finds it outright.
    const repository = await import('./repository')
    const { buildBimElementPlan } = await import('./query')

    const result = await repository.listBimElements({
      modelId: bigModelId,
      organizationId: ORG,
      plan: buildBimElementPlan(
        { properties: [{ name: 'Reference', operator: 'eq', value: 'R7777', source: 'property' }] },
        { searchKeysIndexed: true }
      ),
      elementCount: BIG_MODEL_ELEMENTS,
      limit: 25,
      offset: 0,
    })

    expect(result.walked).toBe(false)
    expect(result.total).toBe(1)
  })

  it('refuses to overwrite a projection written while it was working', async () => {
    // The lazy path reads `rule_inputs`, spends a second or two loading
    // elements, and writes back. A re-extraction can land in that gap:
    // `startBimModel` reuses the SAME row, so `completeBimModel` writes the new
    // revision's projection — and a blind write-back would then replace it with
    // one computed from the PREVIOUS revision's elements. Every later reader
    // would get verdicts for a building that had already been superseded, on
    // the fast path, with nothing to show which revision they described.
    const repository = await import('./repository')
    const { buildStoredRuleInputs } = await import('./rule-inputs')

    const truncationFlag = async (): Promise<boolean | undefined> => {
      const raw = await repository.loadBimRuleInputs(modelId, ORG)
      return raw && typeof raw === 'object' && 'truncated' in raw
        ? Boolean((raw as { truncated: unknown }).truncated)
        : undefined
    }

    const original = await repository.loadBimRuleInputs(modelId, ORG)
    expect(original).not.toBeNull()
    expect(await truncationFlag()).toBe(false)

    // A writer that started before that projection existed still holds `null`,
    // and must lose.
    await repository.saveBimRuleInputs(modelId, ORG, buildStoredRuleInputs([], true), null)
    expect(await truncationFlag()).toBe(false)

    // Passing what is actually there DOES write, so the lazy backfill this
    // guard protects still works.
    await repository.saveBimRuleInputs(modelId, ORG, buildStoredRuleInputs([], true), original)
    expect(await truncationFlag()).toBe(true)

    // Put the fixture's own projection back for the tests that follow.
    await withPlatformAccess('restore the fixture projection', () =>
      db.execute(sql`
        UPDATE bim_models SET rule_inputs = ${JSON.stringify(original)}::jsonb
        WHERE id = ${modelId}::uuid
      `)
    )
    expect(await truncationFlag()).toBe(false)
  })

  it('reports an exact total below the ceiling', async () => {
    const result = await run({ op: 'elements', filter: { ifcTypes: ['IfcWall'] }, limit: 25, offset: 0 })

    expect(result.total).toBe(5)
    expect(result.totalIsLowerBound).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.summary).toBe('5 Bauteile erfüllen die Abfrage.')
  })

  it('counts without grouping', async () => {
    const result = await run({
      op: 'aggregate',
      filter: { ifcTypes: ['IfcWall'] },
      metric: 'count',
      limit: 50,
    })
    expect(result.groups).toEqual([{ key: null, elements: 5, metric: null }])
    expect(result.summary).toBe('5 Bauteile.')
  })

  it('groups counts by storey', async () => {
    const result = await run({ op: 'aggregate', filter: {}, metric: 'count', groupBy: 'storey', limit: 50 })
    expect(result.groups).toEqual(
      expect.arrayContaining([
        { key: 'Erdgeschoss', elements: 12, metric: null },
        { key: 'Obergeschoss', elements: 7, metric: null },
      ])
    )
  })

  it('sums a quantity across a filtered set', async () => {
    const result = await run({
      op: 'aggregate',
      filter: { ifcTypes: ['IfcSpace'] },
      metric: 'sum',
      quantity: 'NetFloorArea',
      limit: 50,
    })
    expect(result.groups?.[0].metric).toBe(69)
    expect(result.summary).toContain('sum(NetFloorArea) = 69')
  })

  it('sums a quantity per storey — the answer a Flächenaufstellung needs', async () => {
    const result = await run({
      op: 'aggregate',
      filter: { ifcTypes: ['IfcSpace'] },
      metric: 'sum',
      quantity: 'NetFloorArea',
      groupBy: 'storey',
      limit: 50,
    })
    expect(result.groups).toEqual(
      expect.arrayContaining([
        { key: 'Erdgeschoss', elements: 2, metric: 44.5 },
        { key: 'Obergeschoss', elements: 2, metric: 24.5 },
      ])
    )
  })

  it('groups by a property value', async () => {
    const result = await run({
      op: 'aggregate',
      filter: { ifcTypes: ['IfcWall'] },
      metric: 'count',
      groupBy: 'property',
      groupProperty: { set: 'Pset_WallCommon', name: 'FireRating' },
      limit: 50,
    })
    expect(result.groups).toEqual(
      expect.arrayContaining([
        { key: 'REI 90', elements: 3, metric: null },
        { key: 'EI 30', elements: 2, metric: null },
      ])
    )
  })

  it('counts each element once when grouping by material', async () => {
    const result = await run({
      op: 'aggregate',
      filter: { ifcTypes: ['IfcWall'] },
      metric: 'count',
      groupBy: 'material',
      limit: 50,
    })
    // Every wall's first layer is Stahlbeton; the three-layer external walls
    // must not be counted three times.
    expect(result.groups).toEqual([{ key: 'Stahlbeton', elements: 5, metric: null }])
  })

  it('reports the model health it computed at extraction', async () => {
    const result = await run({ op: 'health' })
    expect(result.health?.score).toBeGreaterThan(0)
    // The fixture is well-formed structurally; the findings it does have are
    // about missing optional information, not about broken structure.
    expect(result.health?.totals.error).toBe(0)
    expect(result.summary).toContain('Modellprüfung')
  })

  it('attaches no caveat when the model has nothing to qualify', async () => {
    // The fixture places every element in a storey and gives every room an
    // area, so a storey breakdown over it needs no disclaimer.
    const result = await run({ op: 'aggregate', filter: {}, metric: 'count', groupBy: 'storey', limit: 50 })
    expect(result.caveat).toBeNull()
  })

  it('builds the Raumbuch over the whole element set', async () => {
    // The Raumbuch reads rows through their own loader rather than the paged
    // element list, so this is the only place that proves the two agree — a
    // Flächenaufstellung short by a page is exactly the failure that would not
    // show up in a unit test over hand-made records.
    const result = await run({ op: 'schedule' })
    const schedule = result.schedule
    expect(schedule?.totals.rooms).toBe(4)
    expect(schedule?.totals.netFloorArea).toBe(69)
    expect(schedule?.storeys.map((storey) => storey.storeyName)).toEqual([
      'Erdgeschoss',
      'Obergeschoss',
    ])
    // Storey order is the summary's (by elevation), never alphabetical.
    expect(schedule?.storeys[0].rooms.length).toBeGreaterThan(0)
    expect(result.summary).toContain('Raumbuch')
  })

  it('sums a take-off per type and counts what publishes nothing', async () => {
    // Parsed through the schema rather than hand-built, so this exercises the
    // request an API caller actually sends — `filter` and `byMaterial` omitted,
    // filled in by the zod defaults.
    const result = await run(bimQuerySchema.parse({ op: 'takeoff', quantity: 'NetSideArea' }))
    const walls = result.takeoff?.find((row) => row.group === 'IfcWall')
    expect(walls?.elements).toBe(5)
    // Whatever the fixture publishes, the row must account for every element
    // in it: a sum plus its blind spot, never a sum alone.
    expect((walls?.missing ?? 0) + (walls?.value === null ? 0 : 1)).toBeGreaterThan(0)
    expect(result.summary).toContain('Massenermittlung')
  })

  it('splits a take-off by material without double-counting an element', async () => {
    const rows =
      (await run(bimQuerySchema.parse({ op: 'takeoff', quantity: 'NetSideArea', byMaterial: true })))
        .takeoff ?? []
    const wallRows = rows.filter((row) => row.group.startsWith('IfcWall'))
    // A wall with three material layers is still one wall. Grouping by the
    // PRIMARY material keeps the element counts summing back to the type total.
    expect(wallRows.reduce((sum, row) => sum + row.elements, 0)).toBe(5)
  })

  it('treats an absent filter as "every element" rather than crashing', async () => {
    // `buildBimPredicate` is reached with an unparsed request by the internal
    // route and by callers composing a query in code. A TypeError deep in
    // predicate building would surface as a 500 on a perfectly answerable
    // request, so the empty case is pinned here where the module is real.
    const { buildBimPredicate } = await import('./query')
    expect(buildBimPredicate(undefined)).toBeUndefined()
    expect(buildBimPredicate({})).toBeUndefined()
  })

  it('runs the OIB rule catalog over the whole element set', async () => {
    // The rules read published values, so this is the only place that proves
    // they read the values as STORED — a Pset merged occurrence-over-type and
    // round-tripped through jsonb, not a hand-made record.
    const result = await run(bimQuerySchema.parse({ op: 'compliance', gebaeudeklasse: 3 }))
    const rules = result.compliance ?? []
    expect(rules.length).toBeGreaterThan(0)
    // Every rule reports SOME state; none may silently vanish.
    for (const rule of rules) {
      expect(typeof rule.applicable).toBe('boolean')
      expect(rule.thresholdDe.length).toBeGreaterThan(0)
    }
    // The fixture's walls carry Pset_WallCommon.FireRating REI 90, so the
    // fire rule must actually decide rather than fall through to undecidable.
    const fire = rules.find((rule) => rule.ruleId === 'oib2-feuerwiderstand-tragend')
    expect(fire?.applicable).toBe(true)
    expect((fire?.passed ?? 0) + (fire?.failed ?? 0)).toBeGreaterThan(0)
    expect(result.summary).toContain('keine Rechtsauskunft')
  })

  it('stands a rule down rather than assuming a Gebaeudeklasse it was not given', async () => {
    const result = await run(bimQuerySchema.parse({ op: 'compliance' }))
    const fire = (result.compliance ?? []).find(
      (rule) => rule.ruleId === 'oib2-feuerwiderstand-tragend'
    )
    expect(fire?.applicable).toBe(false)
    expect(fire?.notApplicableReason).toContain('Gebäudeklasse')
  })

  it('derives project facts from the model, each with its evidence', async () => {
    const result = await run({ op: 'profile' })
    const suggestions = result.profileSuggestions ?? []
    const storeys = suggestions.find((entry) => entry.key === 'geschosse_oberirdisch')
    expect(storeys?.value).toBe(2)
    expect(storeys?.evidence).toContain('Erdgeschoss')
    // Never asserted as settled: every suggestion carries a confidence, and
    // the Fluchtniveau's can never be better than medium.
    expect(suggestions.find((entry) => entry.key === 'fluchtniveau')?.confidence).toBe('medium')
  })

  it('compares two revisions by GlobalId', async () => {
    const result = await runBimQuery(
      { op: 'compare', baseModelId: modelId, limit: 20_000 },
      { modelId: revisionModelId, organizationId: ORG }
    )
    const comparison = result.comparison
    expect(comparison?.added.map((entry) => entry.name)).toEqual(['Fluchttuer OG'])
    expect(comparison?.removed.map((entry) => entry.name)).toEqual(['Innenwand OG'])
    expect(comparison?.changed).toHaveLength(1)
    expect(comparison?.changed[0].name).toBe('Aussenwand Nord')
    expect(comparison?.changed[0].changes).toContainEqual({
      field: 'Pset_WallCommon.FireRating',
      before: 'REI 90',
      after: 'REI 30',
      delta: null,
    })
    expect(result.summary).toContain('1 neu, 1 entfallen, 1 geändert')
  })

  it('diffs the requirement status between two revisions', async () => {
    // The v2 fixture downgrades `Aussenwand Nord` from REI 90 to REI 30, which
    // at Gebäudeklasse 5 turns a passing rule into a failing one. This is the
    // only place that proves the op reads BOTH revisions from real SQL rather
    // than comparing a model against itself.
    const result = await runBimQuery(
      bimQuerySchema.parse({ op: 'compliance-diff', baseModelId: modelId, gebaeudeklasse: 5 }),
      { modelId: revisionModelId, organizationId: ORG }
    )
    const fire = (result.complianceChanges ?? []).find(
      (change) => change.ruleId === 'oib2-feuerwiderstand-tragend'
    )
    expect(fire?.trend).toBe('broken')
    expect(fire?.before.failed).toBeLessThan(fire?.after.failed ?? 0)
    expect(result.comparedWith).toBe('sample-building.ifc')
    expect(result.summary).toContain('neu nicht erfüllt')
  })

  it('reports nothing moved when a revision is compared with itself', async () => {
    const result = await runBimQuery(
      bimQuerySchema.parse({ op: 'compliance-diff', baseModelId: modelId, gebaeudeklasse: 5 }),
      { modelId, organizationId: ORG }
    )
    expect(result.complianceChanges).toEqual([])
    expect(result.summary).toContain('Keine Anforderung')
  })

  it('refuses a compliance diff against another tenant’s revision', async () => {
    await expect(
      runBimQuery(
        bimQuerySchema.parse({ op: 'compliance-diff', baseModelId: otherModelId }),
        { modelId, organizationId: ORG }
      )
    ).rejects.toBeInstanceOf(BimModelNotReadyError)
  })

  it('stores a human confirmation against the revision it was made on', async () => {
    const repository = await import('./repository')
    const { attachConfirmations, outstandingRules } = await import('./rules')

    await repository.upsertBimCheckConfirmation({
      organizationId: ORG,
      projectId: FIXTURE_PROJECT,
      ruleId: 'oib2-feuerwiderstand-tragend',
      modelId,
      confirmedBy: 'a.muster',
      note: 'Mit dem Brandschutzplaner abgeklärt.',
    })

    const stored = await repository.listBimCheckConfirmations(ORG, FIXTURE_PROJECT)
    expect(stored).toHaveLength(1)
    expect(stored[0].confirmedBy).toBe('a.muster')

    const confirmations = stored.map((entry) => ({
      ...entry,
      confirmedAt: entry.confirmedAt.toISOString(),
    }))
    const rules = await run(bimQuerySchema.parse({ op: 'compliance', gebaeudeklasse: 5 }))

    // Against the revision it was made on: covering.
    const current = attachConfirmations(rules.compliance ?? [], confirmations, modelId)
    expect(
      outstandingRules(current).map((rule) => rule.ruleId)
    ).not.toContain('oib2-feuerwiderstand-tragend')

    // Against a LATER revision: still recorded, no longer covering.
    const later = attachConfirmations(rules.compliance ?? [], confirmations, revisionModelId)
    const stale = later.find((rule) => rule.ruleId === 'oib2-feuerwiderstand-tragend')
    expect(stale?.confirmation).not.toBeNull()
    expect(stale?.confirmationStale).toBe(true)
  })

  it('re-confirming replaces the row rather than growing a history', async () => {
    const repository = await import('./repository')
    await repository.upsertBimCheckConfirmation({
      organizationId: ORG,
      projectId: FIXTURE_PROJECT,
      ruleId: 'oib2-feuerwiderstand-tragend',
      modelId: revisionModelId,
      confirmedBy: 'b.beispiel',
      note: null,
    })
    const stored = await repository.listBimCheckConfirmations(ORG, FIXTURE_PROJECT)
    // The unique constraint is the point: one current human verdict per rule.
    expect(stored).toHaveLength(1)
    expect(stored[0].confirmedBy).toBe('b.beispiel')
    expect(stored[0].modelId).toBe(revisionModelId)
  })

  it('never shows another tenant’s confirmations', async () => {
    const repository = await import('./repository')
    // The row exists for ORG; a missing tenant scope would return it here.
    expect(await repository.listBimCheckConfirmations(OTHER_ORG, FIXTURE_PROJECT)).toEqual([])
  })

  it('withdrawing a confirmation returns the rule to the catalogue’s verdict', async () => {
    const repository = await import('./repository')
    await repository.deleteBimCheckConfirmation({
      organizationId: ORG,
      projectId: FIXTURE_PROJECT,
      ruleId: 'oib2-feuerwiderstand-tragend',
    })
    expect(await repository.listBimCheckConfirmations(ORG, FIXTURE_PROJECT)).toEqual([])
  })

  it('exports the catalogue’s open items as a BCF an unzip can read', async () => {
    // The BCF unit tests build from hand-written verdicts. This one starts at
    // the fixture IFC and ends at bytes, so an element the catalogue flags but
    // the exporter cannot name would surface here and nowhere else.
    const { buildComplianceBcf } = await import('./bcf')
    const { attachConfirmations } = await import('./rules')

    const rules = await run(bimQuerySchema.parse({ op: 'compliance', gebaeudeklasse: 5 }))
    const bcf = buildComplianceBcf({
      projectId: FIXTURE_PROJECT,
      projectName: 'Integrationsfixture',
      model: {
        id: modelId,
        filename: 'sample-building.ifc',
        ifcProjectGlobalId: null,
        updatedAt: new Date('2026-05-04T09:30:15.400Z'),
      },
      results: attachConfirmations(rules.compliance ?? [], [], modelId),
      author: 'planer@example.at',
    })

    expect(bcf.topics).toBeGreaterThan(0)
    const archive = readZipEntries(bcf.bytes)
    expect([...archive.keys()][0]).toBe('bcf.version')

    // Every GlobalId the viewpoints select must be an element that really
    // exists in this model — a selection naming something else opens an empty
    // topic in the CAD.
    const known = new Set(index.elements.map((element) => element.globalId))
    const selected = [...archive.values()]
      .flatMap((content) => [...content.matchAll(/IfcGuid="([^"]+)"/g)])
      .map((match) => match[1])
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.filter((id) => !known.has(id))).toEqual([])
  })

  it('reports a model that is not ready as a retryable 409, not a crash', async () => {
    // `BimModelNotReadyError` was a bare `Error`, so `isAuthzError` did not
    // match it and the handler returned HTTP 500 "Internal server error" with
    // a stack per request. A 250 MB upload spends its first minute extracting;
    // every poll in that window read to the user as a crashed server.
    const { BimModelNotReadyError: Err } = await import('./query')
    const extracting = new Err('extracting', 'Model is still being extracted')
    const missing = new Err('failed', 'Model not found')

    expect(extracting.status).toBe(409)
    expect(extracting.code).toBe('MODEL_NOT_READY')
    expect(missing.status).toBe(404)
    // The status the model is in stays readable — the internal route branches
    // on it to tell the agent "still reading" from "extraction failed".
    expect(extracting.modelStatus).toBe('extracting')
  })

  it('refuses to answer for another tenant, even with the right model id', async () => {
    const { runBimQuery: run2 } = await import('./query')
    await expect(run2({ op: 'overview' }, { modelId, organizationId: OTHER_ORG })).rejects.toBeInstanceOf(
      BimModelNotReadyError
    )
  })

  it('never returns another tenant’s elements', async () => {
    // Same request, other tenant's model: the row exists, so a missing scope
    // would return 19 elements rather than a refusal.
    const result = await runBimQuery(
      { op: 'elements', filter: {}, limit: 200, offset: 0 },
      { modelId: otherModelId, organizationId: OTHER_ORG }
    )
    expect(result.total).toBe(19)

    await expect(
      runBimQuery({ op: 'elements', filter: {}, limit: 200, offset: 0 }, { modelId: otherModelId, organizationId: ORG })
    ).rejects.toBeInstanceOf(BimModelNotReadyError)
  })
})
