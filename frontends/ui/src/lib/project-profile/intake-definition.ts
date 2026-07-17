import { applyProjectProfilePatch, emptyProjectProfile } from './patch-engine'
import type { ProjectPrimitiveValue, ProjectProfile, ProjectProfilePatchOperation } from './types'

export type ProjectIntakeQuestionType = 'single_select' | 'multi_select' | 'boolean' | 'number' | 'text'

export interface ProjectIntakeOption {
  value: string
  label: string
}

export interface ProjectIntakeQuestion {
  id: string
  label: string
  /** Optional one-line helper shown under the field label. */
  help?: string
  type: ProjectIntakeQuestionType
  options?: ProjectIntakeOption[]
  condition?: { field: string; equals?: string; oneOf?: string[] }
  writesTo?: string
  /**
   * Skippable: the wizard lets the user continue without answering. Unanswered
   * optional questions still land in `profile.unknowns` so Grid can chase them later.
   */
  optional?: boolean
}

export interface ProjectIntakeStage {
  id: string
  title: string
  /** Optional one-line description shown under the stage title. */
  description?: string
  questions: ProjectIntakeQuestion[]
}

export interface ProjectIntakeDefinition {
  version: number
  stages: ProjectIntakeStage[]
}

export const projectIntakeDefinitionV1: ProjectIntakeDefinition = {
  version: 3,
  stages: [
    {
      // Focus comes FIRST: once someone has named what they want out of the project,
      // finishing the brief feels like working toward it (commitment & consistency)
      // instead of filling in a form. Multi-select on purpose — Grid helps with all
      // of it, so nobody is forced to rank one goal above the rest.
      id: 'goal',
      title: 'Your focus',
      description: 'Grid helps across the whole project — this just tells it where to dig in first.',
      questions: [
        {
          id: 'focus_areas',
          label: 'What should Grid help with on this project?',
          help: 'Select everything that applies.',
          type: 'multi_select',
          options: [
            { value: 'einreichung', label: 'Getting a permit submission (Einreichung) approved' },
            { value: 'compliance_check', label: 'Verifying the design against the OIB' },
            { value: 'fruehe_planung', label: 'Pinning down design constraints early' },
            { value: 'brandschutz', label: 'Fire-safety concept' },
            { value: 'sanierung', label: 'Renovation / existing-building compliance' },
            { value: 'sonstiges', label: 'Something else' },
          ],
          writesTo: '/goals/focus_areas',
        },
        {
          id: 'goal_details',
          label: 'Tell Grid more',
          help: 'One sentence is enough — e.g. "Confirm the fire-compartment strategy for the submission."',
          type: 'text',
          condition: { field: 'focus_areas', equals: 'sonstiges' },
          writesTo: '/goals/goal_details',
        },
      ],
    },
    {
      id: 'core',
      title: 'Project core',
      description: 'The essentials Grid needs to frame the building.',
      questions: [
        {
          // Jurisdiction is a HARD fact: building law is state law (the nine
          // Landesbauordnungen differ), so every regulatory answer downstream —
          // RIS research, applicable standards, prompt context — depends on it.
          // It must never be inferred from free text.
          id: 'bundesland',
          label: 'Where is the building located?',
          help: 'The location decides which building code applies.',
          type: 'single_select',
          options: [
            { value: 'wien', label: 'Vienna (Wien)' },
            { value: 'niederoesterreich', label: 'Lower Austria (Niederösterreich)' },
            { value: 'oberoesterreich', label: 'Upper Austria (Oberösterreich)' },
            { value: 'steiermark', label: 'Styria (Steiermark)' },
            { value: 'kaernten', label: 'Carinthia (Kärnten)' },
            { value: 'salzburg', label: 'Salzburg' },
            { value: 'tirol', label: 'Tyrol (Tirol)' },
            { value: 'vorarlberg', label: 'Vorarlberg' },
            { value: 'burgenland', label: 'Burgenland' },
            { value: 'ausserhalb_oesterreichs', label: 'Outside Austria' },
          ],
          writesTo: '/facts/bundesland/value',
        },
        {
          id: 'standort_details',
          label: 'Project location',
          help: 'Country and region/city, e.g. "Bayern, Deutschland" — Grid uses this to frame which law applies.',
          type: 'text',
          condition: { field: 'bundesland', equals: 'ausserhalb_oesterreichs' },
          writesTo: '/facts/standort_details/value',
        },
        {
          id: 'hauptnutzung',
          label: 'Main use',
          type: 'single_select',
          options: [
            { value: 'wohnen', label: 'Residential' },
            { value: 'buero', label: 'Office' },
            { value: 'beherbergung', label: 'Hospitality' },
            { value: 'versammlung', label: 'Assembly' },
            { value: 'gesundheit', label: 'Healthcare' },
            { value: 'landwirtschaft', label: 'Agriculture' },
            { value: 'produzierend', label: 'Manufacturing' },
            { value: 'lager', label: 'Storage' },
            { value: 'sonstiges', label: 'Other' },
          ],
          writesTo: '/facts/hauptnutzung/value',
        },
        {
          id: 'anzahl_betten',
          label: 'Number of beds',
          type: 'number',
          condition: { field: 'hauptnutzung', equals: 'beherbergung' },
          writesTo: '/facts/anzahl_betten/value',
        },
        {
          id: 'anzahl_einheiten',
          label: 'Number of units',
          type: 'number',
          condition: { field: 'hauptnutzung', equals: 'wohnen' },
          writesTo: '/facts/anzahl_einheiten/value',
        },
        {
          id: 'sicherheitskategorie',
          label: 'Safety category',
          optional: true,
          type: 'single_select',
          options: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ],
          condition: { field: 'hauptnutzung', oneOf: ['beherbergung', 'gesundheit'] },
          writesTo: '/facts/sicherheitskategorie/value',
        },
      ],
    },
    {
      id: 'classification',
      title: 'Classification',
      description: 'How the building is categorised under the Bauordnung.',
      questions: [
        {
          id: 'widmung',
          label: 'Zoning',
          help: 'Land-use category (Widmung) from the development plan. Skip it if you don’t have the plan handy.',
          optional: true,
          type: 'single_select',
          options: [
            { value: 'bauland', label: 'Building land (Bauland)' },
            { value: 'verkehrsflaeche', label: 'Transport area (Verkehrsfläche)' },
            { value: 'freiland', label: 'Open land (Freiland)' },
            { value: 'kerngebiet', label: 'Core zone (Kerngebiet)' },
            { value: 'gemischt', label: 'Mixed use (Gemischt)' },
          ],
          writesTo: '/facts/widmung/value',
        },
        {
          id: 'gebaeudeklasse',
          label: 'Building class',
          help: 'OIB building class GK1–GK5.',
          type: 'single_select',
          options: [
            { value: 'GK1', label: 'GK1' },
            { value: 'GK2', label: 'GK2' },
            { value: 'GK3', label: 'GK3' },
            { value: 'GK4', label: 'GK4' },
            { value: 'GK5', label: 'GK5' },
          ],
          writesTo: '/facts/gebaeudeklasse/value',
        },
        {
          id: 'bauweise',
          label: 'Construction method',
          optional: true,
          type: 'single_select',
          options: [
            { value: 'offen', label: 'Open' },
            { value: 'gekuppelt', label: 'Coupled' },
            { value: 'geschlossen', label: 'Closed' },
          ],
          writesTo: '/facts/bauweise/value',
        },
        {
          id: 'hohe_gebaeude_details',
          label: 'High-building details',
          help: 'Relevant details for GK4/GK5 high buildings.',
          optional: true,
          type: 'text',
          condition: { field: 'gebaeudeklasse', oneOf: ['GK4', 'GK5'] },
          writesTo: '/facts/hohe_gebaeude_details/value',
        },
      ],
    },
    {
      id: 'building',
      title: 'Building details',
      description: 'Storeys and escape level.',
      questions: [
        {
          id: 'geschosse_oberirdisch',
          label: 'Above-ground floors',
          type: 'number',
          writesTo: '/facts/geschosse_oberirdisch/value',
        },
        {
          id: 'geschosse_unterirdisch',
          label: 'Below-ground floors',
          type: 'number',
          writesTo: '/facts/geschosse_unterirdisch/value',
        },
        {
          id: 'fluchtniveau',
          label: 'Escape level',
          help: 'Height of the highest escape level above ground.',
          type: 'single_select',
          options: [
            { value: '<=7m', label: '≤ 7m' },
            { value: '7-11m', label: '7–11m' },
            { value: '11-22m', label: '11–22m' },
            { value: '>22m', label: '> 22m' },
          ],
          writesTo: '/facts/fluchtniveau/value',
        },
      ],
    },
    {
      id: 'regulatory',
      title: 'Regulatory context',
      description: 'Site constraints and whether this is new or existing fabric.',
      questions: [
        {
          id: 'grundgrenze',
          label: 'On a property boundary',
          type: 'boolean',
          writesTo: '/facts/grundgrenze/value',
        },
        {
          id: 'fluchtlinie',
          label: 'On a building line',
          type: 'boolean',
          writesTo: '/facts/fluchtlinie/value',
        },
        {
          id: 'schutzzone',
          label: 'In a protection zone',
          type: 'boolean',
          writesTo: '/facts/schutzzone/value',
        },
        {
          id: 'abweichender_bebauungsplan',
          label: 'Deviates from the development plan',
          type: 'boolean',
          writesTo: '/facts/abweichender_bebauungsplan/value',
        },
        {
          id: 'bestand_neubau',
          label: 'Existing or new building',
          type: 'single_select',
          options: [
            { value: 'bestand', label: 'Existing building' },
            { value: 'neubau', label: 'New build' },
            { value: 'zu_und_umbau', label: 'Extension / conversion' },
          ],
          writesTo: '/facts/bestand_neubau/value',
        },
        {
          id: 'bestandsalter',
          label: 'Age of existing building',
          optional: true,
          type: 'single_select',
          options: [
            { value: '<10', label: '< 10 years' },
            { value: '10-30', label: '10–30 years' },
            { value: '30-50', label: '30–50 years' },
            { value: '>50', label: '> 50 years' },
          ],
          condition: { field: 'bestand_neubau', equals: 'bestand' },
          writesTo: '/facts/bestandsalter/value',
        },
        {
          id: 'kleingartengebiet',
          label: 'In a designated allotment garden area (Kleingartengebiet)',
          type: 'boolean',
          writesTo: '/facts/kleingartengebiet/value',
        },
        {
          id: 'denkmalschutz',
          label: 'Listed or protected historic building (Denkmalschutz)',
          type: 'boolean',
          writesTo: '/facts/denkmalschutz/value',
        },
        {
          id: 'betriebsanlage',
          label: 'Operational facility subject to trade law (Betriebsanlage, GewO §74ff)',
          type: 'boolean',
          writesTo: '/facts/betriebsanlage/value',
        },
        {
          id: 'stellplatz_relevant',
          label: 'Parking spaces or garages are part of the project',
          type: 'boolean',
          writesTo: '/facts/stellplatz_relevant/value',
        },
      ],
    },
  ],
}

