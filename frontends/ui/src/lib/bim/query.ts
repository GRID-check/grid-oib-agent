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
import { ApiError } from '@/lib/api/errors'
import { bimElements } from '@/lib/db/schema'
import {
  aggregateBimElements,
  countBimElementsByType,
  findBimElement,
  findBimModelById,
  listBimElements,
  loadBimElementsForComparison,
  loadBimElementsForSchedule,
  loadBimRuleInputs,
  saveBimRuleInputs,
  listBimPropertyCatalog,
  type BimElementListRow,
  type BimGroupedCount,
  type BimModelHeader,
  type BimElementQueryPlan,
  type BimPropertyCatalogEntry,
} from './repository'
import {
  readComplianceCache,
  writeComplianceCache,
  type CachedCompliance,
} from './compliance-cache'
import { buildStoredRuleInputs, readStoredRuleInputs } from './rule-inputs'
import { compareModels, renderComparison, type BimComparison } from './compare'
import { deriveProfileSuggestions, renderProfileSuggestions, type BimProfileSuggestion } from './profile'
import {
  diffBimCompliance,
  missingPropertyShoppingList,
  renderBimComplianceDiff,
  ifcTypeVariants,
  renderBimRules,
  runBimRules,
  summarizeBimRules,
  type BimComplianceChange,
  type BimComplianceSummary,
  type BimRuleResult,
} from './rules'
import {
  buildQuantityTakeoff,
  buildRoomSchedule,
  type BimQuantityRow,
  type BimRoomSchedule,
} from './schedule'
import { healthCaveat, type BimHealth } from './validate'
import { BIM_ELEMENTS_PAGE_LIMIT } from './types'
import type { BimModelSummary, BimUnits } from './types'

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

/**
 * The operators whose value reaches SQL as a NUMBER, and which therefore
 * cannot be handed anything else.
 *
 * `value` is a string|number|boolean, so `{operator: 'lt', value: 'breit'}`
 * parses, and `Number('breit')` is NaN. Postgres orders `numeric 'NaN'` ABOVE
 * every real number, so that filter does not fail — it returns EVERY element
 * with the property, as a confident answer to a question nobody asked. Failing
 * the parse is the only outcome the reader can tell apart from a real result.
 */
const NUMERIC_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte'])

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
  .refine(
    (filter) => !NUMERIC_OPERATORS.has(filter.operator) || Number.isFinite(Number(filter.value)),
    {
      message: 'gt/gte/lt/lte need a numeric value',
    }
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
  z.object({
    op: z.literal('compliance'),
    /**
     * The project facts some rules depend on, supplied by the caller.
     *
     * Optional on purpose: a rule that needs a fact it was not given reports
     * `not applicable` WITH the reason rather than assuming a value. Assuming
     * the mildest Gebaeudeklasse would turn a GK5 building's missing R 90 into
     * a pass, which is the exact failure this subsystem exists to prevent.
     */
    gebaeudeklasse: z.number().int().min(1).max(5).nullish(),
    hauptnutzung: z.string().trim().max(64).nullish(),
  }),
  z.object({
    /** The same catalog over two revisions, reporting only what MOVED. */
    op: z.literal('compliance-diff'),
    /** The OLDER revision; this model is the newer one. */
    baseModelId: z.string().uuid().optional(),
    gebaeudeklasse: z.number().int().min(1).max(5).nullish(),
    hauptnutzung: z.string().trim().max(64).nullish(),
  }),
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
    // Max = the viewer's walk page (one shared constant); default = the agent's
    // conversational page, which stays small on purpose — 25 rows is an answer,
    // 1 000 is a data dump no one asked the model to narrate.
    limit: z.number().int().min(1).max(BIM_ELEMENTS_PAGE_LIMIT).default(25),
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
  /** Per-rule verdicts from the OIB rule catalog (`lib/bim/rules.ts`). */
  compliance?: BimRuleResult[]
  complianceSummary?: BimComplianceSummary
  /** Rules whose standing moved between two revisions; only what changed. */
  complianceChanges?: BimComplianceChange[]
  /** The older revision a `compliance-diff` was run against. */
  comparedWith?: string
  /** What to author in the CAD to make the undecidable rules decidable. */
  complianceShoppingList?: Array<{ path: string; elements: number; rules: string[] }>
  takeoff?: BimQuantityRow[]
  profileSuggestions?: BimProfileSuggestion[]
  types?: Array<{ ifcType: string; elements: number }>
  elements?: BimElementListRow[]
  element?: Awaited<ReturnType<typeof findBimElement>>
  properties?: BimPropertyCatalogEntry[]
  /**
   * How much of the model the `properties` catalog was built from. Absent on
   * every other op. `complete: false` means the counts in `properties` are
   * counts over a sample and must not be reported as the model's.
   */
  propertyScan?: { scanned: number; total: number; complete: boolean }
  groups?: BimGroupedCount[]
  /** The model's own unit assignment, so an aggregate can name its unit. */
  units?: BimUnits
  total?: number
  /**
   * `total` is a LOWER BOUND, not the count: past `COUNT_CEILING` matches the
   * query stops counting rather than hold a pool slot for 16-22 s on a large
   * model. "At least 10 000" is the honest reading.
   */
  totalIsLowerBound?: boolean
  truncated?: boolean
}

