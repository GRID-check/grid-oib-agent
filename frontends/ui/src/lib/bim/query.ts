/**
 * The BIM query contract — "talk to your model", made deterministic.
 *
 * Retrieval-augmented answers are the right tool for a *document*: the text is
 * the truth and a language model reading it is the best available reader. A
 * model is not a document. "How many external walls are on the ground floor" has
 * one correct answer, it is a `COUNT(*)` with a `WHERE`, and no amount of
 * retrieved prose makes an LLM good at arithmetic over 40 000 elements.
 *
 * So model questions do not go through retrieval. They come here, get
 * translated into SQL against `bim_elements`, and come back as numbers the
 * agent reports rather than derives. The digest (`digest.ts`) still feeds the
 * retriever, because "is there a model, and what is it of" is a document-shaped
 * question — but every count, sum and filter is answered here.
 *
 * The request vocabulary is CLOSED. Every field is validated against an enum or
 * a schema before it reaches SQL, and every value is a bound parameter, so a
 * model-authored filter cannot become model-authored SQL.
 */

import 'server-only'
import { and, ilike, inArray, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { bimElements } from '@/lib/db/schema'
import {
  aggregateBimElements,
  countBimElementsByType,
  findBimElement,
  findBimModelById,
  listBimElements,
  loadBimElementsForComparison,
  loadBimElementsForSchedule,
  listBimPropertyCatalog,
  type BimElementListRow,
  type BimGroupedCount,
  type BimModelHeader,
  type BimPropertyCatalogEntry,
} from './repository'
import { compareModels, renderComparison, type BimComparison } from './compare'
import { deriveProfileSuggestions, renderProfileSuggestions, type BimProfileSuggestion } from './profile'
import {
  buildQuantityTakeoff,
  buildRoomSchedule,
  type BimQuantityRow,
  type BimRoomSchedule,
} from './schedule'
import { healthCaveat, type BimHealth } from './validate'
import type { BimModelSummary } from './types'

/** Comparison operators a property filter may use. */
export const BIM_FILTER_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
  'missing',
] as const
export type BimFilterOperator = (typeof BIM_FILTER_OPERATORS)[number]

const propertyFilterSchema = z
  .object({
    /**
     * Property-set name (`Pset_WallCommon`). Optional: omitted, the property is
     * looked for in every set, which is what a person means by "fire rating".
     */
    set: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1).max(120),
    operator: z.enum(BIM_FILTER_OPERATORS).default('eq'),
    value: z.union([z.string().max(400), z.number(), z.boolean()]).optional(),
    /** Search quantity sets instead of property sets. */
    source: z.enum(['property', 'quantity']).default('property'),
  })
  .refine(
    (filter) =>
      filter.operator === 'exists' || filter.operator === 'missing' || filter.value !== undefined,
    { message: 'operator requires a value' }
  )

export type BimPropertyFilter = z.infer<typeof propertyFilterSchema>

export const bimFilterSchema = z.object({
  /** Canonical IFC type names (`IfcWall`). Matched case-insensitively. */
  ifcTypes: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
  /** Storey names or storey GlobalIds. */
  storeys: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
  /** Substring match on the element name, case-insensitive. */
  nameContains: z.string().trim().min(1).max(200).optional(),
  /** Substring match on any associated material name. */
  material: z.string().trim().min(1).max(200).optional(),
  /** Substring match on a classification code or label. */
  classification: z.string().trim().min(1).max(200).optional(),
  /** Element GlobalIds — used to resolve a card's highlight list. */
  globalIds: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
  properties: z.array(propertyFilterSchema).max(10).optional(),
})

export type BimFilter = z.infer<typeof bimFilterSchema>

export const BIM_GROUP_BY = [
  'ifcType',
  'storey',
  'predefinedType',
  'typeName',
  'material',
  'property',
] as const
export type BimGroupBy = (typeof BIM_GROUP_BY)[number]

export const BIM_METRICS = ['count', 'sum', 'avg', 'min', 'max'] as const

const aggregateSchema = z.object({
  op: z.literal('aggregate'),
  filter: bimFilterSchema.default({}),
  metric: z.enum(BIM_METRICS).default('count'),
  /** Quantity to aggregate. Required for every metric except `count`. */
  quantity: z.string().trim().min(1).max(120).optional(),
  quantitySet: z.string().trim().min(1).max(120).optional(),
  groupBy: z.enum(BIM_GROUP_BY).optional(),
  /** Property to group by; required when `groupBy` is `property`. */
  groupProperty: z
    .object({ set: z.string().trim().min(1).max(120), name: z.string().trim().min(1).max(120) })
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
})

