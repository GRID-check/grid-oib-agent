// Derive the before/after rows the ProjectProfilePatchCard shows the user
// STRICTLY from the patch operations that will actually be written plus the
// current profile — never from a model-authored `preview`. A prompt-injected
// research context could otherwise show a benign preview while the patch writes
// a different fact, so what the user consents to must equal what gets applied.
import {
  flattenIntakeQuestions,
  formatIntakeAnswer,
  humanizeProfileKey,
  labelForProfileKey,
  projectIntakeDefinitionV1,
} from './intake-definition'
import type { ProjectIntakeQuestion } from './intake-definition'
import { formatBareValue } from './brief-view'
import type { ProjectPrimitiveValue, ProjectProfile, ProjectProfilePatchOperation } from './types'

export interface PatchPreviewRow {
  label: string
  before: string
  after: string
}

type PatchSection = 'facts' | 'assumptions' | 'goals' | 'unknowns'

/**
 * Build the before/after rows for a proposed profile patch. When `profile` is
 * null (not yet loaded) the `before` column is left blank — the component hides
 * that column until the current profile is known — so the user is never shown a
 * "before" the code cannot vouch for.
 */
export function buildPatchPreviewRows(
  patch: ProjectProfilePatchOperation[],
  profile: ProjectProfile | null
): PatchPreviewRow[] {
  const rows: PatchPreviewRow[] = []

  for (const op of patch) {
    const target = extractTarget(op.path)
    if (!target) continue

    if (target.section === 'unknowns') {
      const key = String(op.value ?? '')
      const label = humanizeProfileKey(key)
      rows.push({
        label,
        before: profile === null ? '' : '—',
        after: op.op === 'remove' ? '—' : label,
      })
      continue
    }

    const { section, key } = target
    const label =
      section === 'goals'
        ? humanizeProfileKey(key)
        : labelForProfileKey(projectIntakeDefinitionV1, key)
    const after = op.op === 'remove' ? '—' : formatAfter(key, op.value)
    const before = formatBefore(profile, section, key)
    rows.push({ label, before, after })
  }

  return rows
}

/** `/facts/<key>`, `/facts/<key>/value`, `/assumptions/...`, `/goals/<key>`, `/unknowns/-`. */
function extractTarget(
  path: string
):
  | { section: Exclude<PatchSection, 'unknowns'>; key: string }
  | { section: 'unknowns'; key: string }
  | null {
  const parts = path.split('/')
  const section = parts[1]

  if (section === 'unknowns') {
    if (parts[2] === '-') return { section: 'unknowns', key: '' }
    return null
  }

  if (section === 'facts' || section === 'assumptions') {
    if (parts.length === 3 && parts[2] && parts[2] !== '-')
      return { section, key: decodeSegment(parts[2]) }
    if (parts.length === 4 && parts[3] === 'value' && parts[2] && parts[2] !== '-') {
      return { section, key: decodeSegment(parts[2]) }
    }
    return null
  }

  if (section === 'goals') {
    if (parts.length === 3 && parts[2] && parts[2] !== '-')
      return { section, key: decodeSegment(parts[2]) }
    return null
  }

  return null
}

/** Never hide what will be written: unwrap a shaped `{ value }` op, else JSON-stringify a foreign object. */
function formatAfter(key: string, raw: unknown): string {
  let value: unknown = raw
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    if ('value' in raw) value = (raw as Record<string, unknown>).value
    else return JSON.stringify(raw)
  }
  return formatValue(key, value)
}

function formatBefore(
  profile: ProjectProfile | null,
  section: Exclude<PatchSection, 'unknowns'>,
  key: string
): string {
  if (profile === null) return ''
  let raw: ProjectPrimitiveValue | undefined
  if (section === 'facts') raw = profile.facts[key]?.value
  else if (section === 'assumptions') raw = profile.assumptions[key]?.value
  else raw = profile.goals[key]
  if (raw === undefined) return '—'
  return formatValue(key, raw)
}

/** Format a bare value using the intake question that writes this key, else the generic formatter. */
function formatValue(key: string, value: unknown): string {
  const question = questionForKey(key)
  if (question) return formatIntakeAnswer(question, value as ProjectPrimitiveValue | undefined)
  return formatBareValue(value as ProjectPrimitiveValue)
}

function questionForKey(key: string): ProjectIntakeQuestion | undefined {
  return flattenIntakeQuestions(projectIntakeDefinitionV1).find((question) => {
    const match = question.writesTo?.match(/^\/(?:facts|goals|assumptions)\/([^/]+)/)
    return match?.[1] === key
  })
}

function decodeSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~')
}