// ---------------------------------------------------------------------------
// Shared intake helpers — used by both the wizard (client) and, where relevant,
// server routes. Pure and isomorphic.
// ---------------------------------------------------------------------------

/**
 * The validated `bundesland` token vocabulary (nine Bundesland tokens plus
 * `ausserhalb_oesterreichs`), read straight off the intake question's own
 * options so it can never drift from what the wizard actually offers.
 * Reused by `@/lib/project-profile/prompt-view`'s `loadProjectBundesland`
 * (backlog T3-9 follow-up, 2026-07-16, user-mandated) to validate the fact
 * pulled from the stored profile before it rides the structured
 * `X-Grid-Request-Context` envelope — the backend independently validates
 * the same vocabulary (`aiq_agent.project_context`'s `_BUNDESLAND_TOKENS`),
 * mirrored (not shared) across the language boundary like every other
 * cross-cutting request fact in this module family.
 */
export const BUNDESLAND_TOKENS: readonly string[] = (() => {
  const question = projectIntakeDefinitionV1.stages
    .flatMap((stage) => stage.questions)
    .find((q) => q.id === 'bundesland')
  return question?.options?.map((option) => option.value) ?? []
})()

/** Whether `token` is a recognized `bundesland` intake answer. */
export function isValidBundeslandToken(token: string): boolean {
  return BUNDESLAND_TOKENS.includes(token)
}

