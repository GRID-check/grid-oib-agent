/**
 * Model validation — the five-stage check an IFC file gets on ingestion.
 *
 * ## Why a compliance product validates the model before answering about it
 *
 * A BIM model is not a database somebody designed; it is the output of whatever
 * an architect's authoring tool happened to export, and the failure modes are
 * both common and silent. Elements that sit in no storey are excluded from every
 * per-storey count. Spaces with no `NetFloorArea` make an area total quietly
 * short. A duplicated GlobalId makes "which element is that" ambiguous.
 *
 * None of that stops a query from returning a number. It stops the number from
 * being TRUE, and nothing about the answer looks different. So the model is
 * checked once, the findings are stored with it, and the agent is told to read
 * them before reporting a count — an answer over a model with 43 unplaced
 * elements has to say so.
 *
 * ## What the stages are
 *
 * The five stages follow the buildingSMART conformance ladder and the failure
 * families the openBIM community has converged on (schema, references, spatial,
 * property sets, information completeness):
 *
 *   1. **schema**    — is the declared version usable, and is it current?
 *   2. **identity**  — does every element have one unambiguous GlobalId?
 *   3. **spatial**   — is every element somewhere in the Project→Storey tree?
 *   4. **properties**— are the property sets the standard ones, on the standard types?
 *   5. **complete**  — is the information an answer needs actually present?
 *
 * Stages 1–4 find things that are WRONG. Stage 5 finds things that are MISSING,
 * which is a different claim and is reported as such: a model with no
 * classifications is not defective, it just cannot answer questions about
 * classifications.
 *
 * Pure: a function of the extracted index, no I/O, no clock.
 */

import type { BimElement, BimModelIndex } from './types'

export const BIM_ISSUE_STAGES = ['schema', 'identity', 'spatial', 'properties', 'complete'] as const
export type BimIssueStage = (typeof BIM_ISSUE_STAGES)[number]

/**
 * `error` — answers about this model can be wrong, and the agent must say so.
 * `warning` — a defect that narrows what can be answered.
 * `info` — information that is absent, not information that is wrong.
 */
export type BimIssueSeverity = 'error' | 'warning' | 'info'

export const BIM_ISSUE_RULES = [
  'schema-unknown',
  'schema-legacy',
  'identity-missing-globalid',
  'identity-duplicate-globalid',
  'identity-malformed-globalid',
  'spatial-no-storeys',
  'spatial-orphan-elements',
  'spatial-element-above-storey',
  'spatial-space-without-storey',
  'spatial-storey-without-elevation',
  'spatial-duplicate-storey-elevation',
  'properties-no-property-sets',
  'properties-missing-common-pset',
  'properties-vendor-sets-only',
  'complete-unnamed-elements',
  'complete-space-without-area',
  'complete-no-quantities',
  'complete-no-materials',
  'complete-no-classifications',
] as const
export type BimIssueRule = (typeof BIM_ISSUE_RULES)[number]

export interface BimIssue {
  rule: BimIssueRule
  stage: BimIssueStage
  severity: BimIssueSeverity
  /** How many elements (or entities) the rule matched. */
  count: number
  /** Population the count is out of, when the ratio is what matters. */
  total: number | null
  /**
   * A few affected GlobalIds — enough for the viewer to show the user WHICH
   * elements, without storing a second copy of the model in the summary.
   */
  sampleGlobalIds: string[]
  /** Machine-readable qualifier: an IFC type, a property-set name, a version. */
  detail: string | null
}

export interface BimHealth {
  issues: BimIssue[]
  /**
   * 0–100. Not a grade and not a conformance certificate — a rough readout of
   * how much of what an answer needs is actually present, so two revisions of
   * the same model can be compared at a glance. The issue list is the substance.
   */
  score: number
  /** Counts by severity, for a badge that does not need the whole list. */
  totals: { error: number; warning: number; info: number }
}

/** How many GlobalIds an issue carries as evidence. */
const MAX_SAMPLES = 10

/**
 * The IFC GlobalId format: 22 characters of buildingSMART's base64 variant.
 * A GUID written any other way still identifies an element inside one file, but
 * stops being stable across exports — which is exactly what a revision
 * comparison relies on.
 */
const GLOBAL_ID_PATTERN = /^[0-9A-Za-z_$]{22}$/

/**
 * Element types buildingSMART publishes a `Pset_*Common` for, and that are
 * common enough in a building model that its absence is worth reporting.
 *
 * Deliberately short. Flagging every type with a standardised pset would bury
 * the finding that matters (a wall with no `Pset_WallCommon` cannot answer a
 * fire-rating or a U-value question) under a list of missing psets on railings.
 */
