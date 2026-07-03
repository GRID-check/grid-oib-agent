// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Derive which OIB-Richtlinien apply to a project from the project's own brief
 * (its {@link ProjectProfile}). Pure and isomorphic — safe to run on the server
 * (Overview query) or the client. No I/O, no side effects.
 *
 * The result is orientation, not legal advice: it maps a handful of the brief's
 * facts (main use, building class, escape level, storeys) onto the Richtlinien
 * and explains, in one line, why each is relevant.
 */

import type { ProjectProfile } from '@/lib/project-profile/types'
import { getOibStandard, OIB_STANDARDS } from './standards-catalog'

/** How strongly a Richtlinie applies, given what the brief tells us. */
export type ApplicableStatus = 'required' | 'likely' | 'check'

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

/** Read a fact value as a string, defensively. Returns undefined when absent. */
function factString(profile: ProjectProfile | null, id: string): string | undefined {
  const value = profile?.facts?.[id]?.value
  return typeof value === 'string' ? value : undefined
}

/** Read a fact value as a number, defensively. Returns undefined when absent/NaN. */
function factNumber(profile: ProjectProfile | null, id: string): number | undefined {
  const value = profile?.facts?.[id]?.value
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
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

  const hauptnutzung = factString(profile, 'hauptnutzung')
  const gebaeudeklasse = factString(profile, 'gebaeudeklasse')
  const fluchtniveau = factString(profile, 'fluchtniveau')
  const geschosseUnterirdisch = factNumber(profile, 'geschosse_unterirdisch')

  const standards: ApplicableStandard[] = []

  // OIB 1 — always.
  standards.push(annotate('OIB 1', 'required', 'Structural safety applies to every building.'))

  // OIB 2 — always.
  standards.push(
    annotate('OIB 2', 'required', 'General fire-safety requirements apply to every building.')
  )

  // OIB 2.1 — Betriebsbauten (industrial & commercial).
  if (hauptnutzung === 'produzierend' || hauptnutzung === 'lager') {
    standards.push(
      annotate('OIB 2.1', 'required', 'Manufacturing/storage use is a Betriebsbau.')
    )
  } else if (
    hauptnutzung === 'landwirtschaft' ||
    hauptnutzung === 'sonstiges' ||
    hauptnutzung === undefined
  ) {
    standards.push(
      annotate('OIB 2.1', 'check', 'Applies if the building qualifies as a Betriebsbau.')
    )
  }
  // else: omit (clearly not a Betriebsbau).

  // OIB 2.2 — garages & covered parking.
  if (geschosseUnterirdisch !== undefined && geschosseUnterirdisch >= 1) {
    standards.push(
      annotate('OIB 2.2', 'check', 'Applies if the project includes a garage or covered parking.')
    )
  }
  // else: omit.

  // OIB 2.3 — high-rise (Hochhaus).
  if (fluchtniveau === '>22m') {
    standards.push(
      annotate('OIB 2.3', 'required', 'Top escape level over 22 m — the building is a Hochhaus.')
    )
  } else if (gebaeudeklasse === 'GK5' && fluchtniveau === undefined) {
    standards.push(
      annotate(
        'OIB 2.3',
        'check',
        'GK5 building — confirm whether the top escape level exceeds 22 m.'
      )
    )
  }
  // else: omit.

  // OIB 3 — always.
  standards.push(
    annotate(
      'OIB 3',
      'required',
      'Hygiene, daylight, ventilation and environmental requirements apply to every building.'
    )
  )

  // OIB 4 — always; stronger for publicly used buildings.
  const publicUse =
    hauptnutzung === 'beherbergung' ||
    hauptnutzung === 'gesundheit' ||
    hauptnutzung === 'versammlung' ||
    hauptnutzung === 'buero'
  standards.push(
    annotate(
      'OIB 4',
      'required',
      publicUse
        ? 'Safety in use and barrier-free access — accessibility duties are extensive for publicly used buildings.'
        : 'Safety in use and barrier-free access apply.'
    )
  )

  // OIB 5 — sound protection; required for occupied/noise-sensitive uses.
  const noiseSensitive =
    hauptnutzung === 'wohnen' ||
    hauptnutzung === 'beherbergung' ||
    hauptnutzung === 'gesundheit' ||
    hauptnutzung === 'buero' ||
    hauptnutzung === 'versammlung'
  standards.push(
    noiseSensitive
      ? annotate('OIB 5', 'required', 'Sound protection is required for occupied/noise-sensitive uses.')
      : annotate('OIB 5', 'likely', 'Sound protection typically applies.')
  )

  // OIB 6 — energy & thermal performance; storage/agricultural may be partly exempt.
  if (hauptnutzung === 'lager' || hauptnutzung === 'landwirtschaft') {
    standards.push(
      annotate(
        'OIB 6',
        'check',
        'Unconditioned storage/agricultural buildings may be partly exempt from OIB 6.'
      )
    )
  } else {
    standards.push(
      annotate('OIB 6', 'required', 'Energy and thermal-performance requirements apply.')
    )
  }

  return standards
}

/** Re-exported for callers that want the full catalog alongside the verdicts. */
export { OIB_STANDARDS }