/** Whether a question is currently relevant given the answers collected so far. */
export function evaluateIntakeCondition(
  question: ProjectIntakeQuestion,
  answers: Record<string, ProjectPrimitiveValue>,
): boolean {
  const cond = question.condition
  if (!cond) return true
  const answer = answers[cond.field]
  // Multi-select answers match when the required value is among the selections.
  if (Array.isArray(answer)) {
    if (cond.equals !== undefined) return answer.includes(cond.equals)
    if (cond.oneOf !== undefined) return answer.some((v) => cond.oneOf!.includes(String(v)))
    return true
  }
  if (cond.equals !== undefined) return answer === cond.equals
  if (cond.oneOf !== undefined) return typeof answer === 'string' && cond.oneOf.includes(answer)
  return true
}

/** All questions across every stage, in definition order. */
export function flattenIntakeQuestions(definition: ProjectIntakeDefinition): ProjectIntakeQuestion[] {
  return definition.stages.flatMap((stage) => stage.questions)
}

/**
 * Remove answers belonging to conditional questions whose visibility condition no
 * longer holds, e.g. a bed count after the main use is switched away from
 * Hospitality. Pruning is recursive: dropping one answer can turn a further
 * question's condition false (a chained condition), so we repeat until nothing
 * more is removed. Convergence is guaranteed — each pass only ever removes keys.
 *
 * Returns the same object reference when nothing is pruned (cheap no-op for the
 * common case). Answers of unconditional questions are always kept.
 */
