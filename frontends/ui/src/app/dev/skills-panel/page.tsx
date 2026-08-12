'use client'

/**
 * Dev preview for the Agent Skills tab. Renders the REAL SkillsPanel — the org's
 * skills and nothing else, since everything schedule-shaped moved to the Jobs
 * tab — with a fetch shim serving `/api/skills`, so every row variant is
 * reviewable without a backend: an org skill in play, one switched off, and two
 * of the platform's offers (one taken up, one not) behind the disclosure.
 *
 * The pipeline's own builtins are deliberately absent from the fixture, because
 * they are absent from the endpoint: they are machinery, they carry no
 * `grid-catalog`, and no organization decides anything about them.
 * Not linked from anywhere and 404s outside development (see ../layout.tsx).
 */

import { I18nProvider } from '@/i18n'
import { SkillsPanel } from '@/features/skills/components/skills-panel'

const SKILLS = [
  {
    id: 'skill-1',
    name: 'acoustic-report',
    description: 'Drafts the acoustic compliance report (OIB-Richtlinie 5).',
    body: 'Draft a report on sound insulation per OIB-Richtlinie 5.\n\nUse the project documents as the source of truth for the building’s construction.',
    metadata: {},
    origin: 'org',
    enabled: true,
    clonedFrom: null,
    createdAt: '2026-07-10T09:00:00Z',
    updatedAt: '2026-07-16T09:00:00Z',
  },
  {
    // Switched off: the card stays legible, goes quiet, and says so on its tray.
    id: 'skill-2',
    name: 'escape-routes',
    description: 'Verifies escape route widths and lengths against OIB-Richtlinie 2.3.',
    body: 'Verify every escape route’s width and length against OIB-Richtlinie 2.3.\n\nName each deviation with its exact clause.',
    metadata: { 'grid-agents': 'deep_researcher' },
    origin: 'org',
    enabled: false,
    clonedFrom: null,
    createdAt: '2026-07-12T10:00:00Z',
    updatedAt: '2026-07-12T10:00:00Z',
  },
  {
    // An offer this org took up. No id — it is a file, and the switch stores
    // only the decision.
    id: null,
    name: 'oib-fire-check',
    description: 'Checks a project against the OIB fire-safety guideline (OIB-Richtlinie 2).',
    body: 'Act as a fire-safety reviewer.\n\n1. Read the project brief and identify every fire-safety relevant building part.\n2. Verify each against OIB-Richtlinie 2 (brandschutztechnische Anforderungen).\n3. List deviations with the exact clause number and a suggested fix.',
    metadata: { 'grid-catalog': 'curated' },
    origin: 'platform',
    enabled: true,
    clonedFrom: null,
    createdAt: null,
    updatedAt: null,
  },
  {
    // An offer it has not taken up — the default for anything curated.
    id: null,
    name: 'energy-certificate-check',
    description: 'Reviews the energy certificate against OIB-Richtlinie 6.',
    body: 'Compare the project’s energy certificate against OIB-Richtlinie 6 and list every value that misses its limit.',
    metadata: { 'grid-catalog': 'curated', 'grid-agents': 'deep_researcher' },
    origin: 'platform',
    enabled: false,
    clonedFrom: null,
    createdAt: null,
    updatedAt: null,
  },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __skillsPanelShim?: boolean }
  if (!w.__skillsPanelShim) {
    w.__skillsPanelShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/skills') {
        return Response.json({ skills: SKILLS })
      }
      return real(input, init)
    }
  }
}

export default function SkillsDevPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="mx-auto flex flex-col gap-6 p-8" data-testid="skills-panel-preview">
        <SkillsPanel canManageOrgSkills />
      </main>
    </I18nProvider>
  )
}