const COMMON_PSETS: Record<string, string> = {
  IfcWall: 'Pset_WallCommon',
  IfcSlab: 'Pset_SlabCommon',
  IfcDoor: 'Pset_DoorCommon',
  IfcWindow: 'Pset_WindowCommon',
  IfcSpace: 'Pset_SpaceCommon',
  IfcRoof: 'Pset_RoofCommon',
  IfcColumn: 'Pset_ColumnCommon',
  IfcBeam: 'Pset_BeamCommon',
}

/** Types whose material make-up carries building meaning. */
const MATERIAL_RELEVANT = new Set(['IfcWall', 'IfcSlab', 'IfcRoof', 'IfcColumn', 'IfcBeam'])

/** Quantity names that count as "this space knows its floor area". */
const SPACE_AREA_KEYS = ['NetFloorArea', 'NetArea', 'GrossFloorArea']

function sample(elements: readonly BimElement[]): string[] {
  return elements.slice(0, MAX_SAMPLES).map((element) => element.globalId)
}

function hasQuantity(element: BimElement, keys: readonly string[]): boolean {
  for (const set of Object.values(element.quantities)) {
    for (const key of keys) if (typeof set[key] === 'number') return true
  }
  return false
}

interface RuleInput {
  index: BimModelIndex
  elements: readonly BimElement[]
}

type RuleResult = Omit<BimIssue, 'stage'> | null

// ---------------------------------------------------------------------------
// Stage 1 — schema
// ---------------------------------------------------------------------------

