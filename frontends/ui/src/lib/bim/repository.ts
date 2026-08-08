/**
 * BIM repository — the only module that talks to `bim_models` / `bim_elements`.
 *
 * Repository rules (docs/architecture/bff-service-architecture.md): drizzle
 * only, no HTTP, no object storage, no auth. Every query takes
 * `organizationId` and scopes on it, so tenancy holds in SQL and not merely in
 * the caller. `bim_elements` has no organization column of its own — the join
 * to `bim_models` is the scope, matching the row-level-security policy.
 */

import 'server-only'
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import {
  bimElements,
  bimModels,
  documents,
  type BimElementRow,
  type BimModelRow,
} from '@/lib/db/schema'
import type { BimElement, BimModelStatus, BimModelSummary } from './types'

/** Hard cap for any single element page the API will serve. */
export const BIM_ELEMENT_PAGE_LIMIT = 500

/** Rows per INSERT when writing an extraction result. */
const ELEMENT_INSERT_BATCH = 500

export interface BimModelHeader {
  id: string
  documentId: string
  projectId: string | null
  filename: string
  status: BimModelStatus
  schemaVersion: string | null
  elementCount: number
  errorMessage: string | null
  summary: BimModelSummary | null
  updatedAt: Date
}

/** Columns every model lookup returns, joined to the document's filename. */
const MODEL_COLUMNS = {
  id: bimModels.id,
  documentId: bimModels.documentId,
  projectId: bimModels.projectId,
  filename: documents.filename,
  status: bimModels.status,
  schemaVersion: bimModels.schemaVersion,
  elementCount: bimModels.elementCount,
  errorMessage: bimModels.errorMessage,
  summary: bimModels.summary,
  updatedAt: bimModels.updatedAt,
} as const

export async function findBimModelById(
  modelId: string,
  organizationId: string
): Promise<BimModelHeader | null> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select(MODEL_COLUMNS)
      .from(bimModels)
      .innerJoin(documents, eq(documents.id, bimModels.documentId))
      .where(and(eq(bimModels.id, modelId), eq(bimModels.organizationId, organizationId)))
      .limit(1)
  )
  return rows[0] ?? null
}

export async function findBimModelByDocument(
  documentId: string,
  organizationId: string
): Promise<BimModelHeader | null> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select(MODEL_COLUMNS)
      .from(bimModels)
      .innerJoin(documents, eq(documents.id, bimModels.documentId))
      .where(and(eq(bimModels.documentId, documentId), eq(bimModels.organizationId, organizationId)))
      .limit(1)
  )
  return rows[0] ?? null
}

/**
 * Models in a project, newest first, plus the org-wide Archiv models when
 * `includeArchiv` is set — the same scope rule document retrieval uses, so a
 * chat that can cite an Archiv document can also query its model.
 */
export async function listBimModels(
  organizationId: string,
  options: { projectId?: string | null; includeArchiv?: boolean; limit?: number } = {}
): Promise<BimModelHeader[]> {
  const db = getDb()
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 50)), 200)
  const scope =
    options.projectId === undefined
      ? undefined
      : options.includeArchiv
        ? sql`(${bimModels.projectId} = ${options.projectId} OR ${bimModels.projectId} IS NULL)`
        : options.projectId === null
          ? sql`${bimModels.projectId} IS NULL`
          : eq(bimModels.projectId, options.projectId)

  return withTenant({ organizationId }, () =>
    db
      .select(MODEL_COLUMNS)
      .from(bimModels)
      .innerJoin(documents, eq(documents.id, bimModels.documentId))
      .where(and(eq(bimModels.organizationId, organizationId), scope))
      .orderBy(desc(bimModels.updatedAt))
      .limit(limit)
  )
}

/**
 * Create (or reset) the model row for a document and mark it `extracting`.
 *
 * Idempotent on `document_id`: a re-ingest reuses the row rather than leaving
 * two models for one file, and clears the previous error and summary so a
 * failed extraction cannot leave stale facts visible next to a fresh attempt.
 */
export async function startBimModel(input: {
  organizationId: string
  projectId: string | null
  documentId: string
}): Promise<string> {
  const db = getDb()
  const rows = await withTenant({ organizationId: input.organizationId }, () =>
    db
      .insert(bimModels)
      .values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        documentId: input.documentId,
        status: 'extracting',
      })
      .onConflictDoUpdate({
        target: bimModels.documentId,
        set: {
          status: 'extracting',
          errorMessage: null,
          summary: null,
          schemaVersion: null,
          elementCount: 0,
          extractedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning({ id: bimModels.id })
  )
  return rows[0].id
}

export async function failBimModel(
  modelId: string,
  organizationId: string,
  errorMessage: string
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(bimModels)
      .set({ status: 'failed', errorMessage: errorMessage.slice(0, 2000), updatedAt: new Date() })
      .where(and(eq(bimModels.id, modelId), eq(bimModels.organizationId, organizationId)))
  )
}