export const bimQuerySchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('overview') }),
  z.object({ op: z.literal('health') }),
  z.object({ op: z.literal('schedule') }),
  z.object({ op: z.literal('profile') }),
  z.object({
    op: z.literal('takeoff'),
    quantity: z.string().trim().min(1).max(120).default('NetSideArea'),
    byMaterial: z.boolean().default(false),
    filter: bimFilterSchema.default({}),
  }),
  z.object({
    op: z.literal('compare'),
    /**
     * The OTHER model, by id — the OLDER revision; this model is the newer one.
     *
     * Optional in the schema because the internal endpoint resolves it from a
     * file name for the agent, which never handles ids. `runBimQuery` refuses a
     * request that still lacks it, so the field is optional to PARSE and
     * required to RUN.
     */
    baseModelId: z.string().uuid().optional(),
    /** Ceiling on elements read per side. */
    limit: z.number().int().min(100).max(50_000).default(20_000),
  }),
  z.object({ op: z.literal('types') }),
  z.object({
    op: z.literal('elements'),
    filter: bimFilterSchema.default({}),
    limit: z.number().int().min(1).max(200).default(25),
    offset: z.number().int().min(0).max(100_000).default(0),
  }),
  z.object({ op: z.literal('element'), globalId: z.string().trim().min(1).max(64) }),
  z.object({
    op: z.literal('properties'),
    ifcType: z.string().trim().min(1).max(80).optional(),
    /** Cap on distinct values reported per property. */
    maxValues: z.number().int().min(1).max(50).default(10),
  }),
  aggregateSchema,
])

export type BimQuery = z.infer<typeof bimQuerySchema>

export interface BimQueryResult {
  op: BimQuery['op']
  model: {
    id: string
    filename: string
    schema: string | null
    elementCount: number
  }
  /** Rendered, human-readable answer — what the agent quotes. */
  summary: string
  overview?: BimModelSummary
  health?: BimHealth
  /**
   * The qualification an answer over this model has to carry — orphaned
   * elements, rooms with no area, duplicated ids. Attached to every op whose
   * result those defects would silently distort, so an agent cannot report a
   * per-storey count without also being handed the reason it might be short.
   */
  caveat?: string | null
  comparison?: BimComparison
  schedule?: BimRoomSchedule
  takeoff?: BimQuantityRow[]
  profileSuggestions?: BimProfileSuggestion[]
  types?: Array<{ ifcType: string; elements: number }>
  elements?: BimElementListRow[]
  element?: Awaited<ReturnType<typeof findBimElement>>
  properties?: BimPropertyCatalogEntry[]
  groups?: BimGroupedCount[]
  total?: number
  truncated?: boolean
}

export class BimModelNotReadyError extends Error {
  readonly status: BimModelHeader['status']

  constructor(status: BimModelHeader['status'], message: string) {
    super(message)
    this.name = 'BimModelNotReadyError'
    this.status = status
  }
}

/**
 * `jsonb_each` over a container, exposing `(set_name, prop_name, prop_value)`.
 *
 * Written once because every property predicate needs the same two-level
 * unnest, and the alias names are load-bearing: `s(k, v)` / `p(k, v)` would
 * shadow each other inside the correlated subquery.
 */
function unnestedProperties(source: 'property' | 'quantity'): SQL {
  const column = source === 'quantity' ? bimElements.quantities : bimElements.properties
  return sql`jsonb_each(${column}) AS s(set_name, set_value), jsonb_each(s.set_value) AS p(prop_name, prop_value)`
}

/**
 * The value half of a property predicate.
 *
 * String comparison is case-INSENSITIVE on purpose. Property values are typed
 * by hand in an authoring tool ("REI 90", "rei 90", "Rei 90" all occur in the
 * wild), and a filter that silently returns zero rows because of capitalisation
 * is indistinguishable, to the person reading the answer, from a building that
 * has no fire-rated walls. Numeric comparisons only ever match numeric values —
 * `> 0.2` must not match the string `"0.25"` and then fail on `"n/a"`.
 */
