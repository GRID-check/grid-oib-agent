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
  let FIXTURE_PROJECT: string
  let index: BimModelIndex
  let runBimQuery: typeof import('./query').runBimQuery
  let bimQuerySchema: typeof import('./query').bimQuerySchema
  let BimModelNotReadyError: typeof import('./query').BimModelNotReadyError
  let closeDb: typeof import('@/lib/db').closeDb

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const { getDb, closeDb: close } = await import('@/lib/db')
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
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

    const db = getDb()
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

    const { elements, ...summary } = index
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