/**
 * Write an extraction result: replace the element rows, then flip the model to
 * `ready` with its summary.
 *
 * One transaction, because a model whose summary says "1 240 elements" while
 * the element table holds the previous extraction's rows is worse than either
 * state alone — every count the agent reports would be drawn from a model that
 * never existed.
 */
export async function completeBimModel(input: {
  modelId: string
  organizationId: string
  summary: BimModelSummary
  elements: readonly BimElement[]
  indexStorageKey: string | null
  indexStorageBucket: string | null
}): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId: input.organizationId }, () =>
    db.transaction(async (tx) => {
      await tx.delete(bimElements).where(eq(bimElements.modelId, input.modelId))

      for (let offset = 0; offset < input.elements.length; offset += ELEMENT_INSERT_BATCH) {
        const batch = input.elements.slice(offset, offset + ELEMENT_INSERT_BATCH)
        await tx.insert(bimElements).values(
          batch.map((element) => ({
            modelId: input.modelId,
            globalId: element.globalId,
            expressId: element.expressId,
            ifcType: element.ifcType,
            name: element.name,
            predefinedType: element.predefinedType,
            objectType: element.objectType,
            tag: element.tag,
            typeName: element.typeName,
            storeyGlobalId: element.storeyGlobalId,
            storeyName: element.storeyName,
            containerKind: element.containerKind,
            containerName: element.containerName,
            materials: element.materials,
            classifications: element.classifications,
            properties: element.properties,
            quantities: element.quantities,
          }))
        )
      }

      await tx
        .update(bimModels)
        .set({
          status: 'ready',
          schemaVersion: input.summary.schema,
          summary: input.summary,
          elementCount: input.elements.length,
          indexStorageKey: input.indexStorageKey,
          indexStorageBucket: input.indexStorageBucket,
          errorMessage: null,
          extractedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(bimModels.id, input.modelId), eq(bimModels.organizationId, input.organizationId))
        )
    })
  )
}

/** Column subset the element list endpoints serve. */
export interface BimElementListRow {
  globalId: string
  expressId: number
  ifcType: string
  name: string | null
  predefinedType: string | null
  tag: string | null
  typeName: string | null
  storeyName: string | null
  materials: string[]
}

const ELEMENT_LIST_COLUMNS = {
  globalId: bimElements.globalId,
  expressId: bimElements.expressId,
  ifcType: bimElements.ifcType,
  name: bimElements.name,
  predefinedType: bimElements.predefinedType,
  tag: bimElements.tag,
  typeName: bimElements.typeName,
  storeyName: bimElements.storeyName,
  materials: bimElements.materials,
} as const

/**
 * The tenancy predicate for element queries: the element's model must belong to
 * the caller's organization. Row-level security enforces the same rule
 * underneath; this makes it true in the query as well, so a bug in one is not
 * the only thing standing between two tenants.
 */
function elementScope(modelId: string, organizationId: string) {
  return and(
    eq(bimElements.modelId, modelId),
    sql`EXISTS (SELECT 1 FROM ${bimModels} m WHERE m.id = ${bimElements.modelId} AND m.organization_id = ${organizationId})`
  )
}

export async function listBimElements(input: {
  modelId: string
  organizationId: string
  where?: ReturnType<typeof and>
  limit: number
  offset: number
}): Promise<{ rows: BimElementListRow[]; total: number }> {
  const db = getDb()
  const limit = Math.min(Math.max(1, Math.trunc(input.limit)), BIM_ELEMENT_PAGE_LIMIT)
  const offset = Math.max(0, Math.trunc(input.offset))
  const predicate = and(elementScope(input.modelId, input.organizationId), input.where)

  return withTenant({ organizationId: input.organizationId }, async () => {
    const [rows, totals] = await Promise.all([
      db
        .select(ELEMENT_LIST_COLUMNS)
        .from(bimElements)
        .where(predicate)
        .orderBy(asc(bimElements.ifcType), asc(bimElements.expressId))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(bimElements).where(predicate),
    ])
    return { rows, total: Number(totals[0]?.value ?? 0) }
  })
}

