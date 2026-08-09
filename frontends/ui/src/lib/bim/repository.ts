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
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import {
  bimCheckConfirmations,
  bimElements,
  bimModels,
  documents,
  type BimElementRow,
  type BimModelRow,
} from '@/lib/db/schema'
import { buildSearchKeys, buildStoredRuleInputs } from './rule-inputs'
import type { StoredRuleInputs } from './rule-inputs'
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
  /**
   * Whether the GIN pre-filter may be used against this model's elements —
   * `bim_models.search_keys_indexed`. Read by `buildBimPredicate`; false means
   * the property filters fall back to the unnest alone.
   */
  searchKeysIndexed: boolean
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
  searchKeysIndexed: bimModels.searchKeysIndexed,
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
            searchKeys: buildSearchKeys(element),
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
          // Computed here, inside the same transaction that writes the
          // elements, so the FIRST person to open the Prüfbuch gets the fast
          // path too. Extraction already holds every element in memory; the
          // projection is a map over them and costs nothing next to the parse
          // that produced them.
          ruleInputs: buildStoredRuleInputs(input.elements, false),
          // Set in the SAME transaction that wrote the elements above, so the
          // flag cannot claim an index the rows do not have. An older image
          // extracting a model during a rolling deploy never reaches this line
          // and leaves the flag false, which reads as "unnest only".
          searchKeysIndexed: true,
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

/**
 * Past this the total is reported as a lower bound. Well beyond any page a
 * person scrolls, and far short of the point where counting gets expensive.
 */
export const COUNT_CEILING = 10_000

/**
 * One filter, compiled three ways, because there is no single fastest way.
 *
 * A property filter can be served by two completely different plans and the
 * right one depends on how many elements match — which is exactly what nobody
 * knows in advance. Measured on a seeded 200 000-element model:
 *
 *                                    matches 1      matches 50 000
 *   GIN pre-filter, bitmap plan          5 ms            1 692 ms
 *   ordered walk, no pre-filter      5 877 ms                3 ms
 *
 * A thousandfold either way. Postgres cannot pick between them: jsonb
 * containment has no statistics, so `@>` is costed at a hardcoded 0.5 %
 * selectivity and the planner took the bitmap in both cases above. So the
 * choice is made in {@link listBimElements}, from counts it measures — and
 * these are the three shapes it picks from.
 */
export interface BimElementQueryPlan {
  /** The predicate as written: GIN pre-filter AND the exact unnest. */
  assisted: SQL | undefined
  /**
   * The same question with the pre-filter removed. Identical results — the
   * pre-filter is a necessary condition, never part of the answer — but it
   * leaves the planner free to walk `(model_id, ifc_type, express_id)` in
   * order and stop at the last row of the page.
   */
  unassisted: SQL | undefined
  /**
   * The indexable half alone: a SUPERSET of what `assisted` matches, used to
   * count candidates. `null` when there is nothing to count, either because
   * the model is not indexed or because no property filter contributes a
   * pre-filter — in which case there is no choice to make.
   */
  candidates: SQL | undefined | null
}

/**
 * Rows either plan is allowed to touch before it counts as the wrong one.
 *
 * Both plans cost roughly the same per row they examine — a heap fetch plus a
 * `jsonb_each` unnest, measured at 33 µs (bitmap) and 29 µs (ordered walk) —
 * so "which plan" is just "which reads fewer rows", and this is the budget
 * that answers it. At 2 000 rows either plan lands around 60 ms, and the
 * candidate probe that measures against it costs 66 ms at its cap.
 */
export const PLAN_ROW_BUDGET = 2_000

/**
 * Which of the two plans reads fewer rows.
 *
 * Both cost about the same per row examined — a heap fetch plus a `jsonb_each`
 * unnest, 33 µs on the bitmap side and 29 µs on the walk — so the comparison is
 * just row counts, and the only judgement in it is the budget.
 *
 * Deliberately conservative in one direction: the walk is taken only when it is
 * PROVABLY cheap and the pre-filter is PROVABLY not narrow. Everything
 * uncertain keeps the pre-filter, which is the plan that cannot be catastrophic
 * — its worst case is bounded by how many candidates exist, whereas the walk's
 * worst case is the whole model.
 *
 * @param matched      Elements the filter matches, capped at `COUNT_CEILING`.
 * @param candidates   Elements the pre-filter admits, capped at the budget + 1;
 *                     `null` when no pre-filter exists and there is no choice.
 * @param rowsNeeded   `limit + offset` — how far into the ordering the page ends.
 * @param elementCount Rows the model has.
 */