export class BimModelNotReadyError extends ApiError {
  readonly modelStatus: BimModelHeader['status']

  constructor(status: BimModelHeader['status'], message: string) {
    // Extends `ApiError` so the handler maps it. As a bare `Error` every one
    // of these surfaced as HTTP 500 "Internal server error" with a stack in
    // the logs: a model still extracting — the normal state for the first
    // minute after a 250 MB upload — read to the user as a crashed server,
    // and a model in another tenant read as one too.
    //
    // A missing model is 404, like every other resource. A model that exists
    // but is not readable YET is 409: the request was well-formed and the
    // caller should retry, which a 500 tells them nothing about.
    super(
      status === 'failed' && /not found/i.test(message) ? 404 : 409,
      'MODEL_NOT_READY',
      message
    )
    this.name = 'BimModelNotReadyError'
    this.modelStatus = status
  }
}

/**
 * Storey names and elevations for the rule catalogue.
 *
 * OIB 2 Tabelle 1b asks a different fire-resistance duration of a
 * Kellergeschoß wall than of a ground-floor one; without this a rule cannot
 * tell them apart and has to report the requirement as undetermined.
 */
function storeyFacts(
  summary: BimModelHeader['summary']
): Array<{ name: string; elevation: number | null }> | undefined {
  return summary?.storeys.map((storey) => ({
    name: storey.name ?? '',
    elevation: storey.elevation,
  }))
}

/**
 * The rule catalogue over one model, through every shortcut there is.
 *
 * Written once because it is needed twice, and the second caller — the
 * revision diff — had none of it: two unconditional `loadBimElementsForSchedule`
 * calls, no projection, no memo, and no truncation flag, so the op that
 * compares two 400 000-element revisions was the slowest thing in the product
 * and the least honest about what it had read.
 *
 * The order matters: memo, then the stored projection, then the full load.
 * Each step is a fact about an IMMUTABLE model — a `ready` model never changes
 * and a new revision is a new id — so a hit can never describe a building that
 * has since moved.
 */