export async function findBimElement(
  modelId: string,
  organizationId: string,
  globalId: string
): Promise<BimElementRow | null> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(bimElements)
      .where(and(elementScope(modelId, organizationId), eq(bimElements.globalId, globalId)))
      .limit(1)
  )
  return rows[0] ?? null
}

/** Elements addressed by GlobalId — how a card's highlight list is resolved. */
export async function findBimElementsByGlobalIds(
  modelId: string,
  organizationId: string,
  globalIds: readonly string[]
): Promise<BimElementListRow[]> {
  if (globalIds.length === 0) return []
  const db = getDb()
  const bounded = globalIds.slice(0, BIM_ELEMENT_PAGE_LIMIT)
  return withTenant({ organizationId }, () =>
    db
      .select(ELEMENT_LIST_COLUMNS)
      .from(bimElements)
      .where(and(elementScope(modelId, organizationId), inArray(bimElements.globalId, bounded)))
      .limit(BIM_ELEMENT_PAGE_LIMIT)
  )
}

export interface BimGroupedCount {
  key: string | null
  elements: number
  metric: number | null
}

/**
 * Grouped aggregation over the filtered element set.
 *
 * `groupExpression` and `metricExpression` are built by `query.ts` from a
 * closed vocabulary — never from caller text — so no user string ever reaches
 * the SQL as syntax. Values inside them are bound parameters.
 */
export async function aggregateBimElements(input: {
  modelId: string
  organizationId: string
  where?: ReturnType<typeof and>
  groupExpression: ReturnType<typeof sql> | null
  metricExpression: ReturnType<typeof sql> | null
  limit: number
}): Promise<BimGroupedCount[]> {
  const db = getDb()
  const predicate = and(elementScope(input.modelId, input.organizationId), input.where)
  const limit = Math.min(Math.max(1, Math.trunc(input.limit)), BIM_ELEMENT_PAGE_LIMIT)
  const groupKey = input.groupExpression ?? sql<string | null>`NULL::text`
  const metric = input.metricExpression ?? sql<number | null>`NULL::numeric`

  const rows = await withTenant({ organizationId: input.organizationId }, () => {
    const query = db
      .select({
        key: sql<string | null>`${groupKey}`.as('group_key'),
        elements: count(),
        metric: sql<string | null>`${metric}`.as('metric'),
      })
      .from(bimElements)
      .where(predicate)
      .orderBy(desc(count()))
      .limit(limit)
    return input.groupExpression ? query.groupBy(sql`1`) : query
  })

  // `count()` comes back as a JS number, but SUM/AVG over numeric come back as
  // a STRING from node-postgres (numeric has no lossless JS representation).
  // Coercing at the repository boundary is the documented rule for raw SQL
  // results; skipping it would put "42.5" into a field typed `number`.
  return rows.map((row) => ({
    key: row.key ?? null,
    elements: Number(row.elements),
    metric: row.metric === null || row.metric === undefined ? null : Number(row.metric),
  }))
}

export interface BimPropertyCatalogEntry {
  /** Property-set name, e.g. `Pset_WallCommon`. */
  set: string
  /** Property name within the set, e.g. `FireRating`. */
  name: string
  /** `property` or `quantity` — which container the entry came from. */
  source: 'property' | 'quantity'
  /** How many elements carry this property at all. */
  elements: number
  /** The most common values, with occurrence counts. */
  values: Array<{ value: string; elements: number }>
}

/**
 * The model's own property vocabulary: which sets exist, which properties they
 * carry, and which values those properties actually take.
 *
 * This is what makes a filter answerable. An agent that guesses
 * `Pset_WallCommon.FireResistance` (a plausible name that no exporter writes)
 * gets zero rows and reports "no fire-rated walls", which is a wrong answer
 * dressed as a right one. Reading the catalog first turns that into a filter on
 * `FireRating` with a value the model actually contains.
 */