export function shouldWalkOrdered(input: {
  matched: number
  candidates: number | null
  rowsNeeded: number
  elementCount: number
}): boolean {
  if (input.candidates === null || input.candidates <= PLAN_ROW_BUDGET) return false
  // Matches are spread through the ordering, so the walk reads about one page's
  // worth for every `matched / elementCount` of the table. None at all means it
  // reads the table.
  const walkRows =
    input.matched > 0
      ? Math.ceil((input.rowsNeeded * input.elementCount) / input.matched)
      : input.elementCount
  return walkRows <= PLAN_ROW_BUDGET
}

/** What a page cost, for the caller that wants to know which plan ran. */
export interface BimElementPage {
  rows: BimElementListRow[]
  total: number
  totalIsLowerBound: boolean
  /** `true` when the ordered walk served the page instead of the GIN index. */
  walked: boolean
}

/**
 * One page of elements, plus its total, planned rather than guessed.
 *
 * The GIN pre-filter and the ordered `(model_id, ifc_type, express_id)` walk
 * are each catastrophic in the other's regime — 5 ms vs 5 877 ms for a filter
 * matching one element, 1 692 ms vs 3 ms for one matching a quarter of the
 * model — and Postgres picks the bitmap plan in BOTH cases, because jsonb
 * containment has no statistics and `@>` is costed at a flat 0.5 %.
 *
 * So the two numbers the choice needs are measured first, in one round trip:
 * how many elements MATCH (bounded, and needed for `total` anyway) and how
 * many the pre-filter would hand to the bitmap plan (bounded at
 * {@link PLAN_ROW_BUDGET}). The walk is taken only when it is provably cheap —
 * fewer than the budget's worth of rows to reach the end of the page — and the
 * pre-filter is provably not narrow. Everything else keeps the pre-filter.
 *
 * The choice can only ever be wrong about SPEED: `assisted` and `unassisted`
 * are the same question, and the integration suite asserts they return the
 * same elements.
 */