export function pruneStaleConditionalAnswers(
  answers: Record<string, ProjectPrimitiveValue>,
  definition: ProjectIntakeDefinition | null | undefined,
): Record<string, ProjectPrimitiveValue> {
  if (!definition) return answers
  const questions = flattenIntakeQuestions(definition)
  let current = answers
  let changedAny = false

  for (;;) {
    let changedThisPass = false
    let next: Record<string, ProjectPrimitiveValue> | null = null
    for (const question of questions) {
      if (!question.condition) continue
      if (!(question.id in current)) continue
      if (evaluateIntakeCondition(question, current)) continue
      // Condition is false but an answer is present → drop it.
      if (!next) next = { ...current }
      delete next[question.id]
      changedThisPass = true
    }
    if (!changedThisPass) break
    if (next) current = next
    changedAny = true
  }

  return changedAny ? current : answers
}

/** Whether an answer counts as provided (non-empty). */
export function isIntakeAnswerProvided(answer: ProjectPrimitiveValue | undefined): boolean {
  if (answer === undefined || answer === null || answer === '') return false
  if (Array.isArray(answer)) return answer.length > 0
  return true
}

interface WriteTarget {
  scope: 'facts' | 'goals'
  key: string
}

/** Resolve the fact/goal key a question writes to (e.g. '/facts/widmung/value' -> facts:widmung). */
function resolveWriteTarget(writesTo: string | undefined): WriteTarget | null {
  if (!writesTo) return null
  const factMatch = writesTo.match(/^\/facts\/([^/]+)/)
  if (factMatch) return { scope: 'facts', key: factMatch[1] }
  const goalMatch = writesTo.match(/^\/goals\/([^/]+)/)
  if (goalMatch) return { scope: 'goals', key: goalMatch[1] }
  return null
}

/**
 * Build a {@link ProjectProfile} from collected intake answers using the SAME
 * JSON-pointer patch engine that chat-driven edits use, so the resulting shape is
 * identical to a profile edited through {@link applyProjectProfilePatch}.
 *
 * Currently-relevant questions that were left unanswered are recorded in
 * `profile.unknowns`, so Overview's "what Grid still doesn't know" is accurate.
 */
export function buildIntakeProfile(
  answers: Record<string, ProjectPrimitiveValue>,
  definition: ProjectIntakeDefinition,
  options?: { projectName?: string },
): ProjectProfile {
  const now = new Date().toISOString()
  const patch: ProjectProfilePatchOperation[] = []
  const unknowns: string[] = []

  // The name was already given when the project was created — seed it into the
  // profile instead of asking again in the wizard.
  const projectName = options?.projectName?.trim()
  if (projectName) {
    patch.push({
      op: 'add',
      path: '/facts/project_name',
      value: { value: projectName, confidence: 'confirmed', source: 'onboarding', updatedAt: now },
    })
  }

  for (const question of flattenIntakeQuestions(definition)) {
    const target = resolveWriteTarget(question.writesTo)
    if (!target) continue
    // Only questions that actually apply to this building count toward answered/unknown.
    if (!evaluateIntakeCondition(question, answers)) continue

    const answer = answers[question.id]
    if (!isIntakeAnswerProvided(answer)) {
      unknowns.push(target.key)
      continue
    }

    const value: ProjectPrimitiveValue = Array.isArray(answer) ? [...answer] : answer
    if (target.scope === 'goals') {
      patch.push({ op: 'add', path: `/goals/${target.key}`, value })
    } else {
      patch.push({
        op: 'add',
        path: `/facts/${target.key}`,
        value: { value, confidence: 'confirmed', source: 'onboarding', updatedAt: now },
      })
    }
  }

  for (const key of unknowns) {
    patch.push({ op: 'add', path: '/unknowns/-', value: key })
  }

  return applyProjectProfilePatch(emptyProjectProfile(), patch)
}