function checkSchema({ index }: RuleInput): RuleResult[] {
  const schema = (index.schema ?? '').toUpperCase()
  if (!schema) {
    return [
      {
        rule: 'schema-unknown',
        severity: 'warning',
        count: 1,
        total: null,
        sampleGlobalIds: [],
        // Not an error: the parser read the file anyway. But every downstream
        // "is this entity valid in this version" question is now unanswerable.
        detail: null,
      },
    ]
  }
  if (schema.startsWith('IFC2X3')) {
    return [
      {
        rule: 'schema-legacy',
        severity: 'info',
        count: 1,
        total: null,
        sampleGlobalIds: [],
        detail: index.schema,
      },
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// Stage 2 — identity
// ---------------------------------------------------------------------------

function checkIdentity({ elements }: RuleInput): RuleResult[] {
  const results: RuleResult[] = []

  // `express:` is the extractor's own fallback for an element whose GlobalId
  // attribute was empty — so this counts elements the FILE failed to identify,
  // not ones we failed to read.
  const missing = elements.filter((element) => element.globalId.startsWith('express:'))
  if (missing.length > 0) {
    results.push({
      rule: 'identity-missing-globalid',
      severity: 'error',
      count: missing.length,
      total: elements.length,
      sampleGlobalIds: [],
      detail: null,
    })
  }

  const seen = new Map<string, number>()
  for (const element of elements) seen.set(element.globalId, (seen.get(element.globalId) ?? 0) + 1)
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1)
  if (duplicated.length > 0) {
    results.push({
      rule: 'identity-duplicate-globalid',
      severity: 'error',
      count: duplicated.length,
      total: elements.length,
      sampleGlobalIds: duplicated.slice(0, MAX_SAMPLES).map(([globalId]) => globalId),
      detail: null,
    })
  }

  const malformed = elements.filter(
    (element) =>
      !element.globalId.startsWith('express:') && !GLOBAL_ID_PATTERN.test(element.globalId)
  )
  if (malformed.length > 0) {
    results.push({
      rule: 'identity-malformed-globalid',
      severity: 'warning',
      count: malformed.length,
      total: elements.length,
      sampleGlobalIds: sample(malformed),
      detail: null,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Stage 3 — spatial structure
// ---------------------------------------------------------------------------

function checkSpatial({ index, elements }: RuleInput): RuleResult[] {
  const results: RuleResult[] = []

  if (index.storeys.length === 0) {
    results.push({
      rule: 'spatial-no-storeys',
      severity: 'error',
      count: 1,
      total: null,
      sampleGlobalIds: [],
      detail: null,
    })
  }

  // The finding that matters most. An orphan is invisible to every per-storey
  // question, so a storey breakdown over a model with orphans is a subset
  // presented as a total.
  const orphans = elements.filter((element) => element.containerKind === null)
  if (orphans.length > 0) {
    results.push({
      rule: 'spatial-orphan-elements',
      severity: 'error',
      count: orphans.length,
      total: elements.length,
      sampleGlobalIds: sample(orphans),
      detail: null,
    })
  }

  const aboveStorey = elements.filter(
    (element) => element.containerKind === 'site' || element.containerKind === 'building'
  )
  if (aboveStorey.length > 0) {
    results.push({
      rule: 'spatial-element-above-storey',
      severity: 'warning',
      count: aboveStorey.length,
      total: elements.length,
      sampleGlobalIds: sample(aboveStorey),
      detail: null,
    })
  }

  const spaces = elements.filter((element) => element.ifcType === 'IfcSpace')
  const spacesWithoutStorey = spaces.filter((element) => element.storeyGlobalId === null)
  if (spacesWithoutStorey.length > 0) {
    results.push({
      rule: 'spatial-space-without-storey',
      severity: 'warning',
      count: spacesWithoutStorey.length,
      total: spaces.length,
      sampleGlobalIds: sample(spacesWithoutStorey),
      detail: null,
    })
  }

  const withoutElevation = index.storeys.filter((storey) => storey.elevation === null)
  if (withoutElevation.length > 0) {
    results.push({
      rule: 'spatial-storey-without-elevation',
      severity: 'warning',
      count: withoutElevation.length,
      total: index.storeys.length,
      sampleGlobalIds: withoutElevation
        .map((storey) => storey.globalId)
        .filter((globalId): globalId is string => globalId !== null)
        .slice(0, MAX_SAMPLES),
      detail: null,
    })
  }

  // Two storeys at the same height are almost always a modelling slip, and they
  // make "the storey above" unanswerable.
  const byElevation = new Map<number, number>()
  for (const storey of index.storeys) {
    if (storey.elevation === null) continue
    byElevation.set(storey.elevation, (byElevation.get(storey.elevation) ?? 0) + 1)
  }
  const collisions = [...byElevation.values()].filter((count) => count > 1).length
  if (collisions > 0) {
    results.push({
      rule: 'spatial-duplicate-storey-elevation',
      severity: 'warning',
      count: collisions,
      total: index.storeys.length,
      sampleGlobalIds: [],
      detail: null,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Stage 4 — property sets
// ---------------------------------------------------------------------------

function checkProperties({ elements }: RuleInput): RuleResult[] {
  const results: RuleResult[] = []

  const withoutSets = elements.filter((element) => Object.keys(element.properties).length === 0)
  if (withoutSets.length > 0) {
    results.push({
      rule: 'properties-no-property-sets',
      severity: withoutSets.length === elements.length ? 'error' : 'warning',
      count: withoutSets.length,
      total: elements.length,
      sampleGlobalIds: sample(withoutSets),
      detail: null,
    })
  }

  // One finding per type rather than one aggregate: "walls have no
  // Pset_WallCommon" is actionable and "312 elements are missing a common
  // property set" is not.
  for (const [ifcType, psetName] of Object.entries(COMMON_PSETS)) {
    const ofType = elements.filter((element) => element.ifcType === ifcType)
    if (ofType.length === 0) continue
    const missing = ofType.filter((element) => !(psetName in element.properties))
    if (missing.length === 0) continue
    results.push({
      rule: 'properties-missing-common-pset',
      severity: 'warning',
      count: missing.length,
      total: ofType.length,
      sampleGlobalIds: sample(missing),
      detail: `${ifcType} · ${psetName}`,
    })
  }

  // A model whose property sets are ALL vendor-specific still answers
  // questions — but only ones phrased in that vendor's vocabulary, which no
  // regulation is. Reported as info, because it is a fact about the export.
  const setNames = new Set<string>()
  for (const element of elements) for (const name of Object.keys(element.properties)) setNames.add(name)
  const standard = [...setNames].filter((name) => name.startsWith('Pset_') || name.startsWith('Qto_'))
  if (setNames.size > 0 && standard.length === 0) {
    results.push({
      rule: 'properties-vendor-sets-only',
      severity: 'info',
      count: setNames.size,
      total: setNames.size,
      sampleGlobalIds: [],
      detail: [...setNames].slice(0, 5).join(', '),
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Stage 5 — information completeness
// ---------------------------------------------------------------------------

function checkCompleteness({ elements }: RuleInput): RuleResult[] {
  const results: RuleResult[] = []

  const unnamed = elements.filter((element) => element.name === null)
  if (unnamed.length > 0) {
    results.push({
      rule: 'complete-unnamed-elements',
      severity: 'info',
      count: unnamed.length,
      total: elements.length,
      sampleGlobalIds: sample(unnamed),
      detail: null,
    })
  }

  const spaces = elements.filter((element) => element.ifcType === 'IfcSpace')
  const withoutArea = spaces.filter((element) => !hasQuantity(element, SPACE_AREA_KEYS))
  if (withoutArea.length > 0) {
    results.push({
      // A room with no published area is silently absent from every area total,
      // which is the single most-asked number in this domain.
      rule: 'complete-space-without-area',
      severity: 'warning',
      count: withoutArea.length,
      total: spaces.length,
      sampleGlobalIds: sample(withoutArea),
      detail: null,
    })
  }

  const withoutQuantities = elements.filter(
    (element) => Object.keys(element.quantities).length === 0
  )
  if (withoutQuantities.length === elements.length && elements.length > 0) {
    results.push({
      rule: 'complete-no-quantities',
      severity: 'warning',
      count: elements.length,
      total: elements.length,
      sampleGlobalIds: [],
      detail: null,
    })
  }

  const materialRelevant = elements.filter((element) => MATERIAL_RELEVANT.has(element.ifcType))
  const withoutMaterials = materialRelevant.filter((element) => element.materials.length === 0)
  if (withoutMaterials.length > 0) {
    results.push({
      rule: 'complete-no-materials',
      severity: 'info',
      count: withoutMaterials.length,
      total: materialRelevant.length,
      sampleGlobalIds: sample(withoutMaterials),
      detail: null,
    })
  }

  const classified = elements.filter((element) => element.classifications.length > 0)
  if (elements.length > 0 && classified.length === 0) {
    results.push({
      rule: 'complete-no-classifications',
      severity: 'info',
      count: elements.length,
      total: elements.length,
      sampleGlobalIds: [],
      detail: null,
    })
  }

  return results
}

const STAGES: Array<{ stage: BimIssueStage; run: (input: RuleInput) => RuleResult[] }> = [
  { stage: 'schema', run: checkSchema },
  { stage: 'identity', run: checkIdentity },
  { stage: 'spatial', run: checkSpatial },
  { stage: 'properties', run: checkProperties },
  { stage: 'complete', run: checkCompleteness },
]

/** Severity weights for {@link BimHealth.score}. */
const SEVERITY_WEIGHT: Record<BimIssueSeverity, number> = { error: 12, warning: 5, info: 1 }

/**
 * Score an issue by how much of the model it affects, not merely that it fired.
 *
 * Two walls missing a property set and every wall missing one are the same
 * finding and very different models, so the weight scales with the share of the
 * population the rule looked at. A rule with no population (an absent schema)
 * counts as its full weight.
 */
function penalty(issue: BimIssue): number {
  const weight = SEVERITY_WEIGHT[issue.severity]
  if (issue.total === null || issue.total === 0) return weight
  return weight * Math.min(1, issue.count / issue.total)
}

/** Run every stage over an extracted model. */
export function validateModel(index: BimModelIndex): BimHealth {
  const input: RuleInput = { index, elements: index.elements }
  const issues: BimIssue[] = []
  for (const { stage, run } of STAGES) {
    for (const result of run(input)) {
      if (result) issues.push({ ...result, stage })
    }
  }

  const totals = { error: 0, warning: 0, info: 0 }
  for (const issue of issues) totals[issue.severity] += 1

  const deduction = issues.reduce((sum, issue) => sum + penalty(issue), 0)
  const score = Math.max(0, Math.min(100, Math.round(100 - deduction)))

  return { issues, score, totals }
}

/**
 * The sentence an agent must add to a per-storey or per-area answer over a
 * model with structural gaps, or `null` when there is nothing to qualify.
 *
 * This is the point of validating at all: a count that silently excludes 43
 * unplaced elements is not a smaller truth, it is a wrong answer, and the only
 * place that can be fixed is where the answer is written.
 */
export function healthCaveat(health: BimHealth): string | null {
  const parts: string[] = []
  const find = (rule: BimIssueRule) => health.issues.find((issue) => issue.rule === rule)

  const orphans = find('spatial-orphan-elements')
  if (orphans) {
    parts.push(
      `${orphans.count} Bauteile sind keinem Geschoß zugeordnet und fehlen daher in jeder geschoßweisen Auswertung`
    )
  }
  const spacesWithoutArea = find('complete-space-without-area')
  if (spacesWithoutArea) {
    parts.push(
      `${spacesWithoutArea.count} von ${spacesWithoutArea.total} Räumen veröffentlichen keine Fläche, Flächensummen sind daher unvollständig`
    )
  }
  const duplicates = find('identity-duplicate-globalid')
  if (duplicates) {
    parts.push(`${duplicates.count} GlobalIds kommen mehrfach vor, Bauteile sind nicht eindeutig`)
  }

  return parts.length === 0 ? null : `Hinweis zum Modell: ${parts.join('; ')}.`
}