async function complianceRun(
  header: BimModelHeader,
  organizationId: string,
  facts: { gebaeudeklasse: number | null; hauptnutzung: string | null }
): Promise<CachedCompliance> {
  const cached = readComplianceCache(header.id, facts.gebaeudeklasse, facts.hauptnutzung)
  if (cached) return cached

  // The fast path: a single column of a single row, ~120 bytes per element
  // instead of ~1 199, no `jsonb_each`, one parse. See `rule-inputs.ts`.
  const rawRuleInputs = await loadBimRuleInputs(header.id, organizationId)
  const stored = readStoredRuleInputs(rawRuleInputs)
  const loaded = stored
    ? { elements: stored.elements, truncated: stored.truncated }
    : await loadBimElementsForSchedule(header.id, organizationId)

  // Models extracted before the projection existed have none. The first reader
  // pays the old cost once and leaves it behind for everyone else, which is
  // why there is no backfill job.
  if (!stored) {
    // Guarded on what we read: a re-extraction that landed while we were
    // loading elements has already written a NEWER projection, and ours
    // describes the previous revision.
    await saveBimRuleInputs(
      header.id,
      organizationId,
      buildStoredRuleInputs(loaded.elements, loaded.truncated),
      rawRuleInputs
    )
  }

  // TWO caps, and either one makes the run partial: the loader’s, and
  // EXTRACTION’s — elements past `BIM_ELEMENT_LIMIT` were never written to the
  // table at all, so no loader could report them missing. Only the summary
  // knows about that one. A catalogue run over part of a building, reporting
  // verdict counts as though they covered all of it, is what the Prüfbuch, the
  // BCF export and the signed confirmation all inherit.
  const truncated = loaded.truncated || header.summary?.truncatedAt != null

  const compliance = runBimRules(loaded.elements, {
    ...facts,
    // The model declares its length unit; a rule that guessed could be wrong
    // by a factor of a thousand. Each revision is judged with ITS OWN, so a
    // re-export from millimetres to metres does not register as every
    // dimension changing by a factor of a thousand.
    lengthScale: header.summary?.units.length?.siScale ?? null,
    // OIB 2 Tabelle 1b asks a different duration of a Kellergeschöß wall than
    // of a ground-floor one; without the elevations no rule can tell. From
    // each side’s OWN summary, for the same reason the length scale is.
    storeys: storeyFacts(header.summary),
  })
  const computed: CachedCompliance = {
    truncated,
    compliance,
    complianceSummary: summarizeBimRules(compliance),
    complianceShoppingList: missingPropertyShoppingList(compliance),
  }
  writeComplianceCache(header.id, facts.gebaeudeklasse, facts.hauptnutzung, computed)
  return computed
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
  // A non-finite bound never reaches here through the schema, which rejects
  // it — but `buildBimPredicate` is called directly by tests and by the
  // internal composer, and `NaN` bound into a `numeric` comparison makes the
  // predicate silently all-true rather than raising. `false` is the only safe
  // reading of "compare this against a number that is not one".
  if (!Number.isFinite(value)) return sql`false`
  return sql`CASE WHEN jsonb_typeof(p.prop_value) = 'number' THEN (p.prop_value)::numeric ${operator} ${value} ELSE false END`
}

/**
 * An index-servable condition that every matching row must ALSO satisfy.
 *
 * This is a pre-filter, never the answer: the exact unnest predicate below
 * still decides, so this may only ever be something the real condition
 * IMPLIES. `missing` and `neq` are therefore excluded — both are satisfied by
 * elements that do NOT carry the property, so requiring the key to exist would
 * drop exactly the rows the filter is looking for.
 *
 * The caller decides whether the model is indexed at all
 * (`bim_models.search_keys_indexed`); this function assumes it is. Writing the
 * fallback into the predicate instead — `search_keys IS NULL OR …` — was
 * measured and is a trap: `IS NULL` is not GIN-indexable, so the disjunction
 * makes the whole condition unindexable and every query keeps the old plan.
 *
 * Measured on a seeded 200 000-element model, filter matching one element:
 *
 *   no pre-filter                6 474 ms   Index Scan + 200 000 unnests
 *   `IS NULL OR @>`              2 934 ms   same plan, GIN untouched
 *   `@>` alone                       4 ms   Bitmap Index Scan on the GIN
 *
 * `?` and `@>` are both served by the `jsonb_ops` GIN index on `search_keys`.
 */
