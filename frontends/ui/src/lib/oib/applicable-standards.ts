/**
 * Derive which norms apply to a project from the project's own brief
 * (its {@link ProjectProfile}). Pure and isomorphic — safe to run on the server
 * (Overview query) or the client. No I/O, no side effects.
 *
 * The rules come from the norm registry (`configs/norms/<country>/registry.yml`
 * `applicability:` blocks, ADR-0025 Phase 4) via
 * `./applicability-rules.generated` — the same data the backend's Python
 * resolver consumes, so UI Overview and agent prompts always agree. The
 * evaluator mirrors `aiq_agent.common.applicability` (first-match-wins).
 *
 * The result is orientation, not legal advice.
 */

import type { ProjectProfile, ProjectPrimitiveValue } from '@/lib/project-profile/types'
import {
  APPLICABILITY_RULES,
  type ApplicabilityCondition,
  type ApplicabilityVerdictStatus,
  type ApplicabilityWhen,
} from './applicability-rules.generated'
import { getOibStandard, OIB_STANDARDS } from './standards-catalog'

/** How strongly a norm applies, given what the brief tells us. */
export type ApplicableStatus = ApplicabilityVerdictStatus

/** A catalog entry annotated with a project-specific applicability verdict. */
export interface ApplicableStandard {
  code: string
  titleEn: string
  titleDe: string
  scope: string
  oibUrl: string
  status: ApplicableStatus
  reason: string
}

/** Build an {@link ApplicableStandard} from a catalog code + a verdict. */
function annotate(code: string, status: ApplicableStatus, reason: string): ApplicableStandard {
  const entry = getOibStandard(code)
  if (!entry) {
    // Every code passed here is a literal from the catalog, so this is unreachable
    // in practice; we fail soft rather than throw so the Overview never breaks.
    return { code, titleEn: code, titleDe: code, scope: '', oibUrl: '', status, reason }
  }
  return {
    code: entry.code,
    titleEn: entry.titleEn,
    titleDe: entry.titleDe,
    scope: entry.scope,
    oibUrl: entry.oibUrl,
    status,
    reason,
  }
}

/** The six Richtlinien that apply to essentially every building, as generic 'required'. */
function genericSix(): ApplicableStandard[] {
  return [
    annotate('OIB 1', 'required', 'Structural safety applies to every building.'),
    annotate('OIB 2', 'required', 'General fire-safety requirements apply to every building.'),
    annotate(
      'OIB 3',
      'required',
      'Hygiene, daylight, ventilation and environmental requirements apply to every building.'
    ),
    annotate('OIB 4', 'required', 'Safety in use and barrier-free access apply.'),
    annotate('OIB 5', 'required', 'Sound protection typically applies to occupied buildings.'),
    annotate('OIB 6', 'required', 'Energy and thermal-performance requirements apply.'),
  ]
}

type FactMap = Record<string, ProjectPrimitiveValue>

/** Numeric coercion shared by eq/in/ordering ops (booleans are never numeric). */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** Numeric-aware equality — falls back to string comparison. */
function valueEquals(fact: unknown, expected: unknown): boolean {
  const a = asNumber(fact)
  const b = asNumber(expected)
  if (a !== undefined && b !== undefined) return a === b
  // Booleans cross the language boundary as "true"/"false" strings (profile
  // JSON keeps real booleans, the PROJECT_CONTEXT text view renders strings):
  // compare either representation against the other.
  if (typeof fact === 'boolean' || typeof expected === 'boolean') {
    return String(fact).toLowerCase() === String(expected).toLowerCase()
  }
  return String(fact) === String(expected)
}

function isAbsent(fact: unknown): boolean {
  return fact === undefined || fact === null || fact === ''
}

function compare(fact: unknown, expected: unknown, pred: (a: number, b: number) => boolean): boolean {
  const a = asNumber(fact)
  const b = asNumber(expected)
  return a !== undefined && b !== undefined && pred(a, b)
}

/** Evaluate one condition against the fact map (mirrors the Python resolver). */
export function evaluateCondition(cond: ApplicabilityCondition, facts: FactMap): boolean {
  const fact = facts[cond.fact]
  switch (cond.op) {
    case 'defined':
      return !isAbsent(fact)
    case 'undefined':
      return isAbsent(fact)
    case 'eq':
      return !isAbsent(fact) && valueEquals(fact, cond.value)
    case 'in':
      return Array.isArray(cond.value) && !isAbsent(fact) && cond.value.some((v) => valueEquals(fact, v))
    case 'gt':
      return compare(fact, cond.value, (a, b) => a > b)
    case 'gte':
      return compare(fact, cond.value, (a, b) => a >= b)
    case 'lt':
      return compare(fact, cond.value, (a, b) => a < b)
    case 'lte':
      return compare(fact, cond.value, (a, b) => a <= b)
    default:
      return false
  }
}

/** Evaluate a rule's `when` block: absent block → match; `all` every; `any` some. */
export function evaluateWhen(when: ApplicabilityWhen | undefined, facts: FactMap): boolean {
  if (!when) return true
  if (when.all && !when.all.every((c) => evaluateCondition(c, facts))) return false
  if (when.any && !when.any.some((c) => evaluateCondition(c, facts))) return false
  return true
}

export interface ApplicabilityVerdict {
  status: ApplicableStatus
  reason: string
}

/**
 * Resolve every registry norm's applicability against plain fact values —
 * first matching rule per norm wins; norms without a match are omitted.
 */
export function resolveApplicability(facts: FactMap): Map<string, ApplicabilityVerdict> {
  const verdicts = new Map<string, ApplicabilityVerdict>()
  for (const entry of APPLICABILITY_RULES) {
    for (const rule of entry.rules) {
      if (evaluateWhen(rule.when, facts)) {
        verdicts.set(entry.normId, { status: rule.verdict, reason: rule.reasonEn })
        break
      }
    }
  }
  return verdicts
}

/** Map an OIB catalog code (`OIB 2.1`) to its registry norm id (`oib-rl-2.1`). */
function normIdForCode(code: string): string {
  return `oib-rl-${code.slice(4)}`
}

/**
 * Return only the Richtlinien that are required / likely / worth checking for this
 * project — clearly-inapplicable ones are omitted. When the brief is empty we can
 * only speak generically, so we return the six near-universal Richtlinien as
 * 'required' and let the UI prompt the architect to complete the brief.
 */
export function getApplicableStandards(profile: ProjectProfile | null): ApplicableStandard[] {
  const hasFacts = profile?.facts != null && Object.keys(profile.facts).length > 0
  if (!hasFacts) {
    return genericSix()
  }

  const facts: FactMap = Object.fromEntries(
    Object.entries(profile?.facts ?? {}).map(([id, fact]) => [id, fact.value])
  )
  const verdicts = resolveApplicability(facts)

  const standards: ApplicableStandard[] = []
  for (const entry of OIB_STANDARDS) {
    const verdict = verdicts.get(normIdForCode(entry.code))
    if (verdict) {
      standards.push(annotate(entry.code, verdict.status, verdict.reason))
    }
  }
  return standards
}

/** Re-exported for callers that want the full catalog alongside the verdicts. */
export { OIB_STANDARDS }