function valueCondition(filter: BimPropertyFilter): SQL | null {
  const asText = sql`p.prop_value #>> '{}'`
  switch (filter.operator) {
    case 'exists':
    case 'missing':
      return null
    case 'eq':
      return typeof filter.value === 'string'
        ? sql`lower(${asText}) = lower(${filter.value})`
        : sql`${asText} = ${String(filter.value)}`
    case 'neq':
      return typeof filter.value === 'string'
        ? sql`lower(${asText}) IS DISTINCT FROM lower(${filter.value})`
        : sql`${asText} IS DISTINCT FROM ${String(filter.value)}`
    case 'contains':
      return sql`${asText} ILIKE ${`%${String(filter.value)}%`}`
    case 'gt':
      return numericCondition(sql`>`, Number(filter.value))
    case 'gte':
      return numericCondition(sql`>=`, Number(filter.value))
    case 'lt':
      return numericCondition(sql`<`, Number(filter.value))
    case 'lte':
      return numericCondition(sql`<=`, Number(filter.value))
  }
}

/**
 * A numeric comparison guarded by a CASE, not by `AND`.
 *
 * `jsonb_typeof(v) = 'number' AND v::numeric <= $1` reads like a guard and is
 * not one: SQL does not promise left-to-right evaluation of `AND`, and Postgres
 * really does evaluate the cast first — a model that stores `IsExternal: true`
 * next to a numeric property makes the whole query fail with
 * "cannot cast jsonb boolean to type numeric". CASE is the only construct in
 * SQL that guarantees the order, so the type check actually gates the cast.
 */
function numericCondition(operator: SQL, value: number): SQL {
  return sql`CASE WHEN jsonb_typeof(p.prop_value) = 'number' THEN (p.prop_value)::numeric ${operator} ${value} ELSE false END`
}

function propertyPredicate(filter: BimPropertyFilter): SQL {
  const conditions: SQL[] = [sql`lower(p.prop_name) = lower(${filter.name})`]
  if (filter.set) conditions.push(sql`lower(s.set_name) = lower(${filter.set})`)
  const value = valueCondition(filter)
  if (value) conditions.push(sql`(${value})`)

  const body = sql`SELECT 1 FROM ${unnestedProperties(filter.source)} WHERE ${sql.join(conditions, sql` AND `)}`
  // `missing` is "no property of that name anywhere on the element", which is a
  // different question from "a property whose value is not X" (`neq`): an
  // element with no FireRating at all satisfies the first and not the second.
  return filter.operator === 'missing' ? sql`NOT EXISTS (${body})` : sql`EXISTS (${body})`
}

/**
 * Translate a validated filter into a drizzle predicate.
 *
 * An absent filter means "every element", not a crash. The zod schema defaults
 * `filter` to `{}` so a request through the API always carries one — but the
 * ops that make it optional are reached by other callers too (the internal
 * route composes a query, tests call `runBimQuery` directly), and a
 * `TypeError` deep in predicate building surfaces as a 500 on a request that
 * was perfectly answerable.
 */
export function buildBimPredicate(filter: BimFilter | undefined): SQL | undefined {
  if (!filter) return undefined
  const conditions: Array<SQL | undefined> = []

  if (filter.ifcTypes?.length) {
    conditions.push(
      inArray(
        sql`lower(${bimElements.ifcType})`,
        filter.ifcTypes.map((type) => type.toLowerCase())
      )
    )
  }
  if (filter.storeys?.length) {
    // A storey is addressed by name in conversation and by GlobalId in a card,
    // and the caller should not have to know which it holds.
    const lowered = filter.storeys.map((storey) => storey.toLowerCase())
    conditions.push(
      or(
        inArray(sql`lower(${bimElements.storeyName})`, lowered),
        inArray(sql`lower(${bimElements.storeyGlobalId})`, lowered)
      )
    )
  }
  if (filter.globalIds?.length) {
    conditions.push(inArray(bimElements.globalId, filter.globalIds))
  }
  if (filter.nameContains) {
    conditions.push(ilike(bimElements.name, `%${filter.nameContains}%`))
  }
  if (filter.material) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${bimElements.materials}) AS m(name) WHERE m.name ILIKE ${`%${filter.material}%`})`
    )
  }
  if (filter.classification) {
    const pattern = `%${filter.classification}%`
    conditions.push(
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${bimElements.classifications}) AS c(entry) WHERE (c.entry ->> 'identification') ILIKE ${pattern} OR (c.entry ->> 'name') ILIKE ${pattern} OR (c.entry ->> 'system') ILIKE ${pattern})`
    )
  }
  for (const property of filter.properties ?? []) {
    conditions.push(propertyPredicate(property))
  }

  const present = conditions.filter((condition): condition is SQL => condition !== undefined)
  return present.length === 0 ? undefined : and(...present)
}

