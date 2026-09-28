/**
 * The findings of a report (`metadata.findings`), made durable and bounded.
 *
 * One Befund per requirement the report read against the project: what it
 * requires, the copyable value, whether it is met, how it stands on its
 * evidence, where it is written and which `[N]` carries it. The backend
 * extracts the list off the finished report (`agents/deep_researcher/anatomy.py`)
 * under the contract in `common/findings.py`; the shared fixture
 * `tests/fixtures/findings/wire_payload.json` pins the two sides to one shape.
 *
 * Sanitized on write and again on read, like `answerMeta`: this lands in
 * message jsonb and is rendered as a table.
 */

export const FINDINGS_VERSION = 1

export const FINDING_STATUSES = ['erfuellt', 'nicht_erfuellt', 'offen', 'nicht_anwendbar'] as const
export type FindingStatus = (typeof FINDING_STATUSES)[number]

export const FINDING_GROUNDINGS = ['belegt', 'abgeleitet', 'offen'] as const
export type FindingGrounding = (typeof FINDING_GROUNDINGS)[number]

const MAX_FINDINGS = 40
const MAX_LABEL_CHARS = 200
const MAX_VALUE_CHARS = 120
const MAX_COMMENT_CHARS = 600
const MAX_CITATIONS = 8

export interface FindingReference {
  document: string
  section?: string
  page?: number
}

export interface Finding {
  requirement: string
  value?: string
  /**
   * The verdict, when the report judged the requirement. Absent for a row a
   * Vergleich or an Aktenvermerk states without judging it — the matrix is
   * then a list of Ergebnisse, not of Befunde.
   */
  status?: FindingStatus
  grounding: FindingGrounding
  reference?: FindingReference
  citations: number[]
  comment?: string
  area?: string
}

export interface Findings {
  v: number
  items: Finding[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined

const sanitizeReference = (value: unknown): FindingReference | undefined => {
  if (!isRecord(value)) return undefined
  const document = text(value.document, MAX_LABEL_CHARS)
  if (!document) return undefined
  const out: FindingReference = { document }
  const section = text(value.section, MAX_LABEL_CHARS)
  if (section) out.section = section
  if (typeof value.page === 'number' && Number.isInteger(value.page) && value.page > 0)
    out.page = value.page
  return out
}

const sanitizeFinding = (value: unknown): Finding | null => {
  if (!isRecord(value)) return null
  const requirement = text(value.requirement, MAX_LABEL_CHARS)
  const status = oneOf(value.status, FINDING_STATUSES)
  const grounding = oneOf(value.grounding, FINDING_GROUNDINGS)
  if (!requirement || !grounding) return null
  // A status the contract does not know is dropped as a whole row: a wrong
  // verdict is worse than none. An ABSENT status is a row without one.
  if (value.status !== undefined && value.status !== null && !status) return null
  const citations = Array.isArray(value.citations)
    ? value.citations
        .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0)
        .slice(0, MAX_CITATIONS)
    : []
  const out: Finding = { requirement, grounding, citations }
  if (status) out.status = status
  const val = text(value.value, MAX_VALUE_CHARS)
  if (val) out.value = val
  const reference = sanitizeReference(value.reference)
  if (reference) out.reference = reference
  const comment = text(value.comment, MAX_COMMENT_CHARS)
  if (comment) out.comment = comment
  const area = text(value.area, MAX_LABEL_CHARS)
  if (area) out.area = area
  return out
}

/** Reduce an untrusted findings payload to the contract, or null when nothing survives. */
export function sanitizeFindings(input: unknown): Findings | null {
  if (!isRecord(input) || !Array.isArray(input.items)) return null
  const items = input.items
    .slice(0, MAX_FINDINGS)
    .map(sanitizeFinding)
    .filter((item): item is Finding => item !== null)
  if (items.length === 0) return null
  const v = typeof input.v === 'number' && Number.isFinite(input.v) ? input.v : FINDINGS_VERSION
  return { v, items }
}

/** How many findings carry each status, for the matrix's summary line. */
/** Whether any row carries a verdict: the matrix is Befunde then, Ergebnisse otherwise. */
export const hasFindingStatuses = (findings: Findings): boolean =>
  findings.items.some((item) => item.status !== undefined)

export const findingCounts = (findings: Findings): Record<FindingStatus, number> => {
  const counts = { erfuellt: 0, nicht_erfuellt: 0, offen: 0, nicht_anwendbar: 0 }
  for (const item of findings.items) if (item.status) counts[item.status] += 1
  return counts
}