function searchKeyPrefilter(filter: BimPropertyFilter): SQL | null {
  if (filter.operator === 'missing' || filter.operator === 'neq') return null
  const prefix = filter.source === 'quantity' ? 'q:' : 'p:'
  const key = filter.set
    ? `${prefix}${filter.set.toLowerCase()}.${filter.name.toLowerCase()}`
    : `${prefix}${filter.name.toLowerCase()}`

  // For an exact string match the VALUE is indexable too, which turns the
  // candidate set from "every element carrying a FireRating" into "every
  // element whose FireRating is this one".
  return filter.operator === 'eq' && typeof filter.value === 'string'
    ? sql`${bimElements.searchKeys} @> ${JSON.stringify({ [key]: [filter.value.toLowerCase()] })}::jsonb`
    : sql`${bimElements.searchKeys} ? ${key}`
}

function propertyPredicate(filter: BimPropertyFilter, searchKeysIndexed: boolean): SQL {
  const conditions: SQL[] = [sql`lower(p.prop_name) = lower(${filter.name})`]
  if (filter.set) conditions.push(sql`lower(s.set_name) = lower(${filter.set})`)
  const value = valueCondition(filter)
  if (value) conditions.push(sql`(${value})`)

  const body = sql`SELECT 1 FROM ${unnestedProperties(filter.source)} WHERE ${sql.join(conditions, sql` AND `)}`
  // `missing` is "no property of that name anywhere on the element", which is a
  // different question from "a property whose value is not X" (`neq`): an
  // element with no FireRating at all satisfies the first and not the second.
  const exact = filter.operator === 'missing' ? sql`NOT EXISTS (${body})` : sql`EXISTS (${body})`

  const prefilter = searchKeysIndexed ? searchKeyPrefilter(filter) : null
  return prefilter ? sql`(${prefilter} AND ${exact})` : exact
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
export function buildBimPredicate(
  filter: BimFilter | undefined,
  options: { searchKeysIndexed: boolean } = { searchKeysIndexed: false }
): SQL | undefined {
  return buildBimElementPlan(filter, options).assisted
}

/**
 * An IFC GlobalId: 22 characters of base64 over IFC's own alphabet.
 *
 * Lowercased forms included, because the storey filter compares lowercased.
 */
const IFC_GLOBAL_ID = /^[0-9A-Za-z_$]{22}$/

/** Conditions that are the same however the query is planned. */
function sharedConditions(filter: BimFilter): SQL[] {
  const conditions: Array<SQL | undefined> = []

  if (filter.ifcTypes?.length) {
    // Every spelling of each requested type — see `ifcTypeVariants`. An IFC4
    // export whose walls are `IfcWallStandardCase` used to answer a filter for
    // `IfcWall` with nothing at all, and the agent read that as a building
    // with no walls.
    conditions.push(
      inArray(
        sql`lower(${bimElements.ifcType})`,
        [...new Set(filter.ifcTypes.flatMap(ifcTypeVariants))]
      )
    )
  }
  if (filter.storeys?.length) {
    // A storey is addressed by name in conversation and by GlobalId in a card,
    // and the caller should not have to know which it holds.
    const lowered = filter.storeys.map((storey) => storey.toLowerCase())
    const byName = inArray(sql`lower(${bimElements.storeyName})`, lowered)
    // The GlobalId arm is emitted ONLY for tokens shaped like one. Every value
    // of `storey_global_id` is a 22-character IFC GlobalId, so its lowercase
    // form is always GlobalId-shaped and a token that is not can never equal
    // it — dropping the arm for a list of plain names is exact, not a
    // shortcut. It matters because an unconditional `OR` over two columns is
    // unindexable: the expression index added in 0040 serves the name arm, and
    // an OR with an unindexed second arm sends the whole predicate back to a
    // sequential scan, which is what made that index dead on arrival.
    const globalIds = lowered.filter((storey) => IFC_GLOBAL_ID.test(storey))
    conditions.push(
      globalIds.length === 0
        ? byName
        : or(byName, inArray(sql`lower(${bimElements.storeyGlobalId})`, globalIds))
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

  return conditions.filter((condition): condition is SQL => condition !== undefined)
}

const join = (conditions: SQL[]): SQL | undefined =>
  conditions.length === 0 ? undefined : and(...conditions)

export function buildBimElementPlan(
  filter: BimFilter | undefined,
  options: { searchKeysIndexed: boolean } = { searchKeysIndexed: false }
): BimElementQueryPlan {
  if (!filter) return { assisted: undefined, unassisted: undefined, candidates: null }

  const shared = sharedConditions(filter)
  const properties = filter.properties ?? []
  const prefilters = options.searchKeysIndexed
    ? properties.map(searchKeyPrefilter).filter((condition): condition is SQL => condition !== null)
    : []

  return {
    assisted: join([
      ...shared,
      ...properties.map((property) => propertyPredicate(property, options.searchKeysIndexed)),
    ]),
    unassisted: join([
      ...shared,
      ...properties.map((property) => propertyPredicate(property, false)),
    ]),
    candidates: prefilters.length === 0 ? null : join([...shared, ...prefilters]),
  }
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

/** The per-element value the metric aggregates, or null for a bare count. */
function metricValueExpression(request: z.infer<typeof aggregateSchema>): SQL | null {
  if (request.metric === 'count' || !request.quantity) return null
  return quantityExpression(request.quantity, request.quantitySet)
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
/**
 * The unit symbol a quantity is measured in, per the model's own
 * `IfcUnitAssignment`.
 *
 * Deliberately conservative: the dimension is inferred from the quantity's
 * NAME, and a name this does not recognise gets no symbol rather than a
 * guessed one. A missing unit makes the agent quote a bare number, which is
 * what it did for every aggregate until now; a WRONG unit would have it write
 * "4 120 000 m²" for a model in millimetres, which is worse than silent.
 *
 * The IFC quantity vocabulary is small and stable — `Qto_*` sets use
 * `…Area`, `…Volume`, `…Length`/`Width`/`Height`/`Perimeter`/`Depth`/
 * `Thickness` — so this covers the quantities anyone aggregates.
 */
function quantityUnit(
  request: BimQuery,
  units: BimUnits | undefined
): string {
  if (request.op !== 'aggregate' || request.metric === 'count' || !request.quantity) return ''
  if (!units) return ''
  const name = request.quantity.toLowerCase()
  const unit = name.includes('area')
    ? units.area
    : name.includes('volume')
      ? units.volume
      : /length|width|height|perimeter|depth|thickness/.test(name)
        ? units.length
        : null
  return unit?.symbol ? ` ${unit.symbol}` : ''
}

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
    case 'compliance':
      return renderBimRules(result.compliance ?? [])
    case 'compliance-diff':
      return (
        `Statusänderungen gegenüber ${result.comparedWith ?? 'dem Vorstand'}:\n` +
        renderBimComplianceDiff(result.complianceChanges ?? [])
      )
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
      const listed = shown < total ? `, davon ${shown} aufgelistet` : ''
      // "Mindestens", never a bare number, once the count stopped early. An
      // agent handed "10000 Bauteile" would quote it as the figure, and the
      // model has 400 000.
      // The VERB inflects too. `1 Bauteil erfüllen` is wrong German, and the
      // agent is told to quote this line verbatim. The lower-bound branch is
      // always plural: it only fires past `COUNT_CEILING`.
      return result.totalIsLowerBound
        ? `Mindestens ${total} Bauteile erfüllen die Abfrage${listed}. Die Gesamtzahl wurde nicht zu Ende gezählt.`
        : total === 1
          ? `1 Bauteil erfüllt die Abfrage${listed}.`
          : `${total} Bauteile erfüllen die Abfrage${listed}.`
    }
    case 'element':
      return result.element
        ? `Bauteil ${result.element.ifcType} „${result.element.name ?? result.element.globalId}“.`
        : 'Kein Bauteil mit dieser GlobalId im Modell.'
    case 'properties': {
      const properties = result.properties ?? []
      if (properties.length === 0) return 'Das Modell enthält keine Property Sets.'
      const scan = result.propertyScan
      // The names are the answer and they survive sampling; the counts do not.
      // Saying so is what stops an agent quoting "12 Bauteile mit REI 90" from
      // a scan of 200 walls out of 40 000.
      return scan && !scan.complete
        ? `${properties.length} Merkmale, ermittelt aus einer Stichprobe von ${scan.scanned} der ` +
            `${scan.total} Bauteile (je Bauteiltyp). Die Merkmals- und Wertnamen sind vollständig ` +
            `belastbar, die Anzahlen beziehen sich NUR auf die Stichprobe.`
        : `${properties.length} Merkmale im Modell.`
    }
    case 'aggregate': {
      const groups = result.groups ?? []
      if (groups.length === 0) return 'Kein Bauteil erfüllt die Abfrage.'
      // The model's own unit symbol, the way `overview` and `schedule` already
      // attach one. This used to be `request.metric === 'count' ? '' : ''` — a
      // placeholder never filled — so a model declaring millimetres answered
      // "4120000" and the agent wrote m².
      const unit = quantityUnit(request, result.units)
      /**
       * How many elements CARRIED the quantity, beside how many matched.
       *
       * `sum`/`avg` skip elements that publish nothing, so a hundred rooms of
       * which ten have a floor area produced "250 über 100 Bauteile" — a sum
       * of ten values asserted over a hundred elements. `takeoff` and
       * `schedule` have carried this distinction from the start; the operation
       * the tool description calls "how you answer how much" did not.
       */
      const over = (group: { elements: number; measured: number }): string =>
        group.measured === group.elements
          ? `${group.elements} Bauteile`
          : `${group.measured} von ${group.elements} Bauteilen ` +
            `(${group.elements - group.measured} ohne Wert)`

      if (!request.groupBy) {
        const only = groups[0]
        return request.metric === 'count'
          ? `${only.elements} Bauteil${only.elements === 1 ? '' : 'e'}.`
          : `${request.metric}(${request.quantity}) = ${only.metric === null ? '—' : formatNumber(only.metric)}${unit} über ${over(only)}.`
      }
      const rendered = groups
        .map((group) => {
          const label = group.key ?? '(ohne Angabe)'
          if (request.metric === 'count') return `${label}: ${group.elements}`
          const measured =
            group.measured === group.elements
              ? `${group.elements}`
              : `${group.measured}/${group.elements}`
          return `${label}: ${group.metric === null ? '—' : formatNumber(group.metric)}${unit} (${measured})`
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
  const healthNote = health && CAVEATED_OPS.has(request.op) ? healthCaveat(health) : null

  /**
   * The extraction cap, said out loud to the agent.
   *
   * `summary.truncatedAt` records that the file was bigger than the stored
   * element list. Every op that reads ROWS therefore answers over part of the
   * building, while `overview` — which reads the summary — answers over all of
   * it. The agent could put both in one reply and had no way to know they
   * disagreed: "350 000 Bauteile" from the overview, and a filtered count over
   * the 200 000 that were stored.
   *
   * `compliance` already carried this. The rest did not, though the digest and
   * the viewer both say it plainly.
   */
  const ROW_READING_OPS = new Set([
    'types',
    'elements',
    'aggregate',
    'schedule',
    'takeoff',
    'compare',
    'compliance-diff',
    'profile',
    'properties',
  ])
  const truncatedAt = model.summary?.truncatedAt ?? null
  const capNote =
    truncatedAt !== null && ROW_READING_OPS.has(request.op)
      ? `Achtung: von diesem Modell sind nur ${truncatedAt} Bauteile gespeichert — die Datei ist größer. ` +
        `Jede Zahl aus dieser Abfrage bezieht sich auf den gespeicherten Teil, nicht auf das ganze Gebäude.`
      : null

  const caveat = [capNote, healthNote].filter(Boolean).join(' ') || null

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
      const { rows, total, totalIsLowerBound } = await listBimElements({
        modelId: context.modelId,
        organizationId: context.organizationId,
        plan: buildBimElementPlan(request.filter, {
          searchKeysIndexed: model.searchKeysIndexed,
        }),
        elementCount: model.elementCount,
        limit: request.limit,
        offset: request.offset,
      })
      return finish({
        ...modelBase,
        elements: rows,
        total,
        totalIsLowerBound,
        // A capped count is itself proof there is more: `offset + rows < total`
        // is false on the last page WITHIN the cap, and there are still
        // hundreds of thousands of rows behind it.
        truncated: totalIsLowerBound || request.offset + rows.length < total,
      })
    }

    case 'element':
      return finish({
        ...modelBase,
        element: await findBimElement(context.modelId, context.organizationId, request.globalId),
      })

    case 'properties': {
      const catalog = await listBimPropertyCatalog({
        modelId: context.modelId,
        organizationId: context.organizationId,
        ifcType: request.ifcType,
        maxValues: request.maxValues,
      })
      return finish({
        ...modelBase,
        properties: catalog.entries,
        propertyScan: {
          scanned: catalog.scanned,
          total: catalog.total,
          complete: catalog.complete,
        },
      })
    }

    case 'schedule': {
      if (!model.summary) throw new BimModelNotReadyError('failed', 'Model has no summary')
      const { elements, truncated } = await loadBimElementsForSchedule(
        context.modelId,
        context.organizationId
      )
      return finish({ ...modelBase, truncated, schedule: buildRoomSchedule(model.summary, elements) })
    }

    case 'compliance': {
      // Over the FULL element set, like every other derived table: a rule run
      // against a capped page would report "0 nicht erfuellt" for a building
      // whose failures all sat past the cap.
      return finish({
        ...modelBase,
        ...(await complianceRun(model, context.organizationId, {
          gebaeudeklasse: request.gebaeudeklasse ?? null,
          hauptnutzung: request.hauptnutzung ?? null,
        })),
      })
    }

    case 'takeoff': {
      const { elements, truncated } = await loadBimElementsForSchedule(
        context.modelId,
        context.organizationId,
        buildBimPredicate(request.filter, { searchKeysIndexed: model.searchKeysIndexed })
      )
      return finish({
        ...modelBase,
        truncated,
        takeoff: buildQuantityTakeoff(elements, {
          quantity: request.quantity,
          byMaterial: request.byMaterial,
        }),
      })
    }

    case 'compliance-diff': {
      if (!request.baseModelId) {
        throw new BimModelNotReadyError('failed', 'compliance-diff requires a base model')
      }
      const base = await findBimModelById(request.baseModelId, context.organizationId)
      if (!base || base.status !== 'ready') {
        throw new BimModelNotReadyError(base?.status ?? 'failed', 'Base model is not ready')
      }
      const facts = {
        gebaeudeklasse: request.gebaeudeklasse ?? null,
        hauptnutzung: request.hauptnutzung ?? null,
      }
      const [before, after] = await Promise.all([
        complianceRun(base, context.organizationId, facts),
        complianceRun(model, context.organizationId, facts),
      ])
      return finish({
        ...modelBase,
        compliance: after.compliance,
        complianceSummary: after.complianceSummary,
        complianceShoppingList: after.complianceShoppingList,
        complianceChanges: diffBimCompliance(before.compliance, after.compliance),
        comparedWith: base.filename,
        // EITHER side being capped makes the diff unsound the same way: an
        // element past one side's cap reads as removed, and a rule whose
        // failures sat past it reads as fixed. The banner is the only thing
        // stopping "was hat sich verschlechtert" being answered from half a
        // building.
        truncated: before.truncated || after.truncated,
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
        where: buildBimPredicate(request.filter, { searchKeysIndexed: model.searchKeysIndexed }),
        groupExpression: groupExpression(request.groupBy, request.groupProperty),
        metricExpression: metricExpression(request),
        metricValueExpression: metricValueExpression(request),
        limit: request.limit,
      })
      // The model's units travel with the answer so the summary can name
      // them — the aggregate is the one quantity operation that reported bare
      // numbers.
      return finish({ ...modelBase, groups, units: model.summary?.units })
    }
  }
}

export type {
  BimComplianceChange,
  BimComplianceSummary,
  BimRuleResult,
  BimElementListRow,
  BimGroupedCount,
  BimPropertyCatalogEntry,
  BimComparison,
  BimRoomSchedule,
  BimQuantityRow,
  BimProfileSuggestion,
}