/** The expression a `groupBy` selects, or `null` for no grouping. */
function groupExpression(
  groupBy: BimGroupBy | undefined,
  groupProperty: { set: string; name: string } | undefined
): SQL | null {
  switch (groupBy) {
    case undefined:
      return null
    case 'ifcType':
      return sql`${bimElements.ifcType}`
    case 'storey':
      return sql`${bimElements.storeyName}`
    case 'predefinedType':
      return sql`${bimElements.predefinedType}`
    case 'typeName':
      return sql`${bimElements.typeName}`
    // The FIRST material, not every material: an element with a three-layer
    // build-up would otherwise be counted three times, and "how many walls are
    // concrete" would exceed the number of walls.
    case 'material':
      return sql`${bimElements.materials} ->> 0`
    case 'property':
      return groupProperty
        ? sql`${bimElements.properties} -> ${groupProperty.set} ->> ${groupProperty.name}`
        : null
  }
}

/**
 * A scalar subquery yielding the element's value for one quantity.
 *
 * Written as a subquery rather than `quantities -> set ->> name` so the
 * quantity set may be omitted: exporters disagree about where `NetFloorArea`
 * lives (`Qto_SpaceBaseQuantities`, `BaseQuantities`, a vendor set), and a
 * caller asking for floor area should not have to know which.
 */
function quantityExpression(quantity: string, quantitySet: string | undefined): SQL {
  const conditions: SQL[] = [
    sql`lower(p.prop_name) = lower(${quantity})`,
    sql`jsonb_typeof(p.prop_value) = 'number'`,
  ]
  if (quantitySet) conditions.push(sql`lower(s.set_name) = lower(${quantitySet})`)
  return sql`(SELECT (p.prop_value)::numeric FROM ${unnestedProperties('quantity')} WHERE ${sql.join(conditions, sql` AND `)} LIMIT 1)`
}