/**
 * Merge a freshly wizard-built profile over the previously stored one so a
 * whole-profile PUT can never destroy knowledge the wizard doesn't own.
 *
 * The wizard's questions only round-trip intake-vocabulary keys, but the agent
 * patch flow legitimately records NOVEL facts/goals/unknowns (see
 * {@link validateProfilePatchVocabulary}) and assumptions are never editable
 * here. Merge semantics:
 *
 *  - Intake-owned keys (incl. the seeded `project_name`): the built profile is
 *    authoritative — an answer the user just cleared stays cleared (it lands in
 *    `unknowns`), it is NOT resurrected from the stored profile.
 *  - Non-intake facts/goals from the stored profile are preserved verbatim.
 *  - Unknowns: the built (intake-gap) list first, then stored unknowns that are
 *    not intake-owned, not duplicates, and not answered by a surviving fact/goal.
 *  - Assumptions: stored ones carry over; built ones (always empty today) win
 *    on key conflicts — unchanged from the previous assumptions-only carry-over.
 */
export function mergeIntakeProfile(
  built: ProjectProfile,
  previous: ProjectProfile | null | undefined,
  definition: ProjectIntakeDefinition,
): ProjectProfile {
  if (!previous) return built

  const intakeFactKeys = new Set<string>(['project_name'])
  const intakeGoalKeys = new Set<string>()
  for (const question of flattenIntakeQuestions(definition)) {
    const target = resolveWriteTarget(question.writesTo)
    if (!target) continue
    ;(target.scope === 'goals' ? intakeGoalKeys : intakeFactKeys).add(target.key)
  }

  const facts = {
    ...Object.fromEntries(Object.entries(previous.facts).filter(([key]) => !intakeFactKeys.has(key))),
    ...built.facts,
  }
  const goals = {
    ...Object.fromEntries(Object.entries(previous.goals).filter(([key]) => !intakeGoalKeys.has(key))),
    ...built.goals,
  }

  const unknowns = [...built.unknowns]
  for (const key of previous.unknowns) {
    if (intakeFactKeys.has(key) || intakeGoalKeys.has(key)) continue
    if (unknowns.includes(key)) continue
    if (key in facts || key in goals) continue
    unknowns.push(key)
  }

  return {
    facts,
    goals,
    unknowns,
    assumptions: { ...previous.assumptions, ...built.assumptions },
  }
}

/**
 * Reverse of {@link buildIntakeProfile}: seed wizard answers from an already-saved
 * profile so re-entering intake opens in edit mode, prefilled.
 */
export function answersFromProfile(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition,
): Record<string, ProjectPrimitiveValue> {
  const answers: Record<string, ProjectPrimitiveValue> = {}

  for (const question of flattenIntakeQuestions(definition)) {
    const target = resolveWriteTarget(question.writesTo)
    if (!target) continue

    let value: ProjectPrimitiveValue | undefined =
      target.scope === 'goals' ? profile.goals?.[target.key] : profile.facts?.[target.key]?.value

    if (value === undefined || value === null) continue

    // Tolerate legacy multi_select values that were persisted as a JSON string.
    if (question.type === 'multi_select' && typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value)
        if (Array.isArray(parsed)) value = parsed as string[]
      } catch {
        /* not JSON, keep as-is */
      }
    }

    answers[question.id] = value
  }

  return answers
}

/**
 * Title-case a raw snake_case/space-separated profile key as a last-resort human
 * label (e.g. `hohe_gebaeude_details` -> "Hohe Gebaeude Details").
 */
