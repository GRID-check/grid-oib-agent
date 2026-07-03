// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed catalog of the OIB 2023 Richtlinien (Austrian building-code guidelines).
 *
 * This is the real corpus that ships in `data/oib`. Each entry carries the
 * official code, the German and English titles, a one-line English scope, and a
 * link to the source. We deliberately point every entry at the official overview
 * page rather than inventing deep links — the overview page is the stable,
 * authoritative entry point to the current Richtlinien.
 */

/** The official OIB-Richtlinien overview page — used as the source link for every entry. */
export const OIB_RICHTLINIEN_URL = 'https://www.oib.or.at/de/oib-richtlinien'

/** A single OIB Richtlinie as it appears in the catalog. */
export interface OibStandard {
  /** Official code, e.g. "OIB 2.3". */
  code: string
  /** German title as published by the OIB. */
  titleDe: string
  /** English rendering of the title. */
  titleEn: string
  /** One-line English description of what the Richtlinie covers. */
  scope: string
  /** Link to the source (official overview page). */
  oibUrl: string
}

/** The OIB 2023 Richtlinien, in canonical order. */
export const OIB_STANDARDS: readonly OibStandard[] = [
  {
    code: 'OIB 1',
    titleDe: 'Mechanische Festigkeit und Standsicherheit',
    titleEn: 'Mechanical strength and stability',
    scope: 'Structural safety and load-bearing capacity.',
    oibUrl: OIB_RICHTLINIEN_URL,
  },
  {
    code: 'OIB 2',
    titleDe: 'Brandschutz',
    titleEn: 'Fire safety',
    scope: 'General fire-safety requirements.',
    oibUrl: OIB_RICHTLINIEN_URL,
  },
  {
    code: 'OIB 2.1',
    titleDe: 'Brandschutz bei Betriebsbauten',
    titleEn: 'Fire safety — industrial & commercial buildings',
    scope: 'Fire safety for industrial and commercial buildings (Betriebsbauten).',
    oibUrl: OIB_RICHTLINIEN_URL,
  },
  {
    code: 'OIB 2.2',
    titleDe: 'Brandschutz bei Garagen, überdachten Stellplätzen und Parkdecks',
    titleEn: 'Fire safety — garages & covered parking',
    scope: 'Fire safety for garages, covered parking spaces and parking decks.',
    oibUrl: OIB_RICHTLINIEN_URL,
  },
  {
    code: 'OIB 2.3',
    titleDe: 'Brandschutz bei Gebäuden mit einem Fluchtniveau von mehr als 22 m',
    titleEn: 'Fire safety — high-rise buildings (escape level > 22 m)',
    scope: 'Fire safety for buildings whose top escape level exceeds 22 m (Hochhäuser).',
    oibUrl: OIB_RICHTLINIEN_URL,
  },
  {
    code: 'OIB 3',
    titleDe: 'Hygiene, Gesundheit und Umweltschutz',
    titleEn: 'Hygiene, health and environmental protection',
    scope: 'Hygiene, daylight, ventilation and environmental protection.',
    oibUrl: OIB_RICHTLINIEN_URL,
  },
  {
    code: 'OIB 4',
    titleDe: 'Nutzungssicherheit und Barrierefreiheit',
    titleEn: 'Safety in use and accessibility',
    scope: 'Safety in use and barrier-free (accessible) design.',
    oibUrl: OIB_RICHTLINIEN_URL,
  },
  {
    code: 'OIB 5',
    titleDe: 'Schallschutz',
    titleEn: 'Sound protection',
    scope: 'Sound protection and acoustic performance.',
    oibUrl: OIB_RICHTLINIEN_URL,
  },
  {
    code: 'OIB 6',
    titleDe: 'Energieeinsparung und Wärmeschutz',
    titleEn: 'Energy economy and heat retention',
    scope: 'Energy economy and thermal performance.',
    oibUrl: OIB_RICHTLINIEN_URL,
  },
] as const

/** Look up a catalog entry by its code (e.g. "OIB 2.3"). */
export function getOibStandard(code: string): OibStandard | undefined {
  return OIB_STANDARDS.find((standard) => standard.code === code)
}