export async function listBimElements(input: {
  modelId: string
  organizationId: string
  plan: BimElementQueryPlan
  /** Rows this model has, for estimating how far an ordered walk must read. */
  elementCount: number
  limit: number
  offset: number
}): Promise<BimElementPage> {
  const db = getDb()
  const limit = Math.min(Math.max(1, Math.trunc(input.limit)), BIM_ELEMENT_PAGE_LIMIT)
  const offset = Math.max(0, Math.trunc(input.offset))
  const scope = elementScope(input.modelId, input.organizationId)
  const assisted = and(scope, input.plan.assisted)
  const candidates = input.plan.candidates ? and(scope, input.plan.candidates) : null

  return withTenant({ organizationId: input.organizationId }, async () => {
    // Counted through a bounded subquery, not `count(*)` over the whole
    // predicate. The row half stops at `limit`; an exact total cannot, so on a
    // filtered 400 000-element model it was the slower half of the pair by an
    // order of magnitude — 15.8 s warm, 21.9 s cold, holding a second pool slot
    // the entire time. Nothing in the product needs an exact figure past the
    // cap; it needs to know there are more.
    //
    // The candidate count rides along in the same statement as a second scalar
    // subquery, so measuring the plan costs a subquery rather than a round
    // trip. Both counts always use the pre-filter: a bounded count stops early
    // in either regime, so it has no two-plan problem of its own.
    const counts = await db.execute<{ matches: number; candidates: number | null }>(sql`
      SELECT
        (
          SELECT count(*)::int
          FROM (SELECT 1 FROM ${bimElements} WHERE ${assisted} LIMIT ${COUNT_CEILING + 1}) m
        ) AS matches,
        ${
          candidates
            ? sql`(
                SELECT count(*)::int
                FROM (SELECT 1 FROM ${bimElements} WHERE ${candidates} LIMIT ${PLAN_ROW_BUDGET + 1}) c
              )`
            : sql`NULL::int`
        } AS candidates
    `)
    const row = Array.from(counts)[0]
    const matched = Number(row?.matches ?? 0)
    const candidateRows = row?.candidates === null || row?.candidates === undefined
      ? null
      : Number(row.candidates)

    const walked = shouldWalkOrdered({
      matched,
      candidates: candidateRows,
      rowsNeeded: limit + offset,
      elementCount: input.elementCount,
    })

    const rows = await db
      .select(ELEMENT_LIST_COLUMNS)
      .from(bimElements)
      .where(walked ? and(scope, input.plan.unassisted) : assisted)
      .orderBy(asc(bimElements.ifcType), asc(bimElements.expressId))
      .limit(limit)
      .offset(offset)

    // The subquery is allowed one row past the ceiling purely so the two cases
    // are distinguishable; reporting that row would put a `total` of 10 001 on
    // a model with 400 000 matches, which is wrong twice over. Past the ceiling
    // the number means "at least this many" and the flag says so.
    const totalIsLowerBound = matched > COUNT_CEILING
    return {
      rows,
      total: totalIsLowerBound ? COUNT_CEILING : matched,
      totalIsLowerBound,
      walked,
    }
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
  /**
   * How many of the SCANNED elements carry this property. Equal to the number
   * in the model when {@link BimPropertyCatalog.complete} is true, and a count
   * within the sample when it is not.
   */
  elements: number
  /** The most common values, with occurrence counts over the same scan. */
  values: Array<{ value: string; elements: number }>
}

export interface BimPropertyCatalog {
  entries: BimPropertyCatalogEntry[]
  /** Elements actually read to build {@link entries}. */
  scanned: number
  /** Elements in scope — the whole model, or one IFC type of it. */
  total: number
  /** `false` when `entries` describes a sample rather than every element. */
  complete: boolean
}

/**
 * Past this many in-scope elements the catalog reads a sample instead.
 *
 * The unnest is the cost: a realistic element carries ~29 property and
 * quantity pairs, so the old unbounded query produced `Append (actual
 * rows=11600000)` on a seeded 400 000-element model and two sorts of 45-48 MB
 * against a 4 MB `work_mem` — measured at over the 30 s `statement_timeout`,
 * which reached the caller as HTTP 500. At this ceiling the same unnest is
 * ~145 000 rows.
 */
export const PROPERTY_CATALOG_SCAN_LIMIT = 5_000

/**
 * Bounds on the per-type slice of a sampled scan.
 *
 * Sampling is stratified BY IFC TYPE rather than taken off the top, because
 * property vocabulary is a function of the type — walls carry
 * `Pset_WallCommon`, doors carry `Pset_DoorCommon` — and rows come back from
 * the `(model_id, ifc_type)` index in type order. A flat `LIMIT 5000` would
 * therefore report the vocabulary of whichever types sort first and omit the
 * rest entirely: not an imprecise catalog, a wrong one. Within a type the
 * vocabulary is near-uniform, so a couple of hundred elements describe it.
 */
const PER_TYPE_MIN = 25
const PER_TYPE_MAX = 200

/**
 * The model's own property vocabulary: which sets exist, which properties they
 * carry, and which values those properties actually take.
 *
 * This is what makes a filter answerable. An agent that guesses
 * `Pset_WallCommon.FireResistance` (a plausible name that no exporter writes)
 * gets zero rows and reports "no fire-rated walls", which is a wrong answer
 * dressed as a right one. Reading the catalog first turns that into a filter on
 * `FireRating` with a value the model actually contains.
 *
 * Large models are answered from a sample — see
 * {@link PROPERTY_CATALOG_SCAN_LIMIT} — and say so in
 * {@link BimPropertyCatalog.complete}. The names, which is what the catalog is
 * for, survive sampling; the counts become counts over what was read, and the
 * caller must not present them as the model's.
 */
export async function listBimPropertyCatalog(input: {
  modelId: string
  organizationId: string
  ifcType?: string
  maxValues: number
}): Promise<BimPropertyCatalog> {
  const db = getDb()
  const maxValues = Math.min(Math.max(1, Math.trunc(input.maxValues)), 50)
  const typeFilter = input.ifcType
    ? sql`AND lower(e.ifc_type) = lower(${input.ifcType})`
    : sql``
  const tenantScope = sql`
    EXISTS (
      SELECT 1 FROM bim_models m
      WHERE m.id = e.model_id AND m.organization_id = ${input.organizationId}
    )
  `

  return withTenant({ organizationId: input.organizationId }, async () => {
    // How big the job is, before committing to it. An index-only scan of
    // `bim_elements_model_type_idx` — it never touches the jsonb, which is the
    // part that costs.
    const typeRows = await db.execute<{ ifc_type: string; elements: string }>(sql`
      SELECT e.ifc_type, count(*)::text AS elements
      FROM bim_elements e
      WHERE e.model_id = ${input.modelId} AND ${tenantScope} ${typeFilter}
      GROUP BY e.ifc_type
    `)
    const types = Array.from(typeRows).map((row) => ({
      ifcType: row.ifc_type,
      // count(*) over bigint arrives as a string from node-postgres.
      elements: Number(row.elements),
    }))
    const total = types.reduce((sum, type) => sum + type.elements, 0)
    if (total === 0) return { entries: [], scanned: 0, total: 0, complete: true }

    const perType =
      total <= PROPERTY_CATALOG_SCAN_LIMIT
        ? null
        : Math.min(
            PER_TYPE_MAX,
            Math.max(PER_TYPE_MIN, Math.floor(PROPERTY_CATALOG_SCAN_LIMIT / types.length))
          )
    const scanned =
      perType === null
        ? total
        : types.reduce((sum, type) => sum + Math.min(type.elements, perType), 0)

    const scoped =
      perType === null
        ? sql`
            SELECT e.properties, e.quantities
            FROM bim_elements e
            WHERE e.model_id = ${input.modelId} AND ${tenantScope} ${typeFilter}
          `
        : sql`
            SELECT slice.properties, slice.quantities
            FROM (VALUES ${sql.join(
              types.map((type) => sql`(${type.ifcType}::text)`),
              sql`, `
            )}) AS t(ifc_type)
            CROSS JOIN LATERAL (
              SELECT e.properties, e.quantities
              FROM bim_elements e
              WHERE e.model_id = ${input.modelId}
                AND e.ifc_type = t.ifc_type
                AND ${tenantScope}
              LIMIT ${perType}
            ) slice
          `

    // One pass over the scoped elements, unnesting property and quantity sets
    // together so both vocabularies come back in one round trip. The value list
    // is cut per property inside the query (`row_number`), not in JS, so a model
    // with 40 000 distinct values never materialises them all.
    const rows = await db.execute<{
      set_name: string
      prop_name: string
      source: 'property' | 'quantity'
      element_total: string
      values: Array<{ value: string; elements: number }> | null
    }>(sql`
      WITH scoped AS (${scoped}),
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

    return {
      entries: Array.from(rows).map((row) => ({
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
      })),
      scanned,
      total,
      complete: perType === null,
    }
  })
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
  return { elements: rows.slice(0, bounded).map(toBimElement), truncated: rows.length > bounded }
}

/**
 * Row → domain element.
 *
 * `description` and `containerGlobalId` are not columns: they are only used by
 * the extractor and the viewer's own index, and storing them would widen the
 * table for two fields no query reads.
 */
function toBimElement(row: BimElementRow): BimElement {
  return {
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
  }
}

/**
 * Elements for a whole-model derivation (Raumbuch, Massenermittlung, profile).
 *
 * Same shape as the comparison loader but takes a predicate, because a take-off
 * is usually over a filtered set ("every load-bearing wall") while a room
 * schedule is over all of them. Bounded by the same cap for the same reason.
 */
/**
 * The precomputed rule inputs for a model, or `null` when it has none.
 *
 * One column of one row: no `jsonb_each`, no per-element work, one parse. This
 * is the read that replaces a 50 000-row, ~60 MB scan on the compliance path.
 */
export async function loadBimRuleInputs(
  modelId: string,
  organizationId: string
): Promise<unknown | null> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ ruleInputs: bimModels.ruleInputs })
      .from(bimModels)
      .where(and(eq(bimModels.id, modelId), eq(bimModels.organizationId, organizationId)))
      .limit(1)
  )
  return rows[0]?.ruleInputs ?? null
}

/** Persist the projection so the next reader does not repeat the scan. */
export async function saveBimRuleInputs(
  modelId: string,
  organizationId: string,
  ruleInputs: StoredRuleInputs
): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(bimModels)
      .set({ ruleInputs })
      .where(and(eq(bimModels.id, modelId), eq(bimModels.organizationId, organizationId)))
  )
}

export async function loadBimElementsForSchedule(
  modelId: string,
  organizationId: string,
  where?: ReturnType<typeof and>,
  limit = 50_000
): Promise<{ elements: BimElement[]; truncated: boolean }> {
  const db = getDb()
  const bounded = Math.max(1, Math.trunc(limit))
  const rows = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(bimElements)
      .where(and(elementScope(modelId, organizationId), where))
      .orderBy(asc(bimElements.expressId))
      .limit(bounded + 1)
  )
  return {
    elements: rows.slice(0, bounded).map(toBimElement),
    truncated: rows.length > bounded,
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

// ---------------------------------------------------------------------------
// Human confirmations on rule verdicts
// ---------------------------------------------------------------------------

/** One rule an architect settled themselves, as stored. */
export interface BimStoredConfirmation {
  ruleId: string
  modelId: string
  confirmedBy: string
  note: string | null
  confirmedAt: Date
}

export async function listBimCheckConfirmations(
  organizationId: string,
  projectId: string
): Promise<BimStoredConfirmation[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({
        ruleId: bimCheckConfirmations.ruleId,
        modelId: bimCheckConfirmations.modelId,
        confirmedBy: bimCheckConfirmations.confirmedBy,
        note: bimCheckConfirmations.note,
        confirmedAt: bimCheckConfirmations.updatedAt,
      })
      .from(bimCheckConfirmations)
      .where(
        and(
          eq(bimCheckConfirmations.organizationId, organizationId),
          eq(bimCheckConfirmations.projectId, projectId)
        )
      )
  )
  return rows
}

/**
 * Record (or re-record) a human verdict on one rule.
 *
 * Upserts on (organization, project, rule): a rule has exactly one current
 * human verdict, and re-confirming against a newer revision REPLACES the old
 * one rather than growing a history nobody reads. `model_id` moves with it,
 * which is what clears the stale flag.
 */
export async function upsertBimCheckConfirmation(input: {
  organizationId: string
  projectId: string
  ruleId: string
  modelId: string
  confirmedBy: string
  note: string | null
}): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId: input.organizationId }, () =>
    db
      .insert(bimCheckConfirmations)
      .values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        ruleId: input.ruleId,
        modelId: input.modelId,
        confirmedBy: input.confirmedBy,
        note: input.note,
      })
      .onConflictDoUpdate({
        target: [
          bimCheckConfirmations.organizationId,
          bimCheckConfirmations.projectId,
          bimCheckConfirmations.ruleId,
        ],
        set: {
          modelId: input.modelId,
          confirmedBy: input.confirmedBy,
          note: input.note,
          updatedAt: new Date(),
        },
      })
  )
}

/** Withdraw a confirmation — the rule returns to whatever the catalogue says. */
export async function deleteBimCheckConfirmation(input: {
  organizationId: string
  projectId: string
  ruleId: string
}): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId: input.organizationId }, () =>
    db
      .delete(bimCheckConfirmations)
      .where(
        and(
          eq(bimCheckConfirmations.organizationId, input.organizationId),
          eq(bimCheckConfirmations.projectId, input.projectId),
          eq(bimCheckConfirmations.ruleId, input.ruleId)
        )
      )
  )
}