function metricExpression(request: z.infer<typeof aggregateSchema>): SQL | null {
  if (request.metric === 'count' || !request.quantity) return null
  const value = quantityExpression(request.quantity, request.quantitySet)
  switch (request.metric) {
    case 'sum':
      return sql`sum(${value})`
    case 'avg':
      return sql`avg(${value})`
    case 'min':
      return sql`min(${value})`
    case 'max':
      return sql`max(${value})`
  }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

/** German one-liner the agent can quote verbatim without doing arithmetic. */
function renderSummary(request: BimQuery, result: Omit<BimQueryResult, 'summary'>): string {
  switch (request.op) {
    case 'overview': {
      const overview = result.overview
      if (!overview) return 'Keine Modellzusammenfassung vorhanden.'
      const parts = [
        `Modell „${overview.projectName ?? result.model.filename}“ (${overview.schema ?? 'IFC'})`,
        `${overview.totals.elements} Bauteile`,
        `${overview.totals.storeys} Geschosse`,
        `${overview.totals.spaces} Räume`,
      ]
      if (overview.quantityTotals.netFloorAreaM2 !== null) {
        parts.push(
          `Netto-Grundfläche ${formatNumber(overview.quantityTotals.netFloorAreaM2)} ${overview.units.area?.symbol ?? 'm²'}`
        )
      }
      return `${parts.join(', ')}.`
    }
    case 'health': {
      const health = result.health
      if (!health) return 'Für dieses Modell liegt keine Prüfung vor.'
      if (health.issues.length === 0) return 'Modellprüfung: keine Auffälligkeiten.'
      const rendered = health.issues
        .map((issue) => {
          const scope = issue.total === null ? `${issue.count}` : `${issue.count}/${issue.total}`
          const detail = issue.detail ? ` ${issue.detail}` : ''
          return `${issue.rule}${detail} (${issue.severity}, ${scope})`
        })
        .join('; ')
      return `Modellprüfung ${health.score}/100 — ${rendered}.`
    }
    case 'schedule': {
      const schedule = result.schedule
      if (!schedule) return 'Für dieses Modell liegt kein Raumbuch vor.'
      const missing =
        schedule.totals.roomsWithoutArea > 0
          ? ` ${schedule.totals.roomsWithoutArea} Räume ohne Flächenangabe sind darin NICHT enthalten.`
          : ''
      return (
        `Raumbuch: ${schedule.totals.rooms} Räume in ${schedule.storeys.length} Geschossen, ` +
        `Netto-Grundfläche ${schedule.totals.netFloorArea ?? '—'} ${schedule.units.area}.${missing}`
      )
    }
    case 'takeoff': {
      const rows = result.takeoff ?? []
      if (rows.length === 0) return 'Keine Bauteile für diese Massenermittlung.'
      return `Massenermittlung (${request.quantity}): ${rows
        .slice(0, 20)
        .map(
          (row) =>
            `${row.group}: ${row.value ?? '—'} (${row.elements} Bauteile${row.missing > 0 ? `, ${row.missing} ohne Wert` : ''})`
        )
        .join('; ')}.`
    }
    case 'profile':
      return renderProfileSuggestions(result.profileSuggestions ?? [])
    case 'compare':
      return result.comparison
        ? renderComparison(result.comparison)
        : 'Der Vergleich konnte nicht durchgeführt werden.'
    case 'types': {
      const types = result.types ?? []
      if (types.length === 0) return 'Das Modell enthält keine Bauteile.'
      return `Bauteiltypen: ${types.map((type) => `${type.ifcType} (${type.elements})`).join(', ')}.`
    }
    case 'elements': {
      const total = result.total ?? 0
      const shown = result.elements?.length ?? 0
      if (total === 0) return 'Kein Bauteil erfüllt die Abfrage.'
      return `${total} Bauteil${total === 1 ? '' : 'e'} erfüllen die Abfrage${shown < total ? `, davon ${shown} aufgelistet` : ''}.`
    }
    case 'element':
      return result.element
        ? `Bauteil ${result.element.ifcType} „${result.element.name ?? result.element.globalId}“.`
        : 'Kein Bauteil mit dieser GlobalId im Modell.'
    case 'properties': {
      const properties = result.properties ?? []
      return properties.length === 0
        ? 'Das Modell enthält keine Property Sets.'
        : `${properties.length} Merkmale im Modell.`
    }
    case 'aggregate': {
      const groups = result.groups ?? []
      if (groups.length === 0) return 'Kein Bauteil erfüllt die Abfrage.'
      const unit = request.metric === 'count' ? '' : ''
      if (!request.groupBy) {
        const only = groups[0]
        return request.metric === 'count'
          ? `${only.elements} Bauteil${only.elements === 1 ? '' : 'e'}.`
          : `${request.metric}(${request.quantity}) = ${only.metric === null ? '—' : formatNumber(only.metric)}${unit} über ${only.elements} Bauteile.`
      }
      const rendered = groups
        .map((group) => {
          const label = group.key ?? '(ohne Angabe)'
          return request.metric === 'count'
            ? `${label}: ${group.elements}`
            : `${label}: ${group.metric === null ? '—' : formatNumber(group.metric)} (${group.elements})`
        })
        .join(', ')
      return `${rendered}.`
    }
  }
}

/**
 * Run one validated query against one model.
 *
 * @throws {BimModelNotReadyError} when the model exists but has no elements to
 * query yet — a distinct outcome from "no results", which the agent must not
 * report as "the building has none".
 */
export async function runBimQuery(
  request: BimQuery,
  context: { modelId: string; organizationId: string }
): Promise<BimQueryResult> {
  const model = await findBimModelById(context.modelId, context.organizationId)
  if (!model) throw new BimModelNotReadyError('failed', 'Model not found')
  if (model.status !== 'ready') {
    throw new BimModelNotReadyError(
      model.status,
      model.status === 'failed'
        ? `Model extraction failed: ${model.errorMessage ?? 'unknown error'}`
        : 'Model is still being extracted'
    )
  }

  const modelBase: Omit<BimQueryResult, 'summary'> = {
    op: request.op,
    model: {
      id: model.id,
      filename: model.filename,
      schema: model.schemaVersion,
      elementCount: model.elementCount,
    },
  }

  const health = model.summary?.health ?? null
  // `overview`, `elements`, `aggregate` and `types` all report counts the
  // structural defects change. `element` and `properties` are about one element
  // or the vocabulary, which orphaning does not distort — attaching the caveat
  // there would train the agent to ignore it.
  const CAVEATED_OPS = new Set(['overview', 'types', 'elements', 'aggregate'])
  const caveat = health && CAVEATED_OPS.has(request.op) ? healthCaveat(health) : null

  const finish = (partial: Omit<BimQueryResult, 'summary'>): BimQueryResult => ({
    ...partial,
    caveat,
    summary: renderSummary(request, partial),
  })

  switch (request.op) {
    case 'overview':
      return finish({ ...modelBase, overview: model.summary ?? undefined })

    case 'health':
      return finish({ ...modelBase, health: health ?? undefined })

    case 'types':
      return finish({
        ...modelBase,
        types: await countBimElementsByType(context.modelId, context.organizationId),
      })

    case 'elements': {
      const { rows, total } = await listBimElements({
        modelId: context.modelId,
        organizationId: context.organizationId,
        where: buildBimPredicate(request.filter),
        limit: request.limit,
        offset: request.offset,
      })
      return finish({ ...modelBase, elements: rows, total, truncated: request.offset + rows.length < total })
    }

    case 'element':
      return finish({
        ...modelBase,
        element: await findBimElement(context.modelId, context.organizationId, request.globalId),
      })

    case 'properties':
      return finish({
        ...modelBase,
        properties: await listBimPropertyCatalog({
          modelId: context.modelId,
          organizationId: context.organizationId,
          ifcType: request.ifcType,
          maxValues: request.maxValues,
        }),
      })

    case 'schedule': {
      if (!model.summary) throw new BimModelNotReadyError('failed', 'Model has no summary')
      const { elements } = await loadBimElementsForSchedule(context.modelId, context.organizationId)
      return finish({ ...modelBase, schedule: buildRoomSchedule(model.summary, elements) })
    }

    case 'takeoff': {
      const { elements } = await loadBimElementsForSchedule(
        context.modelId,
        context.organizationId,
        buildBimPredicate(request.filter)
      )
      return finish({
        ...modelBase,
        takeoff: buildQuantityTakeoff(elements, {
          quantity: request.quantity,
          byMaterial: request.byMaterial,
        }),
      })
    }

    case 'profile': {
      if (!model.summary) throw new BimModelNotReadyError('failed', 'Model has no summary')
      const { elements } = await loadBimElementsForSchedule(context.modelId, context.organizationId)
      return finish({
        ...modelBase,
        profileSuggestions: deriveProfileSuggestions({
          summary: model.summary,
          spaceNames: elements
            .filter((element) => element.ifcType === 'IfcSpace')
            .map((element) => element.name ?? '')
            .filter(Boolean),
        }),
      })
    }

    case 'compare': {
      if (!request.baseModelId) {
        throw new BimModelNotReadyError('failed', 'No model to compare against was resolved')
      }
      const baseModel = await findBimModelById(request.baseModelId, context.organizationId)
      if (!baseModel || baseModel.status !== 'ready') {
        throw new BimModelNotReadyError(
          baseModel?.status ?? 'failed',
          'The model to compare against is not ready'
        )
      }
      const [baseElements, revisionElements] = await Promise.all([
        loadBimElementsForComparison(baseModel.id, context.organizationId, request.limit),
        loadBimElementsForComparison(context.modelId, context.organizationId, request.limit),
      ])
      return finish({
        ...modelBase,
        comparison: compareModels({
          base: baseElements.elements,
          revision: revisionElements.elements,
          truncated: baseElements.truncated || revisionElements.truncated,
        }),
      })
    }

    case 'aggregate': {
      const groups = await aggregateBimElements({
        modelId: context.modelId,
        organizationId: context.organizationId,
        where: buildBimPredicate(request.filter),
        groupExpression: groupExpression(request.groupBy, request.groupProperty),
        metricExpression: metricExpression(request),
        limit: request.limit,
      })
      return finish({ ...modelBase, groups })
    }
  }
}

export type {
  BimElementListRow,
  BimGroupedCount,
  BimPropertyCatalogEntry,
  BimComparison,
  BimRoomSchedule,
  BimQuantityRow,
  BimProfileSuggestion,
}