export function humanizeProfileKey(key: string): string {
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Resolve a human label for a raw profile fact/goal key (e.g. `fluchtniveau`)
 * from the intake question that writes it. Falls back to a title-cased
 * humanization of the key for genuinely unknown keys.
 */
export function labelForProfileKey(definition: ProjectIntakeDefinition, key: string): string {
  for (const question of flattenIntakeQuestions(definition)) {
    const target = resolveWriteTarget(question.writesTo)
    if (target?.key === key) return question.label
  }
  return humanizeProfileKey(key)
}

/**
 * Server-side vocabulary validation (defense-in-depth for the profile-patch
 * flow): reject add/replace operations whose value violates the intake
 * question that owns the key — a single-select value outside its options, a
 * non-boolean for a boolean fact, a non-number for a number fact, etc. Keys no
 * intake question covers pass (the model legitimately records novel facts), and
 * `remove` operations always pass. Throws an Error naming the field and the
 * offending value; callers map that to a 400.
 *
 * Lives here (not in patch-engine) because intake-definition already imports
 * patch-engine — the reverse edge would create an import cycle.
 */
export function validateProfilePatchVocabulary(patch: ProjectProfilePatchOperation[]): void {
  for (const operation of patch) {
    if (operation.op === 'remove') continue
    const key = extractVocabKey(operation.path)
    if (!key) continue
    const question = questionForKey(key)
    if (!question) continue
    assertVocabulary(question, unwrapPatchValue(operation.value))
  }
}

/** `/facts/<key>`, `/facts/<key>/value`, `/assumptions/...` (+ /value), `/goals/<key>`. */
function extractVocabKey(path: string): string | null {
  const parts = path.split('/')
  const section = parts[1]
  if (section === 'facts' || section === 'assumptions' || section === 'goals') {
    if (parts.length === 3 && parts[2] && parts[2] !== '-') return decodeVocabSegment(parts[2])
    if (section !== 'goals' && parts.length === 4 && parts[3] === 'value' && parts[2] && parts[2] !== '-') {
      return decodeVocabSegment(parts[2])
    }
  }
  return null
}

function questionForKey(key: string): ProjectIntakeQuestion | undefined {
  return flattenIntakeQuestions(projectIntakeDefinitionV1).find(
    (question) => resolveWriteTarget(question.writesTo)?.key === key,
  )
}

/** A patch value may be bare ("GK4") or already shaped ({ value: "GK4", ... }). */
function unwrapPatchValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return (value as Record<string, unknown>).value
  }
  return value
}

function assertVocabulary(question: ProjectIntakeQuestion, value: unknown): void {
  const label = question.label
  const shown = JSON.stringify(value)
  switch (question.type) {
    case 'single_select': {
      if (typeof value !== 'string' || !question.options?.some((option) => option.value === value)) {
        throw new Error(`Invalid value for "${label}": ${shown} is not an allowed option.`)
      }
      return
    }
    case 'multi_select': {
      const allowed = new Set(question.options?.map((option) => option.value) ?? [])
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && allowed.has(item))) {
        throw new Error(`Invalid value for "${label}": ${shown} is not a subset of the allowed options.`)
      }
      return
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new Error(`Invalid value for "${label}": expected true or false, got ${shown}.`)
      }
      return
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Invalid value for "${label}": expected a number, got ${shown}.`)
      }
      return
    }
    case 'text': {
      if (typeof value !== 'string') {
        throw new Error(`Invalid value for "${label}": expected text, got ${shown}.`)
      }
      return
    }
  }
}

function decodeVocabSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~')
}

/** Human-readable rendering of a single answer, using option labels where available. */
export function formatIntakeAnswer(
  question: ProjectIntakeQuestion,
  answer: ProjectPrimitiveValue | undefined,
): string {
  if (!isIntakeAnswerProvided(answer)) return '—'
  if (question.type === 'boolean') return answer ? 'Yes' : 'No'

  const optionLabel = (value: string): string =>
    question.options?.find((option) => option.value === value)?.label ?? value

  if (question.type === 'multi_select' && Array.isArray(answer)) {
    return answer.map(optionLabel).join(', ')
  }
  if (question.type === 'single_select' && typeof answer === 'string') {
    return optionLabel(answer)
  }
  return String(answer)
}