export async function listBimPropertyCatalog(input: {
  modelId: string
  organizationId: string
  ifcType?: string
  maxValues: number
}): Promise<BimPropertyCatalogEntry[]> {
  const db = getDb()
  const maxValues = Math.min(Math.max(1, Math.trunc(input.maxValues)), 50)
  const typeFilter = input.ifcType
    ? sql`AND lower(e.ifc_type) = lower(${input.ifcType})`
    : sql``

  // One pass over the model's elements, unnesting property and quantity sets
  // together so both vocabularies come back in one round trip. The value list
  // is cut per property inside the query (`row_number`), not in JS, so a model
  // with 40 000 distinct values never materialises them all.
  const rows = await withTenant({ organizationId: input.organizationId }, () =>
    db.execute<{
      set_name: string
      prop_name: string
      source: 'property' | 'quantity'
      element_total: string
      values: Array<{ value: string; elements: number }> | null
    }>(sql`
      WITH scoped AS (
        SELECT e.id, e.properties, e.quantities
        FROM bim_elements e
        WHERE e.model_id = ${input.modelId}
          AND EXISTS (
            SELECT 1 FROM bim_models m
            WHERE m.id = e.model_id AND m.organization_id = ${input.organizationId}
          )
          ${typeFilter}
      ),
      pairs AS (
        SELECT s.set_name, p.prop_name, 'property'::text AS source, p.prop_value #>> '{}' AS value
        FROM scoped e, jsonb_each(e.properties) AS s(set_name, set_value),
             jsonb_each(s.set_value) AS p(prop_name, prop_value)
        UNION ALL
        SELECT s.set_name, p.prop_name, 'quantity'::text AS source, p.prop_value #>> '{}' AS value
        FROM scoped e, jsonb_each(e.quantities) AS s(set_name, set_value),
             jsonb_each(s.set_value) AS p(prop_name, prop_value)
      ),
      counted AS (
        SELECT set_name, prop_name, source, value, count(*) AS occurrences
        FROM pairs
        GROUP BY set_name, prop_name, source, value
      ),
      ranked AS (
        SELECT *, row_number() OVER (
          PARTITION BY set_name, prop_name, source ORDER BY occurrences DESC, value ASC
        ) AS rank
        FROM counted
      )
      SELECT set_name, prop_name, source,
             sum(occurrences)::text AS element_total,
             jsonb_agg(
               jsonb_build_object('value', value, 'elements', occurrences)
               ORDER BY occurrences DESC, value ASC
             ) FILTER (WHERE rank <= ${maxValues}) AS values
      FROM ranked
      GROUP BY set_name, prop_name, source
      ORDER BY source ASC, set_name ASC, prop_name ASC
    `)
  )

  return Array.from(rows).map((row) => ({
    set: row.set_name,
    name: row.prop_name,
    source: row.source,
    // sum() over bigint arrives as a string from node-postgres; coerce here
    // rather than let "12" reach a field typed number.
    elements: Number(row.element_total),
    values: (row.values ?? []).map((entry) => ({
      value: entry.value,
      elements: Number(entry.elements),
    })),
  }))
}

/**
 * Every element of a model, in full, for a revision comparison.
 *
 * Deliberately unpaginated and deliberately bounded by `limit`: a comparison is
 * a set operation over two whole models, so streaming pages would just
 * reassemble the same array with more round trips — but an unbounded read of a
 * 200 000-element model into the BFF is a memory event, so the caller states a
 * ceiling and is told when it was hit.
 */
export async function loadBimElementsForComparison(
  modelId: string,
  organizationId: string,
  limit: number
): Promise<{ elements: BimElement[]; truncated: boolean }> {
  const db = getDb()
  const bounded = Math.max(1, Math.trunc(limit))
  const rows = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(bimElements)
      .where(elementScope(modelId, organizationId))
      .orderBy(asc(bimElements.expressId))
      // One more than asked for, so "was there more" is answered by the query
      // rather than guessed from whether the page came back full.
      .limit(bounded + 1)
  )
  const truncated = rows.length > bounded
  return {
    elements: rows.slice(0, bounded).map((row) => ({
      globalId: row.globalId,
      expressId: row.expressId,
      ifcType: row.ifcType,
      name: row.name,
      description: null,
      predefinedType: row.predefinedType,
      objectType: row.objectType,
      tag: row.tag,
      typeName: row.typeName,
      containerKind: (row.containerKind as BimElement['containerKind']) ?? null,
      containerGlobalId: null,
      containerName: row.containerName,
      storeyGlobalId: row.storeyGlobalId,
      storeyName: row.storeyName,
      materials: row.materials,
      classifications: row.classifications,
      properties: row.properties,
      quantities: row.quantities,
    })),
    truncated,
  }
}

/** Element rows needed to render the viewer's element table for one storey. */
export async function countBimElementsByType(
  modelId: string,
  organizationId: string
): Promise<Array<{ ifcType: string; elements: number }>> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ ifcType: bimElements.ifcType, elements: count() })
      .from(bimElements)
      .where(elementScope(modelId, organizationId))
      .groupBy(bimElements.ifcType)
      .orderBy(desc(count()))
  )
  return rows.map((row) => ({ ifcType: row.ifcType, elements: Number(row.elements) }))
}

export type { BimModelRow, BimElementRow }
