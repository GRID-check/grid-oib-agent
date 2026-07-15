// Pure, isomorphic view-model builder for the Project Brief panel. Turns the
// raw ProjectProfile into the human-readable fact sheet the Overview renders:
// intake-question labels instead of raw fact keys, option labels instead of
// enum values, facts grouped in intake-stage order, unknowns and assumptions
// resolved to the same labels. Deriving at render time (rather than reading the
// stored profile_display) means every project benefits immediately — no
// re-save required.
import {
  flattenIntakeQuestions,
  formatIntakeAnswer,
  projectIntakeDefinitionV1,
} from './intake-definition'
import type { ProjectIntakeQuestion } from './intake-definition'
import { ProjectProfileSchema } from './types'
import type { ProjectAssumption, ProjectFact, ProjectProfile } from './types'

export interface BriefFact {
  key: string
  label: string
  value: string
  source: ProjectFact['source']
  updatedAt: string
}

export interface BriefFactGroup {
  id: string
  title: string
  facts: BriefFact[]
}

export interface BriefAssumption {
  key: string
  label: string
  value: string
  /** The machine value ("wohnen"), for writing back on confirm. */
  rawValue: ProjectAssumption['value']
  reason: string
  source: ProjectAssumption['source']
}

export interface BriefMissingFact {
  key: string
  label: string
}

export interface ProjectBriefView {
  /** Facts grouped by intake stage, in intake order; only non-empty groups. */
  groups: BriefFactGroup[]
  /** What Grid should focus on (goal option labels), when captured. */
  focusAreas: string[]
  /** Free-text goal detail, when captured. */
  goalDetails: string | null
  /** Unanswered intake questions, with human labels. */
  missing: BriefMissingFact[]
  /** Agent-suggested values awaiting confirmation. */
  assumptions: BriefAssumption[]
  /** Captured facts vs captured + still-missing, for the completeness caption. */
  answeredCount: number
  totalCount: number
}

/** Fact keys that are rendered elsewhere on the page (header), not in the sheet. */
const HIDDEN_FACT_KEYS = new Set(['project_name'])

/** Fallback label for a fact key no intake question covers (e.g. agent-added). */
function humanizeKey(key: string): string {
  const label = key.replaceAll('_', ' ')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function questionByFactKey(): Map<string, { question: ProjectIntakeQuestion; stageId: string }> {
  const map = new Map<string, { question: ProjectIntakeQuestion; stageId: string }>()
  for (const stage of projectIntakeDefinitionV1.stages) {
    for (const question of stage.questions) {
      const match = question.writesTo?.match(/^\/facts\/([^/]+)/)
      if (match) map.set(match[1], { question, stageId: stage.id })
    }
  }
  return map
}

export function buildProjectBriefView(rawProfile: unknown): ProjectBriefView {
  const parsed = ProjectProfileSchema.safeParse(rawProfile ?? {})
  const profile: ProjectProfile = parsed.success ? parsed.data : ProjectProfileSchema.parse({})
  const byKey = questionByFactKey()

  // Facts grouped by intake stage, in definition order; unmatched keys go last.
  const groups: BriefFactGroup[] = projectIntakeDefinitionV1.stages.map((stage) => ({
    id: stage.id,
    title: stage.title,
    facts: [],
  }))
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const other: BriefFactGroup = { id: 'other', title: 'Additional context', facts: [] }

  const factKeys = Object.keys(profile.facts)
  const orderedKeys = [
    ...flattenIntakeQuestions(projectIntakeDefinitionV1)
      .map((question) => question.writesTo?.match(/^\/facts\/([^/]+)/)?.[1])
      .filter((key): key is string => Boolean(key) && factKeys.includes(key!)),
    ...factKeys.filter((key) => !byKey.has(key)).sort(),
  ]

  for (const key of orderedKeys) {
    if (HIDDEN_FACT_KEYS.has(key)) continue
    const fact = profile.facts[key]
    const entry = byKey.get(key)
    const view: BriefFact = {
      key,
      label: entry?.question.label ?? humanizeKey(key),
      value: entry ? formatIntakeAnswer(entry.question, fact.value) : formatBareValue(fact.value),
      source: fact.source,
      updatedAt: fact.updatedAt,
    }
    ;(entry ? groupById.get(entry.stageId)! : other).facts.push(view)
  }

  // Goals: focus areas rendered via their option labels.
  const focusQuestion = flattenIntakeQuestions(projectIntakeDefinitionV1).find((q) => q.id === 'focus_areas')
  const rawFocus = profile.goals['focus_areas']
  const focusValues = Array.isArray(rawFocus) ? rawFocus : typeof rawFocus === 'string' ? [rawFocus] : []
  const focusAreas = focusValues.map(
    (value) => focusQuestion?.options?.find((option) => option.value === value)?.label ?? value,
  )
  const goalDetails = typeof profile.goals['goal_details'] === 'string' ? profile.goals['goal_details'] : null

  const missing: BriefMissingFact[] = [...new Set(profile.unknowns)]
    .filter((key) => !(key in profile.facts))
    .map((key) => ({ key, label: byKey.get(key)?.question.label ?? humanizeKey(key) }))

  const assumptions: BriefAssumption[] = Object.entries(profile.assumptions).map(([key, assumption]) => {
    const entry = byKey.get(key)
    return {
      key,
      label: entry?.question.label ?? humanizeKey(key),
      value: entry ? formatIntakeAnswer(entry.question, assumption.value) : formatBareValue(assumption.value),
      rawValue: assumption.value,
      reason: assumption.reason,
      source: assumption.source,
    }
  })

  const answeredCount = groups.reduce((n, group) => n + group.facts.length, 0) + other.facts.length
  return {
    groups: [...groups, other].filter((group) => group.facts.length > 0),
    focusAreas,
    goalDetails,
    missing,
    assumptions,
    answeredCount,
    totalCount: answeredCount + missing.length,
  }
}

/**
 * Plain-text, human-readable profile rendering fed to the summary LLM. Uses the
 * same label resolution as the Project Brief panel — question labels ("Building
 * class") and option labels ("Open land (Freiland)") instead of raw keys and
 * enum tokens — so the generated prose can't leak machine vocabulary like
 * "fluchtniveau" or "abweichender_bebauungsplan" into the sentence. Unknowns
 * and unconfirmed assumptions are deliberately excluded: the summary should
 * describe what the project IS, not enumerate what's missing.
 */
export function buildProjectSummaryText(rawProfile: unknown): string {
  const parsed = ProjectProfileSchema.safeParse(rawProfile ?? {})
  const profile: ProjectProfile = parsed.success ? parsed.data : ProjectProfileSchema.parse({})
  const brief = buildProjectBriefView(profile)

  const lines: string[] = []
  const name = profile.facts['project_name']?.value
  if (typeof name === 'string' && name.trim()) lines.push(`Project name: ${name.trim()}`)
  if (brief.focusAreas.length > 0) lines.push(`Focus: ${brief.focusAreas.join('; ')}`)
  if (brief.goalDetails) lines.push(`Focus details: ${brief.goalDetails}`)
  for (const group of brief.groups) {
    for (const fact of group.facts) {
      lines.push(`${fact.label}: ${fact.value}`)
    }
  }
  return lines.join('\n')
}

export function formatBareValue(value: ProjectFact['value']): string {
  if (value === null) return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}
